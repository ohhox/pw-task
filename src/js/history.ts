// ─── HISTORY ─────────────────────────────────────────────────────────────────
// Snapshot-based undo/redo. Snapshots are pushed to the undo stack just before
// each disk save (via onBeforeSave, called from fileops._saveDbUnlocked).
// Comparison ignores `lastUpdated` so that a bare Ctrl+S after undo does not
// create a spurious undo entry.
import { db, setDb } from './state.js';
import { toast } from './data.js';
import type { Database } from '../types/domain';

const MAX = 50;
const _undo: string[] = [];
const _redo: string[] = [];
let _last: string | null = null;
let _rerender: (() => void) | null = null;

export function initHistory(renderFn: () => void): void {
  _rerender = renderFn;
}

function contentHash(json: string): string {
  try {
    const { lastUpdated: _, ...rest } = JSON.parse(json) as Database & { lastUpdated?: string };
    return JSON.stringify(rest);
  } catch {
    return json;
  }
}

export function onBeforeSave(json: string): void {
  if (_last !== null && contentHash(_last) !== contentHash(json)) {
    _undo.push(_last);
    if (_undo.length > MAX) _undo.shift();
    _redo.length = 0;
  }
  _last = json;
}

export function undo(): void {
  if (!_undo.length) { toast('Nothing to undo'); return; }
  _redo.push(JSON.stringify(db));
  const prev = _undo.pop()!;
  setDb(JSON.parse(prev));
  _last = prev;
  _rerender?.();
  toast('↩ Undo');
}

export function redo(): void {
  if (!_redo.length) { toast('Nothing to redo'); return; }
  _undo.push(JSON.stringify(db));
  const next = _redo.pop()!;
  setDb(JSON.parse(next));
  _last = next;
  _rerender?.();
  toast('↪ Redo');
}

export function canUndo(): boolean { return _undo.length > 0; }
export function canRedo(): boolean { return _redo.length > 0; }
