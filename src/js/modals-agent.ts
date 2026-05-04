// ─── MODALS / AGENT ───────────────────────────────────────────────────────────
// Agent manager + agent edit modals.
import { esc, toast, modelShortName, MODEL_OPTIONS } from './data.js';
import {
  getAllAgents, getAgent, agentAdd, agentUpdate, agentRemove,
  DEFAULT_AGENT_IDS,
} from './agents/index.js';
import { scheduleSave } from './fileops.js';
import { refreshAgentFilter } from './render.js';
import { showModal, qInput, qSelect, qTextarea, qBtn } from './modals-shared.js';
import type { Agent, AgentProvider } from '../types/domain';

export function showAgentManagerModal(): void {
  const ov = document.createElement('div');
  ov.className = 'modal-overlay';
  document.body.appendChild(ov);

  const rerender = (): void => {
    const agents = getAllAgents();
    ov.innerHTML = `<div class="modal" style="max-width:640px;width:92vw">
      <div class="modal-title">⚙ Agent Manager</div>
      <div style="display:flex;flex-direction:column;gap:6px;max-height:380px;overflow-y:auto;padding-right:2px">
        ${agents.map((a) => `
          <div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--surface2);border:1px solid var(--border);border-radius:var(--radius-sm)${a.enabled ? '' : ';opacity:0.5'}">
            <input type="checkbox" style="cursor:pointer;width:16px;height:16px;flex-shrink:0" data-id="${a.id}" data-action="toggle"${a.enabled ? ' checked' : ''}>
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                <span style="font-weight:600;font-size:13px">${esc(a.label)}</span>
                <span style="font-size:10px;padding:1px 5px;border-radius:3px;${a.provider === 'claude' ? 'background:#1e3a5f;color:#60a5fa' : 'background:var(--surface3);color:var(--text-muted)'}">${a.provider}</span>
                ${a.defaultModel ? `<span style="font-size:10px;color:var(--text-muted)">${esc(modelShortName(a.defaultModel))}</span>` : ''}
              </div>
              ${a.systemPrompt ? `<div style="font-size:11px;color:var(--text-dim);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:360px">${esc(a.systemPrompt.slice(0, 80))}${a.systemPrompt.length > 80 ? '…' : ''}</div>` : ''}
            </div>
            <button class="task-action-btn" data-id="${a.id}" data-action="edit" style="flex-shrink:0">✏️</button>
            <button class="task-action-btn danger" data-id="${a.id}" data-action="delete" style="flex-shrink:0"${DEFAULT_AGENT_IDS.has(a.id) ? ' disabled title="Built-in agents cannot be deleted"' : ''}>🗑</button>
          </div>`).join('')}
      </div>
      <div class="modal-actions">
        <button class="modal-btn primary" id="agm-add">＋ Add Agent</button>
        <button class="modal-btn" id="agm-close">Close</button>
      </div>
    </div>`;

    qBtn(ov, '#agm-close').addEventListener('click', () => document.body.removeChild(ov));
    qBtn(ov, '#agm-add').addEventListener('click', () =>
      showAgentEditModal(null, () => { void scheduleSave(); refreshAgentFilter(); rerender(); })
    );
    ov.addEventListener('click', (e) => { if (e.target === ov) document.body.removeChild(ov); });

    ov.querySelectorAll<HTMLElement>('[data-action]').forEach((el) => {
      const id = el.dataset.id || '';
      const action = el.dataset.action;
      if (action === 'toggle') {
        el.addEventListener('change', () => {
          agentUpdate(id, { enabled: (el as HTMLInputElement).checked })
            .then(() => { void scheduleSave(); refreshAgentFilter(); rerender(); })
            .catch((e: unknown) => toast('❌ ' + (e instanceof Error ? e.message : String(e))));
        });
      } else if (action === 'edit') {
        el.addEventListener('click', () =>
          showAgentEditModal(id, () => { void scheduleSave(); refreshAgentFilter(); rerender(); })
        );
      } else if (action === 'delete') {
        el.addEventListener('click', () => {
          agentRemove(id)
            .then(() => { void scheduleSave(); refreshAgentFilter(); rerender(); toast('🗑 Agent removed'); })
            .catch((e: unknown) => toast('❌ ' + (e instanceof Error ? e.message : String(e))));
        });
      }
    });
  };

  rerender();
}

export function showAgentEditModal(agentId: string | null, onSaved: () => void): void {
  const isNew = agentId === null;
  const a: Agent = isNew
    ? { id: '', label: '', provider: 'claude', defaultModel: 'claude-sonnet-4-6', capabilities: [], enabled: true, systemPrompt: '', cliCommand: '', cliArgs: ['{prompt}'] }
    : { ...getAgent(agentId) };

  const modelOptsHtml = MODEL_OPTIONS.map((o) =>
    `<option value="${o.id}"${o.id === a.defaultModel ? ' selected' : ''}>${o.label}</option>`
  ).join('');

  showModal(
    `
    <div class="modal-title">${isNew ? '＋ Add Agent' : 'Edit: ' + esc(a.label)}</div>
    ${isNew ? `<div class="modal-field"><label class="modal-label">ID <span style="font-size:10px;color:var(--text-muted)">(unique, lowercase, hyphens ok)</span></label>
      <input class="modal-input" id="ae-id" value="" placeholder="e.g. my-agent" style="font-family:monospace"></div>` : ''}
    <div class="modal-field"><label class="modal-label">Label</label>
      <input class="modal-input" id="ae-label" value="${esc(a.label)}" placeholder="Display name…"></div>
    <div class="modal-field"><label class="modal-label">Provider</label>
      <select class="modal-select" id="ae-provider"${!isNew && agentId !== null && DEFAULT_AGENT_IDS.has(agentId) ? ' disabled' : ''}>
        <option value="claude"${a.provider === 'claude' ? ' selected' : ''}>claude</option>
        <option value="cli"${a.provider === 'cli' ? ' selected' : ''}>cli</option>
        <option value="manual"${a.provider === 'manual' ? ' selected' : ''}>manual</option>
      </select></div>
    <div class="modal-field"><label class="modal-label">Default Model</label>
      <select class="modal-select" id="ae-model">
        <option value="">— none —</option>
        ${modelOptsHtml}
      </select></div>
    <div class="modal-field"><label class="modal-label">System Prompt <span style="font-size:10px;color:var(--text-muted)">(optional — prepended to every run)</span></label>
      <textarea class="modal-textarea" id="ae-sysprompt" style="min-height:100px;font-family:monospace;font-size:12px">${esc(a.systemPrompt || '')}</textarea></div>
    <div class="modal-field"><label class="modal-label">CLI Command <span style="font-size:10px;color:var(--text-muted)">(provider = cli, e.g. omx)</span></label>
      <input class="modal-input" id="ae-cli-command" value="${esc(a.cliCommand || '')}" placeholder="omx" style="font-family:monospace"></div>
    <div class="modal-field"><label class="modal-label">CLI Args Template <span style="font-size:10px;color:var(--text-muted)">(one arg per line; placeholders: {prompt}, {model}, {sessionId}, {workingDir})</span></label>
      <textarea class="modal-textarea" id="ae-cli-args" style="min-height:88px;font-family:monospace;font-size:12px" placeholder="gemini&#10;{prompt}">${esc((a.cliArgs && a.cliArgs.length ? a.cliArgs : ['{prompt}']).join('\n'))}</textarea></div>`,
    (ov) => {
      const label = qInput(ov, '#ae-label').value.trim();
      if (!label) { toast('Label is required'); return false; }
      const systemPrompt = qTextarea(ov, '#ae-sysprompt').value;
      const defaultModel = qSelect(ov, '#ae-model').value || null;
      const provider = qSelect(ov, '#ae-provider').value as AgentProvider;
      const cliCommand = qInput(ov, '#ae-cli-command').value.trim() || null;
      const cliArgs = qTextarea(ov, '#ae-cli-args').value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (provider === 'cli' && !cliCommand) { toast('CLI Command is required for cli provider'); return false; }
      if (isNew) {
        const id = qInput(ov, '#ae-id').value.trim().replace(/\s+/g, '-').toLowerCase();
        if (!id) { toast('ID is required'); return false; }
        if (getAllAgents().find((x) => x.id === id)) { toast('Agent ID already exists'); return false; }
        agentAdd({ id, label, provider, defaultModel, capabilities: [], enabled: true, systemPrompt, cliCommand, cliArgs })
          .then(() => onSaved())
          .catch((e: unknown) => toast('❌ ' + (e instanceof Error ? e.message : String(e))));
      } else {
        const patch: Partial<Agent> = { label, systemPrompt, defaultModel, cliCommand, cliArgs };
        if (agentId !== null && !DEFAULT_AGENT_IDS.has(agentId)) {
          patch.provider = provider;
        }
        if (agentId !== null) {
          agentUpdate(agentId, patch)
            .then(() => onSaved())
            .catch((e: unknown) => toast('❌ ' + (e instanceof Error ? e.message : String(e))));
        } else {
          onSaved();
        }
      }
    },
    isNew ? 'Add' : 'Save'
  );
}
