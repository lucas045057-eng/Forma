import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import { realpath } from 'node:fs/promises';
import path from 'node:path';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => (typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No free port'))));
    });
  });
}
function probe(port: number, url: string): Promise<number> {
  return new Promise(resolve => {
    const request = httpRequest({ host: '127.0.0.1', port, path: url, method: 'GET', timeout: 5000 }, response => { response.resume(); resolve(response.statusCode ?? 0); });
    request.on('error', () => resolve(0));
    request.on('timeout', () => { request.destroy(); resolve(0); });
    request.end();
  });
}

interface Running { port: number; child: ChildProcess; exited: Promise<void> }
export const previewBase = (id: string) => `/preview/c/${id}/`;

/** One Vite dev server per candidate, reached only through the backend's same-origin proxy. */
export class PreviewManager {
  private running = new Map<string, Running>();
  private options: { workRoot: string; cacheDirectory: string; startTimeoutMs?: number };
  constructor(options: { workRoot: string; cacheDirectory: string; startTimeoutMs?: number }) { this.options = options; }
  port(id: string) { return this.running.get(id)?.port; }

  async start(id: string, directory: string, signal?: AbortSignal) {
    await this.stop(id);
    const vite = await realpath(path.join(this.options.workRoot, 'node_modules', 'vite', 'bin', 'vite.js'));
    const port = await freePort();
    // Only what Vite needs: provider keys and NODE_OPTIONS of the backend are not inherited.
    const env: NodeJS.ProcessEnv = { CI: 'true', PREVIEW_BASE: previewBase(id), PREVIEW_PORT: String(port), PREVIEW_CACHE_DIR: path.join(this.options.cacheDirectory, id) };
    for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'ComSpec']) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const child = spawn(process.execPath, [vite], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const collect = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-4000); };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const exited = new Promise<void>(resolve => child.once('exit', () => { if (this.running.get(id)?.child === child) this.running.delete(id); resolve(); }));
    this.running.set(id, { port, child, exited });
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 90_000);
    try {
      for (;;) {
        signal?.throwIfAborted();
        if (child.exitCode !== null) throw new Error(`候选预览服务启动失败：${output.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(-600)}`);
        if (await probe(port, previewBase(id)) === 200) break;
        if (Date.now() > deadline) throw new Error('候选预览服务启动超时');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      // Warm the entry module so the first paint in the Studio does not wait for dependency optimisation.
      await probe(port, `${previewBase(id)}src/main.tsx`);
    } catch (error) { await this.stop(id); throw error; }
    return previewBase(id);
  }
  async stop(id: string) {
    const entry = this.running.get(id);
    if (!entry) return;
    this.running.delete(id);
    entry.child.kill();
    const timer = setTimeout(() => entry.child.kill('SIGKILL'), 5000);
    await entry.exited;
    clearTimeout(timer);
  }
  async stopAll() { await Promise.all([...this.running.keys()].map(id => this.stop(id))); }

  /** Forward a GET/HEAD below /preview/c/<id>/ to that candidate's dev server. */
  proxy(id: string, incoming: IncomingMessage, outgoing: ServerResponse) {
    const port = this.port(id);
    const fail = (status: number, message: string) => {
      if (outgoing.headersSent) return outgoing.destroy();
      outgoing.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      outgoing.end(JSON.stringify({ error: { code: status === 404 ? 'PREVIEW_NOT_RUNNING' : 'PREVIEW_UNAVAILABLE', message } }));
    };
    if (!port) return fail(404, '该候选版本的预览未在运行');
    const upstream = httpRequest({
      host: '127.0.0.1', port, method: incoming.method, path: incoming.url,
      headers: { ...incoming.headers, host: `127.0.0.1:${port}`, connection: 'close' },
    }, response => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => fail(502, '候选预览服务没有响应'));
    outgoing.on('close', () => upstream.destroy());
    upstream.end();
  }
}
