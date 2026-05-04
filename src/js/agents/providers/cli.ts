// ─── AGENTS / PROVIDERS / GENERIC CLI ────────────────────────────────────────
// Owns: configurable external CLI provider (e.g. `omx gemini {prompt}`).
// Does NOT: resolve agent/model or mutate task state — adapter only.
import { tauriInvoke } from '../../api.js';
import type { ProviderRunArgs, ProviderResult } from '../execution-service.js';
import type { RunResult } from '../../../types/tauri';

function expandTemplate(value: string, vars: Record<string, string>): string {
  return value.replace(/\{(prompt|model|sessionId|workingDir)\}/g, (_m, key: string) => vars[key] ?? '');
}

export async function cliProviderRun({
  prompt,
  model,
  sessionId,
  workingDir,
  runId,
  systemPrompt,
  cliCommand,
  cliArgs,
}: ProviderRunArgs): Promise<ProviderResult> {
  const command = (cliCommand || '').trim();
  if (!command) {
    return { ok: false, error: 'CLI command is required for cli provider', raw: null };
  }

  const fullPrompt = systemPrompt?.trim() ? `${systemPrompt.trim()}\n\n${prompt}` : prompt;
  const vars = {
    prompt: fullPrompt,
    model,
    sessionId: sessionId || '',
    workingDir: workingDir || '',
  };
  const argsTemplate = cliArgs && cliArgs.length ? cliArgs : ['{prompt}'];
  const args = argsTemplate.map((arg) => expandTemplate(arg, vars));

  try {
    const raw = await tauriInvoke('run_cli', {
      command,
      args,
      workingDir: workingDir || null,
      runId,
    });
    const r = raw as RunResult;
    const output = (typeof r === 'object' ? r.output : r) || '';
    const sid = (typeof r === 'object' ? r.sessionId : null) || null;
    return { ok: true, output, sessionId: sid, usage: null, raw: r };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg, raw: e };
  }
}
