// Pure implementations of patch-apply logic — no DOM, no Tauri globals.
// Mirrors src/js/fileops.js::applyPatch + src/js/data.js helpers.

function now() { return new Date().toISOString(); }

export function findTaskAnywhere(tasks, id) {
  for (const t of tasks) {
    if (t.id === id) return t;
    const f = findTaskAnywhere(t.subtasks || [], id);
    if (f) return f;
  }
  return null;
}

export function isFullyDone(task) {
  if (task.status !== 'done') return false;
  return (task.subtasks || []).every(isFullyDone);
}

export function autoEscalate(task) {
  (task.subtasks || []).forEach(autoEscalate);
  const subs = task.subtasks || [];
  if (!subs.length) return;
  const allDone = subs.every(s => s.status === 'done');
  const hasOpen = subs.some(s => ['todo', 'in_progress', 'blocked'].includes(s.status));
  if (allDone && task.status !== 'done' && task.status !== 'pending_review') {
    const old = task.status;
    task.status = 'pending_review';
    task.updatedAt = now();
    (task.activityLog = task.activityLog || []).push({
      timestamp: now(), agent: 'System',
      action: `auto-escalated from ${old} to pending_review (all subtasks done)`
    });
  }
  if (task.status === 'pending_review' && hasOpen) {
    task.status = 'in_progress';
    task.updatedAt = now();
    (task.activityLog = task.activityLog || []).push({
      timestamp: now(), agent: 'System',
      action: 'demoted from pending_review to in_progress (subtask reopened)'
    });
  }
}

// Pure applyPatch: takes db object as first arg (not global).
export function applyPatch(db, patch) {
  for (const change of (patch.changes || [])) {
    const proj = db.projects.find(p => p.id === change.projectId);
    const ts = patch.timestamp || now();
    const agent = patch.agent || 'AI';

    switch (change.type) {
      case 'status_change': {
        const task = proj ? findTaskAnywhere(proj.tasks, change.taskId) : null;
        if (!task) break;
        const old = task.status;
        task.status = change.to;
        task.updatedAt = ts;
        if (change.to === 'done') task.completedAt = ts;
        (task.activityLog = task.activityLog || []).push({
          timestamp: ts, agent,
          action: `changed status from ${old} to ${change.to}${change.note ? ': ' + change.note : ''}`
        });
        if (change.note) task.lastNote = { timestamp: ts, agent, summary: change.note };
        break;
      }
      case 'add_project': {
        if (!change.project) break;
        if (db.projects.find(p => p.id === change.project.id)) break;
        db.projects.push({ tasks: [], ...change.project });
        break;
      }
      case 'add_task': {
        if (!proj) break;
        const task = { reviews: [], subtasks: [], ...change.task };
        if (change.parentTaskId) {
          const parent = findTaskAnywhere(proj.tasks, change.parentTaskId);
          if (parent) {
            if (!findTaskAnywhere(parent.subtasks || [], task.id)) {
              (parent.subtasks = parent.subtasks || []).push(task);
            }
          }
        } else {
          if (!findTaskAnywhere(proj.tasks, task.id)) {
            proj.tasks.push(task);
          }
        }
        break;
      }
      case 'files_modified': {
        const task = proj ? findTaskAnywhere(proj.tasks, change.taskId) : null;
        if (!task) break;
        task.filesModified = [...new Set([...(task.filesModified || []), ...(change.files || [])])];
        task.updatedAt = ts;
        break;
      }
      case 'add_log': {
        const task = proj ? findTaskAnywhere(proj.tasks, change.taskId) : null;
        if (!task) break;
        (task.activityLog = task.activityLog || []).push(change.log);
        break;
      }
    }
  }
  db.projects.forEach(p => (p.tasks || []).forEach(autoEscalate));
  return db;
}

export function applyPatches(db, patches) {
  [...patches]
    .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''))
    .forEach(p => applyPatch(db, p));
  return db;
}
