import { createApp } from './app.ts';

const { app } = await createApp({ logger: true });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
await app.listen({ port: Number(process.env.PORT ?? 3001), host: '127.0.0.1' });
