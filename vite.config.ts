import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Deep imports into Monaco's ESM build (its package exports only allow .js files).
    alias: { 'monaco-esm': fileURLToPath(new URL('./node_modules/monaco-editor/esm/vs', import.meta.url)) },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
