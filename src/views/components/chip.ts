// ─── CHIP / BADGE / LABEL ──────────────────────────────────────────────────
// Production label component for PwTask Pro UI.
// Variants: status, priority, agent, tag, model, neutral.
// Replaces .badge inline classes scattered through render.ts.

export type ChipVariant =
  | 'status-todo'
  | 'status-in_progress'
  | 'status-pending_review'
  | 'status-done'
  | 'status-blocked'
  | 'priority-high'
  | 'priority-medium'
  | 'priority-low'
  | 'agent'
  | 'model-haiku'
  | 'model-sonnet'
  | 'model-opus'
  | 'tag'
  | 'neutral';

export interface ChipOpts {
  label: string;
  variant: ChipVariant;
  dot?: boolean;       // show leading colored dot
  removable?: boolean; // show × button
  size?: 'xs' | 'sm';
  title?: string;
}

const STATUS_LABELS: Record<string, string> = {
  todo: 'Todo',
  in_progress: 'In Progress',
  pending_review: 'Pending Review',
  done: 'Done',
  blocked: 'Blocked',
};

export function chip(opts: ChipOpts): string {
  const { label, variant, dot, removable, size = 'sm', title } = opts;
  const classes = ['chip', `chip--${variant}`, `chip--${size}`].join(' ');
  const inner = [
    dot ? `<span class="chip-dot"></span>` : '',
    `<span class="chip-label">${escapeHtml(label)}</span>`,
    removable ? `<button class="chip-x" aria-label="Remove">×</button>` : '',
  ].filter(Boolean).join('');
  const titleAttr = title ? `title="${escapeAttr(title)}"` : '';
  return `<span class="${classes}" ${titleAttr}>${inner}</span>`;
}

/** Quick-helper: status chip from raw status string */
export function statusChip(status: string): string {
  return chip({
    label: STATUS_LABELS[status] || status,
    variant: `status-${status}` as ChipVariant,
    dot: true,
  });
}

/** Quick-helper: priority chip */
export function priorityChip(priority: string): string {
  if (!priority || priority === 'medium') return ''; // medium = default, no chip
  return chip({
    label: priority.charAt(0).toUpperCase() + priority.slice(1),
    variant: `priority-${priority}` as ChipVariant,
  });
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(v: string): string {
  return v.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
