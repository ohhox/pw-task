// ─── DOM HELPERS ─────────────────────────────────────────────────────────────
// Owns: typed wrappers around getElementById that throw on missing IDs.
// Reason: every static ID in index.html is guaranteed to exist; making each
// caller defend against null clutters business logic. Use $maybe for IDs that
// may be absent (e.g. dynamic content).

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
}

export function $maybe<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}
