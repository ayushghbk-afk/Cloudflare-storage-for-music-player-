import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * AETHER web client (React + TypeScript).
 *
 * Dev server proxies `/api/*` to the local Cloudflare Worker (`npm run dev:worker`)
 * so the browser never talks to the Worker origin directly during development and
 * no CORS configuration is required locally.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'web'),
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, 'dist/web'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // The Arena preview host (and other tunnels) reach the dev server through a
    // proxied origin, so host checking must not reject it.
    allowedHosts: true,
    proxy: {
      '/api': {
        target: process.env.VITE_WORKER_ORIGIN ?? 'http://127.0.0.1:8787',
        changeOrigin: false,
        ws: false,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
