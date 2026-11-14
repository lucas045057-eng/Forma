import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type ProxyOptions, type ViteDevServer } from 'vite';
import { expect, it } from 'vitest';
import config from '../vite.config.ts';

it('routes Studio API requests and check evidence through the real Vite proxy instead of SPA fallback', async () => {
  const seen: string[] = [];
  const upstream = createHttpServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    if (request.url === '/checks/run001/artifacts/smoke.png') {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(Buffer.from([137, 80, 78, 71]));
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ path: request.url, method: request.method }));
    }
  });
  let studio: ViteDevServer | undefined;
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'studio-proxy-test-'));
  try {
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', resolve);
    });
    const target = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
    // Keep the actual proxy keys/options; only replace destinations with this test's loopback server.
    const proxy: Record<string, ProxyOptions> = Object.fromEntries(Object.entries(config.server?.proxy ?? {}).map(([key, option]) => [key, { ...(typeof option === 'string' ? {} : option), target }]));
    studio = await createServer({ configFile: false, envFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
      cacheDir, plugins: [], server: { ...config.server, port: 0, proxy, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent' });
    // Vite's listen wrapper treats port 0 as absent. Its underlying HTTP listener preserves 0.
    await new Promise<void>((resolve, reject) => {
      studio!.httpServer!.once('error', reject);
      studio!.httpServer!.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${(studio.httpServer!.address() as AddressInfo).port}`;
    for (const path of ['/health', '/approvals', '/approvals/card001', '/checks/run001', '/checks/run001/artifacts/schema.json', '/tasks', '/candidates', '/version', '/scene', '/assets', '/events/history?since=0']) {
      const response = await fetch(origin + path);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({ path, method: 'GET' });
    }
    for (const path of ['/approvals/card001', '/checks/run001/cancel', '/candidates/candidate001/checks']) {
      const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      expect(await response.json()).toEqual({ path, method: 'POST' });
    }
    const image = await fetch(origin + '/checks/run001/artifacts/smoke.png');
    expect(image.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await image.arrayBuffer())]).toEqual([137, 80, 78, 71]);
    expect(seen).toHaveLength(15);
  } finally {
    try {
      const httpServer = studio?.httpServer as unknown as { closeAllConnections?: () => void } | null | undefined;
      try { httpServer?.closeAllConnections?.(); }
      finally { await studio?.close(); }
    } finally {
      try {
        upstream.closeAllConnections();
        if (upstream.listening) await new Promise<void>((resolve, reject) => upstream.close(error => error ? reject(error) : resolve()));
      } finally { await rm(cacheDir, { recursive: true, force: true }); }
    }
  }
}, 15_000);
