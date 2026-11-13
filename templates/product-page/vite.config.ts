import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import sourceTag from '@spatial/vite-plugin-source-tag';

// The main work is served at /preview/main/ on 5174 with HMR through the Studio proxy.
// Candidate previews reuse this file from their own worktree; the backend overrides
// base, port and cache directory through the environment and turns HMR off (a candidate
// is only served after the coding agent has finished writing it).
const candidate = process.env.PREVIEW_BASE !== undefined;
export default defineConfig({
  base: process.env.PREVIEW_BASE ?? '/preview/main/',
  cacheDir: process.env.PREVIEW_CACHE_DIR,
  plugins: [sourceTag(), react()],
  server: {
    host: '127.0.0.1', port: Number(process.env.PREVIEW_PORT ?? 5174), strictPort: true,
    hmr: candidate ? false : { clientPort: Number(process.env.STUDIO_PORT ?? 5173), path: '/hmr' },
  },
});
