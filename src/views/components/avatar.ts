// ─── AVATAR ────────────────────────────────────────────────────────────────
// Generates colored avatars with initials. Stable color hash per identifier.

const PALETTE = [
  ['#FB7185', '#F472B6'], // pink
  ['#A78BFA', '#8B5CF6'], // purple
  ['#60A5FA', '#3B82F6'], // blue
  ['#34D399', '#10B981'], // green
  ['#FBBF24', '#F59E0B'], // amber
  ['#F87171', '#EF4444'], // red
  ['#22D3EE', '#06B6D4'], // cyan
  ['#A3E635', '#84CC16'], // lime
  ['#FB923C', '#F97316'], // orange
  ['#818CF8', '#6366F1'], // indigo
];

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i) | 0;
  return Math.abs(h);
}

function initials(name: string): string {
  const words = name.trim().split(/[\s_\-]+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export interface AvatarOpts {
  /** Identifier used both for hash (color) and initials (label). */
  id: string;
  /** Override initials (e.g., agent ID = "rust-dev" but show "RD"). */
  label?: string;
  /** Pixel size — default 28. */
  size?: number;
  /** Show subtle ring around avatar. */
  ring?: boolean;
  title?: string;
}

export function avatar(opts: AvatarOpts): string {
  const { id, label, size = 28, ring, title } = opts;
  const [c1, c2] = PALETTE[hashStr(id) % PALETTE.length];
  const text = (label || initials(id)).slice(0, 2);
  const fontSize = Math.max(10, Math.round(size * 0.4));
  const ringStyle = ring ? `box-shadow:0 0 0 2px var(--surface, #fff);` : '';
  const titleAttr = title ? `title="${title.replace(/"/g, '&quot;')}"` : '';

  return `<span class="avatar" ${titleAttr} style="display:inline-flex;align-items:center;justify-content:center;width:${size}px;height:${size}px;border-radius:50%;background:linear-gradient(135deg,${c1},${c2});color:#fff;font-size:${fontSize}px;font-weight:600;letter-spacing:-0.02em;${ringStyle}">${text}</span>`;
}
