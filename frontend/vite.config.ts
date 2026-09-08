import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const proxyTarget = process.env.LOCALELOCK_API_PROXY ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@shared': path.resolve(repoRoot, 'shared') },
  },
  server: {
    port: 5173,
    strictPort: false,
    fs: { allow: [repoRoot] },
    proxy: { '/api': { target: proxyTarget, changeOrigin: true } },
  },
  preview: {
    port: 4173,
    proxy: { '/api': { target: proxyTarget, changeOrigin: true } },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    emptyOutDir: true,
  },
});
