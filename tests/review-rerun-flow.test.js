import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { applyPatch, isFullyDone, findTaskAnywhere } from './helpers/patch-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixture(relPath) {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', relPath), 'utf8'));
}

function freshMixed() {
  return JSON.parse(JSON.stringify(fixture('mixed-status/tasks.json')));
}

function freshNested() {
  return JSON.parse(JSON.stringify(fixture('nested-subtasks/tasks.json')));
}

const PROJ = 'proj-mix-001';

function statusPatch(taskId, from, to, note = 'test') {
  return {
    version: '1.0',
    timestamp: '2026-05-02T15:00:00.000Z',
    agent: 'Manual',
    changes: [{ type: 'status_change', projectId: PROJ, taskId, from, to, note }]
  };
}

describe('approve flow (pending_review → done)', () => {
  it('sets status to done', () => {
    const db = freshMixed();
    applyPatch(db, statusPatch('task-m-03', 'pending_review', 'done', 'looks good'));
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-m-03');
    expect(task.status).toBe('done');
  });

  it('sets completedAt on approve', () => {
    const db = freshMixed();
    applyPatch(db, statusPatch('task-m-03', 'pending_review', 'done', 'approved'));
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-m-03');
    expect(task.completedAt).toBe('2026-05-02T15:00:00.000Z');
  });

  it('records note in lastNote on approve', () => {
    const db = freshMixed();
    applyPatch(db, statusPatch('task-m-03', 'pending_review', 'done', 'approved by PM'));
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-m-03');
    expect(task.lastNote.summary).toBe('approved by PM');
    expect(task.lastNote.agent).toBe('Manual');
  });

  it('activityLog shows pending_review → done transition', () => {
    const db = freshMixed();
    applyPatch(db, statusPatch('task-m-03', 'pending_review', 'done', 'ok'));
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-m-03');
    const log = task.activityLog[task.activityLog.length - 1];
    expect(log.action).toContain('pending_review');
    expect(log.action).toContain('done');
  });
});

describe('request changes flow (pending_review → in_progress)', () => {
  it('sets status back to in_progress', () => {
    const db = freshMixed();
    applyPatch(db, statusPatch('task-m-03', 'pending_review', 'in_progress', 'need more tests'));
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-m-03');
    expect(task.status).toBe('in_progress');
  });

  it('records review feedback in lastNote', () => {
    const db = freshMixed();
    applyPatch(db, statusPatch('task-m-03', 'pending_review', 'in_progress', 'missing edge case handling'));
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-m-03');
    expect(task.lastNote.summary).toBe('missing edge case handling');
  });

  it('can re-submit for review after changes', () => {
    const db = freshMixed();
    applyPatch(db, statusPatch('task-m-03', 'pending_review', 'in_progress', 'needs work'));
    applyPatch(db, statusPatch('task-m-03', 'in_progress', 'pending_review', 'fixed edge cases'));
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-m-03');
    expect(task.status).toBe('pending_review');
    expect(task.lastNote.summary).toBe('fixed edge cases');
  });
});

describe('rerun flow (todo/in_progress cycle)', () => {
  it('can go from todo → in_progress → pending_review in sequence', () => {
    const db = freshMixed();
    applyPatch(db, statusPatch('task-m-01', 'todo', 'in_progress', 'starting'));
    applyPatch(db, statusPatch('task-m-01', 'in_progress', 'pending_review', 'done'));

    const task = findTaskAnywhere(db.projects[0].tasks, 'task-m-01');
    expect(task.status).toBe('pending_review');
    expect(task.activityLog.length).toBeGreaterThanOrEqual(3);
  });

  it('full cycle: todo → in_progress → pending_review → done', () => {
    const db = freshMixed();
    const steps = [
      statusPatch('task-m-01', 'todo', 'in_progress', 'start'),
      statusPatch('task-m-01', 'in_progress', 'pending_review', 'done'),
      { ...statusPatch('task-m-01', 'pending_review', 'done', 'approved'), agent: 'Manual' }
    ];
    steps.forEach(p => applyPatch(db, p));
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-m-01');
    expect(task.status).toBe('done');
    expect(task.completedAt).toBeDefined();
  });

  it('blocked task can be unblocked and completed', () => {
    const db = freshMixed();
    applyPatch(db, statusPatch('task-m-05', 'blocked', 'in_progress', 'unblocked: got API key'));
    applyPatch(db, statusPatch('task-m-05', 'in_progress', 'pending_review', 'integration done'));
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-m-05');
    expect(task.status).toBe('pending_review');
  });
});

describe('isFullyDone — review context', () => {
  it('nested-subtasks parent is not fully done (subtask-n-01-03 is todo)', () => {
    const db = freshNested();
    const parent = db.projects[0].tasks[0];
    expect(isFullyDone(parent)).toBe(false);
  });

  it('after approving all pending subtasks, parent becomes fully done', () => {
    const db = freshNested();
    const proj = 'proj-nest-001';
    applyPatch(db, {
      version: '1.0', timestamp: '2026-05-02T15:00:00.000Z', agent: 'Manual',
      changes: [
        { type: 'status_change', projectId: proj, taskId: 'task-n-01-02', from: 'pending_review', to: 'done', note: 'ok' },
        { type: 'status_change', projectId: proj, taskId: 'task-n-01-03', from: 'todo', to: 'done', note: 'ok' },
        { type: 'status_change', projectId: proj, taskId: 'task-n-01', from: 'in_progress', to: 'done', note: 'ok' },
      ]
    });
    const parent = db.projects[0].tasks[0];
    expect(isFullyDone(parent)).toBe(true);
  });
});

describe('add_log for review comments', () => {
  it('adds review comment as activityLog entry', () => {
    const db = freshMixed();
    applyPatch(db, {
      version: '1.0', timestamp: '2026-05-02T15:00:00.000Z', agent: 'Manual',
      changes: [{
        type: 'add_log',
        projectId: PROJ,
        taskId: 'task-m-03',
        log: {
          timestamp: '2026-05-02T15:00:00.000Z',
          agent: 'Manual',
          action: 'review comment: please add unit tests for edge cases'
        }
      }]
    });
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-m-03');
    const log = task.activityLog.find(l => l.action.includes('edge cases'));
    expect(log).toBeDefined();
    expect(log.agent).toBe('Manual');
  });
});
