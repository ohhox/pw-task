// ─── ROUTING ─────────────────────────────────────────────────────────────────
// Hash-based URL routing: #p=<projectId>&t=<task/path>
// Lets users bookmark or share a specific project + task selection.
// Restoration runs on pwtask:ready (after db load) and on hashchange.
import { db, setActiveProjectId, setSelectedTaskPath } from './state.js';
import { renderSidebar, renderProject } from './render.js';
import { renderDetail } from './detail.js';

// ─── Write hash ───────────────────────────────────────────────────────────────

export function updateHash(projectId: string | null, taskPath: string[] | null): void {
  const parts: string[] = [];
  if (projectId) parts.push(`p=${encodeURIComponent(projectId)}`);
  if (taskPath?.length) parts.push(`t=${encodeURIComponent(taskPath.join('/'))}`);
  const hash = parts.length ? '#' + parts.join('&') : location.pathname + location.search;
  history.replaceState(null, '', hash);
}

// ─── Restore from hash ────────────────────────────────────────────────────────

function restoreFromHash(): void {
  const raw = location.hash.slice(1);
  if (!raw || !db) return;
  const params = new URLSearchParams(raw);
  const projId = params.get('p');
  const taskStr = params.get('t');
  if (!projId) return;

  const proj = db.projects.find((p) => p.id === projId);
  if (!proj) return;

  setActiveProjectId(projId);
  renderSidebar();

  if (taskStr) {
    const path = taskStr.split('/').filter(Boolean);
    setSelectedTaskPath(path);
    renderProject();
    // Open drawer after render so the detail-panel element is populated
    requestAnimationFrame(() => {
      const panel = document.getElementById('detail-panel');
      const backdrop = document.getElementById('drawer-backdrop');
      if (panel && backdrop) {
        panel.style.display = 'flex';
        backdrop.style.display = 'block';
        requestAnimationFrame(() => {
          panel.classList.add('open');
          backdrop.classList.add('open');
        });
      }
      renderDetail();
    });
  } else {
    setSelectedTaskPath(null);
    renderProject();
  }
}

// ─── Init (call once from main.ts) ───────────────────────────────────────────

export function initRouting(): void {
  // Restore selection when db is ready (dispatched from fileops.loadFromDir)
  window.addEventListener('pwtask:ready', restoreFromHash as EventListener);
  // Restore when user navigates back/forward with browser buttons
  window.addEventListener('hashchange', restoreFromHash);
}
