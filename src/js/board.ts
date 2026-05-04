// ─── BOARD / KANBAN ──────────────────────────────────────────────────────────
// Owns: Kanban board rendering + HTML5 drag-drop for status changes.
// Does NOT: handle the detail panel (detail.ts), modals (modals.ts), or
//           the task list view (render.ts).

import { activeProjectId, setSelectedTaskPath } from './state.js';
import { getProject, autoEscalate, now } from './data.js';
import { esc, calcProgress } from './data.js';
import { scheduleSave } from './fileops.js';
import { priorityChip, chip } from '../views/components/chip.js';
import { getTaskAgentLabel } from './agents/index.js';
import { renderSidebar, renderTaskList } from './render.js';
import { openWorkspace } from './main.js';
import { renderDetail } from './detail.js';
import { showAddTaskModal } from './modals.js';
import type { Task, TaskStatus } from '../types/domain';

// ─── Column config ────────────────────────────────────────────────────────────
const COLUMNS: { status: TaskStatus; title: string; color: string }[] = [
  { status: 'todo',           title: 'Todo',           color: 'var(--gray)' },
  { status: 'in_progress',    title: 'In Progress',    color: 'var(--blue)' },
  { status: 'pending_review', title: 'Pending Review', color: 'var(--orange)' },
  { status: 'blocked',        title: 'Blocked',        color: 'var(--red)' },
  { status: 'done',           title: 'Done',           color: 'var(--green)' },
];

// ─── Module state ─────────────────────────────────────────────────────────────
let showSubtasks = false;

// ─── Card entry (root task or flattened subtask) ──────────────────────────────
interface CardEntry {
  task: Task;
  path: string[];
  parentTitle?: string; // set only for subtasks
}

// ─── Drag payload ─────────────────────────────────────────────────────────────
interface DragPayload {
  path: string[];
}

let _boardDragging = false;

// ─── Render ───────────────────────────────────────────────────────────────────
export function renderBoard(): void {
  const container = document.getElementById('board-container');
  if (!container) return;

  const proj = getProject(activeProjectId);
  const rootTasks: Task[] = proj?.tasks || [];

  // Build flat card list per status
  const byStatus = new Map<TaskStatus, CardEntry[]>();
  for (const col of COLUMNS) byStatus.set(col.status, []);

  for (const root of rootTasks) {
    const bucket = byStatus.get(root.status);
    if (bucket) bucket.push({ task: root, path: [root.id] });

    if (showSubtasks) {
      for (const sub of root.subtasks || []) {
        const subBucket = byStatus.get(sub.status);
        if (subBucket) subBucket.push({ task: sub, path: [root.id, sub.id], parentTitle: root.title });
      }
    }
  }

  container.innerHTML = '';

  // Toggle toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'board-toolbar';
  toolbar.innerHTML = `
    <button class="board-toggle-btn${showSubtasks ? ' active' : ''}" data-action="toggle-subtasks" type="button">
      ${showSubtasks ? '▾' : '▸'} Subtasks
    </button>
  `;
  container.appendChild(toolbar);

  // Columns wrapper
  const cols = document.createElement('div');
  cols.className = 'board-cols';
  for (const col of COLUMNS) {
    const entries = byStatus.get(col.status) || [];
    cols.appendChild(buildColumn(col.status, col.title, col.color, entries));
  }
  container.appendChild(cols);
}

function buildColumn(
  status: TaskStatus,
  title: string,
  color: string,
  entries: CardEntry[]
): HTMLDivElement {
  const col = document.createElement('div');
  col.className = 'board-col';
  col.dataset.colStatus = status;

  const header = document.createElement('div');
  header.className = 'board-col-header';
  header.innerHTML = `
    <span class="board-col-dot" style="background:${color}"></span>
    <span class="board-col-title">${esc(title)}</span>
    <span class="board-col-count">${entries.length}</span>
    <button class="board-col-add" data-add-col="${esc(status)}" title="Add task">＋</button>
  `;
  col.appendChild(header);

  const body = document.createElement('div');
  body.className = 'board-col-body';
  body.dataset.dropTarget = status;

  for (const entry of entries) {
    body.appendChild(buildCard(entry));
  }

  col.appendChild(body);
  return col;
}

function buildCard(entry: CardEntry): HTMLDivElement {
  const { task, path, parentTitle } = entry;

  const card = document.createElement('div');
  card.className = 'board-card';
  card.draggable = true;
  card.dataset.path = path.join('/');

  // Chips
  const chips: string[] = [];
  chips.push(priorityChip(task.priority || ''));
  const agentLbl = getTaskAgentLabel(task);
  if (agentLbl && agentLbl !== 'Executor') {
    chips.push(chip({ label: agentLbl, variant: 'agent', size: 'xs' }));
  }
  const chipsHtml = chips.filter(Boolean).join('');

  // Progress (only for root tasks with subtasks)
  const progress = calcProgress(task);
  const progressHtml = progress !== null
    ? `<div class="board-card-progress"><div class="board-card-progress-fill" style="width:${progress}%"></div></div>`
    : '';

  // Last note
  const noteHtml = task.lastNote
    ? `<div class="board-card-note">${esc(task.lastNote.summary)}</div>`
    : '';

  // Subtask count (root tasks when subtasks hidden)
  const subCount = (task.subtasks || []).length;
  const subDone = (task.subtasks || []).filter((s) => s.status === 'done').length;
  const subHtml = !showSubtasks && subCount > 0
    ? `<div class="board-card-sub-count">${subDone}/${subCount} subtasks</div>`
    : '';

  // Parent label for subtask cards
  const parentHtml = parentTitle
    ? `<div class="board-card-parent">${esc(parentTitle)}</div>`
    : '';
  const approveHtml = task.status === 'pending_review'
    ? `<button class="board-card-done-btn" data-action="approve-done" data-path="${esc(path.join('/'))}" type="button">✓ Done</button>`
    : '';

  card.innerHTML = `
    ${parentHtml}
    ${chipsHtml ? `<div class="board-card-chips">${chipsHtml}</div>` : ''}
    <div class="board-card-title">${esc(task.title)}</div>
    ${noteHtml}
    ${subHtml}
    ${progressHtml}
    ${approveHtml}
  `;

  return card;
}

// ─── Path-based task finder (supports nested subtasks) ───────────────────────
function findByPath(rootTasks: Task[], path: string[]): Task | null {
  if (!path.length) return null;
  let node: Task | undefined = rootTasks.find((t) => t.id === path[0]);
  for (let i = 1; i < path.length; i++) {
    if (!node) return null;
    node = (node.subtasks || []).find((s) => s.id === path[i]);
  }
  return node ?? null;
}

// ─── Events (wired once from main.ts) ────────────────────────────────────────
export function initBoardEvents(): void {
  const boardContainer = document.getElementById('board-container');
  if (!boardContainer) return;

  boardContainer.addEventListener('dragstart', handleDragStart);
  boardContainer.addEventListener('dragover', handleDragOver);
  boardContainer.addEventListener('dragleave', handleDragLeave);
  boardContainer.addEventListener('drop', handleDrop);
  boardContainer.addEventListener('dragend', handleDragEnd);
  boardContainer.addEventListener('click', handleBoardClick);

  // WebView2 fallback: ensure dragover preventDefault fires even outside board-container bounds
  document.addEventListener('dragover', (e) => { if (_boardDragging) e.preventDefault(); });
  document.addEventListener('dragend', () => { _boardDragging = false; });
  document.addEventListener('pwtask:task-view-changed', () => {
    const boardView = document.getElementById('board-view');
    if (boardView && boardView.style.display !== 'none') renderBoard();
  });
}

function handleDragStart(e: DragEvent): void {
  const card = (e.target as Element).closest<HTMLElement>('.board-card');
  if (!card || !e.dataTransfer) return;
  const path = (card.dataset.path || '').split('/');
  const payload: DragPayload = { path };
  // effectAllowed must be set before setData for WebView2 compatibility
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', JSON.stringify(payload));
  card.classList.add('dragging');
  _boardDragging = true;
}

function handleDragOver(e: DragEvent): void {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  const body = (e.target as Element).closest<HTMLElement>('.board-col-body');
  if (body) body.classList.add('dragover');
}

function handleDragLeave(e: DragEvent): void {
  const body = (e.target as Element).closest<HTMLElement>('.board-col-body');
  if (body) {
    const related = e.relatedTarget as Element | null;
    if (!body.contains(related)) body.classList.remove('dragover');
  }
}

function handleDrop(e: DragEvent): void {
  e.preventDefault();
  document.querySelectorAll('.board-col-body.dragover').forEach((el) => el.classList.remove('dragover'));

  const body = (e.target as Element).closest<HTMLElement>('.board-col-body');
  if (!body || !e.dataTransfer) return;

  const newStatus = body.dataset.dropTarget as TaskStatus | undefined;
  if (!newStatus) return;

  let payload: DragPayload;
  try {
    payload = JSON.parse(e.dataTransfer.getData('text/plain')) as DragPayload;
  } catch {
    return;
  }

  const proj = getProject(activeProjectId);
  if (!proj) return;

  const task = findByPath(proj.tasks, payload.path);
  if (!task || task.status === newStatus) return;

  const old = task.status;
  task.status = newStatus;
  task.updatedAt = now();
  if (newStatus === 'done') task.completedAt = now();
  (task.activityLog = task.activityLog || []).push({
    timestamp: now(),
    agent: 'Manual',
    action: `changed status from ${old} to ${newStatus} (board drag)`,
  });

  proj.tasks.forEach(autoEscalate);
  scheduleSave();
  renderBoard();
  renderSidebar();
}

function handleDragEnd(e: DragEvent): void {
  const card = (e.target as Element).closest<HTMLElement>('.board-card');
  if (card) card.classList.remove('dragging');
  document.querySelectorAll('.board-col-body.dragover').forEach((el) => el.classList.remove('dragover'));
  _boardDragging = false;
}

function handleBoardClick(e: MouseEvent): void {
  const target = e.target as Element;

  // Toggle subtasks
  if (target.closest('[data-action="toggle-subtasks"]')) {
    showSubtasks = !showSubtasks;
    renderBoard();
    return;
  }

  // ＋ add-task button
  const addBtn = target.closest<HTMLElement>('[data-add-col]');
  if (addBtn) {
    showAddTaskModal(null);
    return;
  }

  const approveBtn = target.closest<HTMLElement>('[data-action="approve-done"]');
  if (approveBtn) {
    const path = (approveBtn.dataset.path || '').split('/').filter(Boolean);
    const proj = getProject(activeProjectId);
    if (!proj || !path.length) return;
    const task = findByPath(proj.tasks, path);
    if (!task || task.status !== 'pending_review') return;
    task.status = 'done';
    task.completedAt = now();
    task.updatedAt = now();
    (task.reviews = task.reviews || []).push({ timestamp: now(), action: 'approved', comment: '', reviewer: 'Manual' });
    (task.activityLog = task.activityLog || []).push({ timestamp: now(), agent: 'Manual', action: 'approved → done (board)' });
    proj.tasks.forEach(autoEscalate);
    scheduleSave();
    renderBoard();
    renderSidebar();
    renderTaskList();
    renderDetail();
    return;
  }

  // Card click → detail drawer
  const card = target.closest<HTMLElement>('.board-card');
  if (!card) return;
  const path = (card.dataset.path || '').split('/').filter(Boolean);
  if (!path.length) return;

  setSelectedTaskPath(path);
  openWorkspace();
  renderDetail();
}
