import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { PreviewManager } from './preview.ts';
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
