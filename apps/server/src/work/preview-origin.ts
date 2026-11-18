import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import type { PreviewManager } from './preview.ts';

/** This listener serves previews only. No API route or credentials cross this boundary. */
const loopback = ['127.0.0.1', 'localhost', '[::1]'];

export function createPreviewOrigin(
  previews: PreviewManager | (() => PreviewManager),
  options: { mainPort?: number | (() => number | undefined); studioOrigin?: string; allowedHosts?: string[] } = {},
) {
  const resolvePreviews = () => (typeof previews === 'function' ? previews() : previews);
  const resolveMainPort = () => (typeof options.mainPort === 'function' ? (options.mainPort() ?? 5174) : (options.mainPort ?? 5174));
  const studioOrigin = options.studioOrigin ?? 'http://127.0.0.1:5173';
  const hostnames = new Set([...loopback, ...(options.allowedHosts ?? (process.env.PREVIEW_ALLOWED_HOSTS ?? '').split(','))]
    .map(host => host.trim().toLowerCase()).filter(Boolean));
  const ownPort = () => { const address = server.address(); return typeof address === 'object' && address ? address.port : 0; };
  /**
   * DNS-rebinding defence (review F2): only requests addressed to an allowed host name on this
   * listener's own port are served. Trust is derived from configuration, never from the request.
   */
  const trustedHost = (host: string | undefined) => {
    const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec((host ?? '').toLowerCase());
    return !!match && hostnames.has(match[1]) && Number(match[2] ?? 80) === ownPort();
  };
  const trustedOrigin = (origin: string | undefined) => origin === studioOrigin
    || [...hostnames].some(name => origin === `http://${name}:${ownPort()}`);
  const server = createServer((incoming, outgoing) => {
    const url = incoming.url ?? '/';
    if (!trustedHost(incoming.headers.host)) { outgoing.writeHead(403); outgoing.end(); return; }
    if (!['GET', 'HEAD'].includes(incoming.method ?? '') || !/^\/preview\/(main\/|c\/[a-z0-9]{6,32}\/)/.test(url)) {
      outgoing.writeHead(404); outgoing.end(); return;
    }
    outgoing.setHeader('Access-Control-Allow-Origin', studioOrigin);
    outgoing.setHeader('Vary', 'Origin');
    if (url.startsWith('/preview/c/')) {
      resolvePreviews().proxy(url.split('/')[3], incoming, outgoing); return;
    }
    const mainPort = resolveMainPort();
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
    const url = incoming.url ?? '';
    // Only the Vite HMR socket of the main work or of a running candidate; nothing else upgrades.
    const candidate = /^\/preview\/c\/([a-z0-9]{6,32})\/hmr(?:\?|$)/.exec(url);
    const port = /^\/preview\/main\/hmr(?:\?|$)/.test(url) ? resolveMainPort() : candidate ? resolvePreviews().port(candidate[1]) : undefined;
    if (!port || !trustedHost(incoming.headers.host) || !trustedOrigin(incoming.headers.origin)) { socket.destroy(); return; }
    const upstream = connect(port, '127.0.0.1', () => {
      const headers = { ...incoming.headers, host: `127.0.0.1:${port}` };
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
