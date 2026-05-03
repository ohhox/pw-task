// ─── AGENTS / PROVIDERS / MANUAL ─────────────────────────────────────────────
// Owns: manualProviderRun — always returns ok:false (manual tasks cannot be auto-run).
// Does NOT: interact with Tauri or any external service.
import type { ProviderRunArgs, ProviderResult } from '../execution-service.js';

export function manualProviderRun(_args: ProviderRunArgs): Promise<ProviderResult> {
  return Promise.resolve({ ok: false, error: 'Manual tasks cannot be auto-run', raw: null });
}
