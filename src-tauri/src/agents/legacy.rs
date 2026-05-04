// ─── AGENTS / LEGACY MAPPING ─────────────────────────────────────────────────
// Owns: backward-compatible mapping from old `aiAgent` string to canonical
// `agentId`. Mirrors `src/js/agents/legacy-mapping.ts` exactly so both
// implementations stay drop-in compatible until the TS file is removed.
//
// Does NOT: define agents or routing — purely a translation table.

/// Translate the legacy free-form `aiAgent` string (e.g. `"Claude"`) to the
/// canonical agent id (`"executor"`). Unknown / null / empty inputs fall
/// through to `"executor"` so the caller never has to handle a missing agent.
pub fn legacy_to_agent_id(ai_agent: Option<&str>) -> &'static str {
    match ai_agent {
        Some("Claude") => "executor",
        Some("ChatGPT") => "executor",
        Some("Copilot") => "quickfix",
        Some("Manual") => "manual",
        _ => "executor",
    }
}
