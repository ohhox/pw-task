// ─── TREE ────────────────────────────────────────────────────────────────────
// Pure helpers that walk / mutate the recursive `Task` tree.
//
// Semantics are ported one-to-one from `src/js/data.ts` so the Rust and TS
// implementations agree byte-for-byte. Each helper has a comment pointing to
// the matching TS function so reviewers can verify equivalence.
//
// Conventions:
//   * No IO, no globals — everything takes its tree as a parameter.
//   * Mutation helpers (`find_task_mut`, `auto_escalate`) take `&mut`; lookup
//     helpers return borrows so callers don't pay for clones.
//   * Timestamp + log-agent strings are injected by the caller so the helpers
//     stay deterministic and unit-testable.

use crate::domain::{ActivityLog, Task, TaskStatus};
use std::collections::HashMap;

// ─── LOOKUP ─────────────────────────────────────────────────────────────────

/// Depth-first search for a task with `id`. Returns the first match.
/// Mirrors `findTaskAnywhere` in `src/js/data.ts`.
pub fn find_task<'a>(tasks: &'a [Task], id: &str) -> Option<&'a Task> {
    for t in tasks {
        if t.id == id {
            return Some(t);
        }
        if let Some(found) = find_task(&t.subtasks, id) {
            return Some(found);
        }
    }
    None
}

/// Mutable variant of [`find_task`] for callers that need to update the tree
/// in place. Returns the first matching node by depth-first order.
pub fn find_task_mut<'a>(tasks: &'a mut [Task], id: &str) -> Option<&'a mut Task> {
    for t in tasks {
        if t.id == id {
            return Some(t);
        }
        if let Some(found) = find_task_mut(&mut t.subtasks, id) {
            return Some(found);
        }
    }
    None
}

/// Walk a path of task ids from a root list. Returns the deepest task hit, or
/// `None` if any segment is missing. Mirrors `findTaskByPath` minus the
/// global `db`/`activeProjectId` lookup, which lives in the frontend.
pub fn find_task_by_path<'a>(tasks: &'a [Task], path: &[String]) -> Option<&'a Task> {
    if path.is_empty() {
        return None;
    }
    let mut cursor: &[Task] = tasks;
    let mut hit: Option<&Task> = None;
    for id in path {
        let next = cursor.iter().find(|t| &t.id == id)?;
        hit = Some(next);
        cursor = &next.subtasks;
    }
    hit
}

// ─── COUNTING / PROGRESS ────────────────────────────────────────────────────

/// Recursive count of every task in the tree.
/// Mirrors `countAll` in `src/js/data.ts`.
pub fn count_all(tasks: &[Task]) -> usize {
    tasks.iter().map(|t| 1 + count_all(&t.subtasks)).sum()
}

/// Recursive count of `done` tasks across the whole tree.
/// Mirrors `countDone` in `src/js/data.ts`.
pub fn count_done(tasks: &[Task]) -> usize {
    tasks
        .iter()
        .map(|t| {
            (if t.status == TaskStatus::Done { 1 } else { 0 }) + count_done(&t.subtasks)
        })
        .sum()
}

/// Tally of every status across the tree, recursing through subtasks.
/// Mirrors `countByStatus` in `src/js/data.ts`. Returns a fully populated map
/// so callers can index any variant without checking for missing keys.
pub fn count_by_status(tasks: &[Task]) -> HashMap<TaskStatus, usize> {
    let mut counts = HashMap::with_capacity(5);
    counts.insert(TaskStatus::Todo, 0usize);
    counts.insert(TaskStatus::InProgress, 0);
    counts.insert(TaskStatus::PendingReview, 0);
    counts.insert(TaskStatus::Done, 0);
    counts.insert(TaskStatus::Blocked, 0);

    fn walk(tasks: &[Task], counts: &mut HashMap<TaskStatus, usize>) {
        for t in tasks {
            *counts.entry(t.status).or_insert(0) += 1;
            walk(&t.subtasks, counts);
        }
    }
    walk(tasks, &mut counts);
    counts
}

/// Percentage of subtree completion as `Some(0..=100)`. Returns `None` for a
/// leaf task — callers render that as "no progress bar".
/// Mirrors `calcProgress` in `src/js/data.ts`: rounds to nearest integer
/// using TS `Math.round` semantics (half-away-from-zero).
pub fn calc_progress(task: &Task) -> Option<u8> {
    if task.subtasks.is_empty() {
        return None;
    }
    let total = count_all(&task.subtasks) as f64;
    if total == 0.0 {
        return Some(0);
    }
    let done = count_done(&task.subtasks) as f64;
    // Use (x + 0.5).floor() to match JS Math.round for positive numbers,
    // which is what TS `calcProgress` relies on.
    let pct = ((done / total) * 100.0 + 0.5).floor();
    Some(pct.clamp(0.0, 100.0) as u8)
}

/// True if this task AND every descendant is `Done`.
/// Mirrors `isFullyDone` in `src/js/data.ts`.
pub fn is_fully_done(task: &Task) -> bool {
    if task.status != TaskStatus::Done {
        return false;
    }
    task.subtasks.iter().all(is_fully_done)
}

// ─── AUTO-ESCALATE ──────────────────────────────────────────────────────────

/// Wallclock provider injected for testability — production callers pass a
/// closure that returns `chrono::Utc::now().to_rfc3339()` (or whatever the
/// frontend uses for timestamps).
pub type NowFn<'a> = &'a dyn Fn() -> String;

/// Forward + reverse status escalation.
///
/// **Forward:** if every subtask is `Done` and this task is neither `Done`
/// nor `PendingReview`, promote it to `PendingReview` and append an activity
/// log entry naming the previous status.
///
/// **Reverse:** if this task is `PendingReview` but at least one subtask is
/// `Todo`, `InProgress`, or `Blocked`, demote to `InProgress` and log it.
///
/// Mirrors `autoEscalate` in `src/js/data.ts`. Recurses depth-first first so
/// child escalations bubble up before we evaluate the parent — important when
/// a deep subtree just finished.
pub fn auto_escalate(task: &mut Task, now: NowFn<'_>) {
    for sub in task.subtasks.iter_mut() {
        auto_escalate(sub, now);
    }
    if task.subtasks.is_empty() {
        return;
    }

    let all_done = task.subtasks.iter().all(|s| s.status == TaskStatus::Done);
    let has_open = task.subtasks.iter().any(|s| {
        matches!(
            s.status,
            TaskStatus::Todo | TaskStatus::InProgress | TaskStatus::Blocked
        )
    });

    // Forward escalation
    if all_done
        && task.status != TaskStatus::Done
        && task.status != TaskStatus::PendingReview
    {
        let old = task.status;
        task.status = TaskStatus::PendingReview;
        let ts = now();
        task.updated_at = Some(ts.clone());
        let log = task.activity_log.get_or_insert_with(Vec::new);
        log.push(ActivityLog {
            timestamp: ts,
            agent: "System".into(),
            action: format!(
                "auto-escalated from {} to pending_review (all subtasks done)",
                old.as_wire_str()
            ),
        });
    }

    // Reverse escalation — re-read status because forward branch may have
    // updated it (cannot collide because forward sets PendingReview and
    // reverse only fires when status IS PendingReview AND a subtask is open;
    // those preconditions are mutually exclusive on the same call).
    if task.status == TaskStatus::PendingReview && has_open {
        task.status = TaskStatus::InProgress;
        let ts = now();
        task.updated_at = Some(ts.clone());
        let log = task.activity_log.get_or_insert_with(Vec::new);
        log.push(ActivityLog {
            timestamp: ts,
            agent: "System".into(),
            action: "demoted from pending_review to in_progress (subtask reopened)".into(),
        });
    }
}

// ─── NEXT-RUNNABLE ──────────────────────────────────────────────────────────

/// DFS for the path-of-ids leading to the next runnable subtask.
///
/// Returns the path of *id segments* from `task` down to the first descendant
/// that is not `Done`. The starting `task` is NOT included in the returned
/// path — callers prepend their own context if needed (matches the TS
/// `findNextRunnablePath(task, basePath)` API where `basePath` is supplied).
///
/// Returns `None` when every subtask is already done (or there are no
/// subtasks at all). Mirrors `findNextRunnablePath` in `src/js/data.ts`.
pub fn find_next_runnable(task: &Task) -> Option<Vec<String>> {
    for sub in &task.subtasks {
        if sub.status == TaskStatus::Done {
            continue;
        }
        let mut path = vec![sub.id.clone()];
        if let Some(deeper) = find_next_runnable(sub) {
            path.extend(deeper);
        }
        return Some(path);
    }
    None
}
