import { execFileSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: { __BASE_VERSION__: JSON.stringify(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()) },
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: {
      '/preview/main/': { target: 'http://127.0.0.1:5174', ws: true },
      '/scene': { target: 'http://127.0.0.1:3001' },
      '/assets': { target: 'http://127.0.0.1:3001' },
      '/events': { target: 'http://127.0.0.1:3001', ws: true },
    },
  },
});
