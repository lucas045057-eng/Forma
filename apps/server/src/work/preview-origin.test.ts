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

function rawRequest(port: number, lines: string[]): Promise<string> {
  return new Promise(resolve => {
    const socket = connect(port, '127.0.0.1', () => socket.write(`${lines.join('\r\n')}\r\n\r\n`));
    let text = '';
    socket.on('data', chunk => { text += chunk.toString(); });
    socket.on('close', () => resolve(text)); socket.on('error', () => resolve(text));
  });
}
it('refuses requests addressed to a foreign host name, for HTTP and WebSocket alike (review F2)', async () => {
  const main = await upgradeEcho();
  const content = createServer((_request, response) => { response.end('work source'); });
  const mainHttp = await listen(content);
  const previews = { port: () => undefined } as unknown as PreviewManager;
  const origin = await listen(createPreviewOrigin(previews, { mainPort: mainHttp }));
  const ok = await rawRequest(origin, [`GET /preview/main/src/App.tsx HTTP/1.1`, `Host: 127.0.0.1:${origin}`, 'Connection: close']);
  expect(ok).toContain('200 OK');
  for (const host of [`evil.example:${origin}`, 'evil.example', `127.0.0.1:${origin + 1}`, `localhost.evil.example:${origin}`]) {
    for (const method of ['GET', 'HEAD']) {
      const refused = await rawRequest(origin, [`${method} /preview/main/src/App.tsx HTTP/1.1`, `Host: ${host}`, 'Connection: close']);
      expect(refused, `${method} ${host}`).toContain('403');
      expect(refused).not.toContain('work source');
    }
  }
  // WebSocket: a rebinding page has Host and Origin both set to its own name.
  const wsOrigin = await listen(createPreviewOrigin(previews, { mainPort: main.port }));
  const rebinding = await rawRequest(wsOrigin, ['GET /preview/main/hmr HTTP/1.1', `Host: evil.example:${wsOrigin}`, `Origin: http://evil.example:${wsOrigin}`,
    'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==']);
  expect(rebinding).toBe('');
  expect(main.seen).toEqual([]);
  // Explicitly configured host names are accepted.
  const lan = await listen(createPreviewOrigin(previews, { mainPort: mainHttp, allowedHosts: ['studio.lan'] }));
  expect(await rawRequest(lan, ['GET /preview/main/x HTTP/1.1', `Host: studio.lan:${lan}`, 'Connection: close'])).toContain('200 OK');
});
