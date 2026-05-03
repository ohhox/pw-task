import { defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  root: 'src',
  publicDir: false,
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || '127.0.0.1',
    hmr: host
      ? { protocol: 'ws', host, port: 5174 }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**', '**/outputs/**', '**/coverage/**'],
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // WebView2 (Win) and recent WebKit (macOS 11+) both speak modern JS — no transpile needed
    target: 'esnext',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
