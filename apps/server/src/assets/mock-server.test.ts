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
      { ...text, img: 'https://example.com/image.png' },
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
    expect(list.json()).toEqual({ c: '0', d: [] });
    for (const status of [0, 1, 3]) {
      const result = await mock.inject({ url: '/lux3d/v1/generate/task/get?taskid=9000001', headers: auth });
      expect(result.json().d.status).toBe(status);
    }
    expect((await mock.inject('/__stats')).json()).toEqual({ creates: 3, gets: 3 });
  });

  it('serves a truncated GLB whose header still declares the full length', async () => {
    const mock = await setup({ scenario: 'truncated' });
    const result = await mock.inject('/output/model.glb');
    expect(result.statusCode).toBe(200);
    expect(result.rawPayload.subarray(0, 4).toString()).toBe('glTF');
    expect(result.rawPayload.readUInt32LE(8)).toBeGreaterThan(result.rawPayload.length);
  });
});
