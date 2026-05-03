// ─── AGENTS / EXECUTION SERVICE ──────────────────────────────────────────────
// Owns: runTaskWithAgent and planProjectWithAgent — resolves agent+model, calls provider.
// Does NOT: stream output or update UI — returns normalized {ok, output, sessionId, agentId, model}.
import { claudeProviderRun } from './providers/claude.js';
import { manualProviderRun } from './providers/manual.js';
import { resolveAgentId, resolveModel } from './routing.js';
import { getAgent } from './registry.js';
import type { Task, Project, AgentProvider } from '../../types/domain';

// ─── Provider contract ───────────────────────────────────────────────────
// Shared between claudeProviderRun and manualProviderRun so type errors surface
// here when a new field is added rather than silently in a downstream caller.

export interface ProviderRunArgs {
  prompt: string;
  model: string;
  sessionId?: string | null;
  workingDir?: string | null;
  runId: string;
  systemPrompt?: string | null;
  allowedTools?: string[] | null;
  skipPermissions?: boolean;
}

export interface ProviderResult {
  ok: boolean;
  output?: string;
  sessionId?: string | null;
  error?: string;
  raw?: unknown;
}

export type ProviderFn = (args: ProviderRunArgs) => Promise<ProviderResult>;

function getProviderFn(provider: AgentProvider | string): ProviderFn | null {
  if (provider === 'claude') return claudeProviderRun;
  if (provider === 'manual') return manualProviderRun;
  return null;
}

// ─── Service results (extend ProviderResult with metadata) ───────────────

export interface ExecutionResult extends ProviderResult {
  agentId: string;
  provider: AgentProvider | string;
  model: string;
}

interface RunTaskInput {
  task: Task;
  prompt: string;
  sessionId?: string | null;
  workingDir?: string | null;
  runId: string;
}

export async function runTaskWithAgent({
  task,
  prompt,
  sessionId,
  workingDir,
  runId,
}: RunTaskInput): Promise<ExecutionResult> {
  const agentId = resolveAgentId(task);
  const agentEntry = getAgent(agentId);
  const model = resolveModel(task, agentEntry);
  const providerFn = getProviderFn(agentEntry.provider);

  if (!providerFn) {
    return {
      ok: false,
      agentId,
      provider: agentEntry.provider,
      model,
      error: `No adapter for provider '${agentEntry.provider}'`,
    };
  }

  const result = await providerFn({
    prompt,
    model,
    sessionId,
    workingDir,
    runId,
    systemPrompt: agentEntry.systemPrompt || null,
    allowedTools: agentEntry.allowedTools ?? null,
    skipPermissions: agentEntry.skipPermissions ?? false,
  });
  return { ...result, agentId, provider: agentEntry.provider, model };
}

interface PlanProjectInput {
  project: Project;
  prompt: string;
  runId: string;
}

export async function planProjectWithAgent({
  project,
  prompt,
  runId,
}: PlanProjectInput): Promise<ExecutionResult> {
  const agentId = project.agentDefaults?.planner || 'planner';
  const agentEntry = getAgent(agentId);
  const model = agentEntry.defaultModel || 'claude-opus-4-7';
  const providerFn = getProviderFn(agentEntry.provider);

  if (!providerFn) {
    return {
      ok: false,
      agentId,
      provider: agentEntry.provider,
      model,
      error: `No adapter for provider '${agentEntry.provider}'`,
    };
  }

  const result = await providerFn({
    prompt,
    model,
    sessionId: null,
    workingDir: project.workingDir || null,
    runId,
    systemPrompt: agentEntry.systemPrompt || null,
    allowedTools: agentEntry.allowedTools ?? null,
    skipPermissions: agentEntry.skipPermissions ?? false,
  });
  return { ...result, agentId, provider: agentEntry.provider, model };
}
