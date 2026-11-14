import { expect, it, vi } from 'vitest';
import { randomInt } from 'node:crypto';
import { createCodingAgentMock } from '../agent/mock-server.ts';
import { listenForFetch, listenHttpForFetch } from './fetch-listener.ts';

it('never binds a fetch-forbidden candidate and returns the listener it keeps open', async () => {
  const listen = vi.fn(async ({ port }: { port: number; host: string }) => `http://127.0.0.1:${port}`);
  const close = vi.fn(async () => {});
  const mock = { listen, close };
  const create = vi.fn(async () => mock);
  const ports = [6000, 20000];
  const result = await listenForFetch(create, () => ports.shift()!);
  expect(result).toEqual({ mock, baseUrl: 'http://127.0.0.1:20000' });
  expect(create).toHaveBeenCalledTimes(1);
  expect(listen).toHaveBeenCalledExactlyOnceWith({ host: '127.0.0.1', port: 20000 });
  expect(close).not.toHaveBeenCalled();
});

it('closes a listener whose bind collided before allocating a new one', async () => {
  const busy = { listen: vi.fn(async () => { throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' }); }), close: vi.fn(async () => {}) };
  const available = { listen: vi.fn(async () => 'http://127.0.0.1:20001'), close: vi.fn(async () => {}) };
  const instances = [busy, available];
  const ports = [20000, 20001];
  const result = await listenForFetch(async () => instances.shift()!, () => ports.shift()!);
  expect(result.mock).toBe(available);
  expect(busy.close).toHaveBeenCalledOnce();
  expect(available.close).not.toHaveBeenCalled();
  expect(available.listen).toHaveBeenCalledExactlyOnceWith({ host: '127.0.0.1', port: 20001 });
});

it('propagates a bind error other than an occupied port after cleaning up', async () => {
  const error = Object.assign(new Error('denied'), { code: 'EACCES' });
  const mock = { listen: vi.fn(async () => { throw error; }), close: vi.fn(async () => {}) };
  const create = vi.fn(async () => mock);
  await expect(listenForFetch(create, () => 20000)).rejects.toBe(error);
  expect(mock.close).toHaveBeenCalledOnce();
  expect(create).toHaveBeenCalledOnce();
});

it('does not allocate another listener when cleanup fails', async () => {
  const cleanupError = new Error('cleanup failed');
  const mock = { listen: vi.fn(async () => { throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' }); }), close: vi.fn(async () => { throw cleanupError; }) };
  const create = vi.fn(async () => mock);
  await expect(listenForFetch(create, () => 20000)).rejects.toBe(cleanupError);
  expect(create).toHaveBeenCalledOnce();
});

it('bounds allocation when every candidate remains occupied', async () => {
  const close = vi.fn(async () => {});
  const create = vi.fn(async () => ({ listen: async () => { throw Object.assign(new Error('busy'), { code: 'EADDRINUSE' }); }, close }));
  await expect(listenForFetch(create, () => 20000)).rejects.toThrow('fetch-compatible test listener');
  expect(create.mock.calls.length).toBeGreaterThan(0);
  expect(create.mock.calls.length).toBeLessThanOrEqual(32);
  expect(close).toHaveBeenCalledTimes(create.mock.calls.length);
});

it('keeps a real HTTP listener reachable to native fetch and closes it without an orphan', async () => {
  const { server, baseUrl } = await listenHttpForFetch((_request, reply) => reply.end('ready'));
  try {
    expect(Number(new URL(baseUrl).port)).toBeGreaterThanOrEqual(20_000);
    expect(await (await fetch(baseUrl)).text()).toBe('ready');
    expect(server.listening).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  expect(server.listening).toBe(false);
});

it('handles a real Fastify bind collision without closing the existing listener', async () => {
  const owner = await listenHttpForFetch((_request, reply) => reply.end('owner'));
  const occupiedPort = Number(new URL(owner.baseUrl).port);
  let first = true;
  let allocated: Awaited<ReturnType<typeof createCodingAgentMock>> | undefined;
  try {
    const result = await listenForFetch(() => createCodingAgentMock({ scenario: 'no-tools' }), () => {
      if (first) { first = false; return occupiedPort; }
      return randomInt(20_000, 65_536);
    });
    allocated = result.mock;
    expect(new URL(result.baseUrl).port).not.toBe(String(occupiedPort));
    expect(await (await fetch(owner.baseUrl)).text()).toBe('owner');
    expect((await fetch(`${result.baseUrl}/__stats`)).status).toBe(200);
  } finally {
    await allocated?.close();
    owner.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => owner.server.close(error => error ? reject(error) : resolve()));
  }
});
