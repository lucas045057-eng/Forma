import Fastify from 'fastify';
import websocket from '@fastify/websocket';

const app = Fastify({ logger: true });
await app.register(websocket);
app.get('/health', async () => ({ status: 'ok', milestone: 'M0-B' }));
app.get('/events', { websocket: true }, (socket) => {
  socket.send(JSON.stringify({ type: 'ready', message: 'M0 placeholder' }));
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
await app.listen({ port: 3001, host: '127.0.0.1' });
