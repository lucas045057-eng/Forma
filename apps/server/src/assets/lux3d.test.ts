import { expect, it, vi } from 'vitest';
import { Lux3DClient } from './lux3d.ts';
import { listenHttpForFetch } from '../test-support/fetch-listener.ts';

it.each(['http://example.com', 'http://10.0.0.1', 'ftp://example.com', 'https://user:secret@example.com'])('rejects unsafe upstream %s before any request', base => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    expect(() => new Lux3DClient({ base, key: 'mock-only' })).toThrow('HTTPS required');
    expect(fetch).not.toHaveBeenCalled();
  } finally { fetch.mockRestore(); }
});
it.each(['http://127.0.0.1:4010', 'http://localhost:4010', 'http://[::1]:4010', 'https://example.com'])('accepts secure or loopback configuration %s', base => {
  expect(new Lux3DClient({ base, key: 'mock-only' }).base).toBe(base);
});
it('aborts an in-flight task query without waiting for the upstream timeout', async () => {
  let started!: () => void;
  const received = new Promise<void>(resolve => { started = resolve; });
  const { server, baseUrl } = await listenHttpForFetch(() => started());
  const controller = new AbortController();
  const nativeFetch = globalThis.fetch;
  const port = (server.address() as { port: number }).port;
  console.info('[lux3d-test fixture]', { port });
  const transport = vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
    try { return await nativeFetch(...args); }
    catch (error) {
      console.error('[lux3d-test transport]', { port, error: error instanceof Error ? error.message : String(error),
        cause: error instanceof Error ? error.cause : undefined });
      throw error;
    }
  });
  try {
    const client = new Lux3DClient({ base: baseUrl, key: 'mock-only' });
    const result = expect(client.getTask('123', controller.signal)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    await received;
    const start = Date.now(); controller.abort(); await result;
    expect(Date.now() - start).toBeLessThan(1500);
  } finally { transport.mockRestore(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
