import { afterEach, describe, expect, it, vi } from 'vitest';
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
it('distinguishes official gateway, legacy cloud gateways and local loopback mocks', () => {
  expect(new Lux3DClient({ base: 'https://api.aholo.cn', key: 'k' }).legacyGateway).toBe(false);
  expect(new Lux3DClient({ base: 'https://api.aholo3d.cn', key: 'k' }).legacyGateway).toBe(true);
  expect(new Lux3DClient({ base: 'https://api.aholo.ai', key: 'k' }).legacyGateway).toBe(true);
  expect(new Lux3DClient({ base: 'http://127.0.0.1:4010', key: 'k' }).legacyGateway).toBe(false);
  expect(new Lux3DClient({ base: 'http://localhost:4010', key: 'k' }).legacyGateway).toBe(false);
  expect(new Lux3DClient({ base: 'http://[::1]:4010', key: 'k' }).legacyGateway).toBe(false);
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

function respond(status: number, body: string) { return new Response(body, { status, headers: { 'content-type': 'application/json' } }); }
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('Lux3D submission classification (F7)', () => {
  const client = () => new Lux3DClient({ base: 'http://127.0.0.1:49999', key: 'fake-only' });
  it('treats 400/401 as explicit rejection but 403 and 5xx as unknown', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(respond(400, '{"c":"-1","m":"bad"}'));
    await expect(client().providerRequest({ route: '/lux3d/v1/generate/task/get?taskid=1' })).rejects.toMatchObject({ code: 'UPSTREAM_REJECTED', classification: 'rejected' });
    fetchMock.mockResolvedValueOnce(respond(401, '{"c":"-1"}'));
    await expect(client().providerRequest({ route: '/lux3d/v1/generate/task/get?taskid=1' })).rejects.toMatchObject({ code: 'UPSTREAM_AUTH', classification: 'rejected' });
    fetchMock.mockResolvedValueOnce(respond(403, '{"c":"0"}'));
    await expect(client().providerRequest({ route: '/lux3d/v1/generate/task/get?taskid=1' })).rejects.toMatchObject({ code: 'UPSTREAM_FORBIDDEN', classification: 'unknown' });
    fetchMock.mockResolvedValueOnce(respond(500, '{"c":"0"}'));
    await expect(client().providerRequest({ route: '/lux3d/v1/generate/task/get?taskid=1' })).rejects.toMatchObject({ code: 'UPSTREAM_HTTP', classification: 'unknown' });
  });
  it('treats a 200 malformed envelope as unknown instead of rejected', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(respond(200, '{"d":{}}')));
    await expect(client().providerRequest({ route: '/lux3d/v1/generate/task/get?taskid=1' })).rejects.toMatchObject({ code: 'UPSTREAM_FORMAT', classification: 'unknown' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(respond(200, 'not-json')));
    await expect(client().providerRequest({ route: '/lux3d/v1/generate/task/get?taskid=1' })).rejects.toMatchObject({ code: 'UPSTREAM_FORMAT', classification: 'unknown' });
  });
});
