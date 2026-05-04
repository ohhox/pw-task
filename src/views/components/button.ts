// ─── BUTTON ────────────────────────────────────────────────────────────────
// Production-grade Button variants for PwTask Pro UI.
// Returns HTML string — drop-in replacement for ad-hoc <button> tags.
import { icon, type IconName } from '../icons.js';

export type ButtonIntent = 'default' | 'primary' | 'success' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonOpts {
  label?: string;
  intent?: ButtonIntent;
  size?: ButtonSize;
  iconLeft?: IconName;
  iconRight?: IconName;
  iconOnly?: IconName;        // shorthand: icon-only button (no label)
  disabled?: boolean;
  loading?: boolean;
  id?: string;
  title?: string;
  className?: string;
  attrs?: Record<string, string>;
}

export function button(opts: ButtonOpts): string {
  const {
    label = '',
    intent = 'default',
    size = 'md',
    iconLeft, iconRight, iconOnly,
    disabled, loading,
    id, title, className,
    attrs = {},
  } = opts;

  const classes = [
    'btn',
    `btn--${intent}`,
    `btn--${size}`,
    iconOnly ? 'btn--icon-only' : '',
    loading ? 'btn--loading' : '',
    className || '',
  ].filter(Boolean).join(' ');

  const attrStr = [
    id ? `id="${escapeAttr(id)}"` : '',
    title ? `title="${escapeAttr(title)}"` : '',
    disabled ? 'disabled' : '',
    ...Object.entries(attrs).map(([k, v]) => `${k}="${escapeAttr(v)}"`),
  ].filter(Boolean).join(' ');

  let inner = '';
  if (iconOnly) {
    inner = icon(iconOnly, sizeForIcon(size));
  } else {
    if (iconLeft) inner += `<span class="btn-ico btn-ico--left">${icon(iconLeft, sizeForIcon(size))}</span>`;
    if (label) inner += `<span class="btn-label">${escapeHtml(label)}</span>`;
    if (iconRight) inner += `<span class="btn-ico btn-ico--right">${icon(iconRight, sizeForIcon(size))}</span>`;
  }
  if (loading) inner = `<span class="btn-spinner"></span>` + inner;

  return `<button class="${classes}" ${attrStr}>${inner}</button>`;
}

function sizeForIcon(s: ButtonSize): number {
  return s === 'sm' ? 12 : s === 'lg' ? 16 : 14;
}

function escapeAttr(v: string): string {
  return v.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeHtml(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
