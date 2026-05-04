// Integration tests for `ai_task_flow::patch`.
//
// Phase 1.6.4 ports the patch pipeline from TS into Rust. These tests cover
// every `Change` variant, the validate / apply_to_db / apply_batch surface,
// idempotency at all three layers (per-change, per-batch, in-memory tracker),
// and the AppliedPatchTracker bounds enforcement.
//
// The in-memory APPLIED_TRACKER is a process-wide singleton, so tests that
// touch it serialize through `TRACKER_LOCK` and call `_reset_tracker_for_test`
// at the top of each case. Tests that only mutate a local `Database`
// (per-change tests) don't need the lock — they own their own state.

use ai_task_flow::domain::{
    ActivityLog, Change, Database, LastNote, Patch, Project, Task, TaskPriority, TaskStatus,
};
use ai_task_flow::patch::{
    _reset_tracker_for_test, _tracker_len_for_test, apply_batch, apply_to_db, is_applied,
    mark_applied, validate, PatchSource,
};
use std::sync::Mutex;

/// Serialize tests that touch the global tracker so they don't race.
static TRACKER_LOCK: Mutex<()> = Mutex::new(());

fn lock_tracker() -> std::sync::MutexGuard<'static, ()> {
    TRACKER_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

// ─── FIXTURE BUILDERS ──────────────────────────────────────────────────────

fn task(id: &str, status: TaskStatus) -> Task {
    Task {
        id: id.into(),
        title: id.into(),
        description: String::new(),
        status,
        priority: TaskPriority::Medium,
        agent_id: None,
        ai_agent: None,
        model: None,
        prompt: None,
        tags: vec![],
        subtasks: vec![],
        files_modified: vec![],
        last_session_id: None,
        run_history: None,
        last_note: None,
        reviews: None,
        activity_log: None,
        created_at: "2026-01-01T00:00:00.000Z".into(),
        updated_at: None,
        completed_at: None,
    }
}

fn with_subs(mut t: Task, subs: Vec<Task>) -> Task {
    t.subtasks = subs;
    t
}

fn project(id: &str, tasks: Vec<Task>) -> Project {
    Project {
        id: id.into(),
        name: id.into(),
        description: None,
        goal: None,
        working_dir: None,
        run_command: None,
        color: "#60a5fa".into(),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        tasks,
        agent_defaults: None,
    }
}

/// Mirrors the TS `makeDb` fixture: two projects, a three-level tree under p1.
///   p1: r1 (todo)
///         ├── c1 (in_progress)
///         │     └── g1 (todo)
///         └── c2 (done)
///   p2: x1 (todo)
fn make_db() -> Database {
    let g1 = task("g1", TaskStatus::Todo);
    let c1 = with_subs(task("c1", TaskStatus::InProgress), vec![g1]);
    let c2 = task("c2", TaskStatus::Done);
    let r1 = with_subs(task("r1", TaskStatus::Todo), vec![c1, c2]);
    let x1 = task("x1", TaskStatus::Todo);
    Database {
        version: Some("1.0".into()),
        schema_version: None,
        last_updated: "2026-01-01T00:00:00.000Z".into(),
        projects: vec![project("p1", vec![r1]), project("p2", vec![x1])],
        agents: None,
        applied_patches: Some(vec![]),
        instructions: None,
    }
}

fn patch_with(changes: Vec<Change>, ts: &str) -> Patch {
    Patch {
        version: "1.0".into(),
        timestamp: ts.into(),
        agent: "Claude".into(),
        changes,
        applied: None,
    }
}

/// Walk the database tree looking for a task by id (depth-first, all projects).
fn find_in_db<'a>(db: &'a Database, project_id: &str, task_id: &str) -> Option<&'a Task> {
    let proj = db.projects.iter().find(|p| p.id == project_id)?;
    fn walk<'a>(tasks: &'a [Task], id: &str) -> Option<&'a Task> {
        for t in tasks {
            if t.id == id {
                return Some(t);
            }
            if let Some(found) = walk(&t.subtasks, id) {
                return Some(found);
            }
        }
        None
    }
    walk(&proj.tasks, task_id)
}

// ─── validate() ────────────────────────────────────────────────────────────

#[test]
fn validate_well_formed_patch_returns_ok() {
    let p = patch_with(
        vec![Change::StatusChange {
            project_id: "p1".into(),
            task_id: "r1".into(),
            from: None,
            to: TaskStatus::InProgress,
            note: Some("starting work".into()),
        }],
        "2026-05-03T10:00:00.000Z",
    );
    assert!(validate(&p).is_ok());
}

#[test]
fn validate_unsupported_version_is_rejected() {
    let mut p = patch_with(vec![], "2026-05-03T10:00:00.000Z");
    p.version = "2.0".into();
    let err = validate(&p).expect_err("v2.0 must be rejected");
    assert!(err.contains("unsupported version"), "got: {err}");
}

#[test]
fn validate_empty_version_is_allowed_for_legacy_patches() {
    // Pre-versioning patches in the wild have empty/missing version. The TS
    // validator only flagged versions that were truthy AND not "1.0", so the
    // Rust port preserves that lenient behaviour.
    let mut p = patch_with(vec![], "2026-05-03T10:00:00.000Z");
    p.version = String::new();
    assert!(validate(&p).is_ok());
}

// ─── apply_to_db — status_change ───────────────────────────────────────────

#[test]
fn status_change_updates_status_and_appends_log() {
    let mut db = make_db();
    apply_to_db(
        &mut db,
        &patch_with(
            vec![Change::StatusChange {
                project_id: "p1".into(),
                task_id: "r1".into(),
                from: Some(TaskStatus::Todo),
                to: TaskStatus::InProgress,
                note: Some("starting work".into()),
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    )
    .unwrap();

    let r1 = find_in_db(&db, "p1", "r1").unwrap();
    assert_eq!(r1.status, TaskStatus::InProgress);
    assert_eq!(r1.updated_at.as_deref(), Some("2026-05-03T10:00:00.000Z"));
    let last = r1.activity_log.as_ref().and_then(|l| l.last()).unwrap();
    assert!(last.action.contains("changed status from todo to in_progress"));
    assert!(last.action.contains("starting work"));
    assert_eq!(last.agent, "Claude");
    assert_eq!(
        r1.last_note,
        Some(LastNote {
            timestamp: "2026-05-03T10:00:00.000Z".into(),
            agent: "Claude".into(),
            summary: "starting work".into(),
        })
    );
}

#[test]
fn status_change_to_done_sets_completed_at() {
    let mut db = make_db();
    apply_to_db(
        &mut db,
        &patch_with(
            vec![Change::StatusChange {
                project_id: "p1".into(),
                task_id: "g1".into(),
                from: None,
                to: TaskStatus::Done,
                note: Some("finished".into()),
            }],
            "2026-05-03T11:00:00.000Z",
        ),
    )
    .unwrap();
    let g1 = find_in_db(&db, "p1", "g1").unwrap();
    assert_eq!(g1.status, TaskStatus::Done);
    assert_eq!(g1.completed_at.as_deref(), Some("2026-05-03T11:00:00.000Z"));
}

#[test]
fn status_change_idempotent_when_already_at_target() {
    let mut db = make_db();
    let log_before = find_in_db(&db, "p1", "r1")
        .unwrap()
        .activity_log
        .as_ref()
        .map(|l| l.len())
        .unwrap_or(0);
    apply_to_db(
        &mut db,
        &patch_with(
            vec![Change::StatusChange {
                project_id: "p1".into(),
                task_id: "r1".into(),
                from: None,
                to: TaskStatus::Todo, // r1 is already 'todo'
                note: Some("no-op".into()),
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    )
    .unwrap();
    let r1 = find_in_db(&db, "p1", "r1").unwrap();
    assert_eq!(r1.status, TaskStatus::Todo);
    let log_after = r1.activity_log.as_ref().map(|l| l.len()).unwrap_or(0);
    assert_eq!(log_before, log_after, "no-op must not append a log entry");
    assert!(r1.last_note.is_none(), "no-op must not set lastNote");
}

// ─── apply_to_db — add_task ────────────────────────────────────────────────

#[test]
fn add_task_root_appends_to_project_tasks() {
    let mut db = make_db();
    apply_to_db(
        &mut db,
        &patch_with(
            vec![Change::AddTask {
                project_id: "p1".into(),
                parent_task_id: None,
                task: task("new-root", TaskStatus::Todo),
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    )
    .unwrap();
    let p1 = db.projects.iter().find(|p| p.id == "p1").unwrap();
    assert!(p1.tasks.iter().any(|t| t.id == "new-root"));
}

#[test]
fn add_task_with_parent_appends_to_subtasks() {
    let mut db = make_db();
    apply_to_db(
        &mut db,
        &patch_with(
            vec![Change::AddTask {
                project_id: "p1".into(),
                parent_task_id: Some("c1".into()),
                task: task("new-sub", TaskStatus::Todo),
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    )
    .unwrap();
    let c1 = find_in_db(&db, "p1", "c1").unwrap();
    assert!(c1.subtasks.iter().any(|t| t.id == "new-sub"));
}

#[test]
fn add_task_duplicate_id_is_skipped_silently() {
    let mut db = make_db();
    let dup = task("dup-task", TaskStatus::Todo);
    let p = patch_with(
        vec![Change::AddTask {
            project_id: "p1".into(),
            parent_task_id: None,
            task: dup,
        }],
        "2026-05-03T10:00:00.000Z",
    );
    apply_to_db(&mut db, &p).unwrap();
    apply_to_db(&mut db, &p).unwrap(); // second apply must be a no-op, not error
    let p1 = db.projects.iter().find(|p| p.id == "p1").unwrap();
    let count = p1.tasks.iter().filter(|t| t.id == "dup-task").count();
    assert_eq!(count, 1, "duplicate add_task must not produce a second entry");
}

#[test]
fn add_task_defaults_reviews_to_empty_vec() {
    // Tasks deserialized from JSON without a `reviews` field arrive with
    // `reviews: None`. The TS code defaults this to `[]` so the dashboard
    // renders an empty review list rather than `undefined`. We mirror that.
    let mut db = make_db();
    let mut t = task("rv-test", TaskStatus::Todo);
    t.reviews = None;
    apply_to_db(
        &mut db,
        &patch_with(
            vec![Change::AddTask {
                project_id: "p1".into(),
                parent_task_id: None,
                task: t,
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    )
    .unwrap();
    let added = find_in_db(&db, "p1", "rv-test").unwrap();
    assert_eq!(added.reviews.as_ref().map(|r| r.len()), Some(0));
}

// ─── apply_to_db — update_task ────────────────────────────────────────────

#[test]
fn update_task_mutates_only_allowlisted_fields() {
    let mut db = make_db();
    let updates = serde_json::json!({
        "title": "New Title",
        "description": "New desc",
        "priority": "high",
        "tags": ["x", "y"],
        "agentId": "agent-1",
        "aiAgent": "Claude",
        "model": "claude-opus-4-7",
        "prompt": "do the thing",
    });
    apply_to_db(
        &mut db,
        &patch_with(
            vec![Change::UpdateTask {
                project_id: "p1".into(),
                task_id: "r1".into(),
                updates,
                note: Some("rename".into()),
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    )
    .unwrap();
    let r1 = find_in_db(&db, "p1", "r1").unwrap();
    assert_eq!(r1.title, "New Title");
    assert_eq!(r1.description, "New desc");
    assert_eq!(r1.priority, TaskPriority::High);
    assert_eq!(r1.tags, vec!["x".to_string(), "y".to_string()]);
    assert_eq!(r1.agent_id.as_deref(), Some("agent-1"));
    assert_eq!(r1.ai_agent.as_deref(), Some("Claude"));
    assert_eq!(r1.model.as_deref(), Some("claude-opus-4-7"));
    assert_eq!(r1.prompt.as_deref(), Some("do the thing"));
    let last = r1.activity_log.as_ref().and_then(|l| l.last()).unwrap();
    assert!(last.action.starts_with("updated"));
    assert_eq!(r1.last_note.as_ref().map(|n| &n.summary[..]), Some("rename"));
}

#[test]
fn update_task_rejects_off_allowlist_fields_silently() {
    // Schema-changing fields (id, subtasks, status, createdAt) must not be
    // mutated by update_task. The TS test suite considers this a security
    // boundary — see __tests__/patch-system.test.ts.
    let mut db = make_db();
    let original = find_in_db(&db, "p1", "r1").unwrap().clone();
    let updates = serde_json::json!({
        "id": "hijacked",
        "subtasks": [],
        "status": "done",
        "createdAt": "1999-01-01T00:00:00.000Z",
    });
    apply_to_db(
        &mut db,
        &patch_with(
            vec![Change::UpdateTask {
                project_id: "p1".into(),
                task_id: "r1".into(),
                updates,
                note: None,
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    )
    .unwrap();
    let r1 = find_in_db(&db, "p1", "r1").unwrap();
    assert_eq!(r1.id, original.id);
    assert_eq!(r1.status, original.status);
    assert_eq!(r1.created_at, original.created_at);
    assert_eq!(r1.subtasks.len(), original.subtasks.len());
}

#[test]
fn update_task_no_op_skips_log_and_updated_at() {
    // Idempotency guard: updating with the current value must not append
    // an activity log entry or stamp updated_at. Mirrors the TS test
    // 'is idempotent — no-op update skips activityLog write'.
    let mut db = make_db();
    let log_before = find_in_db(&db, "p1", "r1")
        .unwrap()
        .activity_log
        .as_ref()
        .map(|l| l.len())
        .unwrap_or(0);
    let title_before = find_in_db(&db, "p1", "r1").unwrap().title.clone();
    apply_to_db(
        &mut db,
        &patch_with(
            vec![Change::UpdateTask {
                project_id: "p1".into(),
                task_id: "r1".into(),
                updates: serde_json::json!({ "title": title_before }),
                note: None,
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    )
    .unwrap();
    let r1 = find_in_db(&db, "p1", "r1").unwrap();
    let log_after = r1.activity_log.as_ref().map(|l| l.len()).unwrap_or(0);
    assert_eq!(log_before, log_after);
    assert!(
        r1.updated_at.is_none(),
        "no-op update must not stamp updated_at"
    );
}

#[test]
fn update_task_only_off_allowlist_keys_skips_log() {
    let mut db = make_db();
    let log_before = find_in_db(&db, "p1", "r1")
        .unwrap()
        .activity_log
        .as_ref()
        .map(|l| l.len())
        .unwrap_or(0);
    apply_to_db(
        &mut db,
        &patch_with(
            vec![Change::UpdateTask {
                project_id: "p1".into(),
                task_id: "r1".into(),
                updates: serde_json::json!({ "id": "x", "status": "done" }),
                note: None,
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    )
    .unwrap();
    let r1 = find_in_db(&db, "p1", "r1").unwrap();
    let log_after = r1.activity_log.as_ref().map(|l| l.len()).unwrap_or(0);
    assert_eq!(log_before, log_after, "purely off-allowlist update == no log");
}

// ─── apply_to_db — files_modified ─────────────────────────────────────────

#[test]
fn files_modified_appends_and_dedupes() {
    let mut db = make_db();
    apply_to_db(
        &mut db,
        &patch_with(
            vec![Change::FilesModified {
                project_id: "p1".into(),
                task_id: "r1".into(),
                files: vec!["a.ts".into(), "b.ts".into()],
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    )
    .unwrap();
    apply_to_db(
        &mut db,
        &patch_with(
            vec![Change::FilesModified {
                project_id: "p1".into(),
                task_id: "r1".into(),
                files: vec!["b.ts".into(), "c.ts".into()],
            }],
            "2026-05-03T10:01:00.000Z",
        ),
    )
    .unwrap();
    let r1 = find_in_db(&db, "p1", "r1").unwrap();
    let mut files = r1.files_modified.clone();
    files.sort();
    assert_eq!(files, vec!["a.ts", "b.ts", "c.ts"]);
}

// ─── apply_to_db — add_log ────────────────────────────────────────────────

#[test]
fn add_log_pushes_entry() {
    let mut db = make_db();
    apply_to_db(
        &mut db,
        &patch_with(
            vec![Change::AddLog {
                project_id: "p1".into(),
                task_id: "r1".into(),
                log: ActivityLog {
                    timestamp: "2026-05-03T11:00:00.000Z".into(),
                    agent: "Claude".into(),
                    action: "noted something".into(),
                },
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    )
    .unwrap();
    let r1 = find_in_db(&db, "p1", "r1").unwrap();
    let last = r1.activity_log.as_ref().and_then(|l| l.last()).unwrap();
    assert_eq!(last.action, "noted something");
}

#[test]
fn add_log_dedupes_identical_entries() {
    let mut db = make_db();
    let log = ActivityLog {
        timestamp: "2026-05-03T11:00:00.000Z".into(),
        agent: "Claude".into(),
        action: "noted something".into(),
    };
    let p = patch_with(
        vec![Change::AddLog {
            project_id: "p1".into(),
            task_id: "r1".into(),
            log,
        }],
        "2026-05-03T10:00:00.000Z",
    );
    apply_to_db(&mut db, &p).unwrap();
    apply_to_db(&mut db, &p).unwrap();
    let r1 = find_in_db(&db, "p1", "r1").unwrap();
    let matches = r1
        .activity_log
        .as_ref()
        .map(|logs| {
            logs.iter()
                .filter(|l| l.action == "noted something" && l.agent == "Claude")
                .count()
        })
        .unwrap_or(0);
    assert_eq!(matches, 1, "duplicate (timestamp,agent,action) must dedupe");
}

// ─── apply_to_db — add_project ────────────────────────────────────────────

#[test]
fn add_project_appends_and_dedupes() {
    let mut db = make_db();
    let p_new = project("p3", vec![]);
    apply_to_db(
        &mut db,
        &patch_with(
            vec![Change::AddProject {
                project: p_new.clone(),
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    )
    .unwrap();
    apply_to_db(
        &mut db,
        &patch_with(
            vec![Change::AddProject { project: p_new }],
            "2026-05-03T10:01:00.000Z",
        ),
    )
    .unwrap();
    let count = db.projects.iter().filter(|p| p.id == "p3").count();
    assert_eq!(count, 1, "duplicate add_project must dedupe");
}

// ─── apply_to_db — robustness ─────────────────────────────────────────────

#[test]
fn missing_project_id_is_silent_skip() {
    let mut db = make_db();
    let result = apply_to_db(
        &mut db,
        &patch_with(
            vec![Change::StatusChange {
                project_id: "GHOST".into(),
                task_id: "r1".into(),
                from: None,
                to: TaskStatus::Done,
                note: Some("should be skipped".into()),
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    );
    assert!(result.is_ok(), "missing project must not error");
    let r1 = find_in_db(&db, "p1", "r1").unwrap();
    assert_eq!(r1.status, TaskStatus::Todo);
}

#[test]
fn missing_task_id_is_silent_skip_across_change_types() {
    let mut db = make_db();
    let result = apply_to_db(
        &mut db,
        &patch_with(
            vec![
                Change::FilesModified {
                    project_id: "p1".into(),
                    task_id: "GHOST".into(),
                    files: vec!["x.ts".into()],
                },
                Change::UpdateTask {
                    project_id: "p1".into(),
                    task_id: "GHOST".into(),
                    updates: serde_json::json!({ "title": "x" }),
                    note: None,
                },
                Change::AddLog {
                    project_id: "p1".into(),
                    task_id: "GHOST".into(),
                    log: ActivityLog {
                        timestamp: "2026-05-03T11:00:00.000Z".into(),
                        agent: "A".into(),
                        action: "noop".into(),
                    },
                },
            ],
            "2026-05-03T10:00:00.000Z",
        ),
    );
    assert!(result.is_ok(), "missing task must not error");
}

// ─── apply_to_db — auto_escalate runs after apply ─────────────────────────

#[test]
fn auto_escalate_runs_after_apply() {
    // Mark g1 done (subtree of c1) then mark c1 done. With both c1 and c2
    // done, r1 should auto-escalate to pending_review.
    let mut db = make_db();
    apply_to_db(
        &mut db,
        &patch_with(
            vec![
                Change::StatusChange {
                    project_id: "p1".into(),
                    task_id: "g1".into(),
                    from: None,
                    to: TaskStatus::Done,
                    note: Some("g1 done".into()),
                },
                Change::StatusChange {
                    project_id: "p1".into(),
                    task_id: "c1".into(),
                    from: None,
                    to: TaskStatus::Done,
                    note: Some("c1 done".into()),
                },
            ],
            "2026-05-03T10:00:00.000Z",
        ),
    )
    .unwrap();
    let r1 = find_in_db(&db, "p1", "r1").unwrap();
    assert_eq!(r1.status, TaskStatus::PendingReview);
    let has_escalation_log = r1
        .activity_log
        .as_ref()
        .map(|logs| logs.iter().any(|l| l.action.contains("auto-escalated")))
        .unwrap_or(false);
    assert!(has_escalation_log, "auto-escalation should leave a log");
}

// ─── apply_batch ──────────────────────────────────────────────────────────

#[test]
fn apply_batch_sorts_by_timestamp() {
    let _g = lock_tracker();
    _reset_tracker_for_test();
    let mut db = make_db();
    let sources = vec![
        PatchSource {
            id: "zzz_first.json".into(),
            patch: patch_with(
                vec![Change::UpdateTask {
                    project_id: "p1".into(),
                    task_id: "r1".into(),
                    updates: serde_json::json!({ "title": "FIRST" }),
                    note: None,
                }],
                "2026-05-03T09:00:00.000Z",
            ),
        },
        PatchSource {
            id: "aaa_second.json".into(),
            patch: patch_with(
                vec![Change::UpdateTask {
                    project_id: "p1".into(),
                    task_id: "r1".into(),
                    updates: serde_json::json!({ "title": "SECOND" }),
                    note: None,
                }],
                "2026-05-03T10:00:00.000Z",
            ),
        },
    ];
    let result = apply_batch(&mut db, sources);
    assert_eq!(result.applied, 2);
    let r1 = find_in_db(&db, "p1", "r1").unwrap();
    // Final value is 'SECOND' because that patch has the later timestamp,
    // even though its filename sorts first.
    assert_eq!(r1.title, "SECOND");
}

#[test]
fn apply_batch_tie_break_by_id_when_timestamps_equal() {
    let _g = lock_tracker();
    _reset_tracker_for_test();
    let mut db = make_db();
    let same_ts = "2026-05-03T10:00:00.000Z";
    let sources = vec![
        PatchSource {
            id: "zzz.json".into(),
            patch: patch_with(
                vec![Change::UpdateTask {
                    project_id: "p1".into(),
                    task_id: "r1".into(),
                    updates: serde_json::json!({ "title": "Z-WINS" }),
                    note: None,
                }],
                same_ts,
            ),
        },
        PatchSource {
            id: "aaa.json".into(),
            patch: patch_with(
                vec![Change::UpdateTask {
                    project_id: "p1".into(),
                    task_id: "r1".into(),
                    updates: serde_json::json!({ "title": "A-FIRST" }),
                    note: None,
                }],
                same_ts,
            ),
        },
    ];
    let result = apply_batch(&mut db, sources);
    assert_eq!(result.applied, 2);
    // aaa.json applies first (alphabetical), then zzz.json overwrites the title.
    let r1 = find_in_db(&db, "p1", "r1").unwrap();
    assert_eq!(r1.title, "Z-WINS");
}

#[test]
fn apply_batch_skips_already_applied_in_db() {
    let _g = lock_tracker();
    _reset_tracker_for_test();
    let mut db = make_db();
    db.applied_patches = Some(vec!["seen.json".into()]);
    let sources = vec![PatchSource {
        id: "seen.json".into(),
        patch: patch_with(
            vec![Change::FilesModified {
                project_id: "p1".into(),
                task_id: "r1".into(),
                files: vec!["should-not-apply.ts".into()],
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    }];
    let result = apply_batch(&mut db, sources);
    assert_eq!(result.applied, 0);
    assert_eq!(result.skipped, 1);
    let r1 = find_in_db(&db, "p1", "r1").unwrap();
    assert!(r1.files_modified.is_empty());
}

#[test]
fn apply_batch_skips_already_applied_in_tracker() {
    let _g = lock_tracker();
    _reset_tracker_for_test();
    mark_applied("tracker-only.json".into());
    let mut db = make_db();
    let sources = vec![PatchSource {
        id: "tracker-only.json".into(),
        patch: patch_with(
            vec![Change::FilesModified {
                project_id: "p1".into(),
                task_id: "r1".into(),
                files: vec!["should-not-apply.ts".into()],
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    }];
    let result = apply_batch(&mut db, sources);
    assert_eq!(result.applied, 0);
    assert_eq!(result.skipped, 1);
}

#[test]
fn apply_batch_records_applied_into_db_and_tracker() {
    let _g = lock_tracker();
    _reset_tracker_for_test();
    let mut db = make_db();
    let sources = vec![PatchSource {
        id: "first.json".into(),
        patch: patch_with(
            vec![Change::FilesModified {
                project_id: "p1".into(),
                task_id: "r1".into(),
                files: vec!["x.ts".into()],
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    }];
    let result = apply_batch(&mut db, sources);
    assert_eq!(result.applied, 1);
    assert_eq!(result.applied_patch_ids, vec!["first.json".to_string()]);
    let applied = db.applied_patches.as_ref().unwrap();
    assert!(applied.iter().any(|id| id == "first.json"));
    assert!(is_applied("first.json"));
}

#[test]
fn apply_batch_per_patch_error_does_not_abort_subsequent_patches() {
    let _g = lock_tracker();
    _reset_tracker_for_test();
    let mut db = make_db();
    // First patch has unsupported version → validate error.
    // Second patch is well-formed and must still apply.
    let mut bad = patch_with(vec![], "2026-05-03T09:00:00.000Z");
    bad.version = "2.0".into();
    let sources = vec![
        PatchSource {
            id: "bad.json".into(),
            patch: bad,
        },
        PatchSource {
            id: "good.json".into(),
            patch: patch_with(
                vec![Change::UpdateTask {
                    project_id: "p1".into(),
                    task_id: "r1".into(),
                    updates: serde_json::json!({ "title": "survived" }),
                    note: None,
                }],
                "2026-05-03T10:00:00.000Z",
            ),
        },
    ];
    let result = apply_batch(&mut db, sources);
    assert_eq!(result.applied, 1);
    assert_eq!(result.errors.len(), 1, "bad patch should produce one error");
    assert!(
        result.errors[0].starts_with("bad.json:"),
        "error must be prefixed with source id"
    );
    let r1 = find_in_db(&db, "p1", "r1").unwrap();
    assert_eq!(r1.title, "survived");
}

#[test]
fn apply_batch_idempotent_repeated_application_of_same_source() {
    // Critical regression test for task-t-upgrade-11. Re-applying the same
    // PatchSource twice in a single session must not double-mutate the db.
    let _g = lock_tracker();
    _reset_tracker_for_test();
    let mut db = make_db();
    let patch = patch_with(
        vec![Change::FilesModified {
            project_id: "p1".into(),
            task_id: "r1".into(),
            files: vec!["only-once.ts".into()],
        }],
        "2026-05-03T10:00:00.000Z",
    );
    let source = PatchSource {
        id: "once.json".into(),
        patch,
    };
    let r1 = apply_batch(&mut db, vec![source.clone()]);
    assert_eq!(r1.applied, 1);
    let r2 = apply_batch(&mut db, vec![source]);
    assert_eq!(r2.applied, 0, "second apply must be skipped");
    assert_eq!(r2.skipped, 1);
    let r1_task = find_in_db(&db, "p1", "r1").unwrap();
    assert_eq!(r1_task.files_modified, vec!["only-once.ts"]);
}

#[test]
fn apply_batch_skipped_marker_patch_is_no_op() {
    // Patches with `_applied: true` (the legacy fallback marker the TS
    // pipeline writes when the patch file can't be deleted) must apply as
    // no-ops: their changes are NOT re-played.
    let _g = lock_tracker();
    _reset_tracker_for_test();
    let mut db = make_db();
    let mut patch = patch_with(
        vec![Change::FilesModified {
            project_id: "p1".into(),
            task_id: "r1".into(),
            files: vec!["should-not-apply.ts".into()],
        }],
        "2026-05-03T10:00:00.000Z",
    );
    patch.applied = Some(true);
    let source = PatchSource {
        id: "marked.json".into(),
        patch,
    };
    let result = apply_batch(&mut db, vec![source]);
    // Marker patches count as already-applied: skipped, not applied.
    // Their inner changes are NOT replayed.
    assert_eq!(result.applied, 0);
    assert_eq!(result.skipped, 1);
    let r1 = find_in_db(&db, "p1", "r1").unwrap();
    assert!(r1.files_modified.is_empty(), "marker patch must not mutate");
    // The id is added to the durable list so it never reappears.
    let applied = db.applied_patches.as_ref().unwrap();
    assert!(applied.iter().any(|id| id == "marked.json"));
}

// ─── AppliedPatchTracker ──────────────────────────────────────────────────

#[test]
fn tracker_marks_and_reports_applied() {
    let _g = lock_tracker();
    _reset_tracker_for_test();
    assert!(!is_applied("foo"));
    mark_applied("foo".into());
    assert!(is_applied("foo"));
}

#[test]
fn tracker_evicts_when_exceeding_max() {
    let _g = lock_tracker();
    _reset_tracker_for_test();
    // Insert TRACKER_MAX (1000) + a few extras; the eviction policy drops
    // half of the existing entries on the next insert that hits the cap.
    // After inserting 1001 entries we expect the tracker size to be at
    // most TRACKER_MAX.
    for i in 0..1001 {
        mark_applied(format!("patch-{i}"));
    }
    let len = _tracker_len_for_test();
    assert!(len <= 1000, "tracker exceeded MAX cap: {len}");
    assert!(len > 0, "tracker should still hold entries after eviction");
}

#[test]
fn tracker_thread_safety_concurrent_mark_applied() {
    let _g = lock_tracker();
    _reset_tracker_for_test();
    let handles: Vec<_> = (0..8)
        .map(|t| {
            std::thread::spawn(move || {
                for i in 0..50 {
                    mark_applied(format!("thread-{t}-patch-{i}"));
                }
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap();
    }
    // 8 threads × 50 patches = 400 entries; well under the 1000 cap so all
    // should be present without eviction.
    assert_eq!(_tracker_len_for_test(), 400);
    assert!(is_applied("thread-0-patch-0"));
    assert!(is_applied("thread-7-patch-49"));
}

// ─── apply_batch — durable list trimming ──────────────────────────────────

#[test]
fn apply_batch_trims_durable_applied_patches_to_max() {
    let _g = lock_tracker();
    _reset_tracker_for_test();
    let mut db = make_db();
    // Pre-populate with 1000 stale ids.
    db.applied_patches = Some((0..1000).map(|i| format!("stale-{i}")).collect());
    let sources = vec![PatchSource {
        id: "fresh.json".into(),
        patch: patch_with(
            vec![Change::FilesModified {
                project_id: "p1".into(),
                task_id: "r1".into(),
                files: vec!["fresh.ts".into()],
            }],
            "2026-05-03T10:00:00.000Z",
        ),
    }];
    apply_batch(&mut db, sources);
    let applied = db.applied_patches.as_ref().unwrap();
    assert!(applied.len() <= 1000, "durable list capped at 1000");
    assert!(applied.iter().any(|id| id == "fresh.json"));
}
