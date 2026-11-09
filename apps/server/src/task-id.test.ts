import { expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from './app.ts';
import { createMockServer } from './assets/mock-server.ts';

async function fixture() {
  const root = path.resolve(import.meta.dirname, '../../../.data');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'task-id-'));
  const mock = await createMockServer();
  const base = await mock.listen({ host: '127.0.0.1', port: 0 });
  const { app } = await createApp({ dataDirectory: directory, base, key: 'mock-only', pollMs: 1 });
  return { app, mock, close: async () => { await app.close(); await mock.close(); await rm(directory, { recursive: true, force: true }); } };
}

it.each(['1e5', '0', '01', ' 1', '1 ', '1\n', '1\r\n', '1.5', '', '+1', '12345678901234567890', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, true, ['123'], { id: '123' }])('rejects invalid raw taskId %j without upstream queries', async taskId => {
  const { app, mock, close } = await fixture();
  try {
    const response = await app.inject({ method: 'POST', url: '/assets/lux3d/import', payload: { taskId } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_TASK');
    expect((await mock.inject('/__stats')).json()).toEqual({ creates: 0, gets: 0 });
  } finally { await close(); }
});
it.each(['123', '9007199254740992', '9999999999999999999', 456, Number.MAX_SAFE_INTEGER])('accepts valid raw taskId %j without losing precision', async taskId => {
  const { app, close } = await fixture();
  try {
    const response = await app.inject({ method: 'POST', url: '/assets/lux3d/import', payload: { taskId } });
    expect(response.statusCode).toBe(202);
    expect(response.json().taskId).toBe(String(taskId));
  } finally { await close(); }
});
