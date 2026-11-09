import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type RequestListener } from 'node:http';
import * as dns from 'node:dns/promises';
import * as fs from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { downloadGlb } from './download.ts';
import { writeAtomic } from './atomic-file.ts';

vi.mock('node:dns/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:dns/promises')>() }));
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }));

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
async function directory() {
  const base = resolve(import.meta.dirname, '../../../../.data');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(join(base, 'download-test-'));
  cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function host(handler: RequestListener) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function glb() { const bytes = Buffer.alloc(40); bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(40, 8); return bytes; }

it('enforces total time during a continuous drip and leaves no partial file', async () => {
  const dir = await directory();
  const base = await host((_request, response) => {
    response.writeHead(200); response.flushHeaders();
    const timer = setInterval(() => response.write(Buffer.from([0])), 5);
    response.on('close', () => clearInterval(timer));
  });
  const started = Date.now();
  await expect(downloadGlb(`${base}/model.glb`, join(dir, 'raw.glb'), base, { timeoutMs: 70 })).rejects.toMatchObject({ code: 'DOWNLOAD_TIMEOUT' });
  expect(Date.now() - started).toBeLessThan(2000);
  expect(await fs.readdir(dir)).toEqual([]);
});
it('includes a stuck DNS lookup in the total budget', async () => {
  const dir = await directory();
  vi.spyOn(dns, 'lookup').mockImplementation(() => new Promise(() => {}));
  await expect(downloadGlb('https://cdn.example/model.glb', join(dir, 'raw.glb'), undefined, { timeoutMs: 30 })).rejects.toMatchObject({ code: 'DOWNLOAD_TIMEOUT' });
  expect(await fs.readdir(dir)).toEqual([]);
});
it('does not reset the total budget on redirects', async () => {
  const dir = await directory();
  const base = await host((_request, response) => {
    const timer = setTimeout(() => { response.writeHead(302, { Location: '/again.glb' }); response.end(); }, 60);
    response.on('close', () => clearTimeout(timer));
  });
  await expect(downloadGlb(`${base}/model.glb`, join(dir, 'raw.glb'), base, { timeoutMs: 95 })).rejects.toMatchObject({ code: 'DOWNLOAD_TIMEOUT' });
});
it.each(['https://10.0.0.1/model.glb', 'https://[::1]/model.glb', 'https://[::ffff:127.0.0.1]/model.glb'])('rejects redirect target %s before connecting', async target => {
  const dir = await directory();
  const base = await host((_request, response) => { response.writeHead(302, { Location: target }); response.end(); });
  await expect(downloadGlb(`${base}/model.glb`, join(dir, 'raw.glb'), base)).rejects.toMatchObject({ code: 'UNSAFE_OUTPUT_URL' });
});
it('rejects mixed public/private DNS answers', async () => {
  const dir = await directory();
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '192.168.1.2', family: 4 }] as never);
  await expect(downloadGlb('https://cdn.example/model.glb', join(dir, 'raw.glb'))).rejects.toMatchObject({ code: 'UNSAFE_OUTPUT_URL' });
});
it('rejects truncated GLB and oversized body without publishing', async () => {
  const dir = await directory();
  const bytes = glb();
  const base = await host((request, response) => {
    if (request.url === '/large') response.writeHead(200, { 'Transfer-Encoding': 'chunked' });
    response.end(request.url === '/truncated' ? bytes.subarray(0, 25) : bytes);
  });
  await expect(downloadGlb(`${base}/truncated`, join(dir, 'raw.glb'), base)).rejects.toMatchObject({ code: 'INVALID_GLB' });
  await expect(downloadGlb(`${base}/large`, join(dir, 'raw.glb'), base, { maxBytes: 20 })).rejects.toMatchObject({ code: 'MODEL_TOO_LARGE' });
  expect(await fs.readdir(dir)).toEqual([]);
});
it('enforces the production 100 MiB bound from response headers', async () => {
  const dir = await directory();
  const base = await host((_request, response) => { response.writeHead(200, { 'Content-Length': 100 * 1024 * 1024 + 1 }); response.flushHeaders(); });
  await expect(downloadGlb(`${base}/model.glb`, join(dir, 'raw.glb'), base)).rejects.toMatchObject({ code: 'MODEL_TOO_LARGE' });
});
it('uses unique temporaries and preserves the old final file on failed publication', async () => {
  const dir = await directory();
  const filename = join(dir, 'model.glb');
  await fs.writeFile(`${filename}.tmp`, 'stale');
  await writeAtomic(filename, 'old');
  const original = fs.rename;
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => { if (to === filename) throw new Error('injected disk failure'); return original(from, to); });
  await expect(writeAtomic(filename, 'new')).rejects.toThrow('injected disk failure');
  expect(await fs.readFile(filename, 'utf8')).toBe('old');
  expect((await fs.readdir(dir)).sort()).toEqual(['model.glb', 'model.glb.tmp']);
});
it('aborts while publishing and removes only its own temporary', async () => {
  const dir = await directory();
  const filename = join(dir, 'raw.glb');
  const controller = new AbortController();
  const original = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await original(...args); controller.abort(); return file;
  });
  await expect(writeAtomic(filename, glb(), controller.signal)).rejects.toThrow();
  expect(await fs.readdir(dir)).toEqual([]);
});
