// Unit tests for src/js/agents/* — TS facade + execution-service + providers.
//
// Phase 1.6.3 moved the canonical registry + routing logic into Rust
// (`src-tauri/src/agents/*`). The TS facade in `src/js/agents/index.ts`
// is now a thin sync cache backed by `commands.*`. Tests live in two places:
//
//   * `src-tauri/tests/agents_integration.rs` — owns the spec for routing,
//     legacy mapping, registry CRUD, and thread-safety. The 22 cases there
//     replace the deleted TS coverage of those concerns.
//   * THIS FILE — owns the integration path: execution-service dispatches
//     to the right provider, the facade keeps its sync cache in step with
//     IPC writes, and the providers themselves still translate prompts/
//     errors correctly.
//
// `commands.*` is mocked here so vitest never reaches the Tauri runtime.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────
// Tauri core invoke — execution-service shouldn't reach it once providers are
// mocked, but we stub it as a defence in depth (claudeProviderRun imports api).
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

// Mock the api module so claudeProviderRun never hits window.__TAURI__ even if
// a code path forgets to mock the provider directly.
vi.mock('../js/api.js', () => ({
  tauriInvoke: vi.fn().mockResolvedValue({ output: 'mocked', sessionId: 'sess-mock' }),
}));

// Mock the generated bindings so the facade + execution-service can be
// exercised without spawning a Tauri process. Each mock returns the shape
// the real `commands.*` does — `Result` envelopes for fallible commands,
// raw values for infallible ones.
// Untyped vi.fns so per-test `mockResolvedValueOnce` can return either the
// `{ status: 'ok' }` or `{ status: 'error' }` shape without TS narrowing.
type IpcResult = { status: 'ok'; data: unknown } | { status: 'error'; error: string };
const agentResolveMock = vi.fn<(task: unknown) => Promise<unknown>>();
const agentAddMock = vi.fn<(agent: unknown) => Promise<IpcResult>>();
const agentUpdateMock = vi.fn<(id: unknown, patch: unknown) => Promise<IpcResult>>();
const agentRemoveMock = vi.fn<(id: unknown) => Promise<IpcResult>>();
const agentListMock = vi.fn<() => Promise<unknown[]>>();
const agentReplaceAllMock = vi.fn<(saved: unknown) => Promise<void>>();

vi.mock('../bindings.js', () => ({
  commands: {
    agentResolve: (task: unknown) => agentResolveMock(task),
    agentAdd: (agent: unknown) => agentAddMock(agent),
    agentUpdate: (id: unknown, patch: unknown) => agentUpdateMock(id, patch),
    agentRemove: (id: unknown) => agentRemoveMock(id),
    agentList: () => agentListMock(),
    agentReplaceAll: (saved: unknown) => agentReplaceAllMock(saved),
  },
}));

// Provider mocks — execution-service.ts imports these via './providers/*.js'.
const claudeProviderRunMock = vi.fn();
const cliProviderRunMock = vi.fn();
const manualProviderRunMock = vi.fn();

vi.mock('../js/agents/providers/claude.js', () => ({
  claudeProviderRun: (...args: unknown[]) => claudeProviderRunMock(...args),
}));
vi.mock('../js/agents/providers/cli.js', () => ({
  cliProviderRun: (...args: unknown[]) => cliProviderRunMock(...args),
}));
vi.mock('../js/agents/providers/manual.js', () => ({
  manualProviderRun: (...args: unknown[]) => manualProviderRunMock(...args),
}));

import {
  agentAdd,
  agentUpdate,
  agentRemove,
  loadAgentsFromDb,
  getAgent,
  getAllAgents,
  getEnabledAgents,
  getTaskAgentLabel,
  legacyToAgentId,
  resolveAgentId,
  resolveModel,
  _resetAgentsForTest,
} from '../js/agents/index.js';
import { runTaskWithAgent, planProjectWithAgent } from '../js/agents/execution-service.js';
import type { Agent, Project, Task } from '../types/domain';

// ─── Fixtures ────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> & { id?: string } = {}): Task {
  return {
    id: overrides.id ?? 'task-1',
    title: overrides.title ?? 'Test task',
    description: overrides.description ?? '',
    status: overrides.status ?? 'todo',
    priority: overrides.priority ?? 'medium',
    agentId: overrides.agentId,
    aiAgent: overrides.aiAgent,
    model: overrides.model,
    prompt: overrides.prompt,
    tags: overrides.tags ?? [],
    subtasks: overrides.subtasks ?? [],
    filesModified: overrides.filesModified ?? [],
    createdAt: overrides.createdAt ?? '2026-05-03T00:00:00.000Z',
    activityLog: overrides.activityLog,
  };
}

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  return {
    id: overrides.id,
    label: overrides.label ?? overrides.id,
    provider: overrides.provider ?? 'claude',
    defaultModel: overrides.defaultModel ?? 'claude-sonnet-4-6',
    capabilities: overrides.capabilities ?? [],
    enabled: overrides.enabled ?? true,
    systemPrompt: overrides.systemPrompt ?? '',
    allowedTools: overrides.allowedTools,
    skipPermissions: overrides.skipPermissions,
    cliCommand: overrides.cliCommand,
    cliArgs: overrides.cliArgs,
  };
}

beforeEach(() => {
  _resetAgentsForTest();
  claudeProviderRunMock.mockReset();
  cliProviderRunMock.mockReset();
  manualProviderRunMock.mockReset();
  agentResolveMock.mockReset();
  agentAddMock.mockClear();
  agentUpdateMock.mockClear();
  agentRemoveMock.mockClear();
  agentListMock.mockClear();
  agentReplaceAllMock.mockClear();
  // Default behaviours — individual tests may override.
  claudeProviderRunMock.mockResolvedValue({
    ok: true,
    output: 'hello from claude',
    sessionId: 'sess-1',
  });
  manualProviderRunMock.mockResolvedValue({
    ok: false,
    error: 'Manual tasks cannot be auto-run',
    raw: null,
  });
  cliProviderRunMock.mockResolvedValue({
    ok: true,
    output: 'hello from cli',
    sessionId: null,
  });
  // Default IPC responses — make agentResolve mirror the sync cache so most
  // tests don't have to program it explicitly.
  agentResolveMock.mockImplementation(async (task: unknown) => {
    const t = task as Task;
    const id = resolveAgentId(t);
    const agent = getAgent(id);
    return {
      agentId: id,
      label: agent.label,
      provider: agent.provider,
      model: resolveModel(t, agent),
      systemPrompt: agent.systemPrompt ?? '',
    };
  });
  agentAddMock.mockResolvedValue({ status: 'ok', data: null });
  agentUpdateMock.mockResolvedValue({ status: 'ok', data: null });
  agentRemoveMock.mockResolvedValue({ status: 'ok', data: null });
  agentListMock.mockResolvedValue([]);
  // loadAgentsFromDb chains `.catch()` on this — ensure we always return
  // a Promise even after `mockClear()` wipes per-test implementations.
  agentReplaceAllMock.mockResolvedValue(undefined);
});

// ─── runTaskWithAgent ────────────────────────────────────────────────────
// These are the highest-value TS tests post-port: they verify the IPC →
// provider dispatch glue without spinning up Tauri.
describe('runTaskWithAgent()', () => {
  it('claude provider: success path returns ok=true with metadata', async () => {
    claudeProviderRunMock.mockResolvedValueOnce({
      ok: true,
      output: 'done',
      sessionId: 'sess-99',
      raw: { output: 'done' },
    });

    const res = await runTaskWithAgent({
      task: makeTask({ agentId: 'executor', model: 'claude-sonnet-4-6' }),
      prompt: 'do the thing',
      runId: 'run-1',
    });

    expect(res.ok).toBe(true);
    expect(res.output).toBe('done');
    expect(res.sessionId).toBe('sess-99');
    expect(res.agentId).toBe('executor');
    expect(res.provider).toBe('claude');
    expect(res.model).toBe('claude-sonnet-4-6');
    expect(claudeProviderRunMock).toHaveBeenCalledTimes(1);
    expect(manualProviderRunMock).not.toHaveBeenCalled();
    expect(agentResolveMock).toHaveBeenCalledTimes(1);
    // Verify the provider received the resolved arguments
    const call = claudeProviderRunMock.mock.calls[0][0];

    expect(call.prompt).toBe('do the thing');
    expect(call.runId).toBe('run-1');
    expect(call.model).toBe('claude-sonnet-4-6');
  });

  it('manual provider: returns ok=false with explanatory error', async () => {
    const res = await runTaskWithAgent({
      task: makeTask({ agentId: 'manual' }),
      prompt: 'noop',
      runId: 'run-2',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/manual/i);
    expect(res.agentId).toBe('manual');
    expect(res.provider).toBe('manual');
    expect(manualProviderRunMock).toHaveBeenCalledTimes(1);
    expect(claudeProviderRunMock).not.toHaveBeenCalled();
  });

  it('cli provider: dispatches to generic CLI adapter with command template', async () => {
    await agentAdd(
      makeAgent({
        id: 'gemini-custom',
        provider: 'cli',
        defaultModel: 'gemini',
        cliCommand: 'omx',
        cliArgs: ['gemini', '{prompt}'],
      })
    );

    const res = await runTaskWithAgent({
      task: makeTask({ agentId: 'gemini-custom' }),
      prompt: 'use gemini',
      runId: 'run-cli-1',
    });

    expect(res.ok).toBe(true);
    expect(res.provider).toBe('cli');
    expect(cliProviderRunMock).toHaveBeenCalledTimes(1);
    const call = cliProviderRunMock.mock.calls[0][0];
    expect(call.cliCommand).toBe('omx');
    expect(call.cliArgs).toEqual(['gemini', '{prompt}']);
  });

  it('unknown provider: returns descriptive error and does not invoke any provider', async () => {
    // Override the IPC mock to claim the resolved agent uses an unsupported
    // provider — same shape Rust would return if a custom agent had been
    // registered with `provider: "gemini"`.
    agentResolveMock.mockResolvedValueOnce({
      agentId: 'weird',
      label: 'Weird',
      provider: 'gemini',
      model: 'gemini-pro',
      systemPrompt: '',
    });

    const res = await runTaskWithAgent({
      task: makeTask({ agentId: 'weird' }),
      prompt: 'x',
      runId: 'run-3',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no adapter/i);
    expect(res.agentId).toBe('weird');
    expect(res.provider).toBe('gemini');
    expect(claudeProviderRunMock).not.toHaveBeenCalled();
    expect(cliProviderRunMock).not.toHaveBeenCalled();
    expect(manualProviderRunMock).not.toHaveBeenCalled();
  });

  it('propagates task.model override into the provider call', async () => {
    await runTaskWithAgent({
      task: makeTask({ agentId: 'executor', model: 'claude-opus-4-7' }),
      prompt: 'with override',
      runId: 'run-4',
    });

    const call = claudeProviderRunMock.mock.calls[0][0];

    expect(call.model).toBe('claude-opus-4-7');
  });

  it('passes systemPrompt / allowedTools / skipPermissions from the agent entry', async () => {
    // Add a custom agent locally so getAgent(...) returns the allowedTools
    // settings — the Rust IPC payload omits those fields by design.
    await agentAdd(
      makeAgent({
        id: 'custom',
        provider: 'claude',
        defaultModel: 'claude-sonnet-4-6',
        systemPrompt: 'You are custom',
        allowedTools: ['Read', 'Glob'],
        skipPermissions: true,
      })
    );

    await runTaskWithAgent({
      task: makeTask({ agentId: 'custom' }),
      prompt: 'p',
      runId: 'run-5',
    });

    const call = claudeProviderRunMock.mock.calls[0][0];

    expect(call.systemPrompt).toBe('You are custom');
    expect(call.allowedTools).toEqual(['Read', 'Glob']);
    expect(call.skipPermissions).toBe(true);
  });
});

// ─── planProjectWithAgent ────────────────────────────────────────────────
describe('planProjectWithAgent()', () => {
  function makeProject(overrides: Partial<Project> = {}): Project {
    return {
      id: overrides.id ?? 'proj-1',
      name: overrides.name ?? 'Test',
      color: overrides.color ?? '#fff',
      createdAt: overrides.createdAt ?? '2026-05-03T00:00:00.000Z',
      tasks: overrides.tasks ?? [],
      workingDir: overrides.workingDir,
      agentDefaults: overrides.agentDefaults,
    };
  }

  it('uses planner agent by default and forwards prompt + workingDir', async () => {
    claudeProviderRunMock.mockResolvedValueOnce({
      ok: true,
      output: 'plan',
      sessionId: 'sess-plan',
    });

    const res = await planProjectWithAgent({
      project: makeProject({ workingDir: 'D:/work' }),
      prompt: 'plan it',
      runId: 'run-plan-1',
    });

    expect(res.ok).toBe(true);
    expect(res.agentId).toBe('planner');
    expect(res.provider).toBe('claude');
    expect(res.model).toBe('claude-opus-4-7');

    const call = claudeProviderRunMock.mock.calls[0][0];

    expect(call.workingDir).toBe('D:/work');
    expect(call.prompt).toBe('plan it');
  });

  it("respects project.agentDefaults.planner override", async () => {
    await agentAdd(
      makeAgent({
        id: 'mega-planner',
        provider: 'claude',
        defaultModel: 'claude-sonnet-4-6',
      })
    );

    const res = await planProjectWithAgent({
      project: { id: 'p', name: 'p', color: '#fff', createdAt: 't', tasks: [], agentDefaults: { planner: 'mega-planner' } },
      prompt: 'go',
      runId: 'run-plan-2',
    });

    expect(res.agentId).toBe('mega-planner');
    expect(res.model).toBe('claude-sonnet-4-6');
  });

  it('returns error when planner agent points at unknown provider', async () => {
    await agentAdd(
      makeAgent({
        id: 'broken-planner',
        provider: 'unknown' as unknown as Agent['provider'],
        defaultModel: 'x',
      })
    );

    const res = await planProjectWithAgent({
      project: { id: 'p', name: 'p', color: '#fff', createdAt: 't', tasks: [], agentDefaults: { planner: 'broken-planner' } },
      prompt: 'p',
      runId: 'run-plan-3',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no adapter/i);
  });
});

// ─── Facade sync cache (smoke tests — Rust owns the spec) ──────────────────
// These cases verify the TS facade keeps the sync cache aligned with IPC
// writes. The exhaustive routing/CRUD spec lives in the Rust integration
// suite; we only check the bridge layer here.
describe('TS cache facade', () => {
  it('agentAdd appends to the cache after a successful IPC call', async () => {
    const before = getAllAgents().length;
    await agentAdd(makeAgent({ id: 'extra', label: 'Extra' }));

    expect(agentAddMock).toHaveBeenCalledTimes(1);
    expect(getAllAgents().length).toBe(before + 1);
    expect(getAgent('extra').label).toBe('Extra');
  });

  it('agentAdd rejects when the Rust IPC reports a duplicate', async () => {
    agentAddMock.mockResolvedValueOnce({ status: 'error', error: "Agent id 'planner' already exists" });
    await expect(agentAdd(makeAgent({ id: 'planner' }))).rejects.toThrow(/already exists/);
  });

  it('agentUpdate mutates the cached entry and keeps siblings intact', async () => {
    await agentAdd(makeAgent({ id: 'extra', label: 'Original' }));
    const plannerBefore = { ...getAgent('planner') };

    await agentUpdate('extra', { label: 'Renamed', enabled: false });

    expect(getAgent('extra').label).toBe('Renamed');
    expect(getAgent('extra').enabled).toBe(false);
    expect(getAgent('planner').label).toBe(plannerBefore.label);
    expect(getAgent('planner').enabled).toBe(plannerBefore.enabled);
  });

  it('agentRemove drops the entry from the cache', async () => {
    await agentAdd(makeAgent({ id: 'extra' }));
    expect(getAllAgents().some((a) => a.id === 'extra')).toBe(true);

    await agentRemove('extra');

    expect(agentRemoveMock).toHaveBeenCalledWith('extra');
    expect(getAllAgents().some((a) => a.id === 'extra')).toBe(false);
  });

  it('getEnabledAgents filters out disabled agents', async () => {
    await agentAdd(makeAgent({ id: 'off', enabled: false }));
    const enabled = getEnabledAgents();

    expect(enabled.some((a) => a.id === 'off')).toBe(false);
    expect(enabled.every((a) => a.enabled)).toBe(true);
  });

  it('getAgent falls back to executor when id is unknown', () => {
    expect(getAgent('does-not-exist').id).toBe('executor');
  });

  it('getTaskAgentLabel prefers registered agentId label, then legacy aiAgent string', () => {
    expect(getTaskAgentLabel({ agentId: 'planner', aiAgent: 'Claude' })).toBe('Planner');
    expect(getTaskAgentLabel({ agentId: undefined, aiAgent: 'Claude' })).toBe('Claude');
    expect(getTaskAgentLabel({ agentId: undefined, aiAgent: undefined })).toBe('—');
  });

  it('legacyToAgentId mirrors the Rust translation table', () => {
    // Spot-check the values render code relies on. The exhaustive spec lives
    // in `agents_integration.rs::legacy_to_agent_id_known_and_unknown_inputs`.
    expect(legacyToAgentId('Claude')).toBe('executor');
    expect(legacyToAgentId('Copilot')).toBe('quickfix');
    expect(legacyToAgentId('Manual')).toBe('manual');
    expect(legacyToAgentId(null)).toBe('executor');
    expect(legacyToAgentId('NeverHeardOf')).toBe('executor');
  });

  it('resolveAgentId mirrors Rust priorities (sync render path)', () => {
    expect(resolveAgentId(makeTask({ agentId: 'reviewer' }))).toBe('reviewer');
    expect(resolveAgentId(makeTask({ aiAgent: 'Copilot' }))).toBe('quickfix');
    expect(resolveAgentId(makeTask({ tags: ['plan'] }))).toBe('planner');
    expect(resolveAgentId(makeTask())).toBe('executor');
  });

  it('resolveModel honours task override → agent default → ultimate fallback', () => {
    const t = makeTask({ model: 'claude-opus-4-7' });
    expect(resolveModel(t, getAgent('executor'))).toBe('claude-opus-4-7');
    expect(resolveModel(makeTask({ model: null }), getAgent('planner'))).toBe('claude-opus-4-7');
    expect(resolveModel(makeTask({ model: null }), getAgent('manual'))).toBe('claude-sonnet-4-6');
  });
});

// ─── loadAgentsFromDb ────────────────────────────────────────────────────
describe('loadAgentsFromDb()', () => {
  it('loads saved agents, backfills built-in defaults, and pushes to Rust', () => {
    const saved: Agent[] = [
      makeAgent({ id: 'a1', label: 'Saved-1' }),
      makeAgent({ id: 'a2', label: 'Saved-2', systemPrompt: 'sp' }),
    ];

    loadAgentsFromDb(saved);
    const all = getAllAgents();

    expect(all.slice(0, 2).map((a) => a.id)).toEqual(['a1', 'a2']);
    expect(getAgent('a2').systemPrompt).toBe('sp');
    expect(getAgent('gemini').provider).toBe('cli');
    expect(getAgent('gemini').cliCommand).toBe('omx');
    expect(agentReplaceAllMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes missing systemPrompt to empty string', () => {
    const saved = [
      { ...makeAgent({ id: 'a1' }), systemPrompt: undefined },
    ] as unknown as Agent[];

    loadAgentsFromDb(saved);

    expect(getAgent('a1').systemPrompt).toBe('');
  });

  it('falls back to defaults (no-op) when db has no agents — null/undefined/[]', () => {
    const defaultsLen = getAllAgents().length;

    loadAgentsFromDb(null);
    expect(getAllAgents().length).toBe(defaultsLen);
    expect(getAgent('executor').id).toBe('executor');

    loadAgentsFromDb(undefined);
    expect(getAllAgents().length).toBe(defaultsLen);

    loadAgentsFromDb([]);
    expect(getAllAgents().length).toBe(defaultsLen);
    for (const id of ['planner', 'executor', 'reviewer', 'quickfix', 'gemini', 'manual']) {
      expect(getAgent(id).id).toBe(id);
    }
  });

  it('merges newly introduced built-in agents into older saved registries', () => {
    const saved = [
      makeAgent({ id: 'planner', label: 'Saved Planner' }),
      makeAgent({ id: 'executor', label: 'Saved Executor' }),
    ];

    loadAgentsFromDb(saved);

    expect(getAgent('planner').label).toBe('Saved Planner');
    expect(getAgent('gemini').provider).toBe('cli');
    expect(getAgent('gemini').cliCommand).toBe('omx');
  });
});

// ─── Providers (real modules, bypassing the top-level mocks) ────────────
describe('claudeProviderRun (real)', () => {
  it('returns ok=true with output and sessionId on a successful tauriInvoke', async () => {
    const api = await import('../js/api.js');
    const invoke = api.tauriInvoke as unknown as ReturnType<typeof vi.fn>;

    invoke.mockResolvedValueOnce({ output: 'real-out', sessionId: 'sid-real' });

    const real = await vi.importActual<typeof import('../js/agents/providers/claude.js')>(
      '../js/agents/providers/claude.js'
    );
    const res = await real.claudeProviderRun({
      prompt: 'p',
      model: 'claude-sonnet-4-6',
      runId: 'r-real-1',
    });

    expect(res.ok).toBe(true);
    expect(res.output).toBe('real-out');
    expect(res.sessionId).toBe('sid-real');
    const args = invoke.mock.calls[invoke.mock.calls.length - 1][1] as { prompt: string };

    expect(args.prompt).toBe('p');
  });

  it('prepends systemPrompt to the prompt when provided', async () => {
    const api = await import('../js/api.js');
    const invoke = api.tauriInvoke as unknown as ReturnType<typeof vi.fn>;

    invoke.mockResolvedValueOnce({ output: 'x', sessionId: null });

    const real = await vi.importActual<typeof import('../js/agents/providers/claude.js')>(
      '../js/agents/providers/claude.js'
    );

    await real.claudeProviderRun({
      prompt: 'user task',
      model: 'claude-sonnet-4-6',
      runId: 'r-real-2',
      systemPrompt: 'Be concise.',
    });

    const args = invoke.mock.calls[invoke.mock.calls.length - 1][1] as { prompt: string };

    expect(args.prompt.startsWith('Be concise.')).toBe(true);
    expect(args.prompt).toContain('user task');
  });

  it('returns ok=false with error message when tauriInvoke rejects', async () => {
    const api = await import('../js/api.js');
    const invoke = api.tauriInvoke as unknown as ReturnType<typeof vi.fn>;

    invoke.mockRejectedValueOnce(new Error('boom'));

    const real = await vi.importActual<typeof import('../js/agents/providers/claude.js')>(
      '../js/agents/providers/claude.js'
    );
    const res = await real.claudeProviderRun({
      prompt: 'p',
      model: 'claude-sonnet-4-6',
      runId: 'r-real-3',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/boom/);
  });
});

describe('manualProviderRun (real)', () => {
  it('always resolves with ok=false (cannot auto-run)', async () => {
    const real = await vi.importActual<typeof import('../js/agents/providers/manual.js')>(
      '../js/agents/providers/manual.js'
    );
    const res = await real.manualProviderRun({
      prompt: 'x',
      model: '',
      runId: 'r-real-4',
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/manual/i);
    expect(res.raw).toBeNull();
  });
});

describe('cliProviderRun (real)', () => {
  it('expands CLI argument templates and calls the generic Tauri command', async () => {
    const api = await import('../js/api.js');
    const invoke = api.tauriInvoke as unknown as ReturnType<typeof vi.fn>;

    invoke.mockResolvedValueOnce({ output: 'cli-out', sessionId: null });

    const real = await vi.importActual<typeof import('../js/agents/providers/cli.js')>(
      '../js/agents/providers/cli.js'
    );
    const res = await real.cliProviderRun({
      prompt: 'do thing',
      model: 'gemini',
      runId: 'r-cli-real-1',
      workingDir: 'D:\\DEV\\PwTask',
      systemPrompt: 'Be direct.',
      cliCommand: 'omx',
      cliArgs: ['gemini', '--model', '{model}', '--cwd', '{workingDir}', '{prompt}'],
    });

    expect(res.ok).toBe(true);
    expect(res.output).toBe('cli-out');
    const [commandName, args] = invoke.mock.calls[invoke.mock.calls.length - 1];

    expect(commandName).toBe('run_cli');
    expect(args).toEqual({
      command: 'omx',
      args: [
        'gemini',
        '--model',
        'gemini',
        '--cwd',
        'D:\\DEV\\PwTask',
        'Be direct.\n\ndo thing',
      ],
      workingDir: 'D:\\DEV\\PwTask',
      runId: 'r-cli-real-1',
    });
  });

  it('requires a command for generic CLI providers', async () => {
    const real = await vi.importActual<typeof import('../js/agents/providers/cli.js')>(
      '../js/agents/providers/cli.js'
    );

    const res = await real.cliProviderRun({
      prompt: 'x',
      model: 'gemini',
      runId: 'r-cli-real-2',
      cliCommand: '',
      cliArgs: ['{prompt}'],
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/command is required/i);
  });
});
