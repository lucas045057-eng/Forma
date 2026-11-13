import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { createPreviewOrigin } from './preview-origin.ts';
import type { PreviewManager } from './preview.ts';

const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }))); });
async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
/** A stand-in for a Vite dev server: answers any WebSocket upgrade with 101 and the path it saw. */
async function upgradeEcho() {
  const seen: string[] = [];
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    seen.push(request.url ?? '');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Seen: ${request.url}\r\n\r\n`);
    socket.end();
  });
  return { port: await listen(server), seen };
}
function upgrade(port: number, url: string, origin: string): Promise<string> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${url} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    });
    let text = '';
    socket.on('data', chunk => { text += chunk.toString(); });
    socket.on('close', () => resolve(text));
    socket.on('error', () => resolve(text));
  });
}

it('forwards the Vite HMR socket of the main work and of a running candidate, and nothing else (D1)', async () => {
  const main = await upgradeEcho(), candidate = await upgradeEcho();
  const previews = { port: (id: string) => (id === 'abcdef1' ? candidate.port : undefined) } as unknown as PreviewManager;
  const origin = await listen(createPreviewOrigin(previews, { mainPort: main.port }));
  const self = `http://127.0.0.1:${origin}`;

  expect(await upgrade(origin, '/preview/c/abcdef1/hmr?token=t', self)).toContain('101 Switching Protocols');
  expect(candidate.seen).toEqual(['/preview/c/abcdef1/hmr?token=t']);
  expect(await upgrade(origin, '/preview/main/hmr?token=t', self)).toContain('101 Switching Protocols');
  expect(main.seen).toEqual(['/preview/main/hmr?token=t']);

  // Unknown candidates, other paths below a candidate and foreign origins are dropped without forwarding.
  for (const [url, from] of [
    ['/preview/c/zzzzzz9/hmr', self],
    ['/preview/c/abcdef1/src/main.tsx', self],
    ['/scene', self],
    ['/preview/c/abcdef1/hmr', 'http://evil.example'],
  ]) expect(await upgrade(origin, url, from)).toBe('');
  expect(candidate.seen).toHaveLength(1);
  expect(main.seen).toHaveLength(1);
});
