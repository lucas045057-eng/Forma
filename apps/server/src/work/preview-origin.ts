import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import type { PreviewManager } from './preview.ts';

/** This listener serves previews only. No API route or credentials cross this boundary. */
export function createPreviewOrigin(previews: PreviewManager, options: { mainPort?: number; studioOrigin?: string } = {}) {
  const mainPort = options.mainPort ?? 5174;
  const studioOrigin = options.studioOrigin ?? 'http://127.0.0.1:5173';
  const server = createServer((incoming, outgoing) => {
    const url = incoming.url ?? '/';
    if (!['GET', 'HEAD'].includes(incoming.method ?? '') || !/^\/preview\/(main\/|c\/[a-z0-9]{6,32}\/)/.test(url)) {
      outgoing.writeHead(404); outgoing.end(); return;
    }
    outgoing.setHeader('Access-Control-Allow-Origin', studioOrigin);
    outgoing.setHeader('Vary', 'Origin');
    if (url.startsWith('/preview/c/')) {
      previews.proxy(url.split('/')[3], incoming, outgoing); return;
    }
    const upstream = request({ hostname: '127.0.0.1', port: mainPort, method: incoming.method, path: url,
      headers: { host: `127.0.0.1:${mainPort}`, accept: incoming.headers.accept ?? '*/*' } }, response => {
      outgoing.statusCode = response.statusCode ?? 502;
      for (const name of ['content-type', 'cache-control', 'etag']) if (response.headers[name]) outgoing.setHeader(name, response.headers[name]!);
      response.pipe(outgoing);
    });
    const timer = setTimeout(() => upstream.destroy(), 30_000);
    upstream.on('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    outgoing.on('close', () => { clearTimeout(timer); upstream.destroy(); });
    upstream.end();
  });
  server.on('upgrade', (incoming, socket, head) => {
    if (!(incoming.url ?? '').startsWith('/preview/main/hmr') || incoming.headers.origin !== studioOrigin && incoming.headers.origin !== `http://${incoming.headers.host}`) { socket.destroy(); return; }
    const upstream = connect(mainPort, '127.0.0.1', () => {
      const headers = { ...incoming.headers, host: `127.0.0.1:${mainPort}` };
      delete headers.cookie; delete headers.authorization;
      upstream.write(`GET ${incoming.url} HTTP/1.1\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
  });
  return server;
}
