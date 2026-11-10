import { createApp } from './app.ts';

const { app } = await createApp({ logger: true });
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => { void app.close(); });
}
try { await app.listen({ port: Number(process.env.PORT ?? 3001), host: '127.0.0.1' }); }
catch (error) { await app.close(); throw error; } // Release the asset directory lock when the port is taken.
