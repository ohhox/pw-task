// ─── AGENTS / ROUTING ────────────────────────────────────────────────────────
// Owns: choosing which agent + model run a given task.
// Mirrors the TS `resolveAgentId` / `resolveModel` priority order exactly so
// existing tasks resolve to the same agent before and after the Rust port.
//
// Resolution order (matches `src/js/agents/routing.ts`):
//   1. Explicit `task.agent_id`, if it matches a registered agent.
//   2. Legacy `task.ai_agent` field, mapped via `legacy::legacy_to_agent_id`.
//   3. Tag-based routing (case-insensitive):
//        `plan` / `planning`                    → planner
//        `review` / `qa`                        → reviewer
//        `bugfix` / `fix` / `small` / `cleanup` → quickfix
//        `feature` / `refactor` / `implement`   → executor
//   4. Default → executor.

use crate::agents::legacy::legacy_to_agent_id;
use crate::agents::registry::AGENTS;
use crate::domain::{Agent, AgentProvider, Task};
use serde::Serialize;
use specta::Type;

/// Resolved agent + model for a task. Returned by `agent_resolve` over IPC so
/// the frontend only needs one round-trip per task to know which provider /
/// model / system-prompt to invoke.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedAgent {
    pub agent_id: String,
    pub label: String,
    pub provider: AgentProvider,
    pub model: String,
    pub system_prompt: String,
}

/// Pure routing decision. Does not touch the registry beyond looking up
/// which ids exist (the explicit `agent_id` branch needs that to reject
/// dangling references).
pub fn resolve_agent_id(task: &Task) -> String {
    // 1. Explicit assignment, but only if the id actually exists. Falling
    //    through on an unknown id matches the TS behaviour and prevents
    //    a stale `agentId` (e.g. from a deleted custom agent) from
    //    breaking the run.
    if let Some(id) = task.agent_id.as_deref() {
        let agents = AGENTS.read().expect("agents lock poisoned");
        if agents.iter().any(|a| a.id == id) {
            return id.to_string();
        }
    }

    // 2. Legacy free-form field. TS code only consults this when `agentId`
    //    is unset, so we mirror that — even an unknown legacy string falls
    //    through to "executor" via `legacy_to_agent_id`.
    if let Some(legacy) = task.ai_agent.as_deref() {
        if !legacy.is_empty() {
            return legacy_to_agent_id(Some(legacy)).to_string();
        }
    }

    // 3. Tag-based routing. We lowercase once into owned `String`s rather
    //    than per-comparison so multi-tag tasks stay O(N) instead of
    //    O(N * categories).
    let tags: Vec<String> = task.tags.iter().map(|t| t.to_lowercase()).collect();
    let any = |needles: &[&str]| tags.iter().any(|t| needles.contains(&t.as_str()));

    if any(&["plan", "planning"]) {
        return "planner".into();
    }
    if any(&["review", "qa"]) {
        return "reviewer".into();
    }
    if any(&["bugfix", "fix", "small", "cleanup"]) {
        return "quickfix".into();
    }
    if any(&["feature", "refactor", "implement"]) {
        return "executor".into();
    }

    // 4. Hard default. Always exists thanks to `default_agents`.
    "executor".into()
}

/// Choose the model: per-task override → agent default → ultimate fallback.
/// The fallback is `claude-sonnet-4-6` to match the TS code; any change here
/// must also update the TS layer or rely on this Rust value via IPC.
pub fn resolve_model(task: &Task, agent: &Agent) -> String {
    if let Some(m) = task.model.as_deref() {
        if !m.is_empty() {
            return m.to_string();
        }
    }
    if let Some(m) = agent.default_model.as_deref() {
        return m.to_string();
    }
    "claude-sonnet-4-6".into()
}

/// One-shot resolver: produce the full `ResolvedAgent` payload the frontend
/// needs to dispatch a run. Falls back to the executor if the registry is
/// somehow missing the resolved id (defensive — `resolve_agent_id` already
/// guarantees a known id, but a race against `agent_remove` could theoretically
/// leave us holding nothing).
pub fn resolved_for_task(task: &Task) -> ResolvedAgent {
    let agent_id = resolve_agent_id(task);
    let agents = AGENTS.read().expect("agents lock poisoned");
    let agent = agents
        .iter()
        .find(|a| a.id == agent_id)
        .or_else(|| agents.iter().find(|a| a.id == "executor"))
        .cloned()
        .unwrap_or_else(|| {
            // Last-ditch fallback if even "executor" was removed. Build a
            // synthetic entry so callers can still report an error rather
            // than panicking.
            Agent {
                id: "executor".into(),
                label: "Executor".into(),
                provider: AgentProvider::Claude,
                default_model: Some("claude-sonnet-4-6".into()),
                capabilities: vec![],
                enabled: true,
                system_prompt: String::new(),
                allowed_tools: None,
                skip_permissions: None,
                cli_command: None,
                cli_args: None,
            }
        });

    let model = resolve_model(task, &agent);
    ResolvedAgent {
        agent_id: agent.id.clone(),
        label: agent.label,
        provider: agent.provider,
        model,
        system_prompt: agent.system_prompt,
    }
}
