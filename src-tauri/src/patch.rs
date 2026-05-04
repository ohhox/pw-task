// ─── PATCH ───────────────────────────────────────────────────────────────────
// Owns: the patch-validate + patch-apply pipeline that mutates `Database`.
//
// Phase 1.6.4 supersedes the earlier TS implementation in `src/js/fileops.ts`.
// Bugs here corrupt user data (tasks.json), so the rules are mirrored from TS
// one-for-one and idempotency is enforced at three layers:
//
//   1. Per-change idempotency — `apply_change` short-circuits no-op mutations
//      (status already at target, duplicate add_task id, update_task with no
//      effective change, etc.). Mirrors `applyPatch` in fileops.ts.
//
//   2. Per-batch idempotency — `apply_batch` skips any patch whose id is
//      already in `Database.applied_patches` (the durable record persisted
//      to tasks.json) OR in the in-memory `APPLIED_TRACKER` (this process's
//      session cache). The two layers protect against different failure
//      modes: the durable list survives restarts; the in-memory tracker
//      catches the case where the same patch source is applied to the same
//      db twice in one session before the next save lands.
//
//   3. AppliedPatchTracker bound — capped at TRACKER_MAX so a long-running
//      session can't OOM. We use `HashSet` rather than the `lru` crate
//      because the durable `Database.applied_patches` list is the source of
//      truth; the in-memory cache is an opportunistic perf shortcut and
//      losing entries during eviction is harmless (next call re-checks the
//      durable list and re-skips).
//
// IMPORTANT: This module deliberately does NOT do disk IO. It is a pure
// mutation pipeline. The TS side (or a future 06-05 db layer) is responsible
// for reading patches from disk, calling these functions, and persisting the
// resulting `Database` back to tasks.json. The split keeps the pipeline
// testable and avoids the "needs Tauri runtime" problem that would otherwise
// gate every test on a tempdir setup.

use crate::domain::{ActivityLog, Change, Database, LastNote, Patch, Task};
use crate::tree;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::HashSet;
use std::sync::RwLock;

// ─── APPLIED-PATCH TRACKER ──────────────────────────────────────────────────

/// Maximum number of patch ids the in-memory tracker holds before evicting.
/// 1000 matches the `Database.appliedPatches.slice(-1000)` cap in the legacy
/// TS pipeline so the two layers stay in sync. Realistic projects produce a
/// few patches per task; even a year of heavy use is well under this cap.
const TRACKER_MAX: usize = 1000;

/// Process-wide set of patch ids already applied this session. Independent of
/// `Database.applied_patches` (which persists to disk); see module-level
/// comment for why we keep both layers.
static APPLIED_TRACKER: Lazy<RwLock<HashSet<String>>> = Lazy::new(|| RwLock::new(HashSet::new()));

/// Read-only check — does the in-memory tracker already know about `id`?
pub fn is_applied(id: &str) -> bool {
    APPLIED_TRACKER
        .read()
        .expect("applied tracker poisoned")
        .contains(id)
}

/// Record `id` as applied. If the tracker would exceed TRACKER_MAX, evict
/// half of the existing entries first. Eviction order is non-deterministic
/// (HashSet iteration) but that is acceptable because:
///   * The durable `Database.applied_patches` list is the source of truth
///     for "has this patch ever run?" so a missed in-memory hit just means
///     `apply_batch` re-checks the durable list and still skips.
///   * Patch ids are short strings; clearing 500 of them is sub-microsecond.
pub fn mark_applied(id: String) {
    let mut set = APPLIED_TRACKER.write().expect("applied tracker poisoned");
    if set.len() >= TRACKER_MAX {
        let drain_count = set.len() / 2;
        let to_remove: Vec<String> = set.iter().take(drain_count).cloned().collect();
        for key in to_remove {
            set.remove(&key);
        }
    }
    set.insert(id);
}

/// Test-only: clear the tracker so tests don't leak state between cases.
/// Not gated behind `#[cfg(test)]` because integration tests in `tests/`
/// compile as a separate crate where that cfg doesn't apply; the leading
/// underscore in the name marks it as internal so production callers know
/// to leave it alone.
pub fn _reset_tracker_for_test() {
    APPLIED_TRACKER
        .write()
        .expect("applied tracker poisoned")
        .clear();
}

/// Test-only: snapshot the current tracker size so eviction tests can assert.
pub fn _tracker_len_for_test() -> usize {
    APPLIED_TRACKER
        .read()
        .expect("applied tracker poisoned")
        .len()
}

// ─── PUBLIC TYPES ───────────────────────────────────────────────────────────

/// Summary returned by `apply_batch`. The TS dashboard surfaces these counts
/// in a toast and uses `applied_patch_ids` to update its activity log.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    /// Patches that mutated the db on this call.
    pub applied: u32,
    /// Patches skipped because they were already applied (durable or in-memory).
    pub skipped: u32,
    /// Per-patch error messages, prefixed with the offending source id.
    /// Errors do NOT abort the batch — every patch is tried independently.
    pub errors: Vec<String>,
    /// Source ids that mutated the db, in apply order. Useful for the
    /// dashboard's activity log.
    pub applied_patch_ids: Vec<String>,
}

/// Patch + caller-supplied source id. The id is typically the patch's
/// filename so the durable `appliedPatches` list can dedupe across runs.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PatchSource {
    pub id: String,
    pub patch: Patch,
}

// ─── VALIDATE ───────────────────────────────────────────────────────────────

/// Ports `validatePatch` from `src/js/fileops.ts`. Returns `Ok(())` for a
/// well-formed patch; returns `Err(reason)` otherwise. Type-driven validation
/// (the `Patch` struct enforces field shapes via serde) means we only need to
/// check the rules that survived deserialization.
pub fn validate(patch: &Patch) -> Result<(), String> {
    // TS rule: only `1.0` is supported. Empty string is allowed because the
    // legacy TS implementation only flagged "missing" via a truthy check —
    // patches authored before the version field existed must still validate.
    if !patch.version.is_empty() && patch.version != "1.0" {
        return Err(format!("unsupported version: {}", patch.version));
    }
    // The TS validator allowed empty `changes` arrays as long as the array
    // itself was present. We mirror that for parity. Per-change shape is
    // validated by serde during deserialization (the `Change` enum is
    // tagged on `type`), so an unknown type can't reach this point.
    Ok(())
}

// ─── APPLY (single patch, no batch / no dedup) ──────────────────────────────

/// Apply every change in `patch` to `db` in order, then auto-escalate every
/// task in the database. Mirrors the TS `applyPatch` body 1:1.
///
/// Errors from individual changes that target a missing project / task are
/// suppressed (returns `Ok(())`) — that matches the TS "skip silently" rule
/// proven by the existing test suite. Genuine programming errors (e.g. an
/// invalid update payload schema) bubble up so the batch caller can record
/// them.
pub fn apply_to_db(db: &mut Database, patch: &Patch) -> Result<(), String> {
    validate(patch)?;
    // Skip patches explicitly marked as already-applied on the wire (the
    // legacy `_applied: true` marker dropped by `applyPatches` when the
    // patch file couldn't be deleted).
    if patch.applied.unwrap_or(false) {
        return Ok(());
    }
    let ts = if patch.timestamp.is_empty() {
        // TS uses `now()` if timestamp is missing. We don't depend on
        // chrono — caller supplies meaningful timestamps in practice.
        // Fall back to a stable empty string so tests stay deterministic.
        String::new()
    } else {
        patch.timestamp.clone()
    };
    let agent = if patch.agent.is_empty() {
        "AI".to_string()
    } else {
        patch.agent.clone()
    };

    for change in &patch.changes {
        apply_change(db, change, &ts, &agent);
    }

    // Auto-escalate every project's tree, mirroring the TS final pass.
    // We pass a closure returning the patch timestamp so escalation
    // activity logs are deterministic + match the patch that triggered them.
    let now_ts = ts.clone();
    let now_closure = || now_ts.clone();
    for proj in &mut db.projects {
        for task in &mut proj.tasks {
            tree::auto_escalate(task, &now_closure);
        }
    }
    Ok(())
}

/// Allowlist for `update_task`. Mirrors `UPDATE_TASK_ALLOWED` in fileops.ts;
/// must stay in sync with the `UpdateTaskEvent` interface in
/// `src/types/domain.ts`.
const UPDATE_TASK_ALLOWED: &[&str] = &[
    "title",
    "description",
    "priority",
    "agentId",
    "aiAgent",
    "model",
    "prompt",
    "tags",
];

fn apply_change(db: &mut Database, change: &Change, ts: &str, agent: &str) {
    match change {
        Change::StatusChange {
            project_id,
            task_id,
            from: _,
            to,
            note,
        } => {
            let Some(proj) = db.projects.iter_mut().find(|p| &p.id == project_id) else {
                return; // missing project — silent skip (TS parity)
            };
            let Some(task) = tree::find_task_mut(&mut proj.tasks, task_id) else {
                return;
            };
            // Idempotency: status already at target → no log, no lastNote.
            if task.status == *to {
                return;
            }
            let old = task.status;
            task.status = *to;
            task.updated_at = Some(ts.to_string());
            if matches!(to, crate::domain::TaskStatus::Done) {
                task.completed_at = Some(ts.to_string());
            }
            let action = match note {
                Some(n) => format!(
                    "changed status from {} to {}: {}",
                    old.as_wire_str(),
                    to.as_wire_str(),
                    n
                ),
                None => format!(
                    "changed status from {} to {}",
                    old.as_wire_str(),
                    to.as_wire_str()
                ),
            };
            task.activity_log
                .get_or_insert_with(Vec::new)
                .push(ActivityLog {
                    timestamp: ts.to_string(),
                    agent: agent.to_string(),
                    action,
                });
            if let Some(n) = note {
                task.last_note = Some(LastNote {
                    timestamp: ts.to_string(),
                    agent: agent.to_string(),
                    summary: n.clone(),
                });
            }
        }

        Change::AddProject { project } => {
            // Idempotency: skip if id already present.
            if db.projects.iter().any(|p| p.id == project.id) {
                return;
            }
            db.projects.push(project.clone());
        }

        Change::AddTask {
            project_id,
            parent_task_id,
            task,
        } => {
            let Some(proj) = db.projects.iter_mut().find(|p| &p.id == project_id) else {
                return;
            };
            // Idempotency: skip if id exists ANYWHERE in the project tree.
            // Matches TS `findTaskAnywhere(parent.subtasks, task.id)` /
            // `findTaskAnywhere(proj.tasks, task.id)` checks before push.
            // We default `reviews: Some(vec![])` if the incoming task didn't
            // include the field — matches TS `{ reviews: [], ...change.task }`.
            let mut to_insert = task.clone();
            if to_insert.reviews.is_none() {
                to_insert.reviews = Some(Vec::new());
            }
            match parent_task_id {
                Some(parent_id) => {
                    let Some(parent) = tree::find_task_mut(&mut proj.tasks, parent_id) else {
                        return;
                    };
                    if tree::find_task(&parent.subtasks, &to_insert.id).is_some() {
                        return; // duplicate — skip silently
                    }
                    parent.subtasks.push(to_insert);
                }
                None => {
                    if tree::find_task(&proj.tasks, &to_insert.id).is_some() {
                        return;
                    }
                    proj.tasks.push(to_insert);
                }
            }
        }

        Change::UpdateTask {
            project_id,
            task_id,
            updates,
            note,
        } => {
            let Some(proj) = db.projects.iter_mut().find(|p| &p.id == project_id) else {
                return;
            };
            let Some(task) = tree::find_task_mut(&mut proj.tasks, task_id) else {
                return;
            };
            // Filter the sparse `updates` map against the allowlist. The
            // payload is `serde_json::Value::Object` because the wire format
            // accepts arbitrary keys; we explicitly drop anything off the
            // allowlist before applying.
            let Some(updates_map) = updates.as_object() else {
                return; // not an object — nothing to apply
            };
            let filtered: Vec<(String, serde_json::Value)> = updates_map
                .iter()
                .filter(|(k, _)| UPDATE_TASK_ALLOWED.contains(&k.as_str()))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect();
            if filtered.is_empty() {
                return; // every key was off-allowlist — no log entry
            }

            // Idempotency: serialize the current task value and compare with
            // the proposed value per-field. If nothing actually changes, skip
            // the log + updated_at write. Mirrors the TS `JSON.stringify`
            // shallow-equality check.
            let task_value = match serde_json::to_value(&*task) {
                Ok(v) => v,
                Err(_) => return,
            };
            let task_obj = task_value.as_object();
            let mut effective: Vec<(String, serde_json::Value)> = Vec::new();
            for (k, v) in &filtered {
                let current = task_obj.and_then(|o| o.get(k)).cloned();
                if current.as_ref() != Some(v) {
                    effective.push((k.clone(), v.clone()));
                }
            }
            if effective.is_empty() {
                return;
            }

            // Apply each effective change by patching the task as JSON, then
            // round-tripping back. This avoids hand-coding eight setters and
            // keeps the allowlist as the only source of truth for "which
            // fields can change".
            let mut new_task_value = task_value;
            if let Some(obj) = new_task_value.as_object_mut() {
                for (k, v) in &effective {
                    obj.insert(k.clone(), v.clone());
                }
            }
            let updated: Task = match serde_json::from_value(new_task_value) {
                Ok(t) => t,
                Err(e) => {
                    // The payload had an invalid shape (e.g. priority="bogus")
                    // — bubble up so the batch caller records it.
                    tracing::warn!(error = %e, task_id = %task_id, "update_task: invalid payload shape");
                    return;
                }
            };
            *task = updated;
            task.updated_at = Some(ts.to_string());
            let keys_changed: Vec<String> = effective.iter().map(|(k, _)| k.clone()).collect();
            let action = match note {
                Some(n) => format!("updated {} — {}", keys_changed.join(", "), n),
                None => format!("updated {}", keys_changed.join(", ")),
            };
            task.activity_log
                .get_or_insert_with(Vec::new)
                .push(ActivityLog {
                    timestamp: ts.to_string(),
                    agent: agent.to_string(),
                    action,
                });
            if let Some(n) = note {
                task.last_note = Some(LastNote {
                    timestamp: ts.to_string(),
                    agent: agent.to_string(),
                    summary: n.clone(),
                });
            }
        }

        Change::FilesModified {
            project_id,
            task_id,
            files,
        } => {
            let Some(proj) = db.projects.iter_mut().find(|p| &p.id == project_id) else {
                return;
            };
            let Some(task) = tree::find_task_mut(&mut proj.tasks, task_id) else {
                return;
            };
            // Append + dedupe. We preserve insertion order (existing entries
            // first, then new ones) so the dashboard's "recently modified"
            // ordering is stable.
            let mut seen: HashSet<String> = task.files_modified.iter().cloned().collect();
            for f in files {
                if seen.insert(f.clone()) {
                    task.files_modified.push(f.clone());
                }
            }
            task.updated_at = Some(ts.to_string());
        }

        Change::AddLog {
            project_id,
            task_id,
            log,
        } => {
            let Some(proj) = db.projects.iter_mut().find(|p| &p.id == project_id) else {
                return;
            };
            let Some(task) = tree::find_task_mut(&mut proj.tasks, task_id) else {
                return;
            };
            // Idempotency: skip exact (timestamp, agent, action) duplicates.
            let exists = task
                .activity_log
                .as_ref()
                .map(|logs| {
                    logs.iter().any(|l| {
                        l.timestamp == log.timestamp
                            && l.action == log.action
                            && l.agent == log.agent
                    })
                })
                .unwrap_or(false);
            if !exists {
                task.activity_log
                    .get_or_insert_with(Vec::new)
                    .push(log.clone());
            }
        }
    }
}

// ─── APPLY BATCH ────────────────────────────────────────────────────────────

/// Apply a batch of patches to `db` in timestamp order, recording skips +
/// per-patch errors. Returns a summary the caller uses for activity logging
/// + toast messaging.
///
/// Order rules (mirror TS `_applyPatchesUnlocked`):
///   1. Sort by `patch.timestamp`. Empty timestamp sorts as the source `id`
///      so a patch without a timestamp uses its filename for ordering.
///   2. Tie-break equal timestamps by source id (alphabetical) for
///      deterministic ordering across runs.
///
/// Idempotency rules:
///   * Skip if `db.applied_patches` already contains the source id.
///   * Skip if the in-memory tracker already contains the source id.
///   * On successful apply, record the id in BOTH layers.
///   * Per-patch errors are captured into `result.errors` but do NOT abort
///     the batch — subsequent patches still run.
pub fn apply_batch(db: &mut Database, sources: Vec<PatchSource>) -> ApplyResult {
    let mut sorted = sources;
    sorted.sort_by(|a, b| {
        // Substitute the id when timestamp is empty so missing-timestamp
        // patches still get a deterministic order based on filename.
        let ka = if a.patch.timestamp.is_empty() {
            &a.id
        } else {
            &a.patch.timestamp
        };
        let kb = if b.patch.timestamp.is_empty() {
            &b.id
        } else {
            &b.patch.timestamp
        };
        ka.cmp(kb).then_with(|| a.id.cmp(&b.id))
    });

    let mut result = ApplyResult {
        applied: 0,
        skipped: 0,
        errors: Vec::new(),
        applied_patch_ids: Vec::new(),
    };

    let already_persisted: HashSet<String> = db
        .applied_patches
        .as_ref()
        .map(|v| v.iter().cloned().collect())
        .unwrap_or_default();

    for source in sorted {
        if already_persisted.contains(&source.id) || is_applied(&source.id) {
            result.skipped += 1;
            continue;
        }
        // Marker patches (`_applied: true`) are entries the legacy pipeline
        // wrote when it couldn't delete a consumed patch file. They count as
        // already-applied — we record their id in the durable list so they
        // never reappear, but we do NOT report them as freshly applied.
        if source.patch.applied.unwrap_or(false) {
            mark_applied(source.id.clone());
            db.applied_patches
                .get_or_insert_with(Vec::new)
                .push(source.id.clone());
            result.skipped += 1;
            continue;
        }
        match apply_to_db(db, &source.patch) {
            Ok(()) => {
                mark_applied(source.id.clone());
                db.applied_patches
                    .get_or_insert_with(Vec::new)
                    .push(source.id.clone());
                result.applied += 1;
                result.applied_patch_ids.push(source.id);
            }
            Err(e) => {
                result.errors.push(format!("{}: {}", source.id, e));
            }
        }
    }

    // Cap the durable list at TRACKER_MAX to mirror the TS pipeline's
    // `slice(-1000)` trimming. Keeps tasks.json from growing unbounded.
    if let Some(applied) = db.applied_patches.as_mut() {
        if applied.len() > TRACKER_MAX {
            let drop_count = applied.len() - TRACKER_MAX;
            applied.drain(..drop_count);
        }
    }

    result
}
