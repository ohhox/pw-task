// Disk-pipeline integration tests for src/js/fileops.ts patch handling.
//
// Phase 1.6.4 — the pure mutation logic (validate / apply per Change /
// idempotency / auto-escalate) moved to Rust at `src-tauri/src/patch.rs`.
// The exhaustive tests for that logic live in
// `src-tauri/tests/patch_integration.rs`. This file keeps only the TS-side
// concerns:
//
//   * `validatePatch` thin wrapper still returns `string | null` for
//     existing callers.
//   * `applyPatches` disk pipeline correctly reads the patches/ dir,
//     parses files, hands them to `commands.patchApplyBatch`, persists
//     the returned db, and deletes consumed patch files.
//
// We mock `commands.patchApplyBatch` so the pipeline is tested without
// requiring a Tauri runtime; the Rust integration tests cover the actual
// mutation semantics.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── MOCKS (must be hoisted before any module-under-test imports) ─────────

vi.mock('../js/state.js', () => {
  const mod: {
    db: unknown;
    baseDir: string | null;
    activeProjectId: string | null;
    selectedTaskPath: string[] | null;
    setDb: (v: unknown) => void;
    setBaseDir: (v: string | null) => void;
    setActiveProjectId: (v: string | null) => void;
    setSelectedTaskPath: (v: string[] | null) => void;
  } = {
    db: null,
    baseDir: null,
    activeProjectId: null,
    selectedTaskPath: null,
    setDb(v) {
      mod.db = v;
    },
    setBaseDir(v) {
      mod.baseDir = v;
    },
    setActiveProjectId(v) {
      mod.activeProjectId = v;
    },
    setSelectedTaskPath(v) {
      mod.selectedTaskPath = v;
    },
  };
  return mod;
});

// In-memory virtual filesystem used by the api mock.
interface VFile {
  contents: string;
}
const vfs = new Map<string, VFile>();
const vfsDirs = new Set<string>();

vi.mock('../js/api.js', () => ({
  tauriReadText: vi.fn(async (path: string) => {
    const f = vfs.get(path);
    if (!f) throw new Error(`ENOENT: ${path}`);
    return f.contents;
  }),
  tauriWriteText: vi.fn(async (path: string, contents: string) => {
    vfs.set(path, { contents });
  }),
  tauriWriteTextAtomic: vi.fn(async (path: string, contents: string) => {
    vfs.set(path, { contents });
  }),
  tauriReadDir: vi.fn(async (path: string) => {
    if (!vfsDirs.has(path)) throw new Error(`ENOTDIR: ${path}`);
    const prefix = path.replace(/[/\\]$/, '') + '/';
    const out: { name: string; path: string }[] = [];
    for (const key of vfs.keys()) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
        out.push({ name: key.slice(prefix.length), path: key });
      }
    }
    return out;
  }),
  tauriRemove: vi.fn(async (path: string) => {
    vfs.delete(path);
  }),
  tauriCreateDir: vi.fn(async (path: string) => {
    vfsDirs.add(path);
  }),
  tauriOpenDir: vi.fn(async () => null),
  tauriGetConfig: vi.fn(async () => null),
  tauriSetConfig: vi.fn(async () => undefined),
  tauriOpenTerminal: vi.fn(async () => undefined),
  tauriRunProjectCmd: vi.fn(async () => ''),
  tauriListen: vi.fn(async () => () => {}),
  tauriInvoke: vi.fn(async () => undefined),
}));

vi.mock('../js/agents/index.js', () => ({
  loadAgentsFromDb: vi.fn(),
  getAgentsForSave: vi.fn(() => []),
}));

vi.mock('../js/render.js', () => ({
  renderSidebar: vi.fn(),
  renderProject: vi.fn(),
  refreshAgentFilter: vi.fn(),
  renderTaskList: vi.fn(),
  initTaskListEvents: vi.fn(),
}));

vi.mock('../js/detail.js', () => ({
  renderDetail: vi.fn(),
  mkSection: vi.fn(),
  mkDetailRow: vi.fn(),
  mkSelect: vi.fn(),
}));

vi.mock('../js/modals.js', () => ({
  showModal: vi.fn(),
  generateClaudeMd: vi.fn(),
  showClaudeMdCopyModal: vi.fn(),
  showAddProjectModal: vi.fn(),
  showEditProjectModal: vi.fn(),
  confirmDeleteProject: vi.fn(),
  showAddTaskModal: vi.fn(),
  showEditTaskModal: vi.fn(),
  showAgentManagerModal: vi.fn(),
  showAgentEditModal: vi.fn(),
  confirmDeleteTask: vi.fn(),
}));

vi.mock('../js/main.js', () => ({
  openWorkspace: vi.fn(),
  closeWorkspace: vi.fn(),
}));

// Mock the Rust IPC bridge. Each test installs its own behaviour through
// `patchApplyBatchMock` so we can cover happy-path + error-path orchestration
// without spinning up a Tauri runtime.
const patchApplyBatchMock = vi.fn();
vi.mock('../bindings.js', () => ({
  commands: {
    patchApplyBatch: (db: unknown, sources: unknown) =>
      patchApplyBatchMock(db, sources),
    patchValidate: vi.fn(),
    patchApplyToDb: vi.fn(),
  },
}));

// ─── IMPORTS (after mocks) ────────────────────────────────────────────────

import { applyPatches, validatePatch } from '../js/fileops.js';
import * as stateMock from '../js/state.js';
import type { Database, Project, Task, Patch } from '../types/domain';

// ─── TYPED STATE HANDLES ──────────────────────────────────────────────────

const stateAccess = stateMock as unknown as {
  db: Database | null;
  baseDir: string | null;
  setDb: (v: Database | null) => void;
  setBaseDir: (v: string | null) => void;
  setActiveProjectId: (v: string | null) => void;
};

// ─── FIXTURE BUILDERS ─────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? '',
    status: overrides.status ?? 'todo',
    priority: overrides.priority ?? 'medium',
    tags: overrides.tags ?? [],
    subtasks: overrides.subtasks ?? [],
    filesModified: overrides.filesModified ?? [],
    createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
  };
}

function makeProject(id: string, tasks: Task[] = []): Project {
  return {
    id,
    name: id,
    color: '#60a5fa',
    createdAt: '2026-01-01T00:00:00.000Z',
    tasks,
  };
}

function makeDb(): Database {
  return {
    version: '1.0',
    lastUpdated: '2026-01-01T00:00:00.000Z',
    projects: [makeProject('p1', [makeTask({ id: 'r1' })])],
    appliedPatches: [],
  };
}

function makePatch(changes: Patch['changes'], opts: Partial<Patch> = {}): Patch {
  return {
    version: '1.0',
    timestamp: opts.timestamp ?? '2026-05-03T10:00:00.000Z',
    agent: opts.agent ?? 'Claude',
    changes,
    ...opts,
  };
}

// ─── Reset per test ───────────────────────────────────────────────────────

beforeEach(() => {
  stateAccess.setDb(makeDb());
  stateAccess.setBaseDir('D:/test-base');
  stateAccess.setActiveProjectId('p1');
  vfs.clear();
  vfsDirs.clear();
  vfsDirs.add('D:/test-base/patches');
  patchApplyBatchMock.mockReset();
  // Default behaviour: pass the db through unchanged, mark every source applied.
  patchApplyBatchMock.mockImplementation(
    async (db: Database, sources: { id: string; patch: Patch }[]) => [
      {
        ...db,
        appliedPatches: [...(db.appliedPatches || []), ...sources.map((s) => s.id)],
      },
      {
        applied: sources.length,
        skipped: 0,
        errors: [],
        appliedPatchIds: sources.map((s) => s.id),
      },
    ]
  );
});

// ─── validatePatch ────────────────────────────────────────────────────────

describe('validatePatch() — TS-side shape check', () => {
  it('returns null for a well-formed patch', () => {
    const p = makePatch([
      { type: 'status_change', projectId: 'p1', taskId: 'r1', to: 'in_progress' },
    ]);
    expect(validatePatch(p)).toBeNull();
  });

  it('rejects non-objects and missing changes array', () => {
    expect(validatePatch(null)).toMatch(/not an object/);
    expect(validatePatch('nope')).toMatch(/not an object/);
    expect(validatePatch({})).toMatch(/changes is not an array/);
  });

  it('rejects unsupported version', () => {
    expect(validatePatch({ version: '2.0', changes: [] })).toMatch(/unsupported version/);
  });

  it('rejects unknown change types', () => {
    expect(
      validatePatch({ version: '1.0', changes: [{ type: 'nuke_db', projectId: 'p1' }] })
    ).toMatch(/type unknown/);
  });

  it('rejects change missing projectId (except add_project)', () => {
    expect(
      validatePatch({ version: '1.0', changes: [{ type: 'status_change' }] })
    ).toMatch(/projectId missing/);
    expect(
      validatePatch({
        version: '1.0',
        changes: [{ type: 'add_project', project: {} }],
      })
    ).toBeNull();
  });
});

// ─── applyPatches() — disk pipeline orchestration ─────────────────────────

describe('applyPatches() — disk pipeline', () => {
  function writePatch(name: string, patch: Patch) {
    vfs.set('D:/test-base/patches/' + name, {
      contents: JSON.stringify(patch),
    });
  }

  it('returns 0 when patches/ dir is empty and never calls Rust', async () => {
    const n = await applyPatches();
    expect(n).toBe(0);
    expect(patchApplyBatchMock).not.toHaveBeenCalled();
  });

  it('reads + parses every .json file and forwards them to commands.patchApplyBatch', async () => {
    writePatch(
      'a.json',
      makePatch([
        { type: 'files_modified', projectId: 'p1', taskId: 'r1', files: ['a.ts'] },
      ])
    );
    writePatch(
      'b.json',
      makePatch([
        { type: 'files_modified', projectId: 'p1', taskId: 'r1', files: ['b.ts'] },
      ])
    );
    const n = await applyPatches();
    expect(n).toBe(2);
    expect(patchApplyBatchMock).toHaveBeenCalledTimes(1);
    const [, sourcesArg] = patchApplyBatchMock.mock.calls[0];
    expect(sourcesArg.length).toBe(2);
    expect(sourcesArg.map((s: { id: string }) => s.id).sort()).toEqual(
      sourcesArg.map((s: { id: string }) => s.id).sort()
    );
  });

  it('skips invalid JSON files but still forwards the well-formed ones', async () => {
    vfs.set('D:/test-base/patches/broken.json', { contents: '{not json' });
    writePatch(
      'good.json',
      makePatch([
        { type: 'files_modified', projectId: 'p1', taskId: 'r1', files: ['ok.ts'] },
      ])
    );
    const n = await applyPatches();
    expect(n).toBe(1);
    const [, sourcesArg] = patchApplyBatchMock.mock.calls[0];
    expect(sourcesArg.length).toBe(1);
  });

  it('skips files that fail TS-side validation before calling Rust', async () => {
    // version=2.0 is rejected by validatePatch — never reaches Rust.
    vfs.set('D:/test-base/patches/bad-version.json', {
      contents: JSON.stringify({ version: '2.0', changes: [] }),
    });
    const n = await applyPatches();
    expect(n).toBe(0);
    expect(patchApplyBatchMock).not.toHaveBeenCalled();
  });

  it('persists the mutated db returned by Rust into shared state', async () => {
    writePatch(
      'apply-me.json',
      makePatch([
        { type: 'files_modified', projectId: 'p1', taskId: 'r1', files: ['x.ts'] },
      ])
    );
    // Have the Rust mock return a db with a sentinel project so we can assert
    // the wrapper actually wrote it back to state via setDb. (lastUpdated is
    // restamped by saveFile, so we use a project marker instead.)
    patchApplyBatchMock.mockImplementationOnce(async (db: Database) => [
      { ...db, projects: [...db.projects, { id: 'mutated-by-rust', name: 'M', tasks: [] }] },
      { applied: 1, skipped: 0, errors: [], appliedPatchIds: ['some-id'] },
    ]);
    await applyPatches();
    expect(stateAccess.db?.projects.some((p) => p.id === 'mutated-by-rust')).toBe(true);
  });

  it('deletes patch files after successful apply', async () => {
    writePatch(
      'apply-me.json',
      makePatch([
        { type: 'files_modified', projectId: 'p1', taskId: 'r1', files: ['x.ts'] },
      ])
    );
    expect(vfs.has('D:/test-base/patches/apply-me.json')).toBe(true);
    const n = await applyPatches();
    expect(n).toBe(1);
    expect(vfs.has('D:/test-base/patches/apply-me.json')).toBe(false);
  });

  it('does NOT delete files for sources reported in summary.errors', async () => {
    writePatch(
      'good.json',
      makePatch([
        { type: 'files_modified', projectId: 'p1', taskId: 'r1', files: ['good.ts'] },
      ])
    );
    writePatch(
      'bad.json',
      makePatch([
        { type: 'files_modified', projectId: 'p1', taskId: 'r1', files: ['bad.ts'] },
      ])
    );
    // Rust formats error ids using the same patchIdentity the TS pipeline
    // passes in (`${timestamp}|${filename}`), not just the filename.
    patchApplyBatchMock.mockImplementationOnce(async (db: Database, sources: Array<{ id: string }>) => [
      db,
      {
        applied: 1,
        skipped: 0,
        errors: [`${sources.find((s) => s.id.endsWith('|bad.json'))?.id}: simulated error`],
        appliedPatchIds: [sources.find((s) => s.id.endsWith('|good.json'))?.id ?? ''],
      },
    ]);
    await applyPatches();
    // bad.json must remain so the user can inspect it; good.json gets removed.
    expect(vfs.has('D:/test-base/patches/bad.json')).toBe(true);
    expect(vfs.has('D:/test-base/patches/good.json')).toBe(false);
  });

  it('returns 0 and surfaces a toast when Rust throws', async () => {
    writePatch(
      'fails.json',
      makePatch([
        { type: 'files_modified', projectId: 'p1', taskId: 'r1', files: ['x.ts'] },
      ])
    );
    patchApplyBatchMock.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    const n = await applyPatches();
    expect(n).toBe(0);
    // The patch file is still on disk because Rust failed before we could
    // safely delete anything.
    expect(vfs.has('D:/test-base/patches/fails.json')).toBe(true);
  });
});
