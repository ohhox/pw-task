// ─── DATA ────────────────────────────────────────────────────────────────────
// Owns: pure helpers (uuid, date, escaping), task lookup/traversal, progress
//       calculation, model metadata, and Markdown rendering.
// Does NOT: touch DOM beyond the toast helper, call Tauri, or mutate state.
import { db, activeProjectId } from './state.js';
import type { Task, Project, TaskStatus } from '../types/domain';

// `marked` is loaded from CDN as a global script tag — declare for TS.
declare const marked: {
  parse(input: string): string;
  use(opts: Record<string, unknown>): void;
} | undefined;

export function uuid(): string {
  return crypto.randomUUID();
}
export function now(): string {
  return new Date().toISOString();
}
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// HTMLElement extension for toast's debounce timer slot.
type ToastEl = HTMLElement & { _t?: ReturnType<typeof setTimeout> };

export function toast(msg: string, duration = 2500): void {
  const el = document.getElementById('toast') as ToastEl | null;
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  if (el._t) clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), duration);
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  pending_review: 'Pending Review',
  done: 'Done',
  blocked: 'Blocked',
};
export function statusLabel(s: string): string {
  return (STATUS_LABELS as Record<string, string>)[s] ?? s;
}

export const MODEL_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
];

export function modelShortName(m: string | null | undefined): string {
  const found = MODEL_OPTIONS.find((o) => o.id === m);
  if (found) return found.label;
  // Unknown/custom model — restrict to safe charset to prevent attribute breakout
  return String(m || 'unknown').split('-').slice(-2).join(' ').replace(/[^\w\s.+-]/g, '');
}

export function modelBadgeClass(m: string | null | undefined): string {
  if (m?.includes('haiku')) return 'model-haiku';
  if (m?.includes('opus')) return 'model-opus';
  return 'model-sonnet';
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
export function patchFileName(suffix: string): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}_${suffix}.json`;
}

// ─── MARKDOWN ──────────────────────────────────────────────────────────────
export function sanitizeLinkUrl(url: string): string {
  const t = String(url || '').trim();
  // allow only http/https — block javascript:, data:, vbscript:, etc.
  // encode " to prevent attribute breakout in href="..."
  return /^https?:\/\//i.test(t) ? t.replace(/"/g, '%22') : '#';
}

// Configure marked once with safe defaults + custom link renderer.
let _markedReady = false;
function _setupMarked(): void {
  if (_markedReady || typeof marked === 'undefined') return;
  marked.use({
    gfm: true,
    breaks: true,
    renderer: {
      // Override link renderer to keep blocking javascript:/data:/vbscript:
      link(this: { parser: { parseInline: (t: unknown) => string } }, opts: { href: string; title: string | null; tokens: unknown }) {
        const safeHref = sanitizeLinkUrl(opts.href);
        const inner = this.parser.parseInline(opts.tokens);
        const t = opts.title ? ` title="${esc(opts.title)}"` : '';
        return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer"${t}>${inner}</a>`;
      },
    },
  });
  _markedReady = true;
}

export function renderMd(text: string | null | undefined): string {
  if (!text) return '<em style="color:var(--text-muted)">No description</em>';
  if (typeof marked !== 'undefined') {
    _setupMarked();
    try {
      return marked.parse(String(text));
    } catch (e) {
      console.warn('marked parse failed, falling back:', e);
    }
  }
  // Fallback: minimal escape if marked is unavailable (e.g. CDN blocked)
  return `<pre style="white-space:pre-wrap;font-family:inherit">${esc(text)}</pre>`;
}

// ─── DATA HELPERS ──────────────────────────────────────────────────────────
export function getProject(pid: string | null | undefined): Project | undefined {
  return db?.projects.find((p) => p.id === pid);
}

export function findTaskByPath(path: string[] | null | undefined): Task | null {
  if (!db || !path || !path.length) return null;
  const proj = getProject(activeProjectId);
  if (!proj) return null;
  let tasks: Task[] = proj.tasks;
  let task: Task | null = null;
  for (const id of path) {
    const found = tasks.find((t) => t.id === id);
    if (!found) return null;
    task = found;
    tasks = found.subtasks || [];
  }
  return task;
}

export function findTaskAnywhere(tasks: Task[], id: string): Task | null {
  for (const t of tasks) {
    if (t.id === id) return t;
    const f = findTaskAnywhere(t.subtasks || [], id);
    if (f) return f;
  }
  return null;
}

export function findTaskInProject(projectId: string, taskId: string): Task | null {
  const proj = db?.projects.find((p) => p.id === projectId);
  return proj ? findTaskAnywhere(proj.tasks, taskId) : null;
}

export function calcProgress(task: Task): number | null {
  const subs = task.subtasks || [];
  if (!subs.length) return null;
  const total = countAll(subs);
  const done = countDone(subs);
  return total === 0 ? 0 : Math.round((done / total) * 100);
}
export function countAll(tasks: Task[]): number {
  return tasks.reduce((s, t) => s + 1 + countAll(t.subtasks || []), 0);
}
export function countDone(tasks: Task[]): number {
  return tasks.reduce(
    (s, t) => s + (t.status === 'done' ? 1 : 0) + countDone(t.subtasks || []),
    0
  );
}

export function isFullyDone(task: Task): boolean {
  if (task.status !== 'done') return false;
  return (task.subtasks || []).every(isFullyDone);
}

export function autoEscalate(task: Task): void {
  (task.subtasks || []).forEach(autoEscalate);
  const subs = task.subtasks || [];
  if (!subs.length) return;

  const allDone = subs.every((s) => s.status === 'done');
  const hasOpen = subs.some((s) => ['todo', 'in_progress', 'blocked'].includes(s.status));

  // Forward: all subtasks done → escalate to pending_review
  if (allDone && task.status !== 'done' && task.status !== 'pending_review') {
    const old = task.status;
    task.status = 'pending_review';
    task.updatedAt = now();
    (task.activityLog = task.activityLog || []).push({
      timestamp: now(),
      agent: 'System',
      action: `auto-escalated from ${old} to pending_review (all subtasks done)`,
    });
  }

  // Reverse: parent is pending_review but a subtask was reopened → demote to in_progress
  if (task.status === 'pending_review' && hasOpen) {
    task.status = 'in_progress';
    task.updatedAt = now();
    (task.activityLog = task.activityLog || []).push({
      timestamp: now(),
      agent: 'System',
      action: 'demoted from pending_review to in_progress (subtask reopened)',
    });
  }
}

export type StatusCounts = Record<TaskStatus, number>;

function emptyStatusCounts(): StatusCounts {
  return { todo: 0, in_progress: 0, pending_review: 0, done: 0, blocked: 0 };
}

export function countByStatus(tasks: Task[]): StatusCounts {
  const c = emptyStatusCounts();
  const walk = (ts: Task[]): void => {
    ts.forEach((t) => {
      if (t.status in c) c[t.status] = (c[t.status] || 0) + 1;
      walk(t.subtasks || []);
    });
  };
  walk(tasks);
  return c;
}
export function globalCount(): StatusCounts {
  const c = emptyStatusCounts();
  (db?.projects || []).forEach((p) => {
    const pc = countByStatus(p.tasks || []);
    (Object.keys(c) as TaskStatus[]).forEach((k) => {
      c[k] += pc[k] || 0;
    });
  });
  return c;
}

export function findNextRunnablePath(task: Task, basePath: string[]): string[] | null {
  for (const sub of task.subtasks || []) {
    if (sub.status === 'done') continue;
    const subPath = [...basePath, sub.id];
    const deeper = findNextRunnablePath(sub, subPath);
    if (deeper) return deeper;
    return subPath;
  }
  return null;
}

// ─── PATH UTILS ────────────────────────────────────────────────────────────
export function joinPath(base: string, file: string): string {
  return base.replace(/[/\\]$/, '') + '/' + file;
}

// safePathJoin: rejects path traversal (.., absolute paths, drive letters).
// Use for any path that includes user/AI-controlled segments.
export function safePathJoin(base: string, rel: string): string {
  const r = String(rel || '');
  if (r.includes('..') || r.startsWith('/') || r.startsWith('\\') || /^[a-zA-Z]:/.test(r)) {
    throw new Error('Invalid path (traversal blocked): ' + r);
  }
  return joinPath(base, r);
}

// validateTaskId: only allow UUID-like or our prefixed IDs (alphanumeric + hyphens).
export function isSafeTaskId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}
