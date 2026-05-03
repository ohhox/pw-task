import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { applyPatch, autoEscalate, isFullyDone, findTaskAnywhere } from './helpers/patch-core.js';

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

describe('mixed-status fixture — initial state', () => {
  it('has one task per status', () => {
    const db = freshMixed();
    const tasks = db.projects[0].tasks;
    const byStatus = Object.fromEntries(tasks.map(t => [t.status, t]));
    expect(byStatus.todo).toBeDefined();
    expect(byStatus.in_progress).toBeDefined();
    expect(byStatus.pending_review).toBeDefined();
    expect(byStatus.done).toBeDefined();
    expect(byStatus.blocked).toBeDefined();
  });

  it('done task has completedAt', () => {
    const db = freshMixed();
    const done = db.projects[0].tasks.find(t => t.status === 'done');
    expect(done.completedAt).toBeDefined();
  });

  it('pending_review task has lastNote', () => {
    const db = freshMixed();
    const pr = db.projects[0].tasks.find(t => t.status === 'pending_review');
    expect(pr.lastNote).not.toBeNull();
    expect(pr.lastNote.summary).toBeTruthy();
  });
});

describe('status_change via applyPatch', () => {
  it('todo → in_progress', () => {
    const db = freshMixed();
    applyPatch(db, {
      version: '1.0', timestamp: '2026-05-02T12:00:00.000Z', agent: 'Claude',
      changes: [{
        type: 'status_change', projectId: 'proj-mix-001', taskId: 'task-m-01',
        from: 'todo', to: 'in_progress', note: 'starting work'
      }]
    });
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-m-01');
    expect(task.status).toBe('in_progress');
  });

  it('in_progress → pending_review', () => {
    const db = freshMixed();
    applyPatch(db, {
      version: '1.0', timestamp: '2026-05-02T12:00:00.000Z', agent: 'Claude',
      changes: [{
        type: 'status_change', projectId: 'proj-mix-001', taskId: 'task-m-02',
        from: 'in_progress', to: 'pending_review', note: 'feature done'
      }]
    });
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-m-02');
    expect(task.status).toBe('pending_review');
    expect(task.lastNote.summary).toBe('feature done');
  });

  it('blocked → in_progress (unblocked)', () => {
    const db = freshMixed();
    applyPatch(db, {
      version: '1.0', timestamp: '2026-05-02T12:00:00.000Z', agent: 'Manual',
      changes: [{
        type: 'status_change', projectId: 'proj-mix-001', taskId: 'task-m-05',
        from: 'blocked', to: 'in_progress', note: 'API key received'
      }]
    });
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-m-05');
    expect(task.status).toBe('in_progress');
  });

  it('status_change records previous status in activityLog', () => {
    const db = freshMixed();
    applyPatch(db, {
      version: '1.0', timestamp: '2026-05-02T12:00:00.000Z', agent: 'Claude',
      changes: [{
        type: 'status_change', projectId: 'proj-mix-001', taskId: 'task-m-01',
        from: 'todo', to: 'in_progress', note: 'x'
      }]
    });
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-m-01');
    const log = task.activityLog[task.activityLog.length - 1];
    expect(log.action).toContain('todo');
    expect(log.action).toContain('in_progress');
  });
});

describe('autoEscalate — escalation', () => {
  it('escalates in_progress parent to pending_review when all subtasks done', () => {
    const parent = {
      id: 'p1', status: 'in_progress',
      subtasks: [
        { id: 's1', status: 'done', subtasks: [] },
        { id: 's2', status: 'done', subtasks: [] },
      ]
    };
    autoEscalate(parent);
    expect(parent.status).toBe('pending_review');
    const log = parent.activityLog[parent.activityLog.length - 1];
    expect(log.action).toContain('auto-escalated');
  });

  it('does not escalate when some subtasks are not done', () => {
    const parent = {
      id: 'p1', status: 'in_progress',
      subtasks: [
        { id: 's1', status: 'done', subtasks: [] },
        { id: 's2', status: 'todo', subtasks: [] },
      ]
    };
    autoEscalate(parent);
    expect(parent.status).toBe('in_progress');
  });

  it('does not escalate when parent is already done', () => {
    const parent = {
      id: 'p1', status: 'done',
      subtasks: [
        { id: 's1', status: 'done', subtasks: [] },
      ]
    };
    autoEscalate(parent);
    expect(parent.status).toBe('done');
    expect(parent.activityLog).toBeUndefined();
  });

  it('demotes pending_review to in_progress when a subtask is reopened', () => {
    const parent = {
      id: 'p1', status: 'pending_review',
      subtasks: [
        { id: 's1', status: 'done', subtasks: [] },
        { id: 's2', status: 'todo', subtasks: [] },
      ]
    };
    autoEscalate(parent);
    expect(parent.status).toBe('in_progress');
    const log = parent.activityLog[parent.activityLog.length - 1];
    expect(log.action).toContain('demoted');
  });

  it('escalates child when all its subtasks are done; parent waits until child reaches done', () => {
    const grandchild = { id: 'gc1', status: 'done', subtasks: [] };
    const child = { id: 'c1', status: 'in_progress', subtasks: [grandchild] };
    const parent = { id: 'p1', status: 'in_progress', subtasks: [child] };
    autoEscalate(parent);
    // child escalates to pending_review (all its subtasks are done)
    expect(child.status).toBe('pending_review');
    // parent stays in_progress because child is pending_review, not done
    expect(parent.status).toBe('in_progress');
  });
});

describe('autoEscalate — nested-subtasks fixture', () => {
  it('leaves parent in_progress when not all subtasks are done', () => {
    const db = freshNested();
    const parent = db.projects[0].tasks[0];
    autoEscalate(parent);
    expect(parent.status).toBe('in_progress');
  });
});

describe('isFullyDone', () => {
  it('returns true for a leaf task with status done', () => {
    expect(isFullyDone({ status: 'done', subtasks: [] })).toBe(true);
  });

  it('returns false for todo leaf', () => {
    expect(isFullyDone({ status: 'todo', subtasks: [] })).toBe(false);
  });

  it('returns false when parent is done but subtask is not', () => {
    const task = {
      status: 'done',
      subtasks: [{ status: 'todo', subtasks: [] }]
    };
    expect(isFullyDone(task)).toBe(false);
  });

  it('returns true when parent and all nested subtasks are done', () => {
    const task = {
      status: 'done',
      subtasks: [
        { status: 'done', subtasks: [{ status: 'done', subtasks: [] }] }
      ]
    };
    expect(isFullyDone(task)).toBe(true);
  });
});

describe('findTaskAnywhere', () => {
  it('finds a root task', () => {
    const db = freshMixed();
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-m-03');
    expect(task).not.toBeNull();
    expect(task.id).toBe('task-m-03');
  });

  it('finds a deeply nested subtask', () => {
    const db = freshNested();
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-n-01-01-02');
    expect(task).not.toBeNull();
    expect(task.id).toBe('task-n-01-01-02');
  });

  it('returns null for unknown id', () => {
    const db = freshMixed();
    expect(findTaskAnywhere(db.projects[0].tasks, 'no-such-task')).toBeNull();
  });
});
