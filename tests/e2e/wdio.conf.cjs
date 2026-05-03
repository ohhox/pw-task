// WebdriverIO configuration for the Tauri smoke E2E suite.
//
// Spawns `tauri-driver` (cargo bin) in front of `msedgedriver` so WebDriver
// commands can reach the WebView2 webview hosted by the built Tauri exe.
//
// Pre-reqs (see docs/e2e-testing.md):
//   1. cargo install tauri-driver --locked
//   2. msedgedriver.exe matching the installed WebView2 runtime, on PATH
//   3. The Tauri release exe built (this config builds it via `onPrepare`).

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const APP_BINARY = path.join(
  PROJECT_ROOT,
  'src-tauri',
  'target',
  'release',
  'ai-task-flow.exe'
);

function resolveTauriDriver() {
  // Honor CARGO_HOME (CLAUDE.md sets this to D:\cargo on this machine).
  const candidates = [];
  if (process.env.CARGO_HOME) {
    candidates.push(path.join(process.env.CARGO_HOME, 'bin', 'tauri-driver.exe'));
  }
  candidates.push(path.join(os.homedir(), '.cargo', 'bin', 'tauri-driver.exe'));
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fallback to PATH lookup.
  return 'tauri-driver';
}

const TAURI_DRIVER = resolveTauriDriver();
let tauriDriverProc;

exports.config = {
  runner: 'local',
  hostname: '127.0.0.1',
  port: 4444,

  specs: [path.join(__dirname, 'smoke.spec.ts')],
  exclude: [],
  maxInstances: 1,

  capabilities: [
    {
      maxInstances: 1,
      'tauri:options': {
        application: APP_BINARY,
      },
    },
  ],

  logLevel: 'info',
  bail: 0,
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: {
    ui: 'bdd',
    timeout: 120000,
  },

  // Build the Tauri release binary once before the suite.
  // Skip if the binary already exists to keep iterative runs fast.
  onPrepare: () => {
    if (fs.existsSync(APP_BINARY)) {
      console.log(`[wdio] Reusing existing release binary at ${APP_BINARY}`);
      return;
    }
    console.log('[wdio] Building Tauri release binary (first run only)…');
    const result = spawnSync(
      'cargo',
      [
        'build',
        '--release',
        '--manifest-path',
        path.join(PROJECT_ROOT, 'src-tauri', 'Cargo.toml'),
      ],
      { stdio: 'inherit', shell: true }
    );
    if (result.status !== 0) {
      throw new Error(`cargo build --release failed with code ${result.status}`);
    }
  },

  // Spawn tauri-driver before each WebDriver session.
  beforeSession: () => {
    tauriDriverProc = spawn(TAURI_DRIVER, [], {
      stdio: [null, process.stdout, process.stderr],
      shell: false,
    });
    tauriDriverProc.on('error', (err) => {
      console.error('[wdio] tauri-driver failed to start:', err.message);
    });
  },

  afterSession: () => {
    if (tauriDriverProc && !tauriDriverProc.killed) {
      tauriDriverProc.kill();
    }
  },
};
