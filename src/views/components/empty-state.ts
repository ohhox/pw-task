// ─── EMPTY STATES ──────────────────────────────────────────────────────────
// Friendly empty states with character — replaces "No tasks" plain text.
import { icon, type IconName } from '../icons.js';

export interface EmptyStateOpts {
  icon?: IconName;
  title: string;
  description?: string;
  cta?: { label: string; onClick?: string; intent?: 'primary' | 'default' };
}

export function emptyState(opts: EmptyStateOpts): string {
  const { icon: iconName = 'inbox', title, description, cta } = opts;
  const ctaHtml = cta
    ? `<button class="btn btn--${cta.intent || 'primary'} btn--md" ${cta.onClick ? `onclick="${cta.onClick}"` : ''} style="margin-top:16px">${escapeHtml(cta.label)}</button>`
    : '';
  return `
    <div class="empty-state">
      <div class="empty-state-icon">${icon(iconName, 48)}</div>
      <div class="empty-state-title">${escapeHtml(title)}</div>
      ${description ? `<div class="empty-state-desc">${escapeHtml(description)}</div>` : ''}
      ${ctaHtml}
    </div>
  `;
}

/** Curated empty states for known scenarios */
export const EMPTY = {
  noTasks: () => emptyState({
    icon: 'inbox',
    title: 'No tasks yet',
    description: 'Create your first task or use AI Plan to break down a project goal.',
    cta: { label: '＋ New Task', intent: 'primary' },
  }),

  noFilteredTasks: () => emptyState({
    icon: 'search',
    title: 'No tasks match your filter',
    description: 'Try clearing some filters, or check a different project.',
  }),

  noProjects: () => emptyState({
    icon: 'folder',
    title: 'No projects yet',
    description: 'Open a tasks folder or create your first project.',
  }),

  noPendingReview: () => emptyState({
    icon: 'check',
    title: 'All caught up',
    description: 'No tasks waiting for review.',
  }),

  noActiveAgents: () => emptyState({
    icon: 'bot',
    title: 'No agents running',
    description: 'Click ▶ on a task to spawn an agent.',
  }),
};

function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
