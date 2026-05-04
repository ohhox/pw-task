// ─── LOGGER ──────────────────────────────────────────────────────────────────
// Structured JSON logger that:
//   1. Writes to the browser console (dev convenience).
//   2. Forwards each entry to Rust via `write_log_entry` so all logs land in
//      the same daily log file as Rust tracing (%APPDATA%/ai-task-flow/logs/).
//
// NEVER throws — every Tauri call is wrapped in .catch(() => {}) so logging
// can never crash the app.
//
// Test-safe: the Rust bridge is imported lazily so tests that don't use Tauri
// can import this module without triggering the @tauri-apps/api/core import.

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  context?: Record<string, unknown>;
}

// Lazy singleton for the commands binding. Resolved once on first log call.
// Returns null if we're in a non-Tauri environment (tests, SSR, etc.).
type WriteLogEntry = (entry: unknown) => Promise<unknown>;
let _writeLogEntry: WriteLogEntry | null | 'pending' = 'pending';

async function resolveWriteLogEntry(): Promise<WriteLogEntry | null> {
  if (_writeLogEntry !== 'pending') return _writeLogEntry;
  try {
    const { commands } = await import('./bindings.js');
    _writeLogEntry = commands.writeLogEntry.bind(commands) as WriteLogEntry;
  } catch {
    // Not a Tauri environment (tests, etc.) — disable Rust forwarding silently.
    _writeLogEntry = null;
  }
  return _writeLogEntry;
}

class Logger {
  constructor(private readonly module: string) {}

  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.log('debug', msg, ctx);
  }

  info(msg: string, ctx?: Record<string, unknown>): void {
    this.log('info', msg, ctx);
  }

  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.log('warn', msg, ctx);
  }

  error(msg: string, err?: unknown, ctx?: Record<string, unknown>): void {
    const errCtx: Record<string, unknown> = { ...(ctx ?? {}) };
    if (err instanceof Error) {
      errCtx.error = err.message;
      errCtx.stack = err.stack;
    } else if (err !== undefined) {
      errCtx.error = String(err);
    }
    this.log('error', msg, errCtx);
  }

  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module: this.module,
      message,
      ...(context && Object.keys(context).length > 0 ? { context } : {}),
    };

    // Mirror to dev console
    const consoleMethod = level === 'debug' ? 'log' : level;
    // eslint-disable-next-line no-console
    console[consoleMethod](`[${entry.module}]`, message, context ?? '');

    // Forward to Rust (best-effort — logging must never crash the app).
    resolveWriteLogEntry().then((fn) => {
      if (!fn) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fn(entry as any).catch(() => {
        /* swallow — logging must never crash app */
      });
    }).catch(() => {
      /* swallow */
    });
  }
}

export const getLogger = (module: string): Logger => new Logger(module);
