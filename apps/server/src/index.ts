import { createApp } from './app.ts';
import { createPreviewOrigin } from './work/preview-origin.ts';
import type { Socket } from 'node:net';

const { app, work } = await createApp({ logger: true });
const preview = createPreviewOrigin(work.previews, {
  mainPort: Number(process.env.MAIN_PREVIEW_PORT ?? 5174),
  studioOrigin: process.env.STUDIO_ORIGIN ?? 'http://127.0.0.1:5173',
});
const sockets = new Set<Socket>();
preview.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
app.addHook('preClose', async () => {
  for (const socket of sockets) socket.destroy();
  preview.closeAllConnections();
  await new Promise<void>(resolve => preview.close(() => resolve()));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
try {
  await new Promise<void>((resolve, reject) => {
    preview.once('error', reject);
    preview.listen(Number(process.env.PREVIEW_ORIGIN_PORT ?? 5175), '127.0.0.1', resolve);
  });
  await app.listen({ port: Number(process.env.PORT ?? 3001), host: '127.0.0.1' });
} catch (error) { await app.close(); throw error; }
