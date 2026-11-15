import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import sourceTag from '@spatial/vite-plugin-source-tag';
import { realpathSync, readdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const allow = new Set([root]);
const dependencies = path.join(root, 'node_modules');
function packages(folder: string) {
  for (const entry of readdirSync(folder)) {
    if (entry.startsWith('.')) continue;
    const location = path.join(folder, entry);
    if (entry.startsWith('@')) { packages(location); continue; }
    const real = realpathSync(location);
    allow.add(real);
    // pnpm's store contains dependency code, never the enclosing workspace.
    const pieces = real.split(path.sep), index = pieces.lastIndexOf('.pnpm');
    if (index >= 0) allow.add(pieces.slice(0, index + 1).join(path.sep));
  }
}
packages(dependencies);
export default defineConfig({
  base: process.env.PREVIEW_BASE ?? '/preview/main/',
  cacheDir: process.env.PREVIEW_CACHE_DIR,
  plugins: [sourceTag(), react()],
  server: {
    host: '127.0.0.1', port: Number(process.env.PREVIEW_PORT ?? 5174), strictPort: true,
    fs: { strict: true, allow: [...allow], deny: ['**/.env*', '**/*.{pem,key,crt,p12,pfx}', '**/.git/**', '**/*.{bak,tmp}'] },
    // Vite's client always opens its WebSocket and reloads the page in a loop when it cannot,
    // so candidates are not run with HMR off: main work and candidates both reach their own
    // dev server's socket through the preview origin at <base>hmr.
    hmr: { clientPort: Number(process.env.PREVIEW_ORIGIN_PORT ?? 5175), path: '/hmr' },
  },
});
