// Integration tests for `ai_task_flow::domain` + `ai_task_flow::tree`.
//
// We treat these like a public-API contract: every helper in `tree.rs` gets
// at least one test, and the `Task` round-trip test loads the real
// `outputs/tasks.json` to make sure we don't drift from the on-disk shape
// the JS dashboard writes.

use ai_task_flow::domain::{Database, Project, Task, TaskPriority, TaskStatus};
use ai_task_flow::tree::{
    auto_escalate, calc_progress, count_all, count_by_status, count_done,
    find_next_runnable, find_task, find_task_by_path, find_task_mut, is_fully_done,
};
use std::path::PathBuf;

// ── helpers ─────────────────────────────────────────────────────────────────

/// Cheap factory for a leaf task with sensible defaults. Tests override only
/// the fields they care about so the assertions stay focused.
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

/// Deterministic `now()` for auto_escalate tests so the activity-log
/// timestamp is predictable.
fn fixed_now() -> String {
    "2026-05-03T12:00:00.000Z".into()
}

// ── find_task ──────────────────────────────────────────────────────────────

#[test]
fn find_task_flat_list() {
    let tasks = vec![
        task("a", TaskStatus::Todo),
        task("b", TaskStatus::Done),
    ];
    assert_eq!(find_task(&tasks, "a").map(|t| &t.id[..]), Some("a"));
    assert_eq!(find_task(&tasks, "b").map(|t| &t.id[..]), Some("b"));
}

#[test]
fn find_task_nested_three_deep() {
    let g = task("g1", TaskStatus::Todo);
    let c = with_subs(task("c1", TaskStatus::Todo), vec![g]);
    let r = with_subs(task("r1", TaskStatus::Todo), vec![c]);
    let tasks = vec![r];
    assert!(find_task(&tasks, "g1").is_some());
    assert!(find_task(&tasks, "c1").is_some());
    assert!(find_task(&tasks, "r1").is_some());
}

#[test]
fn find_task_missing_returns_none() {
    let tasks = vec![task("a", TaskStatus::Todo)];
    assert!(find_task(&tasks, "ghost").is_none());
}

#[test]
fn find_task_mut_allows_in_place_update() {
    let mut tasks = vec![with_subs(
        task("r", TaskStatus::Todo),
        vec![task("c", TaskStatus::Todo)],
    )];
    {
        let hit = find_task_mut(&mut tasks, "c").unwrap();
        hit.status = TaskStatus::Done;
    }
    let again = find_task(&tasks, "c").unwrap();
    assert_eq!(again.status, TaskStatus::Done);
}

// ── find_task_by_path ──────────────────────────────────────────────────────

#[test]
fn find_task_by_path_walks_three_levels() {
    let g = task("g", TaskStatus::Done);
    let c = with_subs(task("c", TaskStatus::InProgress), vec![g]);
    let r = with_subs(task("r", TaskStatus::Todo), vec![c]);
    let tasks = vec![r];

    let p1: Vec<String> = vec!["r".into()];
    let p2: Vec<String> = vec!["r".into(), "c".into()];
    let p3: Vec<String> = vec!["r".into(), "c".into(), "g".into()];

    assert_eq!(find_task_by_path(&tasks, &p1).map(|t| &t.id[..]), Some("r"));
    assert_eq!(find_task_by_path(&tasks, &p2).map(|t| &t.id[..]), Some("c"));
    assert_eq!(find_task_by_path(&tasks, &p3).map(|t| &t.id[..]), Some("g"));
}

#[test]
fn find_task_by_path_returns_none_for_broken_path() {
    let r = with_subs(task("r", TaskStatus::Todo), vec![task("c", TaskStatus::Todo)]);
    let tasks = vec![r];
    let bad: Vec<String> = vec!["r".into(), "nope".into()];
    assert!(find_task_by_path(&tasks, &bad).is_none());
}

#[test]
fn find_task_by_path_empty_path_is_none() {
    let tasks = vec![task("a", TaskStatus::Todo)];
    let empty: Vec<String> = vec![];
    assert!(find_task_by_path(&tasks, &empty).is_none());
}

// ── count_by_status / count_all / count_done ──────────────────────────────

#[test]
fn count_by_status_empty_tree_is_all_zero() {
    let counts = count_by_status(&[]);
    assert_eq!(counts[&TaskStatus::Todo], 0);
    assert_eq!(counts[&TaskStatus::InProgress], 0);
    assert_eq!(counts[&TaskStatus::PendingReview], 0);
    assert_eq!(counts[&TaskStatus::Done], 0);
    assert_eq!(counts[&TaskStatus::Blocked], 0);
}

#[test]
fn count_by_status_tallies_recursively() {
    let tree = vec![
        with_subs(
            task("a", TaskStatus::Todo),
            vec![
                task("a1", TaskStatus::Done),
                task("a2", TaskStatus::InProgress),
            ],
        ),
        task("b", TaskStatus::Blocked),
    ];
    let counts = count_by_status(&tree);
    assert_eq!(counts[&TaskStatus::Todo], 1);
    assert_eq!(counts[&TaskStatus::Done], 1);
    assert_eq!(counts[&TaskStatus::InProgress], 1);
    assert_eq!(counts[&TaskStatus::Blocked], 1);
    assert_eq!(counts[&TaskStatus::PendingReview], 0);
}

#[test]
fn count_all_and_count_done_walk_full_tree() {
    let tree = vec![with_subs(
        task("r", TaskStatus::Done),
        vec![
            task("c1", TaskStatus::Done),
            task("c2", TaskStatus::Todo),
        ],
    )];
    assert_eq!(count_all(&tree), 3);
    assert_eq!(count_done(&tree), 2);
}

// ── calc_progress ─────────────────────────────────────────────────────────

#[test]
fn calc_progress_leaf_returns_none() {
    let t = task("leaf", TaskStatus::Todo);
    assert_eq!(calc_progress(&t), None);
}

#[test]
fn calc_progress_no_subtasks_done_is_zero() {
    let t = with_subs(
        task("p", TaskStatus::Todo),
        vec![task("a", TaskStatus::Todo), task("b", TaskStatus::Todo)],
    );
    assert_eq!(calc_progress(&t), Some(0));
}

#[test]
fn calc_progress_partial_completion_is_50() {
    let t = with_subs(
        task("p", TaskStatus::Todo),
        vec![task("a", TaskStatus::Done), task("b", TaskStatus::Todo)],
    );
    assert_eq!(calc_progress(&t), Some(50));
}

#[test]
fn calc_progress_all_done_recursive_is_100() {
    let inner_done = with_subs(task("a", TaskStatus::Done), vec![task("a1", TaskStatus::Done)]);
    let t = with_subs(
        task("p", TaskStatus::Done),
        vec![inner_done, task("b", TaskStatus::Done)],
    );
    assert_eq!(calc_progress(&t), Some(100));
}

#[test]
fn calc_progress_rounds_to_nearest_integer() {
    // 1 of 3 done → 33.33 → rounds to 33 (Math.round in TS).
    let t = with_subs(
        task("p", TaskStatus::Todo),
        vec![
            task("a", TaskStatus::Done),
            task("b", TaskStatus::Todo),
            task("c", TaskStatus::Todo),
        ],
    );
    assert_eq!(calc_progress(&t), Some(33));

    // 2 of 3 done → 66.66 → 67
    let t2 = with_subs(
        task("p", TaskStatus::Todo),
        vec![
            task("a", TaskStatus::Done),
            task("b", TaskStatus::Done),
            task("c", TaskStatus::Todo),
        ],
    );
    assert_eq!(calc_progress(&t2), Some(67));
}

// ── is_fully_done ─────────────────────────────────────────────────────────

#[test]
fn is_fully_done_leaf_done() {
    let t = task("leaf", TaskStatus::Done);
    assert!(is_fully_done(&t));
}

#[test]
fn is_fully_done_leaf_not_done() {
    let t = task("leaf", TaskStatus::InProgress);
    assert!(!is_fully_done(&t));
}

#[test]
fn is_fully_done_parent_done_with_open_descendant_is_false() {
    let g = task("g", TaskStatus::Todo);
    let c = with_subs(task("c", TaskStatus::Done), vec![g]);
    let r = with_subs(task("r", TaskStatus::Done), vec![c]);
    assert!(!is_fully_done(&r));
}

#[test]
fn is_fully_done_full_subtree_done_is_true() {
    let g = task("g", TaskStatus::Done);
    let c = with_subs(task("c", TaskStatus::Done), vec![g]);
    let r = with_subs(task("r", TaskStatus::Done), vec![c]);
    assert!(is_fully_done(&r));
}

// ── auto_escalate ─────────────────────────────────────────────────────────

#[test]
fn auto_escalate_forward_when_all_subtasks_done() {
    let mut t = with_subs(
        task("p", TaskStatus::InProgress),
        vec![task("a", TaskStatus::Done), task("b", TaskStatus::Done)],
    );
    auto_escalate(&mut t, &fixed_now);
    assert_eq!(t.status, TaskStatus::PendingReview);
    let log = t.activity_log.as_ref().expect("log should be created");
    assert!(log.iter().any(|l| l.action.contains("auto-escalated")));
    assert_eq!(t.updated_at.as_deref(), Some("2026-05-03T12:00:00.000Z"));
}

#[test]
fn auto_escalate_does_not_touch_done_parent() {
    let mut t = with_subs(
        task("p", TaskStatus::Done),
        vec![task("a", TaskStatus::Done)],
    );
    auto_escalate(&mut t, &fixed_now);
    assert_eq!(t.status, TaskStatus::Done);
    // No activity entry should have been added.
    assert!(t.activity_log.as_ref().map_or(true, |l| l.is_empty()));
}

#[test]
fn auto_escalate_reverse_when_subtask_reopened() {
    let mut t = with_subs(
        task("p", TaskStatus::PendingReview),
        vec![
            task("a", TaskStatus::Done),
            task("b", TaskStatus::InProgress),
        ],
    );
    auto_escalate(&mut t, &fixed_now);
    assert_eq!(t.status, TaskStatus::InProgress);
    let log = t.activity_log.as_ref().expect("log should be created");
    assert!(log.iter().any(|l| l.action.contains("demoted")));
}

#[test]
fn auto_escalate_leaf_no_op() {
    let mut t = task("leaf", TaskStatus::Todo);
    auto_escalate(&mut t, &fixed_now);
    assert_eq!(t.status, TaskStatus::Todo);
    assert!(t.activity_log.is_none());
}

#[test]
fn auto_escalate_recurses_into_subtasks_first() {
    // grandchildren all done → child should escalate to pending_review,
    // but parent itself stays in_progress because child is now PendingReview
    // (not Done) so the "all done" check fails at the parent level.
    let g1 = task("g1", TaskStatus::Done);
    let g2 = task("g2", TaskStatus::Done);
    let c = with_subs(task("c", TaskStatus::InProgress), vec![g1, g2]);
    let mut p = with_subs(task("p", TaskStatus::InProgress), vec![c]);
    auto_escalate(&mut p, &fixed_now);
    let updated_child = &p.subtasks[0];
    assert_eq!(updated_child.status, TaskStatus::PendingReview);
    assert_eq!(p.status, TaskStatus::InProgress);
}

// ── find_next_runnable ────────────────────────────────────────────────────

#[test]
fn find_next_runnable_none_when_no_subtasks() {
    let t = task("r", TaskStatus::Todo);
    assert!(find_next_runnable(&t).is_none());
}

#[test]
fn find_next_runnable_skips_done_and_returns_first_open_path() {
    let b1 = task("b1", TaskStatus::Todo);
    let b = with_subs(task("b", TaskStatus::InProgress), vec![b1]);
    let r = with_subs(
        task("r", TaskStatus::Todo),
        vec![task("a", TaskStatus::Done), b],
    );
    // Returned path is relative to `r` (excludes `r` itself), mirroring the
    // TS contract where the caller passes the basePath separately.
    let path = find_next_runnable(&r).expect("should find something open");
    assert_eq!(path, vec!["b".to_string(), "b1".to_string()]);
}

#[test]
fn find_next_runnable_all_done_returns_none() {
    let r = with_subs(
        task("r", TaskStatus::Done),
        vec![task("a", TaskStatus::Done), task("b", TaskStatus::Done)],
    );
    assert!(find_next_runnable(&r).is_none());
}

// ── round-trip: real tasks.json ───────────────────────────────────────────

fn real_tasks_json() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("outputs")
        .join("tasks.json")
}

#[test]
fn round_trip_real_tasks_json_preserves_shape() {
    // Skip if the file isn't there (e.g. CI without checked-in fixtures).
    let path = real_tasks_json();
    if !path.exists() {
        eprintln!(
            "tasks.json not present at {}, skipping round-trip test",
            path.display()
        );
        return;
    }

    let raw = std::fs::read_to_string(&path).expect("tasks.json readable");

    // Parse twice: once into our typed `Database`, once into untyped JSON.
    let typed: Database =
        serde_json::from_str(&raw).expect("typed deserialize from real tasks.json");
    let original: serde_json::Value =
        serde_json::from_str(&raw).expect("untyped parse for diff");

    // Re-serialize the typed view and parse back into untyped JSON. Comparing
    // at the JSON-value layer (not raw text) skips key-order / whitespace
    // false positives while still catching dropped keys, type changes, etc.
    let reserialized =
        serde_json::to_string(&typed).expect("typed serialize back to JSON");
    let after: serde_json::Value =
        serde_json::from_str(&reserialized).expect("untyped parse of reserialized");

    // Compare top-level keys present on both sides — every original key must
    // still be present after the round-trip.
    let original_keys: std::collections::BTreeSet<_> =
        original.as_object().unwrap().keys().cloned().collect();
    let after_keys: std::collections::BTreeSet<_> =
        after.as_object().unwrap().keys().cloned().collect();
    let missing: Vec<_> = original_keys.difference(&after_keys).collect();
    assert!(
        missing.is_empty(),
        "round-trip dropped top-level keys: {:?}",
        missing
    );

    // _instructions must round-trip byte-equal because we store it as opaque
    // JSON value — losing this would mean the AI patch metadata is gone.
    assert_eq!(
        original.get("_instructions"),
        after.get("_instructions"),
        "_instructions must round-trip unchanged"
    );

    // Every project should still have the same list of task ids at the root.
    if let (Some(orig_projects), Some(after_projects)) =
        (original.get("projects"), after.get("projects"))
    {
        let orig_ids: Vec<&str> = orig_projects
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.get("id").and_then(|v| v.as_str()).unwrap_or(""))
            .collect();
        let after_ids: Vec<&str> = after_projects
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p.get("id").and_then(|v| v.as_str()).unwrap_or(""))
            .collect();
        assert_eq!(orig_ids, after_ids, "project id list must round-trip");
    }
}

#[test]
fn database_with_minimal_fields_deserializes() {
    // A bare-bones db (no agents / no _instructions / no appliedPatches /
    // no version) must still load cleanly — older tasks.json files
    // sometimes omit these.
    let json = r#"{
        "lastUpdated": "2026-01-01T00:00:00.000Z",
        "projects": []
    }"#;
    let db: Database = serde_json::from_str(json).expect("minimal db parses");
    assert!(db.projects.is_empty());
    assert!(db.agents.is_none());
    assert!(db.instructions.is_none());
}

#[test]
fn task_with_legacy_fields_deserializes() {
    // Tests that legacy `aiAgent` field and missing `runHistory`/`reviews`
    // both work.
    let json = r#"{
        "id": "task-1",
        "title": "legacy",
        "description": "",
        "status": "in_progress",
        "priority": "high",
        "aiAgent": "Claude",
        "tags": ["legacy"],
        "subtasks": [],
        "filesModified": [],
        "createdAt": "2026-01-01T00:00:00.000Z"
    }"#;
    let t: Task = serde_json::from_str(json).expect("legacy task parses");
    assert_eq!(t.id, "task-1");
    assert_eq!(t.ai_agent.as_deref(), Some("Claude"));
    assert_eq!(t.priority, TaskPriority::High);
    assert_eq!(t.status, TaskStatus::InProgress);
    assert!(t.run_history.is_none());
    assert!(t.reviews.is_none());
}

#[test]
fn project_with_nested_tasks_round_trips() {
    let inner = task("inner", TaskStatus::Done);
    let outer = with_subs(task("outer", TaskStatus::InProgress), vec![inner]);
    let proj = Project {
        id: "p1".into(),
        name: "P1".into(),
        description: Some("desc".into()),
        goal: Some("ship it".into()),
        working_dir: Some("D:\\DEV\\PwTask".into()),
        run_command: None,
        color: "#60a5fa".into(),
        created_at: "2026-01-01T00:00:00.000Z".into(),
        tasks: vec![outer],
        agent_defaults: None,
    };
    let s = serde_json::to_string(&proj).expect("serialize project");
    // Verify we emit camelCase, not snake_case, on the wire.
    assert!(s.contains("\"workingDir\""), "wire format must use camelCase");
    assert!(s.contains("\"createdAt\""), "wire format must use camelCase");
    let back: Project = serde_json::from_str(&s).expect("deserialize project");
    assert_eq!(back.tasks[0].subtasks[0].id, "inner");
}
