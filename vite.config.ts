import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * One config for three jobs: `pnpm dev` (browser, BrowserAdapter),
 * `pnpm build` (the bundle Tauri ships), and `pnpm test` (vitest + jsdom).
 *
 * Nothing here is Tauri-specific except the dev-server port, which
 * `src-tauri/tauri.conf.json` points `devUrl` at. That is deliberate: the
 * frontend must stay independently runnable so it can be rendered and
 * screenshotted on a headless machine.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    // Tauri ships a fixed, modern webview; no legacy targets needed.
    target: 'es2022',
    sourcemap: true,
    emptyOutDir: true,
  },
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    restoreMocks: true,
  },
});
