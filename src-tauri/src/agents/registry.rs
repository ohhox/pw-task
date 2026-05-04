// ─── AGENTS / REGISTRY ───────────────────────────────────────────────────────
// Owns: the canonical, in-process registry of `Agent` definitions.
// Mirrors the previous TS implementation in `src/js/agents/registry.ts` so
// the IPC commands return identical data to what the dashboard used to
// compute locally.
//
// The registry is a `RwLock<Vec<Agent>>` rather than a hash map because the
// list is short (typically ≤ 8 entries) and the dashboard renders the agents
// in insertion order — preserving order keeps `getAllAgents()` stable across
// IPC boundary so render output doesn't reshuffle on every reload.
//
// Persistence: the registry is rebuilt from `Database.agents` at app start
// by `loadAgentsFromDb` on the TS side. Rust does not own disk persistence
// directly — it just keeps the runtime list and exposes CRUD over IPC.

use crate::domain::{Agent, AgentProvider};
use once_cell::sync::Lazy;
use serde::Deserialize;
use specta::Type;
use std::sync::RwLock;

/// Built-in default agents. Returned on first access and after
/// `_reset_for_test`. Order matches the legacy TS `DEFAULT_AGENTS` array
/// so any UI code that iterates the registry shows the same row order it
/// did before the Rust port.
pub fn default_agents() -> Vec<Agent> {
    vec![
        Agent {
            id: "planner".into(),
            label: "Planner".into(),
            provider: AgentProvider::Claude,
            default_model: Some("claude-opus-4-7".into()),
            capabilities: vec!["plan_project".into(), "breakdown_tasks".into()],
            enabled: true,
            system_prompt: String::new(),
            allowed_tools: None,
            skip_permissions: None,
        },
        Agent {
            id: "executor".into(),
            label: "Executor".into(),
            provider: AgentProvider::Claude,
            default_model: Some("claude-sonnet-4-6".into()),
            capabilities: vec!["implement".into(), "refactor".into(), "bugfix".into()],
            enabled: true,
            system_prompt: String::new(),
            allowed_tools: None,
            skip_permissions: None,
        },
        Agent {
            id: "reviewer".into(),
            label: "Reviewer".into(),
            provider: AgentProvider::Claude,
            default_model: Some("claude-sonnet-4-6".into()),
            capabilities: vec![
                "review".into(),
                "risk_check".into(),
                "regression_check".into(),
            ],
            enabled: true,
            system_prompt: String::new(),
            allowed_tools: None,
            skip_permissions: None,
        },
        Agent {
            id: "quickfix".into(),
            label: "Quick Fix".into(),
            provider: AgentProvider::Claude,
            default_model: Some("claude-haiku-4-5-20251001".into()),
            capabilities: vec!["small_edit".into(), "cleanup".into()],
            enabled: true,
            system_prompt: String::new(),
            allowed_tools: None,
            skip_permissions: None,
        },
        Agent {
            id: "manual".into(),
            label: "Manual".into(),
            provider: AgentProvider::Manual,
            default_model: None,
            capabilities: vec![],
            enabled: true,
            system_prompt: String::new(),
            allowed_tools: None,
            skip_permissions: None,
        },
    ]
}

/// Set of agent ids the dashboard treats as "built-in" — used to disable the
/// delete button and lock the provider field. Kept here so the rule lives next
/// to the agents themselves.
pub const DEFAULT_AGENT_IDS: &[&str] = &["planner", "executor", "reviewer", "quickfix", "manual"];

/// Process-wide registry. Wrapped in a `RwLock` because reads (every render
/// frame asking `agentList`) vastly outnumber writes (occasional CRUD from
/// the Agent Manager modal). `Lazy` defers the heap allocation until the
/// first access, which keeps test startup cheap.
pub static AGENTS: Lazy<RwLock<Vec<Agent>>> = Lazy::new(|| RwLock::new(default_agents()));

/// Sparse update payload for `agent_update`. Every field is optional so the
/// caller can patch a single attribute without echoing the rest. Matches the
/// `Partial<Agent>` shape the TS `agentUpdate` historically accepted.
///
/// `default_model` is `Option<Option<String>>` so the frontend can distinguish
/// "leave unchanged" (`undefined`/missing) from "clear it" (`null`). Same
/// convention for `system_prompt` would be wrong because the TS code treats
/// `""` as the cleared state.
#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<AgentProvider>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub allowed_tools: Option<Option<Vec<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skip_permissions: Option<Option<bool>>,
}

// ─── CRUD helpers ────────────────────────────────────────────────────────────

/// Snapshot the full agent list. Cheap clone — the registry is small and the
/// IPC layer needs an owned `Vec` for serialization anyway.
pub fn agent_list() -> Vec<Agent> {
    AGENTS.read().expect("agents lock poisoned").clone()
}

/// Append a new agent. Rejects duplicate ids so the UI gets a clear error
/// instead of silently shadowing an existing entry on reload.
pub fn agent_add(agent: Agent) -> Result<(), String> {
    let mut agents = AGENTS.write().expect("agents lock poisoned");
    if agents.iter().any(|a| a.id == agent.id) {
        return Err(format!("Agent id '{}' already exists", agent.id));
    }
    agents.push(agent);
    Ok(())
}

/// Mutate the agent matching `id` in place. Missing id is a no-op (matches
/// the TS `agentUpdate` semantics so existing call-sites that don't check
/// the result keep working). Returns `Ok(false)` when nothing was matched
/// so callers that *do* care can branch on it.
pub fn agent_update(id: &str, patch: AgentPatch) -> Result<bool, String> {
    let mut agents = AGENTS.write().expect("agents lock poisoned");
    let Some(agent) = agents.iter_mut().find(|a| a.id == id) else {
        return Ok(false);
    };
    if let Some(label) = patch.label {
        agent.label = label;
    }
    if let Some(provider) = patch.provider {
        agent.provider = provider;
    }
    if let Some(dm) = patch.default_model {
        agent.default_model = dm;
    }
    if let Some(sp) = patch.system_prompt {
        agent.system_prompt = sp;
    }
    if let Some(caps) = patch.capabilities {
        agent.capabilities = caps;
    }
    if let Some(enabled) = patch.enabled {
        agent.enabled = enabled;
    }
    if let Some(at) = patch.allowed_tools {
        agent.allowed_tools = at;
    }
    if let Some(sp) = patch.skip_permissions {
        agent.skip_permissions = sp;
    }
    Ok(true)
}

/// Remove an agent by id. Missing id is a no-op (matches TS).
pub fn agent_remove(id: &str) -> Result<(), String> {
    let mut agents = AGENTS.write().expect("agents lock poisoned");
    agents.retain(|a| a.id != id);
    Ok(())
}

/// Replace the entire registry. Used by `loadAgentsFromDb` on the TS side
/// when the database file holds a saved snapshot. Empty / null lists fall
/// back to the built-in defaults so a corrupt DB never leaves the user with
/// zero agents.
pub fn replace_all(saved: Option<Vec<Agent>>) {
    let mut agents = AGENTS.write().expect("agents lock poisoned");
    match saved {
        Some(list) if !list.is_empty() => {
            *agents = list;
        }
        _ => {
            *agents = default_agents();
        }
    }
}

/// Test-only: reset the registry to its built-in defaults so tests don't
/// leak state between cases. Not gated behind `#[cfg(test)]` because
/// integration tests in `tests/` compile as a separate crate where that
/// cfg doesn't apply; the leading underscore in the name marks it as
/// internal so production callers know to leave it alone.
pub fn _reset_for_test() {
    *AGENTS.write().expect("agents lock poisoned") = default_agents();
}
