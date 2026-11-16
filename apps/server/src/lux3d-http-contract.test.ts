import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from './app.ts';
import { AssetError, Lux3DClient } from './assets/lux3d.ts';

let root: string | undefined;
let instance: Awaited<ReturnType<typeof createApp>> | undefined;
// Only the remote boundary is replaced. Routing, plugins, validation and error handling are real.
const providerCreate = vi.spyOn(Lux3DClient.prototype, 'createProviderTask')
  .mockRejectedValue(new AssetError('TEST_PROVIDER_UNAVAILABLE', 'No provider request in this test', 502, 'unknown'));

function app() {
  if (!instance) throw new Error('HTTP contract fixture was not initialized');
  return instance.app;
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'lux3d-http-contract-'));
  const workRoot = path.join(root, 'work');
  await mkdir(path.join(workRoot, 'src'), { recursive: true });
  await writeFile(path.join(workRoot, 'src/App.tsx'), 'export default () => <main/>;\n');
  instance = await createApp({
    workRoot, dataDirectory: path.join(root, 'assets'), workDataDirectory: path.join(root, 'work-data'),
    historyDirectory: path.join(root, 'history'), base: 'http://127.0.0.1:9', key: 'contract-fake-only',
    codingAgentBaseUrl: 'http://127.0.0.1:9', codingAgentApiKey: 'contract-fake-only', codingAgentModel: 'contract-test',
    speech: {},
  });
});

afterAll(async () => {
  const errors: unknown[] = [];
  try { await instance?.app.close(); } catch (error) { errors.push(error); }
  providerCreate.mockRestore();
  if (root) {
    try {
      const parent = await realpath(tmpdir());
      const actual = await realpath(root);
      if (path.dirname(actual) !== parent || !path.basename(actual).startsWith('lux3d-http-contract-')) {
        throw new Error('Refusing cleanup outside the owned contract-test directory');
      }
      await rm(actual, { recursive: true, force: true });
    } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'HTTP contract fixture cleanup failed');
});

it('returns the shared INVALID_IMAGE envelope from the encapsulated upload route', async () => {
  const result = await app().inject({
    method: 'POST', url: '/assets/uploads?kind=image&filename=looks-like.png',
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'),
  });
  expect(result.statusCode).toBe(400);
  expect(result.json()).toMatchObject({ error: { code: 'INVALID_IMAGE', message: expect.any(String) } });
});

it('returns the shared INVALID_GLB envelope from the encapsulated upload route', async () => {
  const result = await app().inject({
    method: 'POST', url: '/assets/uploads?kind=glb&filename=broken.glb',
    headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('glTF-not-really'),
  });
  expect(result.statusCode).toBe(400);
  expect(result.json()).toMatchObject({ error: { code: 'INVALID_GLB', message: expect.any(String) } });
});

it('returns the shared INVALID_OPERATION_INPUT envelope from workbench routes', async () => {
  const result = await app().inject({ method: 'POST', url: '/assets/lux3d/operations', payload: { unexpected: true } });
  expect(result.statusCode).toBe(400);
  expect(result.json()).toMatchObject({ error: { code: 'INVALID_OPERATION_INPUT', message: expect.any(String) } });
});

it('retains the 409 IDEMPOTENCY_CONFLICT envelope without a second provider creation', async () => {
  const payload = { operation: 'text-to-3d', parameters: { prompt: 'first', version: 'G1', outputFormat: ['glb'] }, idempotencyKey: 'http-contract-key' };
  expect((await app().inject({ method: 'POST', url: '/assets/lux3d/operations', payload })).statusCode).toBe(202);
  const result = await app().inject({
    method: 'POST', url: '/assets/lux3d/operations',
    payload: { ...payload, parameters: { ...payload.parameters, prompt: 'different' } },
  });
  expect(result.statusCode).toBe(409);
  expect(result.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_CONFLICT', message: expect.any(String) } });
  // The admitted task starts asynchronously; wait for that real first call, not a fixed sleep.
  await expect.poll(() => providerCreate.mock.calls.length).toBe(1);
});

it('preserves the error envelope on the existing import API', async () => {
  const result = await app().inject({ method: 'POST', url: '/assets/lux3d/import', payload: { taskId: 'not-an-id' } });
  expect(result.statusCode).toBe(400);
  expect(result.json()).toMatchObject({ error: { code: 'INVALID_TASK', message: expect.any(String) } });
});

it.each([
  ['HOST_DENIED', { host: 'outside.invalid' }],
  ['ORIGIN_DENIED', { host: '127.0.0.1', origin: 'https://outside.invalid' }],
] as const)('keeps %s enforced on upload, workbench and existing routes', async (code, headers) => {
  const before = providerCreate.mock.calls.length;
  for (const url of ['/assets/uploads', '/assets/lux3d/operations', '/assets/lux3d', '/tasks']) {
    const result = await app().inject({ method: 'POST', url, headers, payload: {} });
    expect(result.statusCode).toBe(403);
    expect(result.json()).toMatchObject({ error: { code } });
  }
  expect(providerCreate.mock.calls.length).toBe(before);
});
