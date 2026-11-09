import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import sourceTag from '@spatial/vite-plugin-source-tag';

export default defineConfig({
  base: '/preview/main/',
  plugins: [sourceTag(), react()],
  server: { host: '127.0.0.1', port: 5174, strictPort: true, hmr: { clientPort: 5173, path: '/hmr' } },
});
