// ─── AGENTS / ROUTING ────────────────────────────────────────────────────────
// Owns: resolving which agentId and model to use for a given task.
// Does NOT: run tasks or call providers — resolution only.
import { getAllAgents } from './registry.js';
import { legacyToAgentId } from './legacy-mapping.js';
import type { Task, Agent } from '../../types/domain';

export function resolveAgentId(task: Task): string {
  // 1. Explicit agentId on task
  if (task.agentId && getAllAgents().some((a) => a.id === task.agentId)) return task.agentId;
  // 2. Legacy aiAgent field
  if (task.aiAgent) return legacyToAgentId(task.aiAgent);
  // 3. Tag-based routing
  const tags = (task.tags || []).map((t) => t.toLowerCase());
  if (tags.some((t) => ['plan', 'planning'].includes(t))) return 'planner';
  if (tags.some((t) => ['review', 'qa'].includes(t))) return 'reviewer';
  if (tags.some((t) => ['bugfix', 'fix', 'small', 'cleanup'].includes(t))) return 'quickfix';
  if (tags.some((t) => ['feature', 'refactor', 'implement'].includes(t))) return 'executor';
  // 4. Default
  return 'executor';
}

export function resolveModel(task: Pick<Task, 'model'>, agentEntry: Agent): string {
  return task.model || agentEntry.defaultModel || 'claude-sonnet-4-6';
}
