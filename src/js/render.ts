// ─── RENDER ──────────────────────────────────────────────────────────────────
// Owns: sidebar, project header, task list, and task row DOM rendering.
// Does NOT: handle detail panel (detail.js), modals (modals.js), or data mutations.
import {
  db, activeProjectId, selectedTaskPath, collapsed, filterState, activeRuns,
  setActiveProjectId, setSelectedTaskPath
} from './state.js';
import {
  esc, statusLabel, modelShortName, modelBadgeClass,
  countByStatus, globalCount, calcProgress,
  getProject, findTaskByPath, autoEscalate, now
} from './data.js';
import { statusChip, priorityChip, chip } from '../views/components/chip.js';
import { getEnabledAgents, getTaskAgentLabel, legacyToAgentId } from './agents/index.js';
import { scheduleSave, showWelcome } from './fileops.js';
import { renderDetail } from './detail.js';
import { showAddProjectModal, showAddTaskModal, showEditTaskModal, confirmDeleteTask } from './modals.js';
import { quickPlay } from './ai.js';
import { openWorkspace, closeWorkspace } from './main.js';
import { updateHash } from './routing.js';
import { $ } from './dom.js';
import type { Task, TaskStatus } from '../types/domain';

function dueDateChip(dueDate: string): string {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due = new Date(dueDate + 'T00:00:00');
  const diffDays = Math.round((due.getTime() - today.getTime()) / 86400000);
  if (diffDays < 0)  return `<span class="due-chip due-chip--overdue" title="${dueDate}">⚠ ${Math.abs(diffDays)}d overdue</span>`;
  if (diffDays === 0) return `<span class="due-chip due-chip--today" title="${dueDate}">📅 Today</span>`;
  if (diffDays <= 3)  return `<span class="due-chip due-chip--soon" title="${dueDate}">📅 ${diffDays}d</span>`;
  return `<span class="due-chip due-chip--ok" title="${dueDate}">📅 ${dueDate.slice(5).replace('-', '/')}</span>`;
}

function notifyTaskViewChanged(): void {
  document.dispatchEvent(new CustomEvent('pwtask:task-view-changed'));
}

// ─── BULK SELECT ──────────────────────────────────────────────────────────────

let _bulkMode = false;
export const bulkSelected = new Set<string>(); // path strings joined with '/'

export function isBulkMode(): boolean { return _bulkMode; }

export function toggleBulkMode(): void {
  _bulkMode = !_bulkMode;
  if (!_bulkMode) {
    bulkSelected.clear();
    _updateBulkBar();
  }
  const btn = document.getElementById('btn-bulk-select');
  if (btn) btn.classList.toggle('active', _bulkMode);
  renderTaskList();
}

export function clearBulkSelection(): void {
  bulkSelected.clear();
  _updateBulkBar();
  if (_bulkMode) renderTaskList();
}

function _updateBulkBar(): void {
  const bar = document.getElementById('bulk-bar');
  const countEl = document.getElementById('bulk-count');
  if (!bar) return;
  bar.style.display = _bulkMode && bulkSelected.size > 0 ? '' : 'none';
  if (countEl) countEl.textContent = String(bulkSelected.size);
}

export function renderSidebar(): void {
  const list = $('project-list');
  list.innerHTML = '';
  (db?.projects || []).forEach((p) => {
    const c = countByStatus(p.tasks || []);
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    const div = document.createElement('div');
    div.className = 'project-item' + (p.id === activeProjectId ? ' active' : '');
    div.innerHTML = `
      <div class="project-dot" style="background:${p.color}"></div>
      <div class="project-info">
        <div class="project-name">${esc(p.name)}</div>
        <div class="project-counts">${c.in_progress} doing · ${c.done}/${total} done${c.pending_review ? ` · ${c.pending_review} review` : ''}</div>
      </div>`;
    div.addEventListener('click', () => { setActiveProjectId(p.id); setSelectedTaskPath(null); renderSidebar(); renderProject(); updateHash(p.id, null); });
    list.appendChild(div);
  });

  const gc = globalCount();
  $('summary-rows').innerHTML = ([
    ['Todo', gc.todo, 'var(--text)'],
    ['In Progress', gc.in_progress, 'var(--blue)'],
    ['Review', gc.pending_review, 'var(--orange)'],
    ['Done', gc.done, 'var(--green)'],
    ['Blocked', gc.blocked, 'var(--red)'],
  ] as Array<[string, number, string]>).map(
    ([l, n, c]) =>
      `<div class="summary-row"><span class="summary-label">${l}</span><span class="summary-count" style="color:${c}">${n}</span></div>`
  ).join('');
}

// ─── PROJECT ───────────────────────────────────────────────────────────────
export function renderProject(): void {
  const proj = getProject(activeProjectId);
  if (!proj) {
    $('task-list').innerHTML = '';
    closeWorkspace();
    setSelectedTaskPath(null);
    // Hide topbar project area and tab-bar project actions
    const topbarProj = document.getElementById('topbar-project');
    if (topbarProj) topbarProj.style.display = 'none';
    const quickAct = document.getElementById('proj-quick-actions');
    if (quickAct) quickAct.style.display = 'none';
    if (db && db.projects.length === 0) {
      showWelcome(
        `<p style="margin:0 0 12px;color:var(--text-muted)">ยังไม่มี project — เริ่มต้นสร้าง project แรกได้เลย</p>` +
        `<button class="btn-primary btn-sm" id="onboarding-add-project">＋ สร้าง Project แรก</button>`
      );
      requestAnimationFrame(() => {
        document.getElementById('onboarding-add-project')?.addEventListener('click', showAddProjectModal);
      });
    } else {
      showWelcome('');
    }
    return;
  }

  // Populate topbar project info
  const topbarProj = document.getElementById('topbar-project');
  if (topbarProj) topbarProj.style.display = '';
  const dotEl = document.getElementById('topbar-proj-dot');
  if (dotEl) dotEl.style.background = proj.color;
  const nameEl = document.getElementById('topbar-proj-name');
  if (nameEl) nameEl.textContent = proj.name;
  const descEl = document.getElementById('topbar-proj-desc');
  if (descEl) descEl.textContent = proj.description || '';

  // Show project quick actions in tab bar
  const quickAct = document.getElementById('proj-quick-actions');
  if (quickAct) quickAct.style.display = '';
  const termBtn = document.getElementById('btn-terminal');
  if (termBtn) termBtn.style.display = proj.workingDir ? '' : 'none';
  const runBtn = document.getElementById('btn-run-project');
  if (runBtn) runBtn.style.display = proj.runCommand ? '' : 'none';

  renderTaskList();
  if (selectedTaskPath) renderDetail();
}

// ─── FILTER ────────────────────────────────────────────────────────────────
export function refreshAgentFilter(): void {
  const sel = document.getElementById('filter-agent') as HTMLSelectElement | null;
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">All Agents</option>' +
    getEnabledAgents().map((a) => `<option value="${esc(a.id)}"${a.id === cur ? ' selected' : ''}>${esc(a.label)}</option>`).join('');
}

function taskOrChildMatches(task: Task): boolean {
  const q = filterState.search.toLowerCase();
  const self =
    (!q || task.title.toLowerCase().includes(q) || (task.description || '').toLowerCase().includes(q)) &&
    (!filterState.status || task.status === filterState.status) &&
    (!filterState.agent ||
      task.agentId === filterState.agent ||
      (!task.agentId && legacyToAgentId(task.aiAgent || '') === filterState.agent)) &&
    (!filterState.priority || task.priority === filterState.priority);
  return self || (task.subtasks || []).some(taskOrChildMatches);
}

// ─── TASK LIST ─────────────────────────────────────────────────────────────
const STATUS_SORT: Record<TaskStatus, number> = {
  in_progress: 0,
  pending_review: 1,
  blocked: 2,
  todo: 3,
  done: 4,
};

export function renderTaskList(): void {
  const proj = getProject(activeProjectId);
  const container = $('task-list');
  const countEl = document.getElementById('task-count-display');
  if (!proj) {
    container.innerHTML = '';
    if (countEl) countEl.textContent = '';
    notifyTaskViewChanged();
    return;
  }
  const visible = (proj.tasks || [])
    .filter(taskOrChildMatches)
    .slice()
    .sort((a, b) => (STATUS_SORT[a.status] ?? 3) - (STATUS_SORT[b.status] ?? 3));
  if (countEl) {
    const total = (proj.tasks || []).length;
    countEl.textContent = visible.length === total ? `${total} tasks` : `${visible.length} of ${total} tasks`;
  }
  if (!visible.length) {
    container.innerHTML = '<div class="empty-state">No tasks match your filter</div>';
    notifyTaskViewChanged();
    return;
  }
  container.innerHTML = '';
  visible.forEach((t) => container.appendChild(buildTaskNode(t, [t.id])));
  notifyTaskViewChanged();
}

function buildTaskNode(task: Task, path: string[]): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'task-node';

  const hasSubs = (task.subtasks || []).length > 0;
  const isCollapsed = collapsed.has(task.id);
  const isSelected = selectedTaskPath?.join('/') === path.join('/');
  const progress = calcProgress(task);
  const hasReviews = (task.reviews || []).length > 0;

  const isRunning = activeRuns.has(task.id);
  const pathStr = path.join('/');
  const isBulkChecked = _bulkMode && bulkSelected.has(pathStr);
  const row = document.createElement('div');
  row.className = 'task-row' +
    (isSelected ? ' selected' : '') +
    (task.status === 'pending_review' ? ' review-pending' : '') +
    (isRunning ? ' task-running' : '') +
    (isBulkChecked ? ' bulk-checked' : '');
  row.dataset.path = pathStr;

  row.innerHTML = `
    ${_bulkMode ? `<input type="checkbox" class="task-cb" data-path="${pathStr}"${isBulkChecked ? ' checked' : ''}>` : ''}
    <button class="expand-btn"${hasSubs ? ' data-expandable' : ''}>${hasSubs ? (isCollapsed ? '▶' : '▼') : '·'}</button>
    <div class="task-main">
      <div class="task-title-row">
        ${isRunning ? '<span class="running-pulse" title="กำลังรันอยู่"></span>' : ''}
        <span class="task-title ${task.status === 'done' ? 'done-title' : ''}">${esc(task.title)}</span>
        ${statusChip(task.status)}
        ${priorityChip(task.priority || '')}
        ${(() => { const lbl = getTaskAgentLabel(task); return lbl && lbl !== 'Executor' ? chip({ label: lbl, variant: 'agent' }) : ''; })()}
        ${task.model ? `<span class="badge ${modelBadgeClass(task.model)}">${esc(modelShortName(task.model))}</span>` : ''}
        ${(task.tags || []).map((t) => chip({ label: '#' + t, variant: 'tag' })).join('')}
        ${task.dueDate ? dueDateChip(task.dueDate) : ''}
        ${(task.filesModified || []).length ? `<span class="task-meta-text">📎 ${task.filesModified.length}</span>` : ''}
        ${progress !== null ? `<span class="task-meta-text">${progress}%</span>` : ''}
        ${hasReviews ? `<span class="task-meta-text">💬</span>` : ''}
      </div>
      ${task.lastNote ? `<div class="task-last-note">${esc(task.lastNote.summary)}</div>` : ''}
    </div>
    <div class="task-actions">
      <select class="status-select" data-path="${path.join('/')}">
        ${(['todo', 'in_progress', 'pending_review', 'done', 'blocked'] as TaskStatus[]).map((s) =>
          `<option value="${s}"${task.status === s ? ' selected' : ''}>${statusLabel(s)}</option>`
        ).join('')}
      </select>
      ${task.status === 'pending_review' ? `<button class="task-action-btn approve-done-btn" data-action="approve-done" data-path="${path.join('/')}" title="Mark as done">✓ Done</button>` : ''}
      ${path.length === 1 ? `<button class="task-action-btn quick-play-btn" data-action="quick-play" data-path="${path.join('/')}" title="Run next subtask">▶</button>` : ''}
      <button class="task-action-btn" data-action="add-sub" data-path="${path.join('/')}">＋ Sub</button>
      <button class="task-action-btn" data-action="edit" data-path="${path.join('/')}">✏️</button>
      <button class="task-action-btn danger" data-action="delete" data-path="${path.join('/')}">🗑</button>
    </div>`;

  wrap.appendChild(row);

  if (hasSubs && !isCollapsed) {
    const subWrap = document.createElement('div');
    subWrap.className = 'subtask-container';
    (task.subtasks || []).filter(taskOrChildMatches).forEach((sub) => {
      subWrap.appendChild(buildTaskNode(sub, [...path, sub.id]));
    });
    wrap.appendChild(subWrap);
  }

  return wrap;
}

// ─── TASK LIST EVENTS (delegated, set up once) ────────────────────────────
export function initTaskListEvents(): void {
  const container = $('task-list');

  container.addEventListener('click', (e: MouseEvent) => {
    const target = e.target as Element | null;
    if (!target) return;
    const actionBtn = target.closest('[data-action]') as HTMLElement | null;
    if (actionBtn) {
      const p = (actionBtn.dataset.path || '').split('/');
      if (actionBtn.dataset.action === 'edit') { setSelectedTaskPath(p); showEditTaskModal(p); }
      else if (actionBtn.dataset.action === 'add-sub') showAddTaskModal(p);
      else if (actionBtn.dataset.action === 'delete') confirmDeleteTask(p);
      else if (actionBtn.dataset.action === 'quick-play') quickPlay(p);
      else if (actionBtn.dataset.action === 'approve-done') {
        const t = findTaskByPath(p);
        if (!t || t.status !== 'pending_review') return;
        t.status = 'done';
        t.completedAt = now();
        t.updatedAt = now();
        (t.reviews = t.reviews || []).push({ timestamp: now(), action: 'approved', comment: '', reviewer: 'Manual' });
        (t.activityLog = t.activityLog || []).push({ timestamp: now(), agent: 'Manual', action: 'approved → done' });
        getProject(activeProjectId)?.tasks.forEach(autoEscalate);
        scheduleSave();
        renderSidebar();
        renderTaskList();
        if (selectedTaskPath?.join('/') === p.join('/')) renderDetail();
      }
      return;
    }

    const expandBtn = target.closest('.expand-btn');
    if (expandBtn) {
      if (!expandBtn.hasAttribute('data-expandable')) return;
      const taskRow = expandBtn.closest('.task-row[data-path]') as HTMLElement | null;
      if (!taskRow) return;
      const segs = (taskRow.dataset.path || '').split('/');
      const taskId = segs[segs.length - 1];
      if (collapsed.has(taskId)) collapsed.delete(taskId); else collapsed.add(taskId);
      renderTaskList();
      return;
    }

    // Bulk checkbox click
    const cb = target.closest('.task-cb') as HTMLInputElement | null;
    if (cb && _bulkMode) {
      const ps = cb.dataset.path || '';
      if (cb.checked) bulkSelected.add(ps); else bulkSelected.delete(ps);
      cb.closest('.task-row')?.classList.toggle('bulk-checked', cb.checked);
      _updateBulkBar();
      return;
    }

    const row = target.closest('.task-row[data-path]') as HTMLElement | null;
    if (!row || target.closest('.task-actions')) return;

    // Bulk mode: row click toggles selection
    if (_bulkMode) {
      const ps = row.dataset.path || '';
      const checked = !bulkSelected.has(ps);
      if (checked) bulkSelected.add(ps); else bulkSelected.delete(ps);
      const rowCb = row.querySelector<HTMLInputElement>('.task-cb');
      if (rowCb) rowCb.checked = checked;
      row.classList.toggle('bulk-checked', checked);
      _updateBulkBar();
      return;
    }

    // Normal mode: select task and open drawer
    const path = (row.dataset.path || '').split('/');
    document.querySelectorAll('#task-list .task-row.selected').forEach((r) => r.classList.remove('selected'));
    row.classList.add('selected');
    setSelectedTaskPath(path);
    openWorkspace();
    renderDetail();
    updateHash(activeProjectId, path);
  });

  container.addEventListener('change', (e: Event) => {
    const target = e.target as Element | null;
    if (!target) return;
    const sel = target.closest('.status-select') as HTMLSelectElement | null;
    if (!sel) return;
    const p = (sel.dataset.path || '').split('/');
    const t = findTaskByPath(p);
    if (!t) return;
    const old = t.status;
    t.status = sel.value as TaskStatus;
    t.updatedAt = now();
    if (sel.value === 'done') t.completedAt = now();
    (t.activityLog = t.activityLog || []).push({ timestamp: now(), agent: 'Manual', action: `changed status from ${old} to ${sel.value}` });
    getProject(activeProjectId)?.tasks.forEach(autoEscalate);
    scheduleSave(); renderSidebar(); renderTaskList();
    if (selectedTaskPath?.join('/') === p.join('/')) renderDetail();
  });
}
