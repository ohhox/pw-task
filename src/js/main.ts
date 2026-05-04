// ─── MAIN ────────────────────────────────────────────────────────────────────
// Owns: DOM event bindings, font-size toggle, and app initialization (tryRestoreDir).
// Does NOT: contain business logic — wires UI events to the appropriate module functions.
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getLogger } from '../logger.js';
import { activeProjectId, filterState, setSelectedTaskPath } from './state.js';
import { esc, toast, getProject } from './data.js';
import { tauriOpenTerminal, tauriRunProjectCmd } from './api.js';
import {
  openFolder, saveFile, archiveDoneTasks, checkPatches, tryRestoreDir,
} from './fileops.js';
import {
  renderSidebar, renderProject, renderTaskList, refreshAgentFilter, initTaskListEvents,
} from './render.js';
import { renderBoard, initBoardEvents } from './board.js';
import {
  showAddProjectModal, showEditProjectModal, showAddTaskModal,
  showClaudeMdCopyModal, showAgentManagerModal, confirmDeleteProject,
} from './modals.js';
import { planProject } from './ai.js';
import { $, $maybe } from './dom.js';
import { openPalette, closePalette, initPalette } from './palette.js';
import { undo, redo, initHistory } from './history.js';
import { initRouting, updateHash } from './routing.js';
import {
  toggleBulkMode, isBulkMode, bulkSelected, clearBulkSelection,
} from './render.js';
import { findTaskByPath, autoEscalate, now } from './data.js';
import { scheduleSave } from './fileops.js';
import type { TaskStatus } from '../types/domain';

// Suppress unused-var warning for esc — re-exported indirectly via modals consumers.
void esc;

// ─── Global error handlers ────────────────────────────────────────────────
// Catch unhandled errors and promise rejections and forward them to the
// structured logger so they appear in the daily Rust log file as well.
const _globalLog = getLogger('global');

window.addEventListener('error', (e) => {
  _globalLog.error('Unhandled error', e.error, {
    source: e.filename,
    line: e.lineno,
    col: e.colno,
  });
});

window.addEventListener('unhandledrejection', (e) => {
  const err = e.reason instanceof Error ? e.reason : new Error(String(e.reason));
  _globalLog.error('Unhandled promise rejection', err);
});

// ─── Workspace toggles ────────────────────────────────────────────────────
// Sprint 3 / Phase A: detail panel is now a side-drawer (slides in from right
// over the list view). The list stays visible underneath so the user can keep
// scanning while inspecting a task. Closes on Esc, backdrop click, or the
// drawer's close button.
export function openWorkspace(): void {
  const panel = $('detail-panel');
  const backdrop = $('drawer-backdrop');
  panel.style.display = 'flex';
  backdrop.style.display = 'block';
  // RAF so the transition runs (display:flex → opacity/transform must paint first)
  requestAnimationFrame(() => {
    panel.classList.add('open');
    backdrop.classList.add('open');
  });
}

export function closeWorkspace(): void {
  const panel = $('detail-panel');
  const backdrop = $('drawer-backdrop');
  setSelectedTaskPath(null);
  updateHash(activeProjectId, null);
  panel.classList.remove('open');
  backdrop.classList.remove('open');
  // Wait for the slide-out transition before hiding so we don't snap-flicker.
  setTimeout(() => {
    panel.style.display = 'none';
    backdrop.style.display = 'none';
  }, 180);
  document.querySelectorAll('#task-list .task-row.selected').forEach((r) => r.classList.remove('selected'));
}

// ─── History renderer (injected to avoid fileops→render→history cycle) ────────
initHistory(() => { renderSidebar(); renderProject(); });

// ─── Filter bar toggle ────────────────────────────────────────────────────
let _filtersOpen = false;
function toggleFilterBar(): void {
  _filtersOpen = !_filtersOpen;
  const bar = document.getElementById('filters-bar');
  if (bar) bar.style.display = _filtersOpen ? '' : 'none';
  const btn = document.getElementById('btn-filter-toggle');
  if (btn) btn.classList.toggle('active', _filtersOpen);
}
$('btn-filter-toggle').addEventListener('click', toggleFilterBar);

// ─── Top-bar buttons ──────────────────────────────────────────────────────
$('btn-window-close').addEventListener('click', async () => {
  try {
    await getCurrentWindow().close();
  } catch (e) {
    toast('❌ ปิดโปรแกรมไม่สำเร็จ: ' + String(e));
  }
});
$('btn-open').addEventListener('click', openFolder);
$('btn-open-welcome').addEventListener('click', openFolder);
$('btn-save').addEventListener('click', saveFile);
$('btn-archive').addEventListener('click', archiveDoneTasks);
$('btn-add-project').addEventListener('click', showAddProjectModal);
$('btn-edit-project').addEventListener('click', showEditProjectModal);
$('btn-export-claude').addEventListener('click', () => {
  const proj = getProject(activeProjectId);
  if (proj) showClaudeMdCopyModal(proj);
});
$('btn-plan-project').addEventListener('click', () => {
  const proj = getProject(activeProjectId);
  if (proj) planProject(proj);
});
$('btn-terminal').addEventListener('click', async () => {
  const proj = getProject(activeProjectId);
  if (!proj?.workingDir) { toast('ยังไม่ได้ตั้ง Working Directory'); return; }
  try { await tauriOpenTerminal(proj.workingDir); }
  catch (e) { toast('❌ ' + String(e)); }
});
$('btn-run-project').addEventListener('click', async () => {
  const proj = getProject(activeProjectId);
  if (!proj?.runCommand) { toast('ยังไม่ได้ตั้ง Run Command'); return; }
  if (!proj?.workingDir) { toast('ยังไม่ได้ตั้ง Working Directory'); return; }
  // Security: show exact command before execution so user can verify
  if (!window.confirm(`Run command?\n\n"${proj.runCommand}"\n\nDirectory: ${proj.workingDir}`)) return;
  try { await tauriRunProjectCmd(proj.runCommand, proj.workingDir); }
  catch (e) { toast('❌ ' + String(e)); }
});
$('btn-delete-project').addEventListener('click', confirmDeleteProject);
$('btn-add-task').addEventListener('click', () => showAddTaskModal(null));
$('detail-close').addEventListener('click', closeWorkspace);
$('drawer-backdrop').addEventListener('click', closeWorkspace);

// ─── Filters ──────────────────────────────────────────────────────────────
$<HTMLInputElement>('search-input').addEventListener('input', (e) => {
  filterState.search = (e.target as HTMLInputElement).value;
  renderTaskList();
});
$<HTMLSelectElement>('filter-status').addEventListener('change', (e) => {
  filterState.status = (e.target as HTMLSelectElement).value;
  renderTaskList();
});
$<HTMLSelectElement>('filter-agent').addEventListener('change', (e) => {
  filterState.agent = (e.target as HTMLSelectElement).value;
  renderTaskList();
});
$<HTMLSelectElement>('filter-priority').addEventListener('change', (e) => {
  filterState.priority = (e.target as HTMLSelectElement).value;
  renderTaskList();
});
$('btn-clear-filters').addEventListener('click', () => {
  filterState.search = '';
  filterState.status = '';
  filterState.agent = '';
  filterState.priority = '';
  (['search-input', 'filter-status', 'filter-agent', 'filter-priority'] as const).forEach((id) => {
    const el = $maybe<HTMLInputElement | HTMLSelectElement>(id);
    if (el) el.value = '';
  });
  renderTaskList();
});

// ─── Keyboard shortcuts ───────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName);

  // Always-on shortcuts (even in inputs)
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); void saveFile(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); undo(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); redo(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); openPalette(); return; }

  if (e.key === 'Escape') {
    // Close in z-order: palette → settings → help → modal → drawer
    if (document.getElementById('palette-overlay')?.style.display !== 'none') { closePalette(); return; }
    if (document.getElementById('help-overlay')?.style.display !== 'none') { closeHelp(); return; }
    const modal = document.querySelector('.modal-overlay');
    if (modal) { modal.remove(); return; }
    if ($('detail-panel').classList.contains('open')) { closeWorkspace(); return; }
    if (isBulkMode()) { toggleBulkMode(); return; }
  }

  // Shortcuts blocked when typing in inputs
  if (inInput) return;

  if (e.key === '?') { e.preventDefault(); openHelp(); return; }
  if (e.key === 'n' && !e.ctrlKey && !e.metaKey) { e.preventDefault(); showAddTaskModal(null); return; }
  if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    // Open filter bar if hidden, then focus search
    if (!_filtersOpen) toggleFilterBar();
    const si = document.getElementById('search-input') as HTMLInputElement | null;
    if (si) { si.focus(); si.select(); }
    return;
  }
});

// ─── View tabs ──────────────────────────────────────────────────────────────
// Keep the selected project view stable across rerenders and app restarts.
const VIEW_PANES = {
  list: 'task-list-view',
  board: 'board-view',
} as const;
type ViewKey = keyof typeof VIEW_PANES;

const LAST_VIEW_KEY = 'pwtask-last-view';
const viewTabs = document.getElementById('view-tabs');

function isViewKey(value: string | null | undefined): value is ViewKey {
  return Boolean(value && Object.prototype.hasOwnProperty.call(VIEW_PANES, value));
}

function applyView(target: ViewKey, options: { persist?: boolean } = {}): void {
  viewTabs?.querySelectorAll('.view-tab').forEach((tab) => {
    tab.classList.toggle('active', (tab as HTMLElement).dataset.view === target);
  });

  for (const [view, paneId] of Object.entries(VIEW_PANES)) {
    const pane = document.getElementById(paneId);
    if (pane) pane.style.display = view === target ? '' : 'none';
  }

  if (target === 'board') renderBoard();

  if (options.persist !== false) {
    try { localStorage.setItem(LAST_VIEW_KEY, target); } catch {}
  }
}

function restoreLastView(): void {
  let saved: string | null = null;
  try { saved = localStorage.getItem(LAST_VIEW_KEY); } catch {}
  applyView(isViewKey(saved) ? saved : 'list', { persist: false });
}

viewTabs?.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.view-tab');
  if (!btn || !btn.dataset.view) return;
  const target = btn.dataset.view;
  if (!isViewKey(target)) return;
  applyView(target);
});

// ─── Sync button (now in settings panel) ──────────────────────────────────
$<HTMLButtonElement>('btn-sync').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('btn-sync');
  btn.disabled = true;
  btn.style.opacity = '0.55';
  await checkPatches();
  btn.disabled = false;
  btn.style.opacity = '';
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkPatches();
});

$('btn-agent-mgr').addEventListener('click', showAgentManagerModal);


// ─── Theme toggle ─────────────────────────────────────────────────────────
const _MOON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const _SUN_SVG  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;

function applyTheme(theme: 'light' | 'dark'): void {
  document.documentElement.setAttribute('data-theme', theme);
  document.documentElement.classList.toggle('dark', theme === 'dark');
  const btn = document.getElementById('btn-theme');
  if (btn) btn.innerHTML = theme === 'dark' ? _SUN_SVG : _MOON_SVG;
  try { localStorage.setItem('pwtask-theme', theme); } catch {}
}

const _saved = (() => { try { return localStorage.getItem('pwtask-theme'); } catch { return null; } })();
const _initTheme: 'light' | 'dark' = (_saved === 'light' || _saved === 'dark') ? _saved
  : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
applyTheme(_initTheme);

// Use onclick (not addEventListener) — prevents duplicate handlers on Vite HMR reloads
$('btn-theme').onclick = () => {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
};

// ─── Font size toggle ─────────────────────────────────────────────────────
type FsKey = 'fs-s' | 'fs-m' | 'fs-l';
const FS_SIZES: FsKey[] = ['fs-s', 'fs-m', 'fs-l'];
const FS_LABELS: Record<FsKey, string> = { 'fs-s': 'A⁻', 'fs-m': 'A', 'fs-l': 'A⁺' };

function applyFontSize(cls: FsKey): void {
  document.body.classList.remove(...FS_SIZES);
  document.body.classList.add(cls);
  $('btn-font-size').textContent = FS_LABELS[cls];
  localStorage.setItem('pwtask-fs', cls);
}

const savedFs = (localStorage.getItem('pwtask-fs') as FsKey | null) || 'fs-m';
applyFontSize(FS_SIZES.includes(savedFs) ? savedFs : 'fs-m');

$('btn-font-size').addEventListener('click', () => {
  const cur = FS_SIZES.find((c) => document.body.classList.contains(c)) || 'fs-m';
  applyFontSize(FS_SIZES[(FS_SIZES.indexOf(cur) + 1) % FS_SIZES.length]);
});

// ─── Help overlay ────────────────────────────────────────────────────────
function openHelp(): void {
  const el = document.getElementById('help-overlay');
  if (el) el.style.display = 'flex';
}
function closeHelp(): void {
  const el = document.getElementById('help-overlay');
  if (el) el.style.display = 'none';
}
document.getElementById('help-overlay')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('help-overlay')) closeHelp();
});
document.getElementById('help-close')?.addEventListener('click', closeHelp);

// ─── Bulk select bar ─────────────────────────────────────────────────────
document.getElementById('btn-bulk-select')?.addEventListener('click', toggleBulkMode);

document.getElementById('bulk-cancel')?.addEventListener('click', () => {
  if (isBulkMode()) toggleBulkMode();
});

function _applyBulkStatus(status: TaskStatus): void {
  for (const ps of bulkSelected) {
    const t = findTaskByPath(ps.split('/'));
    if (!t) continue;
    t.status = status;
    t.updatedAt = now();
    if (status === 'done') t.completedAt = now();
    (t.activityLog = t.activityLog || []).push({ timestamp: now(), agent: 'Manual', action: `bulk: set status to ${status}` });
  }
  getProject(activeProjectId)?.tasks.forEach(autoEscalate);
  scheduleSave();
  clearBulkSelection();
  renderSidebar();
  renderTaskList();
}

document.getElementById('bulk-done')?.addEventListener('click', () => _applyBulkStatus('done'));
document.getElementById('bulk-in-progress')?.addEventListener('click', () => _applyBulkStatus('in_progress'));
document.getElementById('bulk-todo')?.addEventListener('click', () => _applyBulkStatus('todo'));

// ─── Init ─────────────────────────────────────────────────────────────────
refreshAgentFilter();
initTaskListEvents();
initBoardEvents();
initPalette();
initRouting();
restoreLastView();
tryRestoreDir();
