// ─── MAIN ────────────────────────────────────────────────────────────────────
// Owns: DOM event bindings, font-size toggle, and app initialization (tryRestoreDir).
// Does NOT: contain business logic — wires UI events to the appropriate module functions.
import { activeProjectId, filterState, setSelectedTaskPath } from './state.js';
import { esc, toast, getProject } from './data.js';
import { tauriOpenInVscode, tauriRunProjectCmd } from './api.js';
import {
  openFolder, saveFile, archiveDoneTasks, checkPatches, tryRestoreDir,
} from './fileops.js';
import {
  renderTaskList, refreshAgentFilter, initTaskListEvents,
} from './render.js';
import {
  showAddProjectModal, showEditProjectModal, showAddTaskModal,
  showClaudeMdCopyModal, showAgentManagerModal, confirmDeleteProject,
} from './modals.js';
import { planProject } from './ai.js';
import { $, $maybe } from './dom.js';

// Suppress unused-var warning for esc — re-exported indirectly via modals consumers.
void esc;

// ─── Workspace toggles ────────────────────────────────────────────────────
export function openWorkspace(): void {
  $('task-list-view').style.display = 'none';
  $('detail-panel').style.display = 'flex';
}

export function closeWorkspace(): void {
  setSelectedTaskPath(null);
  $('detail-panel').style.display = 'none';
  $('task-list-view').style.display = '';
  document.querySelectorAll('#task-list .task-row.selected').forEach((r) => r.classList.remove('selected'));
}

// ─── Top-bar buttons ──────────────────────────────────────────────────────
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
$('btn-vscode').addEventListener('click', async () => {
  const proj = getProject(activeProjectId);
  if (!proj?.workingDir) { toast('ยังไม่ได้ตั้ง Working Directory'); return; }
  try { await tauriOpenInVscode(proj.workingDir); }
  catch (e) { toast('❌ ' + String(e)); }
});
$('btn-run-project').addEventListener('click', async () => {
  const proj = getProject(activeProjectId);
  if (!proj?.runCommand) { toast('ยังไม่ได้ตั้ง Run Command'); return; }
  if (!proj?.workingDir) { toast('ยังไม่ได้ตั้ง Working Directory'); return; }
  try { await tauriRunProjectCmd(proj.runCommand, proj.workingDir); }
  catch (e) { toast('❌ ' + String(e)); }
});
$('btn-delete-project').addEventListener('click', confirmDeleteProject);
$('btn-add-task').addEventListener('click', () => showAddTaskModal(null));
$('detail-close').addEventListener('click', closeWorkspace);

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
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveFile(); }
  if (e.key === 'Escape') {
    document.querySelector('.modal-overlay')?.remove();
  }
});

// ─── Sync button ──────────────────────────────────────────────────────────
$<HTMLButtonElement>('btn-sync').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('btn-sync');
  btn.textContent = '⏳ Syncing…';
  btn.disabled = true;
  await checkPatches();
  btn.textContent = '🔄 Sync';
  btn.disabled = false;
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkPatches();
});

$('btn-agent-mgr').addEventListener('click', showAgentManagerModal);

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

// ─── Init ─────────────────────────────────────────────────────────────────
refreshAgentFilter();
initTaskListEvents();
tryRestoreDir();
