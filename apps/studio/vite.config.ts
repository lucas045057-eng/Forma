import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', port: 5173, strictPort: true,
    proxy: {
      '/preview/main/': { target: 'http://127.0.0.1:5174', ws: true },
      '/preview/c/': { target: 'http://127.0.0.1:3001' },
      '/scene': { target: 'http://127.0.0.1:3001' },
      '/assets': { target: 'http://127.0.0.1:3001' },
      '/events': { target: 'http://127.0.0.1:3001', ws: true },
      '/tasks': { target: 'http://127.0.0.1:3001' },
      '/candidates': { target: 'http://127.0.0.1:3001' },
      '/version': { target: 'http://127.0.0.1:3001' },
    },
  },
});
