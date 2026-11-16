import { afterEach, describe, expect, it } from 'vitest';
import { createMockServer } from './mock-server.ts';

const mocks: Awaited<ReturnType<typeof createMockServer>>[] = [];
afterEach(async () => { for (const mock of mocks.splice(0)) await mock.close(); });
async function setup(options: Parameters<typeof createMockServer>[0] = {}) {
  const mock = await createMockServer(options);
  mocks.push(mock);
  return mock;
}
const textRoute = '/lux3d/v1/generate/text-to-3d/task/create';
const imageRoute = '/lux3d/v1/generate/img-to-3d/task/create';
const partRoute = '/lux3d/v1/part-split/task/create';
const headers = { authorization: 'mock-only' };
const text = { prompt: 'wooden bottle', version: 'G1', outputFormat: ['glb'] };

describe('isolated Lux3D mock contract', () => {
  it('requires an exact raw key for every Lux3D route and keeps stats public and minimal', async () => {
    const mock = await setup();
    for (const authorization of [undefined, 'wrong-key', 'Bearer mock-only']) {
      for (const url of [textRoute, imageRoute, partRoute, '/lux3d/v1/generate/task/list', '/lux3d/v1/generate/task/get?taskid=9000001']) {
        const isCreate = url.endsWith('/create');
        const result = await mock.inject({ method: isCreate ? 'POST' : 'GET', url,
          headers: authorization ? { authorization } : {}, ...(isCreate ? { payload: text } : {}) });
        expect(result.statusCode).toBe(401);
      }
    }
    expect((await mock.inject('/__stats')).json()).toEqual({ creates: 0, gets: 0 });
    expect((await mock.inject('/output/model.glb')).statusCode).toBe(200);
  });

  it('rejects malformed generation bodies without creating a task', async () => {
    const mock = await setup();
    const invalid = [
      {}, { ...text, version: 'G2' }, { ...text, version: 1 },
      { ...text, prompt: '' }, { ...text, prompt: '   ' }, { ...text, prompt: 42 },
      { ...text, imgs: ['https://example.com/image.png'] }, { ...text, unknown: 1 },
      { img: 'https://example.com/image.png', version: 'G1', outputFormat: ['glb'] },
      { ...text, outputFormat: [] }, { ...text, outputFormat: ['obj'] },
      { ...text, outputFormat: ['glb', 'obj'] }, { ...text, outputFormat: ['glb', 'glb'] },
      { ...text, outputFormat: 'glb' }, { prompt: 'bottle', version: 'G1' },
    ];
    for (const payload of invalid) {
      expect((await mock.inject({ method: 'POST', url: textRoute, headers, payload })).statusCode).toBe(400);
    }
    expect((await mock.inject({ method: 'POST', url: imageRoute, headers, payload: text })).statusCode).toBe(400);
    expect((await mock.inject('/__stats')).json()).toEqual({ creates: 0, gets: 0 });
  });

  it('validates part split separately from generation', async () => {
    const mock = await setup();
    for (const payload of [{}, text, { glbUrl: '' }, { glbUrl: 42 }, { glbUrl: 'not-a-url' }, { glbUrl: 'https://example.com/model.glb', ...text }]) {
      expect((await mock.inject({ method: 'POST', url: partRoute, headers, payload })).statusCode).toBe(400);
    }
    expect((await mock.inject('/__stats')).json().creates).toBe(0);
  });

  it('accepts text, image, part split, list and get with a configured key', async () => {
    const mock = await setup({ key: 'test-only-key' });
    const auth = { authorization: 'test-only-key' };
    expect((await mock.inject({ method: 'POST', url: textRoute, headers, payload: text })).statusCode).toBe(401);
    for (const [url, payload] of [
      [textRoute, text],
      [imageRoute, { img: 'https://example.com/image.png', version: 'G1-Turbo', outputFormat: ['glb'], enablePbr: true }],
      [partRoute, { glbUrl: 'https://example.com/model.glb' }],
    ] as const) {
      const response = await mock.inject({ method: 'POST', url, headers: auth, payload });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ c: '0', d: expect.stringMatching(/^\d+$/) });
    }
    const list = await mock.inject({ url: '/lux3d/v1/generate/task/list', headers: auth });
    expect(list.json()).toEqual({ c: '0', d: { items: expect.any(Array), total: 3, page: 1, pageSize: 20 } });
    expect(list.json().d.items).toHaveLength(3);
    for (const status of [0, 1, 3]) {
      const result = await mock.inject({ url: '/lux3d/v1/generate/task/get?taskid=9000001', headers: auth });
      expect(result.json().d.status).toBe(status);
    }
    expect((await mock.inject('/__stats')).json()).toEqual({ creates: 3, gets: 3 });
  });

  it('serves all ten official create routes and typed multi-format outputs', async () => {
    const mock = await setup({ key: 'test-only-key' });
    const auth = { authorization: 'test-only-key' };
    const bodies: Record<string, Record<string, unknown>> = {
      [textRoute]: text,
      [imageRoute]: { img: 'https://example.com/image.png', version: 'G1-Turbo', outputFormat: ['glb'] },
      '/lux3d/v1/generate/multimodal-to-image/task/create': { prompt: 'chair' },
      '/lux3d/v1/generate/image-to-four-view/task/create': { img: 'https://example.com/image.png' },
      '/lux3d/v1/generate/material-transfer/task/create': { img: 'https://example.com/m.png', meshUrl: 'https://example.com/m.glb', version: 'v3.0-standard', outputFormat: ['zip', 'glb'] },
      [partRoute]: { glbUrl: 'https://example.com/model.glb' },
      '/lux3d/v1/multi-format-export/task/create': { modelUrl: 'https://example.com/model.glb', outputFormat: ['stl'] },
      '/lux3d/v1/articulation-animation/task/create': { glbUrl: 'https://example.com/model.glb', prompt: 'open lid' },
      '/lux3d/v1/animations/rig/task/create': { modelUrl: 'https://example.com/model.glb' },
      '/lux3d/v1/animations/retarget/task/create': { rigModelUrl: 'https://example.com/model.glb', animationIds: ['Idle_Loop'], animationOutputMode: 'combined' },
    };
    expect(Object.keys(bodies)).toHaveLength(10);
    for (const [url, payload] of Object.entries(bodies)) {
      const response = await mock.inject({ method: 'POST', url, headers: auth, payload });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ c: '0' });
    }
    const material = await mock.inject({ url: '/lux3d/v1/generate/task/get?taskid=9000005', headers: auth });
    for (let index = 0; index < 2; index++) await mock.inject({ url: '/lux3d/v1/generate/task/get?taskid=9000005', headers: auth });
    const outputs = (await mock.inject({ url: '/lux3d/v1/generate/task/get?taskid=9000005', headers: auth })).json().d.outputs;
    expect(outputs).toHaveLength(5);
    expect(outputs.filter((item: { content: string }) => item.content === 'NOT_REQUESTED').length).toBeGreaterThan(0);
    expect(material.statusCode).toBe(200);
  });

  it('returns an unquoted int64 task id in the dedicated lossless scenario', async () => {
    const mock = await setup({ scenario: 'int64', key: 'test-only-key' });
    const response = await mock.inject({ method: 'POST', url: imageRoute, headers: { authorization: 'test-only-key' }, payload: { img: 'https://example.com/image.png', version: 'G1', outputFormat: ['glb'] } });
    expect(response.body).toContain('9223372036854775807');
    expect(response.body).not.toContain('"9223372036854775807"');
  });

  it('implements the OUS token/single/block/status chain without reusing the API key', async () => {
    const mock = await setup({ key: 'test-only-key' });
    const token = await mock.inject({ url: '/asset/v1/token', headers: { authorization: 'test-only-key' } });
    expect(token.json()).toMatchObject({ ousToken: 'mock-ous-token', blockSize: 4 });
    const single = await mock.inject({ method: 'POST', url: '/ous/api/v2/single/upload', headers: { 'ous-token-v2': 'mock-ous-token', 'content-type': 'multipart/form-data; boundary=x' }, payload: Buffer.from('--x--') });
    expect(single.statusCode).toBe(200);
    const init = await mock.inject({ method: 'POST', url: '/ous/api/v2/block/upload/init?md5=0&blocks=4&size=16&name=x.glb', headers: { 'ous-token-v2': 'mock-ous-token' } });
    expect(init.json().d.lackBlocks).toEqual(['2-3']);
    const part = await mock.inject({ method: 'POST', url: '/ous/api/v2/block/upload/part', headers: { 'ous-token-v2': 'mock-ous-token', 'content-type': 'multipart/form-data; boundary=x' }, payload: Buffer.from('--x--') });
    expect(part.statusCode).toBe(200);
    const status = await mock.inject({ url: '/ous/api/v2/upload/status', headers: { 'ous-token-v2': 'mock-ous-token' } });
    expect(status.json().d.status).toBe(5);
    expect((await mock.inject({ url: '/ous/api/v2/upload/status', headers: { authorization: 'test-only-key' } })).statusCode).toBe(401);
  });

  it('serves a truncated GLB whose header still declares the full length', async () => {
    const mock = await setup({ scenario: 'truncated' });
    const result = await mock.inject('/output/model.glb');
    expect(result.statusCode).toBe(200);
    expect(result.rawPayload.subarray(0, 4).toString()).toBe('glTF');
    expect(result.rawPayload.readUInt32LE(8)).toBeGreaterThan(result.rawPayload.length);
  });
});
