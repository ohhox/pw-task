// ─── COMMAND PALETTE ─────────────────────────────────────────────────────────
// ⌘K / Ctrl+K: fuzzy search across tasks+projects + action commands (> prefix).
import { db, setActiveProjectId, setSelectedTaskPath } from './state.js';
import { esc, toast, statusLabel } from './data.js';
import { renderSidebar, renderProject } from './render.js';
import { renderDetail } from './detail.js';
import { showAddTaskModal, showAddProjectModal } from './modals.js';
import { saveFile, archiveDoneTasks } from './fileops.js';
import { undo, redo } from './history.js';
import type { Task } from '../types/domain';

// ─── Types ───────────────────────────────────────────────────────────────────

interface PaletteItem {
  type: 'task' | 'project' | 'action';
  label: string;
  sub?: string;
  badge?: string;
  badgeVariant?: string; // CSS status key e.g. 'in_progress'
  action: () => void;
}

// ─── Module state ─────────────────────────────────────────────────────────────

let _items: PaletteItem[] = [];
let _idx = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function $id(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function openDrawer(): void {
  const panel = document.getElementById('detail-panel');
  const bd = document.getElementById('drawer-backdrop');
  if (!panel || !bd) return;
  panel.style.display = 'flex';
  bd.style.display = 'block';
  requestAnimationFrame(() => {
    panel.classList.add('open');
    bd.classList.add('open');
  });
}

// ─── Open / close ─────────────────────────────────────────────────────────────

export function openPalette(): void {
  $id('palette-overlay').style.display = 'flex';
  const inp = $id('palette-input') as HTMLInputElement;
  inp.value = '';
  _idx = 0;
  _refresh('');
  requestAnimationFrame(() => inp.focus());
}

export function closePalette(): void {
  $id('palette-overlay').style.display = 'none';
}

// ─── Build items ──────────────────────────────────────────────────────────────

function _refresh(q: string): void {
  _items = _buildItems(q);
  _idx = 0;
  _render();
}

function _buildItems(q: string): PaletteItem[] {
  const raw = q.trim();
  const isAction = raw.startsWith('>');
  const term = (isAction ? raw.slice(1) : raw).toLowerCase().trim();

  if (isAction) {
    const actions: PaletteItem[] = [
      { type: 'action', label: 'New Task', sub: 'Add task to current project', action: () => { closePalette(); showAddTaskModal(null); } },
      { type: 'action', label: 'New Project', sub: 'Create a new project', action: () => { closePalette(); showAddProjectModal(); } },
      { type: 'action', label: 'Save', sub: 'Ctrl+S — save changes to disk', action: () => { closePalette(); void saveFile(); } },
      { type: 'action', label: 'Archive done tasks', sub: 'Move all done tasks to archive', action: () => { closePalette(); void archiveDoneTasks(); } },
      { type: 'action', label: 'Undo', sub: 'Ctrl+Z', action: () => { closePalette(); undo(); } },
      { type: 'action', label: 'Redo', sub: 'Ctrl+Y', action: () => { closePalette(); redo(); } },
    ];
    return term
      ? actions.filter((a) => a.label.toLowerCase().includes(term) || (a.sub || '').toLowerCase().includes(term))
      : actions;
  }

  if (!db) return [];
  const out: PaletteItem[] = [];

  // Projects
  for (const proj of db.projects) {
    if (!term || proj.name.toLowerCase().includes(term)) {
      out.push({
        type: 'project',
        label: proj.name,
        sub: `${proj.tasks.length} task${proj.tasks.length !== 1 ? 's' : ''}`,
        action: () => {
          closePalette();
          setActiveProjectId(proj.id);
          setSelectedTaskPath(null);
          renderSidebar();
          renderProject();
        },
      });
    }
  }

  // Tasks — cross-project recursive walk
  function walk(tasks: Task[], projId: string, projName: string, path: string[]): void {
    for (const t of tasks) {
      const tp = [...path, t.id];
      const matches =
        !term ||
        t.title.toLowerCase().includes(term) ||
        (t.description || '').toLowerCase().includes(term) ||
        (t.tags || []).some((tag) => tag.toLowerCase().includes(term));
      if (matches) {
        out.push({
          type: 'task',
          label: t.title,
          sub: projName,
          badge: statusLabel(t.status),
          badgeVariant: t.status,
          action: () => {
            closePalette();
            setActiveProjectId(projId);
            setSelectedTaskPath(tp);
            renderSidebar();
            renderProject();
            openDrawer();
            renderDetail();
          },
        });
      }
      walk(t.subtasks || [], projId, projName, tp);
    }
  }

  for (const proj of db.projects) {
    walk(proj.tasks || [], proj.id, proj.name, []);
  }

  return out.slice(0, 30);
}

// ─── Render results ───────────────────────────────────────────────────────────

const TYPE_ICON: Record<PaletteItem['type'], string> = {
  project: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  task: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
  action: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
};

function _render(): void {
  const el = $id('palette-results');
  if (!_items.length) {
    el.innerHTML = '<div class="palette-empty">No results — try <kbd>&gt;</kbd> for actions</div>';
    return;
  }
  el.innerHTML = _items
    .map(
      (item, i) => `
    <div class="palette-item${i === _idx ? ' is-selected' : ''}" data-idx="${i}">
      <span class="palette-item-icon">${TYPE_ICON[item.type]}</span>
      <span class="palette-item-body">
        <span class="palette-item-label">${esc(item.label)}</span>
        ${item.sub ? `<span class="palette-item-sub">${esc(item.sub)}</span>` : ''}
      </span>
      ${item.badge ? `<span class="palette-badge palette-badge--${esc(item.badgeVariant || '')}">${esc(item.badge)}</span>` : ''}
    </div>`
    )
    .join('');
}

function _move(dir: 1 | -1): void {
  if (!_items.length) return;
  _idx = (_idx + dir + _items.length) % _items.length;
  _render();
  ($id('palette-results').querySelector('.palette-item.is-selected') as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
}

function _select(): void {
  _items[_idx]?.action();
}

// ─── Init (call once from main.ts) ───────────────────────────────────────────

export function initPalette(): void {
  const overlay = $id('palette-overlay');

  // Backdrop click closes
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closePalette();
  });

  // Input events
  const inp = $id('palette-input') as HTMLInputElement;
  inp.addEventListener('input', () => _refresh(inp.value));
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); _move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); _move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); _select(); }
    else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  });

  // Click on result row
  $id('palette-results').addEventListener('click', (e) => {
    const item = (e.target as Element).closest<HTMLElement>('.palette-item');
    if (!item) return;
    const idx = parseInt(item.dataset.idx ?? '0', 10);
    if (isNaN(idx)) return;
    _idx = idx;
    _select();
  });

  // Hover → update selected index for keyboard continuity
  $id('palette-results').addEventListener('mousemove', (e) => {
    const item = (e.target as Element).closest<HTMLElement>('.palette-item');
    if (!item) return;
    const idx = parseInt(item.dataset.idx ?? '', 10);
    if (!isNaN(idx) && idx !== _idx) {
      _idx = idx;
      _render();
    }
  });

}
