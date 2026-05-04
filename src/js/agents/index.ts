// ─── AGENTS / FACADE ─────────────────────────────────────────────────────────
// Phase 1.6.3 moved the canonical agent registry + routing logic into Rust
// (`src-tauri/src/agents/*`). This module is the thin TypeScript layer that
// keeps a synchronous in-process cache of `commands.agentList()` so render
// helpers (renderTaskList, renderDetail, renderSidebar) can read agent
// metadata without an `await` per frame.
//
// Read paths   → sync getters against the cache.
// Write paths  → async wrappers around `commands.*`; on success, the cache
//                is updated in place so subsequent renders see the change
//                without a second IPC round-trip.
// Routing/dispatch → execution-service.ts uses `commands.agentResolve(task)`,
//                    NOT the cache, so the Rust side stays the source of
//                    truth for which agent + model actually runs.
//
// The legacy aiAgent translation table and the synchronous `resolveAgentId`
// helper live here too — they're tiny, pure, and required for sync render
// paths (e.g. picking the default option in an Agent <select>). The Rust
// implementation in `agents/legacy.rs` and `agents/routing.rs` is
// authoritative; this TS copy must stay byte-for-byte aligned with it.

import { commands } from '../../bindings.js';
import type { Agent, AgentProvider, Task } from '../../types/domain';

// ─── DEFAULTS ────────────────────────────────────────────────────────────────
// Mirror of `src-tauri/src/agents/registry.rs::default_agents()`. Used as the
// initial cache value before the first IPC load completes, and as the fallback
// when loadAgentsFromDb is called with empty/null data.

const DEFAULT_AGENTS: Agent[] = [
  {
    id: 'planner',
    label: 'Planner',
    provider: 'claude',
    defaultModel: 'claude-opus-4-7',
    capabilities: ['plan_project', 'breakdown_tasks'],
    enabled: true,
    systemPrompt: '',
  },
  {
    id: 'executor',
    label: 'Executor',
    provider: 'claude',
    defaultModel: 'claude-sonnet-4-6',
    capabilities: ['implement', 'refactor', 'bugfix'],
    enabled: true,
    systemPrompt: '',
  },
  {
    id: 'reviewer',
    label: 'Reviewer',
    provider: 'claude',
    defaultModel: 'claude-sonnet-4-6',
    capabilities: ['review', 'risk_check', 'regression_check'],
    enabled: true,
    systemPrompt: '',
  },
  {
    id: 'quickfix',
    label: 'Quick Fix',
    provider: 'claude',
    defaultModel: 'claude-haiku-4-5-20251001',
    capabilities: ['small_edit', 'cleanup'],
    enabled: true,
    systemPrompt: '',
  },
  {
    id: 'gemini',
    label: 'Gemini (OMX)',
    provider: 'cli',
    defaultModel: 'gemini',
    capabilities: ['plan_project', 'implement', 'review'],
    enabled: true,
    systemPrompt: '',
    cliCommand: 'omx',
    cliArgs: ['gemini', '{prompt}'],
  },
  {
    id: 'manual',
    label: 'Manual',
    provider: 'manual',
    defaultModel: null,
    capabilities: [],
    enabled: true,
    systemPrompt: '',
  },
];

export const DEFAULT_AGENT_IDS: ReadonlySet<string> = new Set(
  DEFAULT_AGENTS.map((a) => a.id)
);

// ─── LEGACY MAPPING ──────────────────────────────────────────────────────────
// Mirror of `src-tauri/src/agents/legacy.rs::legacy_to_agent_id`. Tiny pure
// table — exposed sync because every render iteration that builds an Agent
// <select> needs to translate a stale `aiAgent` string into a current id.

const LEGACY_AGENT_MAP: Record<string, string> = {
  Claude: 'executor',
  ChatGPT: 'executor',
  Copilot: 'quickfix',
  Manual: 'manual',
};

export function legacyToAgentId(aiAgent: string | null | undefined): string {
  return (aiAgent && LEGACY_AGENT_MAP[aiAgent]) || 'executor';
}

// ─── CACHE ───────────────────────────────────────────────────────────────────
// The cache is the only mutable state in this module. All write helpers must
// keep it in sync with the Rust registry; tests rely on `_resetAgentsForTest`
// to start clean between cases.

let _cache: Agent[] = DEFAULT_AGENTS.map((a) => ({ ...a }));

/** Test-only: restore the cache to its built-in defaults. */
export function _resetAgentsForTest(): void {
  _cache = DEFAULT_AGENTS.map((a) => ({ ...a }));
}

/**
 * Replace the cache from a saved DB snapshot. Empty / null falls back to
 * defaults. Also pushes the same list to the Rust registry so server-side
 * routing decisions agree with what the dashboard renders.
 *
 * Fire-and-forget on the IPC side — if the Rust call fails we still want
 * the dashboard to show the cached agents rather than throw mid-load.
 */
export function loadAgentsFromDb(savedAgents: Agent[] | undefined | null): void {
  if (!Array.isArray(savedAgents) || !savedAgents.length) {
    _cache = DEFAULT_AGENTS.map((a) => ({ ...a }));
  } else {
    _cache = savedAgents.map((a) => ({ ...a, systemPrompt: a.systemPrompt ?? '' }));
    for (const defaultAgent of DEFAULT_AGENTS) {
      if (!_cache.some((a) => a.id === defaultAgent.id)) {
        _cache.push({ ...defaultAgent });
      }
    }
  }
  // Mirror to Rust without blocking the loader. `void` to silence
  // floating-promise lint complaints.
  void commands.agentReplaceAll(_cache).catch(() => {
    /* dashboard recovers on next CRUD; nothing actionable here */
  });
}

export function getAgentsForSave(): Agent[] {
  return _cache;
}

// ─── SYNC LOOKUPS ────────────────────────────────────────────────────────────

/** Lookup helper. Falls back to `executor` then to the first cached entry so
 *  callers never need to handle `undefined`. */
export function getAgent(agentId: string | null | undefined): Agent {
  return (
    _cache.find((a) => a.id === agentId) ||
    _cache.find((a) => a.id === 'executor') ||
    _cache[0]
  );
}

export function getAllAgents(): Agent[] {
  return _cache;
}

export function getEnabledAgents(): Agent[] {
  return _cache.filter((a) => a.enabled);
}

export function getTaskAgentLabel(task: Pick<Task, 'agentId' | 'aiAgent'>): string {
  if (task.agentId) {
    const a = _cache.find((x) => x.id === task.agentId);
    if (a) return a.label;
  }
  return task.aiAgent || '—';
}

// ─── ROUTING (sync mirror of Rust `resolve_agent_id`) ────────────────────────
// The async `commands.agentResolve(task)` is preferred for dispatch (see
// execution-service.ts). This sync version exists for render code paths that
// need to ask "is this task manual?" or "which agent should be pre-selected
// in a <select>?" without going async.
//
// IMPORTANT: keep this in lockstep with `src-tauri/src/agents/routing.rs`.
// Any tag/legacy change must land in both places — the Rust suite has
// integration tests that lock down the contract.

export function resolveAgentId(task: Task): string {
  if (task.agentId && _cache.some((a) => a.id === task.agentId)) return task.agentId;
  if (task.aiAgent) return legacyToAgentId(task.aiAgent);
  const tags = (task.tags || []).map((t) => t.toLowerCase());
  if (tags.some((t) => ['plan', 'planning'].includes(t))) return 'planner';
  if (tags.some((t) => ['review', 'qa'].includes(t))) return 'reviewer';
  if (tags.some((t) => ['bugfix', 'fix', 'small', 'cleanup'].includes(t))) return 'quickfix';
  if (tags.some((t) => ['feature', 'refactor', 'implement'].includes(t))) return 'executor';
  return 'executor';
}

export function resolveModel(task: Pick<Task, 'model'>, agentEntry: Agent): string {
  return task.model || agentEntry.defaultModel || 'claude-sonnet-4-6';
}

// ─── ASYNC CRUD (writes: Rust first, then update cache) ──────────────────────
// All three mirror the legacy synchronous TS API but now return Promises.
// The Agent Manager modal already runs inside async event handlers so
// switching to `await` is a small change.

export async function agentAdd(agent: Agent): Promise<void> {
  const res = await commands.agentAdd(agent);
  if (res.status === 'error') throw new Error(res.error);
  _cache.push({ ...agent });
}

export async function agentUpdate(id: string, patch: Partial<Agent>): Promise<void> {
  // Build the Rust-shaped patch by only forwarding keys the caller actually
  // set. The bindings type uses `field?: T | null` semantics, so an absent
  // key means "leave unchanged" and `null` means "clear" — distinguishing
  // them via `in patch` lets the dashboard clear a defaultModel by passing
  // `{ defaultModel: null }` without zeroing the rest of the agent.
  const rustPatch: Record<string, unknown> = {};
  if ('label' in patch) rustPatch.label = patch.label ?? null;
  if ('provider' in patch) rustPatch.provider = patch.provider ?? null;
  if ('systemPrompt' in patch) rustPatch.systemPrompt = patch.systemPrompt ?? null;
  if ('capabilities' in patch) rustPatch.capabilities = patch.capabilities ?? null;
  if ('enabled' in patch) rustPatch.enabled = patch.enabled ?? null;
  if ('defaultModel' in patch) rustPatch.defaultModel = patch.defaultModel ?? null;
  if ('allowedTools' in patch) rustPatch.allowedTools = patch.allowedTools ?? null;
  if ('skipPermissions' in patch) rustPatch.skipPermissions = patch.skipPermissions ?? null;
  if ('cliCommand' in patch) rustPatch.cliCommand = patch.cliCommand ?? null;
  if ('cliArgs' in patch) rustPatch.cliArgs = patch.cliArgs ?? null;

  const res = await commands.agentUpdate(
    id,
    rustPatch as Parameters<typeof commands.agentUpdate>[1]
  );
  if (res.status === 'error') throw new Error(res.error);
  const a = _cache.find((x) => x.id === id);
  if (a) Object.assign(a, patch);
}

export async function agentRemove(id: string): Promise<void> {
  const res = await commands.agentRemove(id);
  if (res.status === 'error') throw new Error(res.error);
  _cache = _cache.filter((a) => a.id !== id);
}
