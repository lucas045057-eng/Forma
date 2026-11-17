import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PlacementSession } from './placement-state.ts';
import { DragSessionCache, liveSession } from './drag-session.ts';

const session = (sessionId: string, expiresAt: number, assetId = 'asset-a'): PlacementSession => ({ sessionId, assetId, baseVersion: 'v1', expiresAt });

let now = 1_000_000;
let restoreClock = () => {};
beforeEach(() => {
  now = 1_000_000;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  restoreClock = () => clock.mockRestore();
});
afterEach(() => restoreClock());

it('treats a cached session as live only before its server-issued expiry', () => {
  const cached = { 'asset-a': session('s1', Date.now() + 50) };
  expect(liveSession(cached, 'asset-a')?.sessionId).toBe('s1');
  expect(liveSession(cached, 'asset-b')).toBeUndefined();
  now += 80;
  expect(liveSession(cached, 'asset-a')).toBeUndefined();
});

it('reuses a live cache for repeated interactions and prepares again only after the cached session expires', async () => {
  const cache = new DragSessionCache();
  let serial = 0;
  const prepare = vi.fn(async (): Promise<PlacementSession> => {
    serial += 1;
    return session(`s${serial}`, Date.now() + 50);
  });

  const first = await cache.ensure('asset-a', prepare);
  expect(first.sessionId).toBe('s1');
  expect(prepare).toHaveBeenCalledTimes(1);

  // pointer enter, focus and click while the cache is still live must not create another session.
  const repeated = await Promise.all([
    cache.ensure('asset-a', prepare),
    cache.ensure('asset-a', prepare),
    cache.ensure('asset-a', prepare),
  ]);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(repeated.map(item => item.sessionId)).toEqual(['s1', 's1', 's1']);
  expect(cache.live('asset-a')?.sessionId).toBe('s1');

  // Advance the controlled clock past the short expiry; the cache must be treated as absent.
  now += 80;
  expect(cache.live('asset-a')).toBeUndefined();
  const refreshed = await cache.ensure('asset-a', prepare);
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(refreshed.sessionId).toBe('s2');
  expect(cache.live('asset-a')?.sessionId).toBe('s2');
});

it('merges concurrent interactions for one asset and keeps different assets independent', async () => {
  const cache = new DragSessionCache();
  const resolvers: Array<(value: PlacementSession) => void> = [];
  const prepare = vi.fn((): Promise<PlacementSession> => new Promise(resolve => { resolvers.push(resolve); }));

  const first = cache.ensure('asset-a', prepare);
  const second = cache.ensure('asset-a', prepare);
  const other = cache.ensure('asset-b', prepare);
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(resolvers).toHaveLength(2);

  resolvers[0](session('a1', Date.now() + 1000));
  resolvers[1](session('b1', Date.now() + 1000, 'asset-b'));
  expect(await Promise.all([first, second, other])).toEqual([
    expect.objectContaining({ sessionId: 'a1' }),
    expect.objectContaining({ sessionId: 'a1' }),
    expect.objectContaining({ sessionId: 'b1' }),
  ]);
  expect(cache.live('asset-a')?.sessionId).toBe('a1');
  expect(cache.live('asset-b')?.sessionId).toBe('b1');
});

it('surfaces a preparation failure and lets a later interaction retry', async () => {
  const cache = new DragSessionCache();
  const failure = new Error('会话创建失败');
  const prepare = vi.fn()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(session('s2', Date.now() + 1000));

  await expect(cache.ensure('asset-a', prepare)).rejects.toBe(failure);
  expect(cache.live('asset-a')).toBeUndefined();
  expect(cache.snapshot()).toEqual({});
  expect((await cache.ensure('asset-a', prepare)).sessionId).toBe('s2');
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(cache.live('asset-a')?.sessionId).toBe('s2');
});

it('never reports a just-created but already expired session as usable', async () => {
  const cache = new DragSessionCache();
  const prepare = vi.fn(async (): Promise<PlacementSession> => session('dead', Date.now() - 1));

  await cache.ensure('asset-a', prepare);
  expect(cache.live('asset-a')).toBeUndefined();
  expect(cache.snapshot()['asset-a']?.sessionId).toBe('dead');
  await cache.ensure('asset-a', prepare);
  expect(prepare).toHaveBeenCalledTimes(2);
});
