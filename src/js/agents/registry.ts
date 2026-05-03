// ─── AGENTS / REGISTRY ───────────────────────────────────────────────────────
// Owns: runtime agent array, lookup helpers, CRUD (agentAdd/Update/Remove), DB sync.
// Does NOT: contain routing logic or provider adapters.
import type { Agent, Task } from '../../types/domain';

export const DEFAULT_AGENT_IDS = new Set<string>([
  'planner',
  'executor',
  'reviewer',
  'quickfix',
  'manual',
]);

let _agents: Agent[] = [
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
    id: 'manual',
    label: 'Manual',
    provider: 'manual',
    defaultModel: null,
    capabilities: [],
    enabled: true,
    systemPrompt: '',
  },
];

export function loadAgentsFromDb(savedAgents: Agent[] | undefined | null): void {
  if (!Array.isArray(savedAgents) || !savedAgents.length) return;
  _agents = savedAgents.map((a) => ({ ...a, systemPrompt: a.systemPrompt ?? '' }));
}

export function getAgentsForSave(): Agent[] {
  return _agents;
}

export function getAgent(agentId: string | null | undefined): Agent {
  return (
    _agents.find((a) => a.id === agentId) ||
    _agents.find((a) => a.id === 'executor') ||
    _agents[0]
  );
}

export function getAllAgents(): Agent[] {
  return _agents;
}
export function getEnabledAgents(): Agent[] {
  return _agents.filter((a) => a.enabled);
}

export function getTaskAgentLabel(task: Pick<Task, 'agentId' | 'aiAgent'>): string {
  if (task.agentId) {
    const a = _agents.find((x) => x.id === task.agentId);
    if (a) return a.label;
  }
  return task.aiAgent || '—';
}

export function agentAdd(agent: Agent): void {
  _agents.push(agent);
}
export function agentUpdate(id: string, patch: Partial<Agent>): void {
  const a = _agents.find((x) => x.id === id);
  if (a) Object.assign(a, patch);
}
export function agentRemove(id: string): void {
  _agents = _agents.filter((a) => a.id !== id);
}
