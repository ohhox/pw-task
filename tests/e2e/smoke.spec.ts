// E2E smoke test for AI Task Flow (Tauri).
//
// Covers:
//   1. App launches and auto-loads the seeded workspace fixture
//   2. Project list and task tree match tasks.json
//   3. Clicking a task row opens the detail panel
//   4. An external patch dropped into patches/ is applied via 🔄 Sync
//      (file disappears + task status flips to pending_review)
//   5. After session restart, a queued patch is applied at startup
//
// See docs/e2e-testing.md for Windows pre-requisites and known limitations.

import { browser, $, $$ } from '@wdio/globals';
import { expect as wdioExpect } from 'expect-webdriverio';
import { promises as fs } from 'fs';
import * as path from 'path';

const E2E_DIR = path.resolve(__dirname);
const FIXTURE_SRC = path.join(E2E_DIR, 'fixtures', 'smoke-workspace');
const WORKSPACE = path.join(E2E_DIR, '.workspace');
const PATCHES_DIR = path.join(WORKSPACE, 'patches');
const TASKS_FILE = path.join(WORKSPACE, 'tasks.json');

const APP_CONFIG_DIR = path.join(process.env.APPDATA || '', 'ai-task-flow');
const APP_CONFIG = path.join(APP_CONFIG_DIR, 'config.json');
const APP_CONFIG_BACKUP = path.join(APP_CONFIG_DIR, 'config.e2e-backup.json');

const PROJECT_ID = 'proj-smoke-001';

// ── helpers ────────────────────────────────────────────────────────────────
async function copyDir(src: string, dest: string): Promise<void> {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(src, dest, { recursive: true });
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

async function listPatches(): Promise<string[]> {
  try {
    const entries = await fs.readdir(PATCHES_DIR);
    return entries.filter(n => n.endsWith('.json'));
  } catch { return []; }
}

async function writePatch(name: string, patch: object): Promise<void> {
  await fs.writeFile(path.join(PATCHES_DIR, name), JSON.stringify(patch, null, 2));
}

function patchFileName(suffix: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
    `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}_${suffix}.json`;
}

async function readTasksDb(): Promise<{
  projects: Array<{
    id: string;
    tasks: Array<{ id: string; status: string; lastNote?: { summary?: string } }>;
  }>;
}> {
  const text = await fs.readFile(TASKS_FILE, 'utf8');
  return JSON.parse(text);
}

// ── lifecycle ──────────────────────────────────────────────────────────────
before(async () => {
  // Backup existing app config so we don't clobber the user's real workspace.
  await fs.mkdir(APP_CONFIG_DIR, { recursive: true });
  if (await fileExists(APP_CONFIG)) {
    await fs.copyFile(APP_CONFIG, APP_CONFIG_BACKUP);
  }

  // Materialize a fresh workspace for the test run.
  await copyDir(FIXTURE_SRC, WORKSPACE);
  await fs.mkdir(PATCHES_DIR, { recursive: true });

  // Seed the app config so loadFromDir() picks up our fixture on launch.
  await fs.writeFile(
    APP_CONFIG,
    JSON.stringify({ tasksDir: WORKSPACE }, null, 2)
  );
});

after(async () => {
  // Restore previous config (or remove the test seed if there was none).
  if (await fileExists(APP_CONFIG_BACKUP)) {
    await fs.rename(APP_CONFIG_BACKUP, APP_CONFIG);
  } else {
    await fs.rm(APP_CONFIG, { force: true });
  }
});

// ── tests ──────────────────────────────────────────────────────────────────
describe('AI Task Flow — smoke', () => {
  it('1) launches and auto-loads the workspace fixture', async () => {
    await $('#project-view').waitForDisplayed({ timeout: 15000 });
    await $('.project-item').waitForExist({ timeout: 5000 });
    // Save / Sync buttons appear once a workspace is loaded.
    await wdioExpect($('#btn-sync')).toBeDisplayed();
  });

  it('2) project list and task tree match tasks.json', async () => {
    const projectNameEls = await $$('.project-item .project-name');
    const projectNames = await Promise.all(
      projectNameEls.map(el => el.getText())
    );
    wdioExpect(projectNames).toContain('Smoke Project');

    const taskTitleEls = await $$('#task-list .task-row .task-title');
    const taskTitles = await Promise.all(
      taskTitleEls.map(el => el.getText())
    );
    wdioExpect(taskTitles).toEqual(
      wdioExpect.arrayContaining([
        '1. ตรวจการโหลด project',
        '2. ตรวจการ apply patch ผ่าน sync',
        '3. ตรวจการ apply patch ตอน restart',
      ])
    );
  });

  it('3) clicking a task opens the detail panel', async () => {
    const row = $('.task-row[data-path="task-s-01"]');
    await row.waitForExist({ timeout: 5000 });
    // Click the title area (avoid action buttons / status select).
    await row.$('.task-main').click();

    await $('#detail-panel').waitForDisplayed({ timeout: 5000 });
    const titleInput = $('.ws-title-input');
    await titleInput.waitForExist({ timeout: 3000 });
    wdioExpect(await titleInput.getValue()).toBe('1. ตรวจการโหลด project');
  });

  it('4) clicking 🔄 Sync applies a queued patch and removes the file', async () => {
    const patchName = patchFileName('E2E-sync');
    await writePatch(patchName, {
      version: '1.0',
      timestamp: new Date().toISOString(),
      agent: 'E2E-Test',
      changes: [
        {
          type: 'status_change',
          projectId: PROJECT_ID,
          taskId: 'task-s-02',
          from: 'todo',
          to: 'pending_review',
          note: 'flipped via E2E sync',
        },
      ],
    });

    // Sanity check before the click.
    wdioExpect(await listPatches()).toContain(patchName);

    await $('#btn-sync').click();

    // applyPatches() saves tasks.json then removes the patch file.
    await browser.waitUntil(
      async () => !(await listPatches()).includes(patchName),
      { timeout: 10000, timeoutMsg: 'patch file was not removed after Sync' }
    );

    // UI reflects the new status (badge class is status-pending_review).
    const reviewBadge = $(
      '.task-row[data-path="task-s-02"] .badge.status-pending_review'
    );
    await reviewBadge.waitForExist({ timeout: 5000 });

    // tasks.json on disk also reflects it.
    const db = await readTasksDb();
    const proj = db.projects.find(p => p.id === PROJECT_ID)!;
    const task = proj.tasks.find(t => t.id === 'task-s-02')!;
    wdioExpect(task.status).toBe('pending_review');
    wdioExpect(task.lastNote?.summary).toBe('flipped via E2E sync');
  });

  it('5) restart applies pending patches at startup', async () => {
    const patchName = patchFileName('E2E-restart');
    await writePatch(patchName, {
      version: '1.0',
      timestamp: new Date().toISOString(),
      agent: 'E2E-Test',
      changes: [
        {
          type: 'status_change',
          projectId: PROJECT_ID,
          taskId: 'task-s-03',
          from: 'todo',
          to: 'pending_review',
          note: 'applied at restart',
        },
      ],
    });

    wdioExpect(await listPatches()).toContain(patchName);

    // Hard-reload the WebDriver session — tauri-driver relaunches the exe,
    // which re-runs tryRestoreDir() → loadFromDir() → applyPatches().
    await browser.reloadSession();

    await $('#project-view').waitForDisplayed({ timeout: 15000 });

    await browser.waitUntil(
      async () => !(await listPatches()).includes(patchName),
      { timeout: 10000, timeoutMsg: 'queued patch was not applied at restart' }
    );

    const reviewBadge = $(
      '.task-row[data-path="task-s-03"] .badge.status-pending_review'
    );
    await reviewBadge.waitForExist({ timeout: 5000 });

    const db = await readTasksDb();
    const proj = db.projects.find(p => p.id === PROJECT_ID)!;
    const task = proj.tasks.find(t => t.id === 'task-s-03')!;
    wdioExpect(task.status).toBe('pending_review');
  });
});
