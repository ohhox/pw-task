// ─── API ─────────────────────────────────────────────────────────────────────
// Owns: Tauri IPC wrappers only.
// Typed via TauriCommands map in src/types/tauri.ts.
import type {
  TauriCommandName,
  TauriCommandArgs,
  TauriCommandResult,
} from '../types/tauri';

/** Generic typed invoke — checks args against the TauriCommands signature. */
export const tauriInvoke = <K extends TauriCommandName>(
  cmd: K,
  args?: TauriCommandArgs<K>
): Promise<TauriCommandResult<K>> =>
  // The cast is needed because indexed access loses argument variance.
  // The K constraint above guarantees the call site itself is sound.
  window.__TAURI__.core.invoke(cmd, args as never) as Promise<TauriCommandResult<K>>;

// ─── Convenience wrappers (preserve existing call sites) ─────────────────
export const tauriReadText = (path: string) => tauriInvoke('read_text_file', { path });
export const tauriWriteText = (path: string, contents: string) =>
  tauriInvoke('write_text_file', { path, contents });
export const tauriWriteTextAtomic = (path: string, contents: string) =>
  tauriInvoke('write_text_file_atomic', { path, contents });
export const tauriReadDir = (path: string) => tauriInvoke('read_dir', { path });
export const tauriRemove = (path: string) => tauriInvoke('remove_file', { path });
export const tauriCreateDir = (path: string) => tauriInvoke('create_dir', { path });
export const tauriOpenTerminal = (path: string) => tauriInvoke('open_terminal', { path });
export const tauriRunProjectCmd = (cmd: string, workingDir: string) =>
  tauriInvoke('run_project_command', { cmd, workingDir });
export const tauriGetConfig = () => tauriInvoke('get_config');
export const tauriSetConfig = (tasksDir: string) => tauriInvoke('set_config', { tasksDir });

/** Plugin command — returns selected directory path or null on cancel. */
export const tauriOpenDir = (): Promise<string | null> =>
  window.__TAURI__.core.invoke<string | null>('plugin:dialog|open', {
    options: { directory: true, multiple: false },
  });

/** Subscribes to a Tauri event; returns an unlisten function. */
export const tauriListen = <T = unknown>(
  event: string,
  handler: (e: { payload: T }) => void
): Promise<() => void> => window.__TAURI__.event.listen<T>(event, handler);
