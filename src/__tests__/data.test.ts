// Unit tests for src/js/data.ts pure helpers.
// Phase 1.2.1 — Vitest setup + first unit tests (task-t-phase1-02-01).
//
// The state module exports live `let` bindings (`db`, `activeProjectId`).
// We mock it so we control db/activeProjectId per test via setDb / setActiveProjectId.
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock state BEFORE importing data — vi.mock is hoisted by Vitest.
vi.mock('../js/state.js', () => {
  const mod: {
    db: unknown;
    activeProjectId: string | null;
    setDb: (v: unknown) => void;
    setActiveProjectId: (v: string | null) => void;
  } = {
    db: null,
    activeProjectId: null,
    setDb(v: unknown) {
      mod.db = v;
    },
    setActiveProjectId(v: string | null) {
      mod.activeProjectId = v;
    },
  };
  return mod;
});

import {
  uuid,
  esc,
  statusLabel,
  modelShortName,
  modelBadgeClass,
  fmtDate,
  patchFileName,
  sanitizeLinkUrl,
  renderMd,
  getProject,
  findTaskByPath,
  findTaskAnywhere,
  findTaskInProject,
  calcProgress,
  countAll,
  countDone,
  isFullyDone,
  autoEscalate,
  countByStatus,
  globalCount,
  findNextRunnablePath,
  joinPath,
  safePathJoin,
  isSafeTaskId,
} from '../js/data.js';
import * as stateMock from '../js/state.js';
import type { Task, Project, Database } from '../types/domain';

// Local helper: build a minimal Task with required fields filled in.
function makeTask(overrides: Partial<Task> & { id: string; status?: Task['status'] }): Task {
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
    activityLog: overrides.activityLog,
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

const setDb = (stateMock as unknown as { setDb: (v: Database | null) => void }).setDb;
const setActiveProjectId = (
  stateMock as unknown as { setActiveProjectId: (v: string | null) => void }
).setActiveProjectId;

beforeEach(() => {
  setDb(null);
  setActiveProjectId(null);
});

// ─── uuid ────────────────────────────────────────────────────────────────
describe('uuid()', () => {
  it('returns valid uuid v4 format', () => {
    const id = uuid();

    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );
  });

  it('produces no collisions across 1000 calls', () => {
    const ids = new Set<string>();

    for (let i = 0; i < 1000; i++) ids.add(uuid());

    expect(ids.size).toBe(1000);
  });
});

// ─── esc ─────────────────────────────────────────────────────────────────
describe('esc()', () => {
  it('escapes &, <, >, and " for safe HTML interpolation', () => {
    const input = '<script>alert("x&y")</script>';

    const out = esc(input);

    expect(out).toBe('&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;');
  });

  it('coerces null/undefined to empty string (no throw)', () => {
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });
});

// ─── statusLabel ────────────────────────────────────────────────────────
describe('statusLabel()', () => {
  it('returns human label for known statuses', () => {
    expect(statusLabel('pending_review')).toBe('Pending Review');
    expect(statusLabel('in_progress')).toBe('In Progress');
    expect(statusLabel('done')).toBe('Done');
  });

  it('falls back to the raw key for unknown statuses', () => {
    expect(statusLabel('mystery')).toBe('mystery');
  });
});

// ─── modelShortName / modelBadgeClass ───────────────────────────────────
describe('modelShortName()', () => {
  it('maps known model id to display label', () => {
    expect(modelShortName('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(modelShortName('claude-opus-4-7')).toBe('Opus 4.7');
  });

  it('handles unknown models by stripping unsafe characters', () => {
    const out = modelShortName('weird-model-<svg>');

    // Last two segments joined with " ", with characters outside [\w\s.+-] removed
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
  });

  it('returns a safe default for null/empty input', () => {
    expect(modelShortName(null)).toBe('unknown');
    expect(modelShortName('')).toBe('unknown');
  });
});

describe('modelBadgeClass()', () => {
  it('classifies haiku, opus, and falls back to sonnet', () => {
    expect(modelBadgeClass('claude-haiku-4-5-20251001')).toBe('model-haiku');
    expect(modelBadgeClass('claude-opus-4-7')).toBe('model-opus');
    expect(modelBadgeClass('claude-sonnet-4-6')).toBe('model-sonnet');
    expect(modelBadgeClass(null)).toBe('model-sonnet');
  });
});

// ─── fmtDate ────────────────────────────────────────────────────────────
describe('fmtDate()', () => {
  it('returns em-dash for null/undefined input', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate(undefined)).toBe('—');
  });

  it('formats a valid ISO string into a non-empty locale string', () => {
    const out = fmtDate('2026-05-03T10:30:00.000Z');

    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});

// ─── patchFileName ──────────────────────────────────────────────────────
describe('patchFileName()', () => {
  it('produces YYYY-MM-DDTHH-MM-SS_<suffix>.json', () => {
    const name = patchFileName('Claude');

    expect(name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_Claude\.json$/);
  });
});

// ─── sanitizeLinkUrl ────────────────────────────────────────────────────
describe('sanitizeLinkUrl()', () => {
  it('allows http and https URLs', () => {
    expect(sanitizeLinkUrl('http://example.com')).toBe('http://example.com');
    expect(sanitizeLinkUrl('https://example.com/path?q=1')).toBe('https://example.com/path?q=1');
  });

  it('blocks javascript:, data:, vbscript: and other unsafe schemes', () => {
    expect(sanitizeLinkUrl('javascript:alert(1)')).toBe('#');
    expect(sanitizeLinkUrl('JaVaScRiPt:alert(1)')).toBe('#');
    expect(sanitizeLinkUrl('data:text/html,<script>alert(1)</script>')).toBe('#');
    expect(sanitizeLinkUrl('vbscript:msgbox(1)')).toBe('#');
    expect(sanitizeLinkUrl('file:///etc/passwd')).toBe('#');
  });

  it('encodes embedded double-quotes to prevent attribute breakout', () => {
    const out = sanitizeLinkUrl('https://example.com/"onerror=alert(1)');

    expect(out).not.toContain('"');
    expect(out).toContain('%22');
  });

  it('returns # for empty/null input', () => {
    expect(sanitizeLinkUrl('')).toBe('#');
    // sanitizeLinkUrl coerces via String(url || '')
    expect(sanitizeLinkUrl(null as unknown as string)).toBe('#');
  });
});

// ─── renderMd ───────────────────────────────────────────────────────────
describe('renderMd()', () => {
  it('returns "No description" placeholder for empty input', () => {
    const out = renderMd('');

    expect(out).toContain('No description');
  });

  it('falls back to escaped <pre> when marked CDN global is absent', () => {
    // In Node/happy-dom test env there is no global `marked`, so we exercise the fallback.
    const out = renderMd('# Header\n**bold** & <script>alert(1)</script>');

    // Falls back to safe escape — no live <script>, & gets escaped
    expect(out).toContain('<pre');
    expect(out).not.toContain('<script>alert(1)</script>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&amp;');
  });

  it('escapes potential XSS payloads in fallback mode', () => {
    const out = renderMd('<img src=x onerror=alert(1)>');

    expect(out).not.toMatch(/<img[^>]*onerror/);
    expect(out).toContain('&lt;img');
  });
});

// ─── getProject / findTaskByPath / findTaskAnywhere / findTaskInProject ─
describe('task lookup helpers', () => {
  function seedDb(): { db: Database; proj: Project; root: Task; child: Task; grand: Task } {
    const grand = makeTask({ id: 'g1', status: 'done' });
    const child = makeTask({ id: 'c1', status: 'in_progress', subtasks: [grand] });
    const root = makeTask({ id: 'r1', status: 'todo', subtasks: [child] });
    const proj = makeProject('p1', [root]);
    const db: Database = {
      lastUpdated: '2026-01-01T00:00:00.000Z',
      projects: [proj],
    };
    return { db, proj, root, child, grand };
  }

  it('getProject returns undefined when db is null', () => {
    expect(getProject('p1')).toBeUndefined();
  });

  it('getProject returns matching project when db is loaded', () => {
    const { db } = seedDb();
    setDb(db);

    expect(getProject('p1')?.id).toBe('p1');
    expect(getProject('missing')).toBeUndefined();
  });

  it('findTaskByPath returns null when no path or no active project', () => {
    expect(findTaskByPath(null)).toBeNull();
    expect(findTaskByPath([])).toBeNull();

    const { db } = seedDb();
    setDb(db);
    setActiveProjectId(null);

    expect(findTaskByPath(['r1'])).toBeNull();
  });

  it('findTaskByPath walks nested 3 levels deep', () => {
    const { db } = seedDb();
    setDb(db);
    setActiveProjectId('p1');

    expect(findTaskByPath(['r1'])?.id).toBe('r1');
    expect(findTaskByPath(['r1', 'c1'])?.id).toBe('c1');
    expect(findTaskByPath(['r1', 'c1', 'g1'])?.id).toBe('g1');
  });

  it('findTaskByPath returns null on broken path', () => {
    const { db } = seedDb();
    setDb(db);
    setActiveProjectId('p1');

    expect(findTaskByPath(['r1', 'nope'])).toBeNull();
  });

  it('findTaskAnywhere finds tasks in a flat array', () => {
    const t = makeTask({ id: 'a' });

    expect(findTaskAnywhere([t], 'a')?.id).toBe('a');
  });

  it('findTaskAnywhere finds tasks 3 levels deep', () => {
    const { proj, grand } = seedDb();

    expect(findTaskAnywhere(proj.tasks, 'g1')).toBe(grand);
  });

  it('findTaskAnywhere returns null for missing id', () => {
    const { proj } = seedDb();

    expect(findTaskAnywhere(proj.tasks, 'ghost')).toBeNull();
  });

  it('findTaskInProject returns null when project missing', () => {
    expect(findTaskInProject('nope', 'r1')).toBeNull();
  });

  it('findTaskInProject finds nested task within named project', () => {
    const { db } = seedDb();
    setDb(db);

    expect(findTaskInProject('p1', 'g1')?.id).toBe('g1');
  });
});

// ─── calcProgress / countAll / countDone ────────────────────────────────
describe('progress helpers', () => {
  it('calcProgress returns null for a leaf (no subtasks)', () => {
    const t = makeTask({ id: 't1' });

    expect(calcProgress(t)).toBeNull();
  });

  it('calcProgress is 0 when no subtask is done', () => {
    const t = makeTask({
      id: 't1',
      subtasks: [makeTask({ id: 'a' }), makeTask({ id: 'b' })],
    });

    expect(calcProgress(t)).toBe(0);
  });

  it('calcProgress is between 0 and 100 for partial completion', () => {
    const t = makeTask({
      id: 't1',
      subtasks: [
        makeTask({ id: 'a', status: 'done' }),
        makeTask({ id: 'b', status: 'todo' }),
      ],
    });

    const pct = calcProgress(t);

    expect(pct).toBe(50);
  });

  it('calcProgress is 100 when all (recursive) tasks done', () => {
    const t = makeTask({
      id: 't1',
      subtasks: [
        makeTask({
          id: 'a',
          status: 'done',
          subtasks: [makeTask({ id: 'a1', status: 'done' })],
        }),
        makeTask({ id: 'b', status: 'done' }),
      ],
    });

    expect(calcProgress(t)).toBe(100);
  });

  it('countAll / countDone walk the whole tree', () => {
    const tasks: Task[] = [
      makeTask({
        id: 'r',
        status: 'done',
        subtasks: [
          makeTask({ id: 'c1', status: 'done' }),
          makeTask({ id: 'c2', status: 'todo' }),
        ],
      }),
    ];

    expect(countAll(tasks)).toBe(3);
    expect(countDone(tasks)).toBe(2);
  });
});

// ─── isFullyDone ────────────────────────────────────────────────────────
describe('isFullyDone()', () => {
  it('returns false if the parent itself is not done', () => {
    const t = makeTask({ id: 't', status: 'in_progress' });

    expect(isFullyDone(t)).toBe(false);
  });

  it('returns true when parent done and no subtasks', () => {
    const t = makeTask({ id: 't', status: 'done' });

    expect(isFullyDone(t)).toBe(true);
  });

  it('returns false when any descendant is not done', () => {
    const t = makeTask({
      id: 't',
      status: 'done',
      subtasks: [
        makeTask({
          id: 'c',
          status: 'done',
          subtasks: [makeTask({ id: 'g', status: 'todo' })],
        }),
      ],
    });

    expect(isFullyDone(t)).toBe(false);
  });

  it('returns true when entire subtree is done', () => {
    const t = makeTask({
      id: 't',
      status: 'done',
      subtasks: [
        makeTask({
          id: 'c',
          status: 'done',
          subtasks: [makeTask({ id: 'g', status: 'done' })],
        }),
      ],
    });

    expect(isFullyDone(t)).toBe(true);
  });
});

// ─── autoEscalate ───────────────────────────────────────────────────────
describe('autoEscalate()', () => {
  it('forward: parent → pending_review when all subtasks done', () => {
    const t = makeTask({
      id: 'p',
      status: 'in_progress',
      subtasks: [
        makeTask({ id: 'a', status: 'done' }),
        makeTask({ id: 'b', status: 'done' }),
      ],
    });

    autoEscalate(t);

    expect(t.status).toBe('pending_review');
    expect(t.activityLog?.[0]?.action).toMatch(/auto-escalated/);
  });

  it('does not escalate parent already done', () => {
    const t = makeTask({
      id: 'p',
      status: 'done',
      subtasks: [makeTask({ id: 'a', status: 'done' })],
    });

    autoEscalate(t);

    expect(t.status).toBe('done');
  });

  it('reverse: parent demoted from pending_review when subtask reopened', () => {
    const t = makeTask({
      id: 'p',
      status: 'pending_review',
      subtasks: [
        makeTask({ id: 'a', status: 'done' }),
        makeTask({ id: 'b', status: 'in_progress' }),
      ],
    });

    autoEscalate(t);

    expect(t.status).toBe('in_progress');
    expect(t.activityLog?.some((l) => /demoted/.test(l.action))).toBe(true);
  });

  it('leaf task with no subtasks is left untouched', () => {
    const t = makeTask({ id: 'leaf', status: 'todo' });

    autoEscalate(t);

    expect(t.status).toBe('todo');
    expect(t.activityLog).toBeUndefined();
  });
});

// ─── countByStatus / globalCount ─────────────────────────────────────────
describe('countByStatus / globalCount', () => {
  it('countByStatus tallies recursively across nested subtasks', () => {
    const tasks: Task[] = [
      makeTask({
        id: 'a',
        status: 'todo',
        subtasks: [
          makeTask({ id: 'a1', status: 'done' }),
          makeTask({ id: 'a2', status: 'in_progress' }),
        ],
      }),
      makeTask({ id: 'b', status: 'blocked' }),
    ];

    const c = countByStatus(tasks);

    expect(c.todo).toBe(1);
    expect(c.done).toBe(1);
    expect(c.in_progress).toBe(1);
    expect(c.blocked).toBe(1);
    expect(c.pending_review).toBe(0);
  });

  it('globalCount returns zeroed counts when db is null', () => {
    const c = globalCount();

    expect(c).toEqual({
      todo: 0,
      in_progress: 0,
      pending_review: 0,
      done: 0,
      blocked: 0,
    });
  });

  it('globalCount sums across all projects when db is loaded', () => {
    const db: Database = {
      lastUpdated: '2026-01-01T00:00:00.000Z',
      projects: [
        makeProject('p1', [makeTask({ id: 't1', status: 'done' })]),
        makeProject('p2', [
          makeTask({ id: 't2', status: 'todo' }),
          makeTask({ id: 't3', status: 'done' }),
        ]),
      ],
    };
    setDb(db);

    const c = globalCount();

    expect(c.done).toBe(2);
    expect(c.todo).toBe(1);
  });
});

// ─── findNextRunnablePath ───────────────────────────────────────────────
describe('findNextRunnablePath()', () => {
  it('returns null when no runnable subtasks', () => {
    const t = makeTask({ id: 'r', subtasks: [] });

    expect(findNextRunnablePath(t, ['r'])).toBeNull();
  });

  it('returns the path of the first non-done leaf', () => {
    const t = makeTask({
      id: 'r',
      subtasks: [
        makeTask({ id: 'a', status: 'done' }),
        makeTask({
          id: 'b',
          status: 'in_progress',
          subtasks: [makeTask({ id: 'b1', status: 'todo' })],
        }),
      ],
    });

    expect(findNextRunnablePath(t, ['r'])).toEqual(['r', 'b', 'b1']);
  });
});

// ─── joinPath / safePathJoin / isSafeTaskId ─────────────────────────────
describe('joinPath()', () => {
  it('joins base and file with a forward slash, stripping trailing separators', () => {
    expect(joinPath('/tmp/', 'a.txt')).toBe('/tmp/a.txt');
    expect(joinPath('C:\\foo\\', 'a.txt')).toBe('C:\\foo/a.txt');
  });
});

describe('safePathJoin()', () => {
  it('joins safe relative segments', () => {
    expect(safePathJoin('/tmp', 'a.txt')).toBe('/tmp/a.txt');
    expect(safePathJoin('/tmp', 'sub/a.txt')).toBe('/tmp/sub/a.txt');
  });

  it('throws on path traversal (..)', () => {
    expect(() => safePathJoin('/tmp', '../etc/passwd')).toThrow(/traversal/);
    expect(() => safePathJoin('/tmp', 'sub/../../escape')).toThrow(/traversal/);
  });

  it('throws on absolute paths and Windows drive letters', () => {
    expect(() => safePathJoin('/tmp', '/etc/passwd')).toThrow(/traversal/);
    expect(() => safePathJoin('/tmp', '\\windows\\system32')).toThrow(/traversal/);
    expect(() => safePathJoin('/tmp', 'C:\\Windows')).toThrow(/traversal/);
  });
});

describe('isSafeTaskId()', () => {
  it('accepts well-formed task IDs', () => {
    expect(isSafeTaskId('task-abc-123')).toBe(true);
    expect(isSafeTaskId('proj_test_01')).toBe(true);
    expect(isSafeTaskId('a')).toBe(true);
  });

  it('rejects IDs with traversal, spaces, or unsafe characters', () => {
    expect(isSafeTaskId('../etc')).toBe(false);
    expect(isSafeTaskId('with space')).toBe(false);
    expect(isSafeTaskId('a/b')).toBe(false);
    expect(isSafeTaskId('task!')).toBe(false);
  });

  it('rejects non-strings and empty/oversized inputs', () => {
    expect(isSafeTaskId(null)).toBe(false);
    expect(isSafeTaskId(undefined)).toBe(false);
    expect(isSafeTaskId(123)).toBe(false);
    expect(isSafeTaskId('')).toBe(false);
    expect(isSafeTaskId('a'.repeat(129))).toBe(false);
  });
});
