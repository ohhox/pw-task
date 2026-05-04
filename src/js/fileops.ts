// ─── FILEOPS ────────────────────────────────────────────────────────────────
// Owns: folder selection, tasks.json read/write, patch apply/sync, archive.
// Does NOT: touch DOM beyond welcome/save-status helpers, contain UI logic.
import { getLogger } from '../logger.js';
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
  findTaskByPath, isFullyDone,
} from './data.js';
import { loadAgentsFromDb, getAgentsForSave } from './agents/index.js';
import { renderSidebar, renderProject, refreshAgentFilter } from './render.js';
import { renderDetail } from './detail.js';
import { showModal } from './modals.js';
import { closeWorkspace } from './main.js';
import type { Database, Task, Patch } from '../types/domain';
import { runMigrations, CURRENT_SCHEMA_VERSION } from '../migrations/index.js';
import { commands } from '../bindings.js';
import { onBeforeSave } from './history.js';
import type {
  Database as RustDatabase,
  Patch as RustPatch,
  PatchSource as RustPatchSource,
  ApplyResult as RustApplyResult,
} from '../bindings.js';

// Narrow `unknown` errors caught from try/catch into a printable string.
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const log = getLogger('fileops');

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

// [Phase 1.6.4] Patch shape validation — moved to Rust. The wire format is
// permissive (Change type-tagged enum, optional fields), so most shape errors
// surface as serde-deserialize failures inside `commands.patchApplyBatch`.
// This wrapper still returns the legacy `string | null` shape so existing
// callers keep working; we do the cheap checks locally before paying for IPC.
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

  // [P1.4.1] Schema migration — run before setDb so the in-memory db is always current.
  // `text` is the original raw JSON (pre-migration) used as the backup snapshot.
  let dbParsed = parsed as Database;
  try {
    const migResult = runMigrations(dbParsed);
    if (migResult.ran.length > 0) {
      // 1. Backup original (pre-migration) data using the raw text we already read.
      const tasksJsonPath = joinPath(baseDir, 'tasks.json');
      const backupPath = `${tasksJsonPath}.v${migResult.fromVersion}.bak`;
      await tauriWriteText(backupPath, text);
      // 2. Save the migrated db atomically.
      dbParsed = migResult.db as Database;
      await tauriWriteTextAtomic(tasksJsonPath, JSON.stringify(dbParsed, null, 2));
      // 3. Notify the user.
      toast(`✅ Migrated schema: ${migResult.ran.join(', ')}`);
    } else {
      dbParsed = migResult.db as Database;
    }
  } catch (e) {
    // Migration failure is non-fatal — log and continue with parsed data as-is.
    log.error('Schema migration failed', e);
    toast(`⚠️ Schema migration failed: ${errMsg(e)}`, 5000);
  }

  // [P1 fix] init applied-patches tracker
  if (!Array.isArray(dbParsed.appliedPatches)) dbParsed.appliedPatches = [];
  // Stamp schemaVersion so future loads skip migration for this db.
  if (!dbParsed.schemaVersion) dbParsed.schemaVersion = CURRENT_SCHEMA_VERSION;
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
//
// [Phase 1.6.4] The pure mutation pipeline (validate / apply per Change type
// / sort+dedupe a batch) lives in Rust at `src-tauri/src/patch.rs`. This
// module keeps the disk pipeline (read patches/ dir, parse JSON, write db,
// delete consumed files) because Rust does not yet own the DB layer
// (Phase 1.6.5 will move it).
//
// Idempotency now layers:
//   * In-memory tracker on the Rust side (process lifetime cache).
//   * Durable `db.appliedPatches` list passed in/out via the IPC tuple.
//   * Disk-side: consumed files deleted; if delete fails, write an
//     `_applied: true` marker so a re-scan ignores them.

interface PatchQueueEntry {
  name: string;
  path: string;
  patch: Patch;
  id: string;
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

  // Phase 1: parse + validate every file, skipping bad ones with a warning.
  // The Rust pipeline handles ordering + idempotency, so all we do here is
  // produce a flat list of `(id, patch, file path)` tuples.
  const queue: PatchQueueEntry[] = [];
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
    // Marker files (`{_applied: true}`) — written when a previous run
    // could not delete a consumed patch. Skip BEFORE validation so they
    // don't show up as "missing changes array" warnings.
    if (patch._applied) continue;
    const err = validatePatch(patch);
    if (err) { skipReasons.push(`${entry.name}: ${err}`); continue; }

    const id = patchIdentity(entry.name, patch);
    queue.push({ name: entry.name, path: filePath, patch, id });
  }

  if (skipReasons.length) {
    log.warn('Patch issues', { reasons: skipReasons });
    if (skipReasons.some((r) => !r.includes('already applied'))) {
      toast(`⚠️ Patch issues: ${skipReasons.length} (ดู console)`, 4000);
    }
  }

  if (!queue.length) return 0;

  // Phase 2: hand off to Rust. The Rust side sorts by timestamp, dedupes
  // against db.appliedPatches + its in-memory tracker, applies each patch,
  // and runs auto-escalate on every project tree before returning.
  const sources: RustPatchSource[] = queue.map((q) => ({
    id: q.id,
    patch: q.patch as unknown as RustPatch,
  }));
  let mutated: RustDatabase;
  let summary: RustApplyResult;
  try {
    [mutated, summary] = await commands.patchApplyBatch(
      db as unknown as RustDatabase,
      sources,
    );
  } catch (e) {
    log.warn('patchApplyBatch failed', { error: errMsg(e) });
    toast(`❌ Patch apply failed: ${errMsg(e)}`, 4000);
    return 0;
  }
  setDb(mutated as unknown as Database);
  if (summary.errors.length) {
    log.warn('Patch errors', { errors: summary.errors });
    toast(`❌ Patch errors: ${summary.errors.length} (ดู console)`, 4000);
  }

  // Phase 3: persist + delete files for everything that was applied or
  // skipped (already-applied entries' files should be removed too so they
  // don't pile up). Patches whose apply errored stay on disk for manual
  // inspection.
  // Rust formats errors as `"{id}: {message}"` — split on the first ": "
  // (with space) so source ids that contain a colon parse correctly.
  const erroredIds = new Set(
    summary.errors.map((e) => {
      const idx = e.indexOf(': ');
      return idx === -1 ? e : e.slice(0, idx);
    })
  );
  const toDelete: { name: string; path: string }[] = [];
  for (const q of queue) {
    if (erroredIds.has(q.id)) continue;
    toDelete.push({ name: q.name, path: q.path });
  }

  if (!toDelete.length) return summary.applied;

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
      log.warn('Failed to remove patch', { name });
    }
  }
  return summary.applied;
}

// [P1 fix] Internal save without re-acquiring the lock.
async function _saveDbUnlocked(): Promise<void> {
  if (!baseDir || !db) return;
  db.lastUpdated = now();
  db.agents = getAgentsForSave();
  const json = JSON.stringify(db, null, 2);
  onBeforeSave(json);
  await tauriWriteTextAtomic(joinPath(baseDir, 'tasks.json'), json);
  saveTime = new Date();
  updateSaveStatus();
}

// [Phase 1.6.4] `applyPatch` (single-patch in-process mutation) and the
// `UPDATE_TASK_ALLOWED` constant moved to Rust (`src-tauri/src/patch.rs`).
// All TS callers now go through `applyPatches()` which calls
// `commands.patchApplyBatch` for the actual mutation.

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
