import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AssetService } from './service.ts';
import { Lux3DClient } from './lux3d.ts';
import { createMockServer, type MockScenario } from './mock-server.ts';
import { downloadGlb } from './download.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
async function setup(scenario: MockScenario = 'success', timeoutMs = 2000) {
  const directory = await mkdtemp(path.join(tmpdir(), 'spatial-assets-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const mock = await createMockServer({ scenario });
  const base = await mock.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => mock.close());
  const client = new Lux3DClient({ base, key: 'test-only-key' });
  const events: string[] = [];
  const service = new AssetService({ directory, client, pollMs: 1, timeoutMs,
    emit: event => events.push(event.type),
    process: async () => ({ before: { bytes: 1000, vertices: 3 }, after: { bytes: 500, vertices: 3 }, durationMs: 1, bounds: { min: [-0.5, 0, 0], max: [0.5, 1, 0] } }),
  });
  await service.init();
  cleanups.push(() => service.close());
  return { directory, mock, base, client, service, events };
}

describe('asset idempotency and polling', () => {
  it('concurrent and restarted submissions use one paid task; conflicting input is rejected', async () => {
    const { service, mock, directory, client, events } = await setup();
    const input = { prompt: 'wooden diffuser', version: 'G1-Turbo' as const };
    const [first, second] = await Promise.all([service.submit(input, 'same-key'), service.submit(input, 'same-key')]);
    expect(second.id).toBe(first.id);
    await service.idle();
    expect(service.get(first.id)?.status).toBe('ready');
    expect(events).toContain('asset.ready');
    expect((await mock.inject('/__stats')).json().creates).toBe(1);
    await expect(service.submit({ ...input, prompt: 'different' }, 'same-key')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const restarted = new AssetService({ directory, client });
    await restarted.init();
    expect((await restarted.submit(input, 'same-key')).taskId).toBe(first.taskId);
    await restarted.close();
    expect((await mock.inject('/__stats')).json().creates).toBe(1);
    const stored = await readFile(path.join(directory, 'index.json'), 'utf8');
    expect(stored).not.toContain('test-only-key');
    expect(stored).not.toContain('output/model.glb');
    expect(JSON.stringify(service.get(first.id))).not.toContain('keyHash');
  });
  it('does not resubmit when the remote creation result is unknown', async () => {
    const { service, client } = await setup();
    const create = vi.spyOn(client, 'createTextTo3d').mockRejectedValue(new Error('sensitive upstream body'));
    const input = { prompt: 'bottle', version: 'G1' as const };
    expect((await service.submit(input, 'unknown-key')).status).toBe('submit_unknown');
    const again = await service.submit(input, 'unknown-key');
    expect(create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(again)).not.toContain('sensitive');
  });
  it.each([
    ['failed', 'failed', 'GENERATION_FAILED'], ['cancelled', 'cancelled', 'GENERATION_CANCELLED'],
    ['expired403', 'failed', 'OUTPUT_URL_EXPIRED'], ['expired404', 'failed', 'OUTPUT_URL_EXPIRED'],
    ['unknown', 'failed', 'UNKNOWN_STATUS'], ['timeout', 'failed', 'POLL_TIMEOUT'],
  ] as const)('handles %s without creating a task during import', async (scenario, status, code) => {
    const { service, mock } = await setup(scenario, scenario === 'timeout' ? 20 : 2000);
    const asset = await service.importTask('4969293');
    await service.idle();
    expect(service.get(asset.id)).toMatchObject({ status, error: { code } });
    expect((await mock.inject('/__stats')).json().creates).toBe(0);
    const before = (await mock.inject('/__stats')).json().gets;
    await service.importTask('4969293');
    await service.idle();
    expect((await mock.inject('/__stats')).json().gets).toBeGreaterThan(before);
  });
  it('rejects unsafe IDs and internal downloads, and wraps part-split on the shared task endpoint', async () => {
    const { service, client, directory } = await setup();
    await expect(service.importTask('../secret')).rejects.toMatchObject({ code: 'INVALID_TASK' });
    expect(service.modelPath('../secret')).toBeUndefined();
    await expect(downloadGlb('https://127.0.0.1/secret', path.join(directory, 'bad.glb'))).rejects.toMatchObject({ code: 'UNSAFE_OUTPUT_URL' });
    const task = await client.createPartSplit({ glbUrl: 'https://example.com/model.glb' });
    expect((await client.getTask(task)).status).toBe(0);
  });
});
