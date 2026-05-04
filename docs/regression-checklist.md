# Refactor Regression Baseline — PwTask Desktop App

**Task:** `task-t-08-01`  
**Scope:** Desktop App (Tauri) UI + data-flow baseline before refactor  
**Last updated:** 2026-05-04

เอกสารนี้เป็น safety net สำหรับ refactor รอบ `task-t-08-*` ทุกงานถัดไปต้องใช้ checklist นี้เป็น acceptance criteria: ก่อน merge/commit ให้รัน automated checks และ tick manual flow ที่เกี่ยวข้องกับไฟล์ที่แตะ หาก refactor แตะ cross-cutting wiring เช่น `main.ts`, `fileops.ts`, `render.ts`, `detail.ts`, `ai.ts`, `board.ts`, หรือ `src-tauri/src/main.rs` ให้ทวน checklist ทั้งชุดอย่างน้อย smoke pass หนึ่งรอบ

> Baseline rule: refactor ต้องไม่เปลี่ยน behavior ที่ผู้ใช้เห็น เว้นแต่งานนั้นระบุ behavior change ชัดเจน

---

## 0. Automated Gate ก่อน/หลัง Refactor

| Gate | Command | Expected |
|---|---|---|
| TypeScript | `npm run typecheck` | exit 0 |
| Unit tests | `npm run test` | 5 files / 116 tests pass ณ baseline นี้ |
| Frontend build | `npm run build:vite` | Vite build ผ่านและสร้าง `dist/` |
| Lint | `npm run lint` | exit 0; baseline ยังมี warning `no-explicit-any`/eslint-disable เดิมได้ |
| Rust check | `$env:PATH="C:\Users\wit00\.cargo\bin;D:\msys64\mingw64\bin;$env:PATH"; $env:CARGO_HOME="D:\cargo"; cargo check --manifest-path src-tauri/Cargo.toml` | exit 0 |

Known non-blocking baseline debt ที่ไม่ใช่เป้าหมายของ refactor task นี้:
- `npm run format:check` ยังมีหลายไฟล์ไม่ตรง Prettier
- `npm run test:e2e` ยังต้องซ่อม dependency/WebDriver lane แยกต่างหาก
- `cargo clippy -- -D warnings` ยังมี clippy debt แยกต่างหาก

---

## 1. Current UI/Data Flow Map

### 1.1 Static shell (`src/index.html`)

Primary DOM anchors:
- Top bar: `btn-save`, `btn-theme`, `btn-open`, `btn-font-size`, `btn-agent-mgr`
- Sidebar: `project-list`, `summary-rows`, `btn-add-project`
- Welcome/open folder: `welcome`, `welcome-msg`, `current-dir-display`, `btn-open-welcome`
- Project view: `project-view`, `view-tabs`, `task-list-view`, `board-view`
- Project actions: `btn-run-project`, `btn-terminal`, `btn-plan-project`, `btn-edit-project`, `btn-export-claude`, `btn-delete-project`
- Filters/bulk: `filters-bar`, `search-input`, `filter-status`, `filter-agent`, `filter-priority`, `btn-bulk-select`, `bulk-bar`
- Task rendering: `task-list`, `board-container`
- Detail drawer: `detail-panel`, `detail-body`, `drawer-backdrop`
- Utility overlays: `palette-overlay`, `help-overlay`, `toast`

External runtime script baseline:
- `marked@15` is loaded from CDN and consumed as global `marked` by `src/js/data.ts` markdown rendering.
- App entrypoint is `src/js/main.ts` via module script.

### 1.2 Tauri/Rust command surface (`src-tauri/src/main.rs`)

Frontend IPC-visible commands used by flows:
- Config/workspace: `get_config`, `set_config`
- File operations: `read_text_file`, `write_text_file`, `write_text_file_atomic`, `read_dir`, `remove_file`, `create_dir`
- Local actions: `open_terminal`, `run_project_command`, `open_log_folder`
- Logging: `write_log_entry`
- AI run: `run_claude` emits `run-line:{runId}` and returns output/session/usage
- Tree helpers: `task_count_by_status`, `task_calc_progress`, `task_is_fully_done`, `task_find_next_runnable`
- Agent registry: `agent_list`, `agent_resolve`, `agent_add`, `agent_update`, `agent_remove`, `agent_replace_all`
- Patch/db layer: `patch_validate`, `patch_apply_to_db`, `patch_apply_batch`, `db_load`, `db_save`, `db_get`, `db_replace`, `db_set_base`, `db_write_migration_backup`, `patches_apply_pending`

Important runtime side effects:
- `WorkspaceRoot` is set by `set_config` and guards mutating filesystem commands.
- Active `claude` child PIDs are tracked and killed when the main window is destroyed.
- Logs are written under app config log dir with daily rolling retention.

### 1.3 Startup / open folder / load data

Flow:
1. `src/js/main.ts` binds DOM events, initializes history, task-list events, board events, palette, routing, last-view restore.
2. `tryRestoreDir()` in `src/js/fileops.ts` calls `get_config()`.
3. If config has a folder, `baseDir` is set and `loadFromDir()` runs.
4. `loadFromDir()` loads `tasks.json`, runs migrations if needed, initializes agent cache, ensures `patches/`, applies pending patches, then calls `onDbLoaded()`.
5. `onDbLoaded()` updates welcome/project view visibility, renders sidebar/project, starts `checkPatches()` interval, and dispatches `pwtask:ready` for hash routing.
6. Manual folder change uses `openFolder()` -> Tauri dialog -> `set_config()` -> `loadFromDir()`.

### 1.4 Patch sync / save

Patch sync flow:
1. Manual sync button and visibility resume call `checkPatches()`.
2. `checkPatches()` calls `applyPatches()`.
3. `applyPatches()` reads `patches/`, validates shape, calls Rust `patch_apply_batch`, saves DB, deletes successfully consumed patch files, and keeps errored files.
4. If patches applied, UI rerenders `renderSidebar()`, `renderProject()`, and selected detail if still present.

Save flow:
1. Mutations call `scheduleSave()` for autosave or `saveFile()` for immediate save.
2. `saveFileOrThrow()`/save lock persists the current db using atomic write path.
3. `save-status` shows saved/failed state.

### 1.5 Project/task rendering

Project render flow:
1. `renderSidebar()` counts statuses recursively and renders project cards + global summary.
2. Selecting a project sets `activeProjectId`, clears selected task, rerenders project, updates hash.
3. `renderProject()` updates topbar project info/actions, then calls `renderTaskList()`.
4. `renderTaskList()` filters/sorts root tasks, builds task rows recursively, then dispatches `pwtask:task-view-changed` so board can refresh when visible.
5. Board tab uses `renderBoard()` to group tasks by status; optional subtask flattening is toggled inside board.

### 1.6 Detail panel edit

Flow:
1. Clicking a task row/card sets `selectedTaskPath`, opens drawer, calls `renderDetail()`.
2. `renderDetail()` resolves selected task from current project tree.
3. Editing title/status/priority/agent/model/due date/description/tags/files mutates task, sets timestamps, schedules save, and rerenders list/sidebar/detail as needed.
4. Closing drawer clears selection and updates routing hash.

### 1.7 Plan Project

Flow:
1. `btn-plan-project` calls `planProject(project)`.
2. Project must have enough goal/context; otherwise user sees a toast/error state.
3. Planning modal streams agent output via execution service.
4. Parsed task JSON is presented/added to project as `todo` tasks.
5. Save + sidebar/task list rerender after accepting planned tasks.

### 1.8 Play Task

Flow:
1. Detail `Run` button or list quick-play calls `playTask()`.
2. A runnable task gets status moved to `in_progress` when appropriate.
3. `runClaude()`/execution service starts provider, subscribes to `run-line:{runId}`, streams terminal output, tracks active run in UI.
4. On success: status becomes `pending_review`, `lastNote`, `lastSessionId`, `runHistory`, usage/cost metadata, and activity log are updated.
5. On failure: status reverts when needed, controls are re-enabled, and error is shown.

### 1.9 Review / Done / Re-run

Flow:
1. A `pending_review` task shows review controls in detail.
2. Baseline current UI also shows quick `✓ Done` action for `pending_review` rows/cards.
3. Done/approve sets status `done`, timestamps, review entry, activity log, and rerenders sidebar/list/detail/board.
4. Request Changes requires a comment, sets status back to `in_progress`, appends review log, and rerenders.
5. Fresh Re-run/Resume Session records request changes, moves to `in_progress`, then calls `runClaude()` with feedback/resume session.

---

## 2. Manual Regression Checklist

Use `Result` as `PASS`, `FAIL`, or `N/A` with notes.

### A. Open / Change Folder / Load

| ID | Scenario | Expected | Result |
|---|---|---|---|
| A1 | Open app with no saved config | Welcome view visible; project view hidden; no crash | |
| A2 | Click topbar `Change folder` and select valid workspace | `tasks.json` loads, projects render in sidebar, first project active | |
| A3 | Click welcome `Change…` and select valid workspace | Same as A2 | |
| A4 | Reopen app after config saved | Previous folder restores automatically | |
| A5 | Select folder without readable `tasks.json` | User sees load error/welcome state; app remains usable | |

### B. Patch Sync

| ID | Scenario | Expected | Result |
|---|---|---|---|
| B1 | Start app with valid patch in `patches/` | Patch applies, toast shows applied count, consumed file removed | |
| B2 | Click Sync with no patches | No data mutation; button re-enables | |
| B3 | Add patch while app is open then click Sync | Sidebar/list/detail reflect patch changes | |
| B4 | Invalid JSON patch exists | Invalid patch skipped/reported; valid patches still apply; no crash | |
| B5 | Patch application has per-file error | Errored patch remains; successful patches persist | |

### C. Save / Persistence

| ID | Scenario | Expected | Result |
|---|---|---|---|
| C1 | Edit a task and wait autosave delay | `save-status` indicates recent save | |
| C2 | Press Ctrl+S | Immediate save succeeds | |
| C3 | Click Save button if visible | Immediate save succeeds | |
| C4 | Restart app after edit | Changed task persists | |

### D. Project and Task List Render

| ID | Scenario | Expected | Result |
|---|---|---|---|
| D1 | Select project in sidebar | Header, counts, task list, quick actions update | |
| D2 | Search/filter by text/status/agent/priority | Visible rows match filter; count label updates | |
| D3 | Clear filters | All matching project tasks return | |
| D4 | Expand/collapse subtasks | Only that subtree toggles; selection remains valid | |
| D5 | Change row status dropdown | Badge/counts/sidebar update and save schedules | |
| D6 | Pending review row shows `✓ Done` | Clicking it changes status to `done` and logs review/activity | |
| D7 | Bulk select and bulk status buttons | Selected tasks update status, selection clears | |

### E. Board View

| ID | Scenario | Expected | Result |
|---|---|---|---|
| E1 | Switch to Board tab | Tasks grouped by current status; tab selection persists after restart | |
| E2 | Change status from list/detail while Board visible | Board refreshes to latest status | |
| E3 | Drag card to another column | Task status updates, sidebar counts update, save schedules | |
| E4 | Toggle subtasks | Subtask cards show/hide without losing root cards | |
| E5 | Pending review card shows `✓ Done` | Clicking it moves card to Done column and updates list/detail | |

### F. Detail Panel Edit

| ID | Scenario | Expected | Result |
|---|---|---|---|
| F1 | Click task row/card | Drawer opens with correct task; row selected | |
| F2 | Close drawer via close button/backdrop/Esc | Drawer hides; selection clears | |
| F3 | Edit title | Header/list row update; save schedules | |
| F4 | Change status/priority/agent/model | Chips/dropdowns/list/sidebar update consistently | |
| F5 | Edit markdown description | Preview renders sanitized markdown; raw text persists | |
| F6 | Copy ID | Clipboard receives task id | |
| F7 | Add/remove tags/files | Detail section refreshes and data persists | |

### G. Plan Project

| ID | Scenario | Expected | Result |
|---|---|---|---|
| G1 | Plan without usable goal/context | User receives clear toast/error; no blank tasks added | |
| G2 | Plan with goal | Planning modal opens, output streams | |
| G3 | Planning returns task JSON | User can add generated tasks; project list refreshes | |
| G4 | Planning output invalid/missing JSON | Error/warning shown; app remains usable | |

### H. Play Task

| ID | Scenario | Expected | Result |
|---|---|---|---|
| H1 | Task without prompt | Run path is disabled or shows clear error | |
| H2 | Run task with prompt | Terminal streams lines; controls show running state | |
| H3 | Run succeeds | Status becomes `pending_review`; run history/session/last note saved | |
| H4 | Run fails | Error shown; status reverts when appropriate; controls re-enable | |
| H5 | Quick-play root task with open subtask | First runnable subtask opens/runs as expected | |

### I. Review / Re-run

| ID | Scenario | Expected | Result |
|---|---|---|---|
| I1 | Open pending review task | Review panel visible; Done/Request Changes available | |
| I2 | Click `✅ Done` in detail | Status `done`, `completedAt`, review entry, activity log saved | |
| I3 | Request Changes without comment | Toast requires comment; status unchanged | |
| I4 | Request Changes with comment | Status `in_progress`; review entry saved | |
| I5 | Fresh Re-run | Task moves to `in_progress`, feedback included, run starts | |
| I6 | Resume Session with session id | Run resumes prior session id | |
| I7 | Resume Session without session id | Resume button disabled | |

### J. Shell/Utility UX

| ID | Scenario | Expected | Result |
|---|---|---|---|
| J1 | Toggle dark/light theme | Theme changes and persists after restart | |
| J2 | Cycle font size | Font size cycles S/M/L and persists | |
| J3 | Open command palette Ctrl/Cmd+K | Palette opens, search/actions work, Esc closes | |
| J4 | Archive fully done tasks | Eligible tasks move to `tasks-archive.json`; ineligible tasks remain | |
| J5 | Visibility change back to app | `checkPatches()` runs without disrupting UI | |

---

## 3. Acceptance Criteria for Next Refactor Tasks

Every next refactor task should include this in its Definition of Done:

1. Identify which sections of this checklist are affected.
2. Run the automated gates from Section 0 at minimum unless task is docs-only.
3. Manually verify affected checklist rows and record failures in the task note/review.
4. If a refactor intentionally changes behavior, update this baseline doc in the same change.
5. Do not mark task `pending_review` until the relevant checklist rows are either PASS or explicitly documented as pre-existing/blocked.

Suggested mapping:
- CSS/layout refactor: A, D, E, F, J + `build:vite`
- `main.ts` event wiring refactor: A, B, C, D, E, F, G, H, I, J
- `fileops.ts`/DB/patch refactor: A, B, C, D, I + Rust/TS unit tests
- `render.ts` refactor: D, E, F, I
- `detail.ts` refactor: F, H, I
- `ai.ts`/agent execution refactor: G, H, I
- `src-tauri/src/main.rs` refactor: A, B, C, H + `cargo check`/`rust:test`
