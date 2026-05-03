// ─── AGENTS / PROVIDERS / CLAUDE ─────────────────────────────────────────────
// Owns: claudeProviderRun — bridges execution-service to Tauri run_claude command.
// Does NOT: resolve agent/model or update any state — adapter only.
import { tauriInvoke } from '../../api.js';
import type { ProviderRunArgs, ProviderResult } from '../execution-service.js';
import type { RunResult } from '../../../types/tauri';

// Default allowed tools — read-only by default. Users can opt into "full" via
// agent settings (skipPermissions=true) for tasks that need write/bash access.
const DEFAULT_ALLOWED_TOOLS: string[] = [
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'Edit', 'Write', 'NotebookEdit',
  'Bash(npm:*)', 'Bash(cargo:*)', 'Bash(git:*)', 'Bash(node:*)',
  'TodoWrite',
];

export async function claudeProviderRun({
  prompt,
  model,
  sessionId,
  workingDir,
  runId,
  systemPrompt,
  allowedTools,
  skipPermissions,
}: ProviderRunArgs): Promise<ProviderResult> {
  const fullPrompt = systemPrompt?.trim() ? `${systemPrompt.trim()}\n\n${prompt}` : prompt;
  try {
    const raw = await tauriInvoke('run_claude', {
      prompt: fullPrompt,
      model,
      sessionId: sessionId || null,
      workingDir: workingDir || null,
      runId,
      allowedTools: skipPermissions ? null : (allowedTools || DEFAULT_ALLOWED_TOOLS),
      skipPermissions: skipPermissions === true,
    });
    const r = raw as RunResult;
    const output = (typeof r === 'object' ? r.output : r) || '';
    const sid = (typeof r === 'object' ? r.sessionId : null) || null;
    return { ok: true, output, sessionId: sid, raw: r };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, raw: e };
  }
}
