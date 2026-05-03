// ─── FILEOPS ────────────────────────────────────────────────────────────────
// Owns: folder selection, tasks.json read/write, patch apply/sync, archive.
// Does NOT: touch DOM beyond welcome/save-status helpers, contain UI logic.
import {
  db, baseDir, activeProjectId, selectedTaskPath,
  setDb, setBaseDir, setActiveProjectId,
} from './state.js';
import {
  tauriReadText, tauriWriteText, tauriWriteTextAtomic, tauriReadDir,
  tauriRemove, tauriCreateDir, tauriOpenDir, tauriGetConfig, tauriSetConfig,
} from './api.js';
import {
  now, joinPath, esc, toast,
  findTaskByPath, findTaskAnywhere, autoEscalate, isFullyDone,
} from './data.js';
import { loadAgentsFromDb, getAgentsForSave } from './agents/registry.js';
import { renderSidebar, renderProject, refreshAgentFilter } from './render.js';
import { renderDetail } from './detail.js';
import { showModal } from './modals.js';
import { closeWorkspace } from './main.js';
import type { Database, Task, Patch, Change } from '../types/domain';

// Narrow `unknown` errors caught from try/catch into a printable string.
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// ─── SAVE STATE ───────────────────────────────────────────────────────────
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveTime: Date | null = null;

// [P1 fix] Promise-based save mutex — prevents auto-sync timer (30s) from
// racing with debounced user save and clobbering keystrokes.
let _saveLock: Promise<void> = Promise.resolve();
async function withSaveLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const prev = _saveLock;
  let release: () => void = () => {};
  _saveLock = new Promise<void>((r) => {
    release = r;
  });
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

// [P1 fix] Schema validation — silent-skip is a footgun. We at least require the
// shape is sane and report mismatches via toast so the user knows when patches
// are being dropped.
export function validatePatch(patch: unknown): string | null {
  if (!patch || typeof patch !== 'object') return 'patch is not an object';
  const p = patch as Record<string, unknown>;
  if (!Array.isArray(p.changes)) return 'patch.changes is not an array';
  if (p.version && p.version !== '1.0') return `unsupported version: ${String(p.version)}`;
  for (let i = 0; i < p.changes.length; i++) {
    const c = p.changes[i] as Record<string, unknown> | null;
    if (!c || typeof c !== 'object') return `changes[${i}] is not an object`;
    if (typeof c.type !== 'string') return `changes[${i}].type missing`;
    const VALID = ['status_change', 'add_project', 'add_task', 'update_task', 'files_modified', 'add_log'];
    if (!VALID.includes(c.type)) return `changes[${i}].type unknown: ${c.type}`;
    if (c.type !== 'add_project' && typeof c.projectId !== 'string') return `changes[${i}].projectId missing`;
  }
  return null;
}

// [P1 fix] Patch identifier — used for double-apply tracking.
function patchIdentity(name: string, patch: { timestamp?: string }): string {
  return `${patch.timestamp || ''}|${name}`;
}

export async function loadFromDir(): Promise<void> {
  updateDirDisplay();
  if (!baseDir) {
    showWelcome('กรุณาเลือก folder ที่จะเก็บข้อมูล');
    return;
  }
  let text: string;
  try {
    text = await tauriReadText(joinPath(baseDir, 'tasks.json'));
  } catch {
    // tasks.json not found — initialize a fresh database in this folder
    try {
      setDb({ version: '1.0', projects: [], lastUpdated: now() });
      await tauriCreateDir(joinPath(baseDir, 'patches'));
      await saveFileOrThrow();
      loadAgentsFromDb(db?.agents);
      setActiveProjectId(null);
      onDbLoaded();
      toast('✅ สร้าง tasks.json และ patches/ ใหม่แล้ว');
    } catch (e) {
      showWelcome(
        `ไม่สามารถสร้างไฟล์ใน<br><code style="font-size:11px">${esc(baseDir)}</code><br><span style="color:var(--red)">${esc(errMsg(e))}</span>`
      );
    }
    return;
  }
  // [P1 fix] try/catch JSON.parse — silent crash on corrupt tasks.json was a footgun
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    showWelcome(
      `tasks.json เสียหาย หรือไม่ใช่ JSON ที่ถูกต้อง<br>` +
      `<code style="font-size:11px">${esc(joinPath(baseDir, 'tasks.json'))}</code><br>` +
      `<span style="color:var(--red);font-size:12px">${esc(errMsg(e))}</span><br>` +
      `<span style="color:var(--text-muted);font-size:11px">ลองดูใน .bak (ถ้ามี) หรือ restore จาก git</span>`
    );
    return;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Database).projects)) {
    showWelcome(`<span style="color:var(--red)">tasks.json รูปแบบไม่ถูกต้อง — ขาด projects array</span>`);
    return;
  }
  const dbParsed = parsed as Database;
  // [P1 fix] init applied-patches tracker
  if (!Array.isArray(dbParsed.appliedPatches)) dbParsed.appliedPatches = [];
  setDb(dbParsed);

  loadAgentsFromDb(db?.agents); // must run before applyPatches so saveFileOrThrow persists correct agents
  await tauriCreateDir(joinPath(baseDir, 'patches')).catch(() => {});
  const applied = await applyPatches();
  setActiveProjectId(db?.projects[0]?.id || null);
  onDbLoaded();
  if (applied > 0) toast(`✅ Applied ${applied} patch${applied > 1 ? 'es' : ''}`);
}

export async function openFolder(): Promise<void> {
  try {
    const selected = await tauriOpenDir();
    if (!selected) return;
    setBaseDir(selected);
    if (baseDir) await tauriSetConfig(baseDir);
    await loadFromDir();
  } catch (e) {
    toast('❌ ' + errMsg(e));
  }
}

export async function tryRestoreDir(): Promise<void> {
  const saved = await tauriGetConfig();
  setBaseDir(saved || null);
  await loadFromDir();
}

function updateDirDisplay(): void {
  const el = document.getElementById('current-dir-display');
  if (el) el.textContent = baseDir || '';
}

export function showWelcome(msg: string): void {
  const w = document.getElementById('welcome-msg');
  if (w) w.innerHTML = msg || '';
  const welcome = document.getElementById('welcome');
  if (welcome) welcome.style.display = 'flex';
  const projView = document.getElementById('project-view');
  if (projView) projView.style.display = 'none';
}

export async function saveFileOrThrow(): Promise<void> {
  if (!baseDir || !db) return;
  // [P1 fix] Atomic write + mutex — prevents tasks.json corruption + auto-sync race
  await withSaveLock(_saveDbUnlocked);
}

export async function saveFile(): Promise<void> {
  try {
    await saveFileOrThrow();
  } catch (e) {
    toast('❌ Save failed: ' + errMsg(e));
  }
}

export function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveFile, 1000);
}

export function updateSaveStatus(): void {
  const el = document.getElementById('save-status');
  if (!el) return;
  if (!saveTime) { el.textContent = ''; return; }
  const diff = Math.round((Date.now() - saveTime.getTime()) / 1000);
  if (diff < 10) el.textContent = 'Saved · just now';
  else if (diff < 120) el.textContent = `Saved · ${diff}s ago`;
  else el.textContent = `Saved · ${Math.round(diff / 60)}m ago`;
}
setInterval(updateSaveStatus, 15000);

// ─── PATCH SYSTEM ──────────────────────────────────────────────────────────

interface PatchQueueEntry {
  name: string;
  path: string;
  patch: Patch;
  id?: string;
  alreadyApplied?: boolean;
}

export async function applyPatches(): Promise<number> {
  if (!baseDir) return 0;
  return withSaveLock(_applyPatchesUnlocked);
}

async function _applyPatchesUnlocked(): Promise<number> {
  if (!db || !baseDir) return 0;
  const patchesDir = joinPath(baseDir, 'patches');
  if (!Array.isArray(db.appliedPatches)) db.appliedPatches = [];

  let entries: { path?: string; name: string }[];
  try {
    entries = await tauriReadDir(patchesDir);
  } catch {
    return 0;
  }

  const patches: PatchQueueEntry[] = [];
  const skipReasons: string[] = [];
  for (const entry of entries) {
    if (!entry.name?.endsWith('.json')) continue;
    const filePath = entry.path || joinPath(patchesDir, entry.name);
    let text: string;
    try {
      text = await tauriReadText(filePath);
    } catch {
      skipReasons.push(`${entry.name}: read failed`);
      continue;
    }
    let patch: Patch;
    try {
      patch = JSON.parse(text) as Patch;
    } catch {
      skipReasons.push(`${entry.name}: invalid JSON`);
      continue;
    }
    if (patch._applied) continue;

    const err = validatePatch(patch);
    if (err) { skipReasons.push(`${entry.name}: ${err}`); continue; }

    const id = patchIdentity(entry.name, patch);
    if (db.appliedPatches.includes(id)) {
      skipReasons.push(`${entry.name}: already applied (skip)`);
      patches.push({ name: entry.name, path: filePath, patch, alreadyApplied: true });
      continue;
    }
    patches.push({ name: entry.name, path: filePath, patch, id });
  }

  if (skipReasons.length) {
    console.warn('Patch issues:', skipReasons);
    if (skipReasons.some((r) => !r.includes('already applied'))) {
      toast(`⚠️ Patch issues: ${skipReasons.length} (ดู console)`, 4000);
    }
  }

  if (!patches.length) return 0;

  patches.sort((a, b) => {
    const ta = a.patch.timestamp || a.name;
    const tb = b.patch.timestamp || b.name;
    return ta.localeCompare(tb);
  });

  const toDelete: { name: string; path: string }[] = [];
  let appliedCount = 0;
  for (const { name, path, patch, id, alreadyApplied } of patches) {
    if (alreadyApplied) {
      toDelete.push({ name, path });
      continue;
    }
    try {
      applyPatch(patch);
      if (id) db.appliedPatches.push(id);
      appliedCount++;
      toDelete.push({ name, path });
    } catch (e) {
      console.warn('Failed to apply patch:', name, e);
      toast(`❌ Failed to apply ${name}: ${errMsg(e)}`, 4000);
    }
  }

  if (db.appliedPatches.length > 1000) {
    db.appliedPatches = db.appliedPatches.slice(-1000);
  }

  if (!toDelete.length) return 0;

  try {
    await _saveDbUnlocked();
  } catch (e) {
    toast('❌ Save failed — patches NOT deleted: ' + errMsg(e));
    return 0;
  }

  for (const { name, path } of toDelete) {
    let removed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await tauriRemove(path);
        removed = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 80 * (1 << attempt)));
      }
    }
    if (!removed) {
      try {
        await tauriWriteText(path, JSON.stringify({ _applied: true }));
      } catch {}
      console.warn('Failed to remove patch:', name);
    }
  }
  return appliedCount;
}

// [P1 fix] Internal save without re-acquiring the lock.
async function _saveDbUnlocked(): Promise<void> {
  if (!baseDir || !db) return;
  db.lastUpdated = now();
  db.agents = getAgentsForSave();
  await tauriWriteTextAtomic(joinPath(baseDir, 'tasks.json'), JSON.stringify(db, null, 2));
  saveTime = new Date();
  updateSaveStatus();
}

// Allowlist for update_task — keep in sync with src/types/domain.ts UpdateTaskEvent.
const UPDATE_TASK_ALLOWED: Array<keyof Task> = [
  'title', 'description', 'priority', 'agentId', 'aiAgent', 'model', 'prompt', 'tags',
];

export function applyPatch(patch: Patch): void {
  if (!db) return;
  for (const change of patch.changes || []) {
    const proj = 'projectId' in change ? db.projects.find((p) => p.id === change.projectId) : undefined;
    const ts = patch.timestamp || now();
    const agent = patch.agent || 'AI';

    switch (change.type) {
      case 'status_change': {
        const task = proj ? findTaskAnywhere(proj.tasks, change.taskId) : null;
        if (!task) break;
        if (task.status === change.to) break;
        const old = task.status;
        task.status = change.to;
        task.updatedAt = ts;
        if (change.to === 'done') task.completedAt = ts;
        (task.activityLog = task.activityLog || []).push({
          timestamp: ts,
          agent,
          action: `changed status from ${old} to ${change.to}${change.note ? ': ' + change.note : ''}`,
        });
        if (change.note) {
          task.lastNote = { timestamp: ts, agent, summary: change.note };
        }
        break;
      }
      case 'add_project': {
        if (!change.project) break;
        if (db.projects.find((p) => p.id === change.project.id)) break;
        db.projects.push({ ...change.project, tasks: change.project.tasks ?? [] });
        break;
      }
      case 'add_task': {
        if (!proj) break;
        const task: Task = { reviews: [], ...change.task };
        if (change.parentTaskId) {
          const parent = findTaskAnywhere(proj.tasks, change.parentTaskId);
          if (parent) {
            if (!findTaskAnywhere(parent.subtasks || [], task.id)) {
              (parent.subtasks = parent.subtasks || []).push(task);
            }
          }
        } else {
          if (!findTaskAnywhere(proj.tasks, task.id)) proj.tasks.push(task);
        }
        break;
      }
      case 'update_task': {
        const task = proj ? findTaskAnywhere(proj.tasks, change.taskId) : null;
        if (!task) break;
        const updates = (change.updates || {}) as Partial<Record<keyof Task, unknown>>;
        const filtered = Object.fromEntries(
          Object.entries(updates).filter(([k]) => UPDATE_TASK_ALLOWED.includes(k as keyof Task))
        ) as Partial<Task>;
        if (!Object.keys(filtered).length) break;
        const willChange = Object.entries(filtered).some(
          ([k, v]) => JSON.stringify((task as unknown as Record<string, unknown>)[k]) !== JSON.stringify(v)
        );
        if (!willChange) break;
        Object.assign(task, filtered);
        task.updatedAt = ts;
        (task.activityLog = task.activityLog || []).push({
          timestamp: ts,
          agent,
          action: `updated ${Object.keys(filtered).join(', ')}${change.note ? ' — ' + change.note : ''}`,
        });
        if (change.note) {
          task.lastNote = { timestamp: ts, agent, summary: change.note };
        }
        break;
      }
      case 'files_modified': {
        const task = proj ? findTaskAnywhere(proj.tasks, change.taskId) : null;
        if (!task) break;
        task.filesModified = [
          ...new Set([...(task.filesModified || []), ...(change.files || [])]),
        ];
        task.updatedAt = ts;
        break;
      }
      case 'add_log': {
        const task = proj ? findTaskAnywhere(proj.tasks, change.taskId) : null;
        if (!task) break;
        const log = change.log;
        const exists = (task.activityLog || []).some(
          (l) => l.timestamp === log.timestamp && l.action === log.action && l.agent === log.agent
        );
        if (!exists) (task.activityLog = task.activityLog || []).push(log);
        break;
      }
    }
  }
  db.projects.forEach((p) => (p.tasks || []).forEach(autoEscalate));
}

// ─── ARCHIVE ───────────────────────────────────────────────────────────────

interface ArchiveEntry {
  projectId: string;
  projectName: string;
  archivedAt: string;
  task: Task;
}

interface ArchiveDb {
  version: string;
  archivedTasks: ArchiveEntry[];
  lastUpdated?: string;
}

export async function archiveDoneTasks(): Promise<void> {
  if (!baseDir || !db) return;

  const preview: string[] = [];
  db.projects.forEach((proj) => {
    (proj.tasks || []).filter(isFullyDone).forEach((t) => preview.push(t.title));
  });

  if (!preview.length) {
    toast('📦 ไม่มี task ที่ fully done ให้ archive');
    return;
  }

  showModal(
    `<div class="modal-title">📦 Archive Done Tasks</div>
     <p style="color:var(--text-dim);font-size:13px;margin-bottom:8px">จะย้าย <strong>${preview.length}</strong> task ออกไป <code>tasks-archive.json</code>:</p>
     <ul style="font-size:12px;color:var(--text-muted);margin:0;padding-left:16px;max-height:160px;overflow-y:auto">
       ${preview.map((t) => `<li>${esc(t)}</li>`).join('')}
     </ul>`,
    () => {
      doArchiveConfirmed();
    },
    'Archive',
    true
  );
}

async function doArchiveConfirmed(): Promise<void> {
  if (!db || !baseDir) return;
  const entries: ArchiveEntry[] = [];
  db.projects.forEach((proj) => {
    const toArchive = (proj.tasks || []).filter(isFullyDone);
    toArchive.forEach((task) =>
      entries.push({ projectId: proj.id, projectName: proj.name, archivedAt: now(), task })
    );
    proj.tasks = (proj.tasks || []).filter((t) => !isFullyDone(t));
  });

  if (!entries.length) {
    toast('📦 ไม่มี task ที่ fully done ให้ archive');
    return;
  }

  const archivePath = joinPath(baseDir, 'tasks-archive.json');
  let archiveDb: ArchiveDb = { version: '1.0', archivedTasks: [] };
  try {
    const text = await tauriReadText(archivePath);
    archiveDb = JSON.parse(text) as ArchiveDb;
    archiveDb.archivedTasks = archiveDb.archivedTasks || [];
  } catch {}

  archiveDb.archivedTasks.push(...entries);
  archiveDb.lastUpdated = now();

  try {
    await tauriWriteTextAtomic(archivePath, JSON.stringify(archiveDb, null, 2));
  } catch (e) {
    toast('❌ Archive save failed: ' + errMsg(e));
    db.projects.forEach((proj) => {
      const restored = entries.filter((en) => en.projectId === proj.id).map((en) => en.task);
      proj.tasks.push(...restored);
    });
    return;
  }

  await saveFile();
  renderSidebar();
  renderProject();
  if (selectedTaskPath) {
    const task = findTaskByPath(selectedTaskPath);
    if (!task) closeWorkspace();
  }
  toast(`📦 Archived ${entries.length} task${entries.length > 1 ? 's' : ''} → tasks-archive.json`);
}

export async function checkPatches(): Promise<void> {
  if (!baseDir || !db) return;
  const applied = await applyPatches();
  if (applied > 0) {
    renderSidebar();
    renderProject();
    if (selectedTaskPath) {
      if (findTaskByPath(selectedTaskPath)) renderDetail();
      else closeWorkspace();
    }
  }
}

let syncTimer: ReturnType<typeof setInterval> | null = null;

function onDbLoaded(): void {
  refreshAgentFilter();
  const ids = ['welcome', 'project-view', 'btn-save', 'btn-archive', 'btn-sync'];
  const displays = ['none', 'flex', '', '', ''];
  ids.forEach((id, i) => {
    const el = document.getElementById(id);
    if (el) el.style.display = displays[i];
  });
  renderSidebar();
  renderProject();

  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(checkPatches, 30000);
}
