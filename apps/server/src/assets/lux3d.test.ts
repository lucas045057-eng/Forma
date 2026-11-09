import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { Lux3DClient } from './lux3d.ts';

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
  const server = createServer(() => started());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const controller = new AbortController();
  try {
    const client = new Lux3DClient({ base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, key: 'mock-only' });
    const result = expect(client.getTask('123', controller.signal)).rejects.toMatchObject({ code: 'UPSTREAM_UNAVAILABLE' });
    await received;
    const start = Date.now(); controller.abort(); await result;
    expect(Date.now() - start).toBeLessThan(1500);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
