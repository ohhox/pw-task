// Integration tests for `ai_task_flow::agents`.
//
// Phase 1.6.3 ports the routing + registry logic from TS into Rust. Many of
// these cases are direct ports of the old `src/__tests__/agents.test.ts`
// suite, kept under their original names so reviewers can match them up.
//
// The registry is a process-wide `RwLock` singleton, which means tests share
// state. We serialize through a `Mutex` and call `_reset_for_test()` at the
// top of every test that mutates it. Using a `Mutex` (rather than running
// each test in its own process) keeps the suite fast and works regardless
// of `--test-threads`.

use ai_task_flow::agents::{
    _reset_for_test, agent_add, agent_list, agent_remove, agent_update, default_agents,
    legacy_to_agent_id, replace_all, resolve_agent_id, resolve_model, resolved_for_task,
    AgentPatch, ResolvedAgent, DEFAULT_AGENT_IDS,
};
use ai_task_flow::domain::{Agent, AgentProvider, Task, TaskPriority, TaskStatus};
use std::sync::Mutex;

/// Serialize tests that touch the global registry so they don't race.
/// `Lazy<Mutex<()>>` is overkill for this — a `static Mutex::new(())` works
/// in stable Rust 1.63+, and we already require 1.77. We poison-tolerate
/// because a panic in one test must not kill the whole suite.
static REGISTRY_LOCK: Mutex<()> = Mutex::new(());

fn lock_registry() -> std::sync::MutexGuard<'static, ()> {
    REGISTRY_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

// ── Fixtures ────────────────────────────────────────────────────────────────

fn task_fixture() -> Task {
    Task {
        id: "task-1".into(),
        title: "Test task".into(),
        description: String::new(),
        status: TaskStatus::Todo,
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
        created_at: "2026-05-03T00:00:00.000Z".into(),
        updated_at: None,
        completed_at: None,
    }
}

fn agent_fixture(id: &str) -> Agent {
    Agent {
        id: id.into(),
        label: id.into(),
        provider: AgentProvider::Claude,
        default_model: Some("claude-sonnet-4-6".into()),
        capabilities: vec![],
        enabled: true,
        system_prompt: String::new(),
        allowed_tools: None,
        skip_permissions: None,
    }
}

// ── default_agents ──────────────────────────────────────────────────────────

#[test]
fn default_agents_has_five_canonical_entries() {
    let agents = default_agents();
    assert_eq!(agents.len(), 5);
    let ids: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();
    assert_eq!(ids, vec!["planner", "executor", "reviewer", "quickfix", "manual"]);
    // Sanity check the providers + models we expect downstream code to rely on.
    let manual = agents.iter().find(|a| a.id == "manual").unwrap();
    assert_eq!(manual.provider, AgentProvider::Manual);
    assert!(manual.default_model.is_none());
    let planner = agents.iter().find(|a| a.id == "planner").unwrap();
    assert_eq!(planner.default_model.as_deref(), Some("claude-opus-4-7"));
}

#[test]
fn default_agent_ids_constant_matches_default_agents() {
    let agents = default_agents();
    let actual: Vec<&str> = agents.iter().map(|a| a.id.as_str()).collect();
    let mut sorted_const = DEFAULT_AGENT_IDS.to_vec();
    let mut sorted_actual = actual.clone();
    sorted_const.sort();
    sorted_actual.sort();
    assert_eq!(sorted_const, sorted_actual, "DEFAULT_AGENT_IDS drift");
}

// ── resolve_agent_id ────────────────────────────────────────────────────────

#[test]
fn resolve_agent_id_returns_explicit_when_registered() {
    let _g = lock_registry();
    _reset_for_test();
    let mut t = task_fixture();
    t.agent_id = Some("reviewer".into());
    assert_eq!(resolve_agent_id(&t), "reviewer");
}

#[test]
fn resolve_agent_id_falls_through_when_explicit_id_unknown() {
    let _g = lock_registry();
    _reset_for_test();
    let mut t = task_fixture();
    t.agent_id = Some("ghost-agent".into());
    // No legacy/tag hints → should default to executor.
    assert_eq!(resolve_agent_id(&t), "executor");
}

#[test]
fn resolve_agent_id_uses_legacy_ai_agent_when_explicit_absent() {
    let _g = lock_registry();
    _reset_for_test();
    let cases = [
        ("Claude", "executor"),
        ("ChatGPT", "executor"),
        ("Copilot", "quickfix"),
        ("Manual", "manual"),
        ("Unknown", "executor"),
    ];
    for (legacy, expected) in cases {
        let mut t = task_fixture();
        t.ai_agent = Some(legacy.into());
        assert_eq!(resolve_agent_id(&t), expected, "legacy {legacy}");
    }
}

#[test]
fn resolve_agent_id_routes_by_tags_case_insensitive() {
    let _g = lock_registry();
    _reset_for_test();
    let cases = [
        (vec!["plan"], "planner"),
        (vec!["Planning"], "planner"),
        (vec!["review"], "reviewer"),
        (vec!["QA"], "reviewer"),
        (vec!["bugfix"], "quickfix"),
        (vec!["Cleanup"], "quickfix"),
        (vec!["small"], "quickfix"),
        (vec!["fix"], "quickfix"),
        (vec!["refactor"], "executor"),
        (vec!["feature"], "executor"),
        (vec!["IMPLEMENT"], "executor"),
    ];
    for (tags, expected) in cases {
        let mut t = task_fixture();
        t.tags = tags.iter().map(|s| (*s).to_string()).collect();
        assert_eq!(resolve_agent_id(&t), expected, "tags {tags:?}");
    }
}

#[test]
fn resolve_agent_id_defaults_to_executor() {
    let _g = lock_registry();
    _reset_for_test();
    assert_eq!(resolve_agent_id(&task_fixture()), "executor");
    let mut t = task_fixture();
    t.tags = vec!["random-tag".into()];
    assert_eq!(resolve_agent_id(&t), "executor");
}

// ── resolve_model ───────────────────────────────────────────────────────────

#[test]
fn resolve_model_task_override_wins() {
    let _g = lock_registry();
    _reset_for_test();
    let mut t = task_fixture();
    t.model = Some("claude-opus-4-7".into());
    let agent = agent_fixture("executor");
    assert_eq!(resolve_model(&t, &agent), "claude-opus-4-7");
}

#[test]
fn resolve_model_falls_back_to_agent_default() {
    let _g = lock_registry();
    _reset_for_test();
    let t = task_fixture();
    let mut agent = agent_fixture("planner");
    agent.default_model = Some("claude-opus-4-7".into());
    assert_eq!(resolve_model(&t, &agent), "claude-opus-4-7");
}

#[test]
fn resolve_model_ultimate_fallback_is_sonnet() {
    let _g = lock_registry();
    _reset_for_test();
    let t = task_fixture();
    let mut agent = agent_fixture("manual");
    agent.default_model = None;
    assert_eq!(resolve_model(&t, &agent), "claude-sonnet-4-6");
}

// ── resolved_for_task ───────────────────────────────────────────────────────

#[test]
fn resolved_for_task_returns_full_struct() {
    let _g = lock_registry();
    _reset_for_test();
    let mut t = task_fixture();
    t.agent_id = Some("reviewer".into());
    t.model = Some("claude-opus-4-7".into());
    let r: ResolvedAgent = resolved_for_task(&t);
    assert_eq!(r.agent_id, "reviewer");
    assert_eq!(r.label, "Reviewer");
    assert_eq!(r.provider, AgentProvider::Claude);
    assert_eq!(r.model, "claude-opus-4-7");
}

#[test]
fn resolved_for_task_handles_manual_provider() {
    let _g = lock_registry();
    _reset_for_test();
    let mut t = task_fixture();
    t.ai_agent = Some("Manual".into());
    let r = resolved_for_task(&t);
    assert_eq!(r.agent_id, "manual");
    assert_eq!(r.provider, AgentProvider::Manual);
    // manual default_model is None → fallback to sonnet.
    assert_eq!(r.model, "claude-sonnet-4-6");
}

// ── legacy_to_agent_id ──────────────────────────────────────────────────────

#[test]
fn legacy_to_agent_id_known_and_unknown_inputs() {
    assert_eq!(legacy_to_agent_id(Some("Claude")), "executor");
    assert_eq!(legacy_to_agent_id(Some("Copilot")), "quickfix");
    assert_eq!(legacy_to_agent_id(Some("Manual")), "manual");
    assert_eq!(legacy_to_agent_id(Some("ChatGPT")), "executor");
    assert_eq!(legacy_to_agent_id(Some("Mystery")), "executor");
    assert_eq!(legacy_to_agent_id(None), "executor");
    assert_eq!(legacy_to_agent_id(Some("")), "executor");
}

// ── CRUD ────────────────────────────────────────────────────────────────────

#[test]
fn agent_add_appends_to_registry() {
    let _g = lock_registry();
    _reset_for_test();
    let before = agent_list().len();
    agent_add(agent_fixture("extra")).expect("first add succeeds");
    assert_eq!(agent_list().len(), before + 1);
    assert!(agent_list().iter().any(|a| a.id == "extra"));
}

#[test]
fn agent_add_rejects_duplicate_id() {
    let _g = lock_registry();
    _reset_for_test();
    agent_add(agent_fixture("dup")).unwrap();
    let err = agent_add(agent_fixture("dup")).expect_err("duplicate must fail");
    assert!(err.contains("dup"), "error should mention id: {err}");
    // Built-in ids are also duplicates.
    let err = agent_add(agent_fixture("planner")).expect_err("planner already present");
    assert!(err.contains("planner"));
}

#[test]
fn agent_update_mutates_in_place_leaves_others_alone() {
    let _g = lock_registry();
    _reset_for_test();
    agent_add(agent_fixture("extra")).unwrap();

    let patch = AgentPatch {
        label: Some("Renamed".into()),
        enabled: Some(false),
        ..Default::default()
    };
    let matched = agent_update("extra", patch).unwrap();
    assert!(matched);

    let agents = agent_list();
    let extra = agents.iter().find(|a| a.id == "extra").unwrap();
    assert_eq!(extra.label, "Renamed");
    assert!(!extra.enabled);
    let planner = agents.iter().find(|a| a.id == "planner").unwrap();
    assert_eq!(planner.label, "Planner");
    assert!(planner.enabled);
}

#[test]
fn agent_update_unknown_id_is_noop() {
    let _g = lock_registry();
    _reset_for_test();
    let snapshot = agent_list();
    let matched = agent_update(
        "nope",
        AgentPatch {
            label: Some("X".into()),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(!matched);
    assert_eq!(agent_list(), snapshot);
}

#[test]
fn agent_update_clears_default_model_via_double_option() {
    let _g = lock_registry();
    _reset_for_test();
    // planner has a non-null default_model; clearing it requires Some(None).
    agent_update(
        "planner",
        AgentPatch {
            default_model: Some(None),
            ..Default::default()
        },
    )
    .unwrap();
    let planner = agent_list().into_iter().find(|a| a.id == "planner").unwrap();
    assert!(planner.default_model.is_none());
}

#[test]
fn agent_remove_deletes_by_id_and_missing_is_noop() {
    let _g = lock_registry();
    _reset_for_test();
    agent_add(agent_fixture("extra")).unwrap();
    assert!(agent_list().iter().any(|a| a.id == "extra"));
    agent_remove("extra").unwrap();
    assert!(!agent_list().iter().any(|a| a.id == "extra"));

    let before = agent_list().len();
    agent_remove("does-not-exist").unwrap();
    assert_eq!(agent_list().len(), before);
}

// ── replace_all ─────────────────────────────────────────────────────────────

#[test]
fn replace_all_swaps_in_saved_list() {
    let _g = lock_registry();
    _reset_for_test();
    let saved = vec![agent_fixture("a1"), agent_fixture("a2")];
    replace_all(Some(saved));
    let after = agent_list();
    assert_eq!(after.len(), 2);
    assert_eq!(after[0].id, "a1");
    assert_eq!(after[1].id, "a2");
}

#[test]
fn replace_all_falls_back_to_defaults_for_empty_or_none() {
    let _g = lock_registry();
    _reset_for_test();
    // Mutate first so we can detect the fallback.
    agent_add(agent_fixture("extra")).unwrap();

    replace_all(None);
    assert_eq!(agent_list().len(), 5);
    assert!(!agent_list().iter().any(|a| a.id == "extra"));

    agent_add(agent_fixture("extra")).unwrap();
    replace_all(Some(vec![]));
    assert_eq!(agent_list().len(), 5);
}

// ── thread safety ───────────────────────────────────────────────────────────

#[test]
fn registry_survives_concurrent_crud() {
    let _g = lock_registry();
    _reset_for_test();

    // Spawn four worker threads doing a mix of add / update / remove against
    // disjoint id spaces. The test is satisfied if none of them panics and
    // the final state is internally consistent.
    let handles: Vec<_> = (0..4)
        .map(|worker| {
            std::thread::spawn(move || {
                for i in 0..25 {
                    let id = format!("w{worker}-a{i}");
                    let _ = agent_add(agent_fixture(&id));
                    let _ = agent_update(
                        &id,
                        AgentPatch {
                            label: Some(format!("Renamed {id}")),
                            ..Default::default()
                        },
                    );
                    if i % 3 == 0 {
                        let _ = agent_remove(&id);
                    }
                }
            })
        })
        .collect();

    for h in handles {
        h.join().expect("worker thread panicked");
    }

    let final_list = agent_list();
    // Built-ins must still be present (we never removed them).
    for id in DEFAULT_AGENT_IDS {
        assert!(
            final_list.iter().any(|a| a.id == *id),
            "built-in {id} disappeared"
        );
    }
    // No id should appear twice — the add path enforces uniqueness even
    // under contention.
    let mut ids: Vec<_> = final_list.iter().map(|a| a.id.clone()).collect();
    ids.sort();
    let mut deduped = ids.clone();
    deduped.dedup();
    assert_eq!(ids, deduped, "duplicate ids leaked under contention");
}
