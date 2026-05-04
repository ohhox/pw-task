// ─── MODALS / TASK ────────────────────────────────────────────────────────────
// Task CRUD modals: add, edit, delete.
import { activeProjectId, selectedTaskPath } from './state.js';
import {
  esc, now, uuid, statusLabel, MODEL_OPTIONS, toast,
  autoEscalate, getProject, findTaskByPath,
} from './data.js';
import { getEnabledAgents, getAgent, legacyToAgentId } from './agents/index.js';
import { scheduleSave } from './fileops.js';
import { renderSidebar, renderTaskList } from './render.js';
import { renderDetail } from './detail.js';
import { showModal, qInput, qSelect, qTextarea } from './modals-shared.js';
import type { Task, TaskStatus, TaskPriority } from '../types/domain';

export function showAddTaskModal(parentPath: string[] | null): void {
  showModal(
    `
    <div class="modal-title">${parentPath ? 'New Subtask' : 'New Task'}</div>
    <div class="modal-field"><label class="modal-label">Title</label><input class="modal-input" id="t-title" placeholder="Task title…"></div>
    <div class="modal-field"><label class="modal-label">Description</label><textarea class="modal-textarea" id="t-desc" placeholder="Markdown supported…"></textarea></div>
    <div class="modal-field"><label class="modal-label">Priority</label>
      <select class="modal-select" id="t-priority"><option value="medium">Medium</option><option value="high">High</option><option value="low">Low</option></select></div>
    <div class="modal-field"><label class="modal-label">Agent</label>
      <select class="modal-select" id="t-agent">
        ${getEnabledAgents().map((a) => `<option value="${a.id}"${a.id === 'executor' ? ' selected' : ''}>${a.label}</option>`).join('')}
      </select></div>
    <div class="modal-field"><label class="modal-label">Model</label>
      <select class="modal-select" id="t-model">
        <option value="">— agent default —</option>
        ${MODEL_OPTIONS.map((o) => `<option value="${o.id}">${o.label}</option>`).join('')}
      </select></div>
    <div class="modal-field"><label class="modal-label">Due Date</label><input class="modal-input" id="t-due" type="date"></div>
    <div class="modal-field"><label class="modal-label">Prompt</label><textarea class="modal-textarea" id="t-prompt" placeholder="คำสั่งสำหรับ Claude…" style="min-height:70px;font-size:12px"></textarea></div>`,
    (ov) => {
      const title = qInput(ov, '#t-title').value.trim();
      if (!title) { toast('Title is required'); return false; }
      const agentId = qSelect(ov, '#t-agent').value;
      const agentEntry = getAgent(agentId);
      const dueVal = (ov.querySelector<HTMLInputElement>('#t-due'))?.value.trim() || null;
      const task: Task = {
        id: uuid(),
        title,
        description: qTextarea(ov, '#t-desc').value.trim(),
        status: 'todo',
        priority: qSelect(ov, '#t-priority').value as TaskPriority,
        dueDate: dueVal || null,
        tags: [],
        agentId,
        aiAgent: agentEntry.label,
        model: qSelect(ov, '#t-model').value || null,
        prompt: qTextarea(ov, '#t-prompt').value.trim() || null,
        lastSessionId: null,
        runHistory: [],
        filesModified: [],
        createdAt: now(),
        updatedAt: now(),
        completedAt: null,
        reviews: [],
        activityLog: [{ timestamp: now(), agent: 'Manual', action: 'created task' }],
        subtasks: [],
      };
      if (!parentPath) {
        getProject(activeProjectId)?.tasks.push(task);
      } else {
        const parent = findTaskByPath(parentPath);
        if (parent) (parent.subtasks = parent.subtasks || []).push(task);
      }
      scheduleSave();
      renderSidebar();
      renderTaskList();
      toast('✅ Task created');
    },
    'Create'
  );
}

export function showEditTaskModal(path: string[]): void {
  const task = findTaskByPath(path);
  if (!task) return;
  showModal(
    `
    <div class="modal-title">Edit Task</div>
    <div class="modal-field"><label class="modal-label">Title</label><input class="modal-input" id="t-title" value="${esc(task.title)}"></div>
    <div class="modal-field"><label class="modal-label">Description</label><textarea class="modal-textarea" id="t-desc">${esc(task.description || '')}</textarea></div>
    <div class="modal-field"><label class="modal-label">Status</label>
      <select class="modal-select" id="t-status">${(['todo', 'in_progress', 'pending_review', 'done', 'blocked'] as TaskStatus[]).map((s) => `<option value="${s}"${task.status === s ? ' selected' : ''}>${statusLabel(s)}</option>`).join('')}</select></div>
    <div class="modal-field"><label class="modal-label">Priority</label>
      <select class="modal-select" id="t-priority">${(['low', 'medium', 'high'] as TaskPriority[]).map((s) => `<option value="${s}"${task.priority === s ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
    <div class="modal-field"><label class="modal-label">Agent</label>
      <select class="modal-select" id="t-agent">${getEnabledAgents().map((a) => {
        const sel = (task.agentId || legacyToAgentId(task.aiAgent || '')) === a.id;
        return `<option value="${a.id}"${sel ? ' selected' : ''}>${a.label}</option>`;
      }).join('')}</select></div>
    <div class="modal-field"><label class="modal-label">Due Date</label><input class="modal-input" id="t-due" type="date" value="${task.dueDate || ''}"></div>`,
    (ov) => {
      const title = qInput(ov, '#t-title').value.trim();
      if (!title) { toast('Title is required'); return false; }
      const newStatus = qSelect(ov, '#t-status').value as TaskStatus;
      if (newStatus !== task.status) {
        (task.activityLog ??= []).push({
          timestamp: now(),
          agent: 'Manual',
          action: `changed status from ${task.status} to ${newStatus}`,
        });
        if (newStatus === 'done') task.completedAt = now();
      }
      const newAgentId = qSelect(ov, '#t-agent').value;
      task.title = title;
      task.description = qTextarea(ov, '#t-desc').value.trim();
      task.status = newStatus;
      task.priority = qSelect(ov, '#t-priority').value as TaskPriority;
      task.agentId = newAgentId;
      task.aiAgent = getAgent(newAgentId).label;
      task.dueDate = (ov.querySelector<HTMLInputElement>('#t-due'))?.value.trim() || null;
      task.updatedAt = now();
      getProject(activeProjectId)?.tasks.forEach(autoEscalate);
      scheduleSave();
      renderSidebar();
      renderTaskList();
      if (selectedTaskPath?.join('/') === path.join('/')) renderDetail();
    },
    'Save'
  );
}

export function confirmDeleteTask(path: string[]): void {
  const task = findTaskByPath(path);
  if (!task) return;
  showModal(
    `<div class="modal-title">Delete Task</div><p style="color:var(--text-dim);font-size:13px">Delete <strong>${esc(task.title)}</strong>${(task.subtasks || []).length ? ' and all subtasks' : ''}?</p>`,
    () => {
      const proj = getProject(activeProjectId);
      if (!proj) return false;
      if (path.length === 1) {
        proj.tasks = proj.tasks.filter((t) => t.id !== path[0]);
      } else {
        const parent = findTaskByPath(path.slice(0, -1));
        if (parent) parent.subtasks = (parent.subtasks || []).filter((t) => t.id !== path[path.length - 1]);
      }
      if (selectedTaskPath?.join('/').startsWith(path.join('/'))) {
        const panel = document.getElementById('detail-panel');
        if (panel) panel.style.display = 'none';
      }
      scheduleSave();
      renderSidebar();
      renderTaskList();
      toast('🗑 Task deleted');
    },
    'Delete',
    true
  );
}
