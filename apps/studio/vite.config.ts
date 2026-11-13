import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:3001';
const mainPreview = process.env.MAIN_PREVIEW_ORIGIN ?? 'http://127.0.0.1:5174';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: Number(process.env.STUDIO_PORT ?? 5173), strictPort: true,
    proxy: {
      '/preview/main/': { target: mainPreview, ws: true },
      '/preview/c/': { target: backend },
      '/scene': { target: backend },
      '/assets': { target: backend },
      '/events': { target: backend, ws: true },
      '/tasks': { target: backend },
      '/candidates': { target: backend },
      '/version': { target: backend },
    },
  },
});
