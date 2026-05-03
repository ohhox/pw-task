// ─── AGENTS / LEGACY MAPPING ─────────────────────────────────────────────────
// Owns: backward-compatible mapping from old aiAgent string to agentId.
// Does NOT: define agents or routing — purely a translation table.
const LEGACY_AGENT_MAP: Record<string, string> = {
  Claude: 'executor',
  ChatGPT: 'executor',
  Copilot: 'quickfix',
  Manual: 'manual',
};

export function legacyToAgentId(aiAgent: string | null | undefined): string {
  return (aiAgent && LEGACY_AGENT_MAP[aiAgent]) || 'executor';
}
