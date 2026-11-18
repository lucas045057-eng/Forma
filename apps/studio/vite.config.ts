import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const backend = process.env.BACKEND_ORIGIN ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    cors: false,
    headers: { 'Cross-Origin-Resource-Policy': 'same-origin' },
    host: '127.0.0.1', port: Number(process.env.STUDIO_PORT ?? 5173), strictPort: true,
    proxy: {
      '/health': { target: backend },
      '/speech': { target: backend },
      '/approvals': { target: backend },
      '/checks': { target: backend },
      '/scene': { target: backend },
      '/assets': { target: backend },
      '/events': { target: backend, ws: true },
      '/tasks': { target: backend },
      '/candidates': { target: backend },
      '/version': { target: backend },
      '/works': { target: backend },
    },
  },
});
