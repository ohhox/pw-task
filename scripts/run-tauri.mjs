// Node-side wrapper for Tauri CLI invocations that need the mingw64 toolchain
// at the front of PATH. Tauri's Rust build script calls windres, which then
// launches gcc/cc1 for preprocessing Windows resources.
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { join } from 'node:path';

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

const tauriCli = join(process.cwd(), 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

const result = spawnSync(process.execPath, [tauriCli, ...process.argv.slice(2)], {
  env,
  stdio: 'inherit',
  shell: false,
});

process.exit(result.status ?? 1);
