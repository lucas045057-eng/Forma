import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { allocatePreviewPort, isRestrictedPreviewPort, PreviewManager, previewViteEntry } from './preview.ts';
import { listenServerForFetch } from '../test-support/fetch-listener.ts';

it('proxies only GET and HEAD to the selected loopback preview port', async () => {
  const upstream = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(`${request.method} ${request.url}`);
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const port = (upstream.address() as AddressInfo).port;
  const manager = new PreviewManager({ workRoot: '.', cacheDirectory: '.' });
  const running = manager as unknown as { running: Map<string, { port: number }> };
  running.running.set('candidate1', { port });
  const { server: proxy, baseUrl: base } = await listenServerForFetch(() => createServer((request, response) => manager.proxy('candidate1', request, response)));
  try {
    const get = await fetch(`${base}/preview/c/candidate1/src/main.tsx?direct=1`);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('GET /preview/c/candidate1/src/main.tsx?direct=1');
    const head = await fetch(`${base}/preview/c/candidate1/`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const post = await fetch(`${base}/preview/c/candidate1/`, { method: 'POST' });
    expect(post.status).toBe(405);
  } finally {
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});

/**
 * Resolver-only regression: it proves which vite entry is handed to the worker, not that Vite
 * starts, serves, or that the HTTP probe passes. Windows fix evidence: a junctioned node_modules
 * makes pnpm's relative link resolve against the logical parent chain; POSIX already resolves it
 * physically, so the old-path rejection is asserted only on Windows.
 */
it('resolves the preview Vite entry through a junctioned work root and keeps broken links failing', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'spatial-preview-vite-')));
  try {
    const repo = path.join(root, 'repo');
    const store = path.join(repo, 'node_modules', '.pnpm', 'vite@test', 'node_modules', 'vite');
    await mkdir(path.join(store, 'bin'), { recursive: true });
    await writeFile(path.join(store, 'bin', 'vite.js'), 'export {};\n');
    const expected = await realpath(path.join(store, 'bin', 'vite.js'));
    const modules = path.join(repo, 'templates', 'product-page', 'node_modules');
    await mkdir(modules, { recursive: true });
    // Same shape as pnpm: a relative directory link that climbs out of node_modules to the store.
    const relativeVite = path.join('..', '..', '..', 'node_modules', '.pnpm', 'vite@test', 'node_modules', 'vite');
    try {
      await symlink(relativeVite, path.join(modules, 'vite'), 'dir');
    } catch (error) {
      throw new Error(`this regression needs directory symlink support (Developer Mode or SeCreateSymbolicLinkPrivilege): ${(error as Error).message}`);
    }

    // A plain work root resolves the same package link unchanged.
    expect(await previewViteEntry(path.join(repo, 'templates', 'product-page'))).toBe(expected);

    // A legacy work root mounts node_modules as a junction over the template's modules.
    const legacy = path.join(repo, '.data', 'pi-lux3d', 'legacy-work');
    await mkdir(legacy, { recursive: true });
    await symlink(modules, path.join(legacy, 'node_modules'), 'junction');
    if (process.platform === 'win32') {
      await expect(realpath(path.join(legacy, 'node_modules', 'vite', 'bin', 'vite.js'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await previewViteEntry(legacy)).toBe(expected);

    // A broken package link is still a failure, not something the normalization may skip.
    const brokenModules = path.join(repo, 'broken-modules');
    await mkdir(brokenModules, { recursive: true });
    await symlink(path.join('..', '..', '..', 'node_modules', '.pnpm', 'missing', 'node_modules', 'vite'), path.join(brokenModules, 'vite'), 'dir');
    const broken = path.join(repo, 'broken');
    await mkdir(broken, { recursive: true });
    await symlink(brokenModules, path.join(broken, 'node_modules'), 'junction');
    await expect(previewViteEntry(broken)).rejects.toMatchObject({ code: 'ENOENT' });

    // Plain module directories resolve directly.
    const plain = path.join(repo, 'plain');
    await mkdir(path.join(plain, 'node_modules', 'vite', 'bin'), { recursive: true });
    await writeFile(path.join(plain, 'node_modules', 'vite', 'bin', 'vite.js'), 'export {};\n');
    expect(await previewViteEntry(plain)).toBe(await realpath(path.join(plain, 'node_modules', 'vite', 'bin', 'vite.js')));
  } finally {
    const actual = await realpath(root);
    if (path.dirname(actual) !== await realpath(tmpdir())) throw new Error('refusing cleanup outside the owned temp root');
    await rm(actual, { recursive: true, force: true });
  }
});

it('skips Fetch/Chromium restricted ports and occupied loopback ports during preview port allocation', async () => {
  expect(isRestrictedPreviewPort(80)).toBe(true);
  expect(isRestrictedPreviewPort(5061)).toBe(true);
  expect(isRestrictedPreviewPort(6000)).toBe(true);
  expect(isRestrictedPreviewPort(10080)).toBe(true);
  expect(isRestrictedPreviewPort(24567)).toBe(false);

  const occupied = createServer((_req, res) => res.end('busy'));
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const occupiedPort = (occupied.address() as AddressInfo).port;
  try {
    const sequence = [5061, 6000, 10080, occupiedPort, 0];
    let index = 0;
    const selected = await allocatePreviewPort(() => sequence[Math.min(index++, sequence.length - 1)]);
    expect(isRestrictedPreviewPort(selected)).toBe(false);
    expect(selected).not.toBe(occupiedPort);
  } finally {
    await new Promise<void>(resolve => occupied.close(() => resolve()));
  }
});
