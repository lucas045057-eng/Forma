import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './app.ts';
import { createMockServer } from './assets/mock-server.ts';
import { listenForFetch } from './test-support/fetch-listener.ts';

it('runs the mock import through HTTP, processing and model serving; rejects invalid inputs and foreign origins', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'spatial-api-'));
  const { mock, baseUrl: base } = await listenForFetch(() => createMockServer());
  const { app, service } = await createApp({ dataDirectory: directory, base, key: 'mock-only', pollMs: 1 });
  try {
    const invalid = await app.inject({ method: 'POST', url: '/assets/lux3d', payload: { prompt: 'bottle', img: 'https://example.com/x.png', version: 'G1', idempotencyKey: 'one' } });
    expect(invalid.statusCode).toBe(400);
    const foreign = await app.inject({ method: 'POST', url: '/assets/lux3d/import', headers: { origin: 'https://example.com' }, payload: { taskId: '123' } });
    expect(foreign.statusCode).toBe(403);
    const imported = await app.inject({ method: 'POST', url: '/assets/lux3d/import', payload: { taskId: '123' } });
    expect(imported.statusCode).toBe(202);
    await service.idle();
    const asset = (await app.inject(`/assets/${imported.json().id}`)).json();
    expect(asset.status).toBe('ready');
    expect(asset.metrics.after.vertices).toBe(3);
    const model = await app.inject(asset.modelUrl);
    expect(model.statusCode).toBe(200);
    expect(model.headers['content-type']).toContain('model/gltf-binary');
    expect(model.rawPayload.toString('ascii', 0, 4)).toBe('glTF');
    expect((await mock.inject('/__stats')).json().creates).toBe(0);
    expect((await app.inject('/assets/no-such/model.glb')).statusCode).toBe(404);
    expect(JSON.stringify(asset)).not.toContain('mock-only');
  } finally { await app.close(); await mock.close(); await rm(directory, { recursive: true, force: true }); }
});
