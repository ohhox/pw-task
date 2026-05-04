// ─── AGENTS MODULE ───────────────────────────────────────────────────────────
// Single source of truth for agent definitions, routing, and CRUD.
//
// Phase 1.6.3 moves what used to live in `src/js/agents/{registry,routing,
// legacy-mapping}.ts` into Rust so:
//   * the dashboard and any future server-side runner share one list,
//   * the IPC contract is type-checked end-to-end via `tauri-specta`,
//   * the next phase (06-04 patch system) can call the routing helpers
//     directly without an IPC hop.
//
// Module layout matches the old TS file naming so reviewers can `git blame`
// across the migration cleanly:
//   * `legacy.rs`   ←→ legacy-mapping.ts
//   * `registry.rs` ←→ registry.ts
//   * `routing.rs`  ←→ routing.ts

pub mod legacy;
pub mod registry;
pub mod routing;

pub use legacy::legacy_to_agent_id;
pub use registry::{
    _reset_for_test, agent_add, agent_list, agent_remove, agent_update, default_agents,
    replace_all, AgentPatch, AGENTS, DEFAULT_AGENT_IDS,
};
pub use routing::{resolve_agent_id, resolve_model, resolved_for_task, ResolvedAgent};
