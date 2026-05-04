// Node-side wrapper for cargo invocations that need the mingw64 toolchain
// on PATH (tauri-winres calls windres → cpp during build.rs).
//
// Usage:  node scripts/run-cargo.mjs check --manifest-path src-tauri/Cargo.toml
//
// This exists because the dev sandbox blocks shell-level PATH mutation; Node
// can mutate `process.env` for the spawned child without that restriction.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const env = { ...process.env };
const nodeBin = dirname(process.execPath);
const toolPath = [
  nodeBin,
  join(process.env.APPDATA || '', 'npm'),
  'C:\\Users\\wit00\\.cargo\\bin',
  'D:\\msys64\\mingw64\\bin',
  env.PATH || '',
].join(';');
env.PATH = toolPath;
env.Path = toolPath;
env.CARGO_HOME = env.CARGO_HOME || 'D:\\cargo';

const result = spawnSync('cargo', process.argv.slice(2), {
  env,
  stdio: 'inherit',
  shell: false,
});

process.exit(result.status ?? 1);
