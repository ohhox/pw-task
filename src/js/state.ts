// ─── STATE ───────────────────────────────────────────────────────────────────
// Owns: shared mutable state across all modules.
// ES Module exports: read via `db`, write via `setDb()` (live bindings).
import type { Database } from '../types/domain';

export let db: Database | null = null;
export let baseDir: string | null = null;
export let activeProjectId: string | null = null;
export let selectedTaskPath: string[] | null = null;
export const collapsed = new Set<string>();
export const filterState: { search: string; status: string; agent: string; priority: string } = {
  search: '',
  status: '',
  agent: '',
  priority: '',
};

export interface ActiveRunUiRefs {
  playBtn?: HTMLElement | null;
  statusEl?: HTMLElement | null;
  terminal?: HTMLElement | null;
}

export interface ActiveRunEntry {
  runId: string;
  lines: string[];
  uiRefs: ActiveRunUiRefs;
}

// taskId → entry (one in-flight run per task; concurrent guard lives in ai.ts)
export const activeRuns = new Map<string, ActiveRunEntry>();

// Setters — required because ES module imports are read-only bindings.
export function setDb(v: Database | null): void {
  db = v;
}
export function setBaseDir(v: string | null): void {
  baseDir = v;
}
export function setActiveProjectId(v: string | null): void {
  activeProjectId = v;
}
export function setSelectedTaskPath(v: string[] | null): void {
  selectedTaskPath = v;
}
