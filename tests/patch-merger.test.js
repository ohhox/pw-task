import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { describe, it, expect, beforeEach } from 'vitest';
import { applyPatch, applyPatches, findTaskAnywhere } from './helpers/patch-core.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function fixture(relPath) {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', relPath), 'utf8'));
}

function freshDb() {
  return JSON.parse(JSON.stringify(fixture('with-pending-patches/tasks.json')));
}

function loadPatch(name) {
  return fixture(`with-pending-patches/patches/${name}`);
}

describe('applyPatch — status_change', () => {
  it('changes task status and appends activityLog', () => {
    const db = freshDb();
    const patch = loadPatch('2026-05-02T10-00-00_Claude.json');
    applyPatch(db, patch);

    const task = findTaskAnywhere(db.projects[0].tasks, 'task-p-01');
    expect(task.status).toBe('pending_review');
    expect(task.updatedAt).toBe('2026-05-02T10:00:00.000Z');
    const lastLog = task.activityLog[task.activityLog.length - 1];
    expect(lastLog.agent).toBe('Claude');
    expect(lastLog.action).toContain('pending_review');
  });

  it('sets lastNote when note is provided', () => {
    const db = freshDb();
    applyPatch(db, loadPatch('2026-05-02T10-00-00_Claude.json'));
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-p-01');
    expect(task.lastNote).not.toBeNull();
    expect(task.lastNote.summary).toContain('implement เสร็จ');
    expect(task.lastNote.agent).toBe('Claude');
  });

  it('sets completedAt when changing to done', () => {
    const db = freshDb();
    applyPatch(db, {
      version: '1.0',
      timestamp: '2026-05-02T11:00:00.000Z',
      agent: 'Manual',
      changes: [{
        type: 'status_change',
        projectId: 'proj-patch-001',
        taskId: 'task-p-01',
        from: 'in_progress',
        to: 'done',
        note: 'approved'
      }]
    });
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-p-01');
    expect(task.status).toBe('done');
    expect(task.completedAt).toBe('2026-05-02T11:00:00.000Z');
  });

  it('is a no-op for unknown taskId', () => {
    const db = freshDb();
    const before = JSON.stringify(db);
    applyPatch(db, {
      version: '1.0',
      timestamp: '2026-05-02T10:00:00.000Z',
      agent: 'Claude',
      changes: [{
        type: 'status_change',
        projectId: 'proj-patch-001',
        taskId: 'task-nonexistent',
        from: 'todo',
        to: 'done',
        note: 'x'
      }]
    });
    expect(JSON.stringify(db)).toBe(before);
  });
});

describe('applyPatch — files_modified', () => {
  it('appends files to filesModified', () => {
    const db = freshDb();
    applyPatch(db, loadPatch('2026-05-02T10-00-00_Claude.json'));
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-p-01');
    expect(task.filesModified).toContain('src/feature.ts');
    expect(task.filesModified).toContain('src/feature.test.ts');
  });

  it('deduplicates files on repeated patches', () => {
    const db = freshDb();
    const patch = loadPatch('2026-05-02T10-00-00_Claude.json');
    applyPatch(db, patch);
    applyPatch(db, patch);
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-p-01');
    const count = task.filesModified.filter(f => f === 'src/feature.ts').length;
    expect(count).toBe(1);
  });
});

describe('applyPatch — add_log', () => {
  it('appends log entry to activityLog', () => {
    const db = freshDb();
    applyPatch(db, loadPatch('2026-05-02T10-15-00_Claude.json'));
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-p-02');
    const log = task.activityLog.find(l => l.action === 'เพิ่ม test files 2 ไฟล์');
    expect(log).toBeDefined();
    expect(log.agent).toBe('Claude');
  });
});

describe('applyPatch — add_task', () => {
  it('adds a new root-level task to the project', () => {
    const db = freshDb();
    applyPatch(db, loadPatch('2026-05-02T10-30-00_Claude.json'));
    const task = findTaskAnywhere(db.projects[0].tasks, 'task-p-03');
    expect(task).not.toBeNull();
    expect(task.title).toContain('ใหม่ที่เพิ่มโดย patch');
    expect(task.status).toBe('todo');
  });

  it('does not duplicate an existing task on re-apply', () => {
    const db = freshDb();
    const patch = loadPatch('2026-05-02T10-30-00_Claude.json');
    applyPatch(db, patch);
    applyPatch(db, patch);
    const count = db.projects[0].tasks.filter(t => t.id === 'task-p-03').length;
    expect(count).toBe(1);
  });

  it('adds subtask under parent when parentTaskId is set', () => {
    const db = freshDb();
    applyPatch(db, {
      version: '1.0',
      timestamp: '2026-05-02T11:00:00.000Z',
      agent: 'Claude',
      changes: [{
        type: 'add_task',
        projectId: 'proj-patch-001',
        parentTaskId: 'task-p-01',
        task: {
          id: 'task-p-01-sub',
          title: 'Subtask',
          status: 'todo',
          subtasks: [],
          reviews: []
        }
      }]
    });
    const parent = findTaskAnywhere(db.projects[0].tasks, 'task-p-01');
    const sub = findTaskAnywhere(parent.subtasks, 'task-p-01-sub');
    expect(sub).not.toBeNull();
    expect(sub.title).toBe('Subtask');
  });
});

describe('applyPatches — ordering', () => {
  it('applies all 3 patches and produces correct final state', () => {
    const db = freshDb();
    const patches = [
      loadPatch('2026-05-02T10-00-00_Claude.json'),
      loadPatch('2026-05-02T10-15-00_Claude.json'),
      loadPatch('2026-05-02T10-30-00_Claude.json'),
    ];
    applyPatches(db, patches);

    const taskP01 = findTaskAnywhere(db.projects[0].tasks, 'task-p-01');
    expect(taskP01.status).toBe('pending_review');
    expect(taskP01.filesModified).toContain('src/feature.ts');

    const taskP02 = findTaskAnywhere(db.projects[0].tasks, 'task-p-02');
    expect(taskP02.filesModified).toContain('src/tests/integration.test.ts');
    expect(taskP02.filesModified).toContain('src/tests/unit.test.ts');
    const addedLog = taskP02.activityLog.find(l => l.action === 'เพิ่ม test files 2 ไฟล์');
    expect(addedLog).toBeDefined();

    const taskP03 = findTaskAnywhere(db.projects[0].tasks, 'task-p-03');
    expect(taskP03).not.toBeNull();
    expect(taskP03.status).toBe('todo');
  });

  it('applies patches in timestamp order regardless of array order', () => {
    const db = freshDb();
    const patches = [
      loadPatch('2026-05-02T10-30-00_Claude.json'),
      loadPatch('2026-05-02T10-00-00_Claude.json'),
      loadPatch('2026-05-02T10-15-00_Claude.json'),
    ];
    applyPatches(db, patches);

    const taskP01 = findTaskAnywhere(db.projects[0].tasks, 'task-p-01');
    expect(taskP01.status).toBe('pending_review');
    const taskP03 = findTaskAnywhere(db.projects[0].tasks, 'task-p-03');
    expect(taskP03).not.toBeNull();
  });
});

describe('applyPatch — add_project', () => {
  it('adds a new project to db', () => {
    const db = freshDb();
    applyPatch(db, {
      version: '1.0',
      timestamp: '2026-05-02T12:00:00.000Z',
      agent: 'Manual',
      changes: [{
        type: 'add_project',
        project: {
          id: 'proj-new-001',
          name: 'New Project',
          tasks: []
        }
      }]
    });
    expect(db.projects.find(p => p.id === 'proj-new-001')).toBeDefined();
  });

  it('ignores duplicate project id', () => {
    const db = freshDb();
    applyPatch(db, {
      version: '1.0',
      timestamp: '2026-05-02T12:00:00.000Z',
      agent: 'Manual',
      changes: [{
        type: 'add_project',
        project: { id: 'proj-patch-001', name: 'Duplicate', tasks: [] }
      }]
    });
    const count = db.projects.filter(p => p.id === 'proj-patch-001').length;
    expect(count).toBe(1);
    expect(db.projects.find(p => p.id === 'proj-patch-001').name).toBe('Patch Test Project');
  });
});
