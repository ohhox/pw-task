// ─── DATA-RS ─────────────────────────────────────────────────────────────────
// Async wrappers around the Rust-side tree helpers exposed via tauri-specta
// (see src-tauri/src/main.rs:task_*). Pairs with `data.ts` which holds the
// synchronous TypeScript implementations used in DOM render hot paths.
//
// **Why both exist (Phase 1.6.2 trade-off):**
//   * `data.ts` helpers (`countByStatus`, `calcProgress`, `findTaskAnywhere`,
//     `isFullyDone`, `autoEscalate`, `findNextRunnablePath`) run in
//     synchronous DOM render loops (`render.ts`, `detail.ts`, `modals.ts`,
//     `fileops.ts`). Converting them to async would force `await` into 30+
//     call sites including event handlers, cause UI flicker on first render
//     of every project, and add an IPC round-trip per task in the tree —
//     unacceptable for a desktop app.
//   * The Rust side is the canonical implementation that sibling tasks
//     06-04 (patch system) and 06-05 (db layer) consume in-process via
//     `ai_task_flow::tree::*` — no IPC hop.
//   * This module bridges the two for any future TS caller that *can*
//     tolerate async (background validation, batch operations, headless
//     scripts, etc.).
//
// Both implementations port the same logic from the original `data.ts` so
// they MUST agree byte-for-byte; the Rust integration tests in
// `src-tauri/tests/domain_tree_integration.rs` enforce that contract.

import { commands } from '../bindings.js';
import type { Task as TsTask } from '../types/domain';
// Pull in the Rust-typed `Task` — it is structurally compatible with
// `types/domain.ts` because both are generated from the same shape.
import type { Task as RustTask, TaskStatus } from '../bindings.js';

/// The TS and Rust `Task` types describe the same JSON shape; cast at the
/// boundary so callers don't have to convert. Any drift would surface as a
/// failed serde round-trip in `domain_tree_integration::round_trip_*`.
function asRustTask(t: TsTask): RustTask {
  return t as unknown as RustTask;
}

/**
 * Recursive count of every `TaskStatus` across the tree, including subtasks.
 *
 * Async equivalent of `countByStatus` from `data.ts`. Returns a fully
 * populated map so callers can index any status without a presence check.
 */
export async function countByStatusRs(
  tasks: TsTask[]
): Promise<Record<TaskStatus, number>> {
  return commands.taskCountByStatus(tasks.map(asRustTask));
}

/**
 * Subtree completion percentage (0..=100) or `null` for leaf tasks. Async
 * equivalent of `calcProgress` from `data.ts`.
 */
export async function calcProgressRs(task: TsTask): Promise<number | null> {
  return commands.taskCalcProgress(asRustTask(task));
}

/**
 * True when the task and every descendant has status `done`. Async
 * equivalent of `isFullyDone` from `data.ts`.
 */
export async function isFullyDoneRs(task: TsTask): Promise<boolean> {
  return commands.taskIsFullyDone(asRustTask(task));
}

/**
 * DFS path of ids to the first non-`done` descendant, or `null` when nothing
 * is left to run. Path is **relative** to the supplied task (does not include
 * the task's own id) — mirrors the TS contract where the caller passes the
 * `basePath` separately.
 *
 * Async equivalent of `findNextRunnablePath(task, basePath)` from `data.ts`,
 * minus the basePath argument.
 */
export async function findNextRunnableRs(
  task: TsTask
): Promise<string[] | null> {
  return commands.taskFindNextRunnable(asRustTask(task));
}
