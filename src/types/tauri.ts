// ─── TAURI IPC TYPES ─────────────────────────────────────────────────────────
// Typed signatures for every command exposed by src-tauri/src/main.rs.
// Phase 1.6.1 will replace this with auto-generated bindings via tauri-specta;
// until then this file is the contract surface between TS frontend and Rust backend.

// ─── COMMAND PAYLOADS ─────────────────────────────────────────────────────

export interface DirEntry {
  path: string;
  name: string;
}

export interface RunClaudeArgs {
  prompt: string;
  model: string;
  sessionId?: string | null;
  workingDir?: string | null;
  runId: string;
  /** Restrict Claude to these tools — null = use default whitelist. Set when skipPermissions=false. */
  allowedTools?: string[] | null;
  /** Pass --dangerously-skip-permissions. Default false. Use only for trusted agents. */
  skipPermissions?: boolean;
}

export interface RunResult {
  output: string;
  sessionId: string | null;
}

// ─── COMMAND MAP ──────────────────────────────────────────────────────────
// Each entry: command name → (args object | void) => Promise<result>
// Use with a typed wrapper: tauriInvoke<'read_text_file'>({ path })

export interface TauriCommands {
  // Config (legacy + APPDATA-aware)
  get_config: () => Promise<string>;
  set_config: (args: { tasksDir: string }) => Promise<void>;

  // Filesystem
  read_text_file: (args: { path: string }) => Promise<string>;
  write_text_file: (args: { path: string; contents: string }) => Promise<void>;
  /** Atomic write via tmp+rename — see src-tauri/src/main.rs (P1 fix) */
  write_text_file_atomic: (args: { path: string; contents: string }) => Promise<void>;
  read_dir: (args: { path: string }) => Promise<DirEntry[]>;
  remove_file: (args: { path: string }) => Promise<void>;
  create_dir: (args: { path: string }) => Promise<void>;

  // External process
  open_in_vscode: (args: { path: string }) => Promise<void>;
  run_project_command: (args: { cmd: string; workingDir: string }) => Promise<void>;

  // Claude orchestration — emits `run-line:{runId}` events while streaming
  run_claude: (args: RunClaudeArgs) => Promise<RunResult>;
}

export type TauriCommandName = keyof TauriCommands;

export type TauriCommandArgs<K extends TauriCommandName> = Parameters<TauriCommands[K]>[0];

export type TauriCommandResult<K extends TauriCommandName> = Awaited<
  ReturnType<TauriCommands[K]>
>;

// ─── EVENT TYPES ──────────────────────────────────────────────────────────
// Emitted by Rust during run_claude — frontend listens with @tauri-apps/api/event

/** Each chunk of streamed output. Event name: `run-line:{runId}` */
export interface RunLineEvent {
  payload: string;
}

/** Final completion notification. Event name: `run-done:{runId}` */
export interface RunDoneEvent {
  payload: string;
}

// ─── TAURI WINDOW GLOBALS ─────────────────────────────────────────────────
// Tauri exposes its API on `window.__TAURI__` when `withGlobalTauri: true`.
// Declared here so api.js can keep working during the incremental migration.

export interface TauriGlobal {
  core: {
    invoke<K extends TauriCommandName>(
      cmd: K,
      args?: TauriCommandArgs<K>
    ): Promise<TauriCommandResult<K>>;
    /** Plugin commands like `plugin:dialog|open` aren't in TauriCommands. */
    invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  };
  event: {
    listen<T = unknown>(
      event: string,
      handler: (e: { payload: T }) => void
    ): Promise<() => void>;
  };
}

declare global {
  interface Window {
    __TAURI__: TauriGlobal;
  }
}

export {};
