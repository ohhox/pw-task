import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect } from 'vitest';
import { applyPatch, findTaskAnywhere } from './helpers/patch-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixture(relPath) {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', relPath), 'utf8'));
}

function freshLegacy() {
  return JSON.parse(JSON.stringify(fixture('legacy-schema/tasks.json')));
}

function freshCorrupted() {
  return JSON.parse(JSON.stringify(fixture('corrupted/tasks.json')));
}

describe('legacy-schema fixture — loading', () => {
  it('parses without error', () => {
    expect(() => freshLegacy()).not.toThrow();
  });

  it('has version 1.0', () => {
    const db = freshLegacy();
    expect(db.version).toBe('1.0');
  });

  it('has 2 projects', () => {
    const db = freshLegacy();
    expect(db.projects.length).toBe(2);
  });

  it('task missing prompt/model/lastSessionId/runHistory fields still loads', () => {
    const db = freshLegacy();
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-l-01');
    expect(task).not.toBeNull();
    expect(task.prompt).toBeUndefined();
    expect(task.model).toBeUndefined();
    expect(task.lastSessionId).toBeUndefined();
    expect(task.runHistory).toBeUndefined();
  });

  it('task missing activityLog still loads (task-l-02)', () => {
    const db = freshLegacy();
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-l-02');
    expect(task).not.toBeNull();
    expect(task.activityLog).toBeUndefined();
  });

  it('task missing createdAt still loads (task-l-03)', () => {
    const db = freshLegacy();
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-l-03');
    expect(task).not.toBeNull();
    expect(task.createdAt).toBeUndefined();
  });

  it('old-style reviews as string array is preserved as-is (task-l-04)', () => {
    const db = freshLegacy();
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-l-04');
    expect(Array.isArray(task.reviews)).toBe(true);
    expect(typeof task.reviews[0]).toBe('string');
  });

  it('project without goal/workingDir still loads', () => {
    const db = freshLegacy();
    expect(db.projects[0].goal).toBeUndefined();
    expect(db.projects[0].workingDir).toBeUndefined();
  });
});

describe('legacy-schema — applyPatch compatibility', () => {
  it('status_change works on legacy task (no activityLog)', () => {
    const db = freshLegacy();
    applyPatch(db, {
      version: '1.0', timestamp: '2026-05-02T12:00:00.000Z', agent: 'Claude',
      changes: [{
        type: 'status_change',
        projectId: 'proj-legacy-001',
        taskId: 'task-l-02',
        from: 'pending_review',
        to: 'done',
        note: 'approved'
      }]
    });
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-l-02');
    expect(task.status).toBe('done');
    expect(Array.isArray(task.activityLog)).toBe(true);
    expect(task.activityLog.length).toBe(1);
  });

  it('files_modified works on legacy task (no filesModified)', () => {
    const db = freshLegacy();
    applyPatch(db, {
      version: '1.0', timestamp: '2026-05-02T12:00:00.000Z', agent: 'Claude',
      changes: [{
        type: 'files_modified',
        projectId: 'proj-legacy-001',
        taskId: 'task-l-03',
        files: ['src/new-file.ts']
      }]
    });
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-l-03');
    expect(task.filesModified).toContain('src/new-file.ts');
  });

  it('add_log works on task missing activityLog', () => {
    const db = freshLegacy();
    applyPatch(db, {
      version: '1.0', timestamp: '2026-05-02T12:00:00.000Z', agent: 'Claude',
      changes: [{
        type: 'add_log',
        projectId: 'proj-legacy-001',
        taskId: 'task-l-02',
        log: { timestamp: '2026-05-02T12:00:00.000Z', agent: 'Claude', action: 'reviewed' }
      }]
    });
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-l-02');
    expect(Array.isArray(task.activityLog)).toBe(true);
    expect(task.activityLog[0].action).toBe('reviewed');
  });

  it('add_task works on legacy project (no _instructions)', () => {
    const db = freshLegacy();
    applyPatch(db, {
      version: '1.0', timestamp: '2026-05-02T12:00:00.000Z', agent: 'Claude',
      changes: [{
        type: 'add_task',
        projectId: 'proj-legacy-001',
        parentTaskId: null,
        task: {
          id: 'task-l-new',
          title: 'Newly added task',
          status: 'todo',
          subtasks: [],
          reviews: []
        }
      }]
    });
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-l-new');
    expect(task).not.toBeNull();
  });
});

describe('corrupted fixture — loading', () => {
  it('parses without error', () => {
    expect(() => freshCorrupted()).not.toThrow();
  });

  it('preserves unknown status value as-is', () => {
    const db = freshCorrupted();
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-c-01');
    expect(task.status).toBe('unknown_status');
  });

  it('preserves null priority', () => {
    const db = freshCorrupted();
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-c-02');
    expect(task.priority).toBeNull();
  });

  it('handles null subtasks gracefully in findTaskAnywhere', () => {
    const db = freshCorrupted();
    expect(() => findTaskAnywhere(db.projects[0].tasks, 'any-id')).not.toThrow();
  });

  it('status_change on task with null subtasks does not crash', () => {
    const db = freshCorrupted();
    expect(() => applyPatch(db, {
      version: '1.0', timestamp: '2026-05-02T12:00:00.000Z', agent: 'Claude',
      changes: [{
        type: 'status_change',
        projectId: 'proj-corrupt-001',
        taskId: 'task-c-03',
        from: 'todo', to: 'in_progress', note: 'starting'
      }]
    })).not.toThrow();
  });

  it('duplicate project id: patch targets the first matching project', () => {
    const db = freshCorrupted();
    applyPatch(db, {
      version: '1.0', timestamp: '2026-05-02T12:00:00.000Z', agent: 'Claude',
      changes: [{
        type: 'add_task',
        projectId: 'proj-corrupt-001',
        parentTaskId: null,
        task: { id: 'task-dup-new', title: 'Added to first match', status: 'todo', subtasks: [], reviews: [] }
      }]
    });
    const first = db.projects[0];
    const added = findTaskAnywhere(first.tasks, 'task-dup-new');
    expect(added).not.toBeNull();
  });
});

describe('empty fixture', () => {
  it('loads and has empty projects array', () => {
    const db = fixture('empty/tasks.json');
    expect(db.version).toBe('1.0');
    expect(db.projects).toEqual([]);
  });

  it('applyPatch on empty db is a no-op for unknown project', () => {
    const db = fixture('empty/tasks.json');
    expect(() => applyPatch(db, {
      version: '1.0', timestamp: '2026-05-02T12:00:00.000Z', agent: 'Claude',
      changes: [{
        type: 'status_change', projectId: 'nonexistent', taskId: 'x',
        from: 'todo', to: 'done', note: 'x'
      }]
    })).not.toThrow();
  });
});
