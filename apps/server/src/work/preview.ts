import { spawn, type ChildProcess } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer } from 'node:net';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RESTRICTED_PREVIEW_PORTS = new Set<number>([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

export function isRestrictedPreviewPort(port: number): boolean {
  return !Number.isInteger(port) || port < 1024 || port > 65_535 || RESTRICTED_PREVIEW_PORTS.has(port);
}

export async function allocatePreviewPort(
  nextPort: () => number = () => randomInt(20_000, 65_536),
  maxAttempts = 32,
): Promise<number> {
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const requested = nextPort();
    if (requested !== 0 && isRestrictedPreviewPort(requested)) continue;
    try {
      const bound = await new Promise<number>((resolve, reject) => {
        const server = createServer();
        const onError = (error: Error) => { server.off('error', onError); reject(error); };
        server.once('error', onError);
        server.listen(requested, '127.0.0.1', () => {
          server.off('error', onError);
          const address = server.address();
          server.close(closeErr => {
            if (closeErr) return reject(closeErr);
            if (typeof address === 'object' && address) resolve(address.port);
            else reject(new Error('No free port'));
          });
        });
      });
      if (!isRestrictedPreviewPort(bound)) return bound;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && !(process.platform === 'win32' && code === 'EACCES')) throw error;
    }
  }
  throw new Error('No safe preview port available', { cause: lastError });
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

/**
 * Resolve the Vite entry executed by the preview worker. Resolve `node_modules` itself first:
 * a legacy work root mounts `node_modules` as a junction over the template's modules, and pnpm's
 * relative package links are then resolved against the junction's logical parent chain, which
 * does not contain the store. Resolving the physical root first makes the same link resolve in
 * place; a missing root or a broken package link still fails with ENOENT.
 */
export async function previewViteEntry(workRoot: string): Promise<string> {
  const modules = await realpath(path.join(workRoot, 'node_modules'));
  return realpath(path.join(modules, 'vite', 'bin', 'vite.js'));
}

/** One Vite dev server per candidate, reached only through the backend's same-origin proxy. */
export class PreviewManager {
  private running = new Map<string, Running>();
  private reservedPorts = new Set<number>();
  private options: { workRoot: string; cacheDirectory: string; startTimeoutMs?: number };
  constructor(options: { workRoot: string; cacheDirectory: string; startTimeoutMs?: number }) { this.options = options; }
  port(id: string) { return this.running.get(id)?.port; }

  private isPortBusy(port: number) {
    if (this.reservedPorts.has(port)) return true;
    for (const entry of this.running.values()) if (entry.port === port) return true;
    return false;
  }

  private async reservePreviewPort(): Promise<number> {
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = await allocatePreviewPort();
      if (!this.isPortBusy(candidate)) {
        this.reservedPorts.add(candidate);
        return candidate;
      }
    }
    throw new Error('未能分配到空闲候选预览端口');
  }

  async start(id: string, directory: string, signal?: AbortSignal) {
    await this.stop(id);
    const vite = await previewViteEntry(this.options.workRoot);
    const port = await this.reservePreviewPort();
    let child: ChildProcess | undefined;
    let exited: Promise<void>;
    try {
      signal?.throwIfAborted();
      // Only what Vite needs: provider keys and NODE_OPTIONS of the backend are not inherited.
      const env: NodeJS.ProcessEnv = { CI: 'true', PREVIEW_BASE: previewBase(id), PREVIEW_PORT: String(port), PREVIEW_CACHE_DIR: path.join(this.options.cacheDirectory, id), PREVIEW_ORIGIN_PORT: process.env.PREVIEW_ORIGIN_PORT ?? '5175' };
      for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'ComSpec']) {
        if (process.env[key] !== undefined) env[key] = process.env[key];
      }
      const worker = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? './preview-worker.ts' : './preview-worker.js', import.meta.url));
      child = spawn(process.execPath, [worker, vite], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
      const spawned = child;
      let output = '';
      const collect = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-4000); };
      spawned.stdout!.on('data', collect); spawned.stderr!.on('data', collect);
      let failed = false;
      exited = new Promise<void>(resolve => {
        const finish = () => {
          failed = true;
          this.reservedPorts.delete(port);
          if (this.running.get(id)?.child === spawned) this.running.delete(id);
          resolve();
        };
        spawned.once('error', finish); spawned.once('close', finish);
      });
      this.running.set(id, { port, child: spawned, exited });
      const deadline = Date.now() + (this.options.startTimeoutMs ?? 90_000);
      for (;;) {
        signal?.throwIfAborted();
        if (failed || spawned.exitCode !== null) throw new Error(`候选预览服务启动失败：${output.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(-600)}`);
        if (await probe(port, previewBase(id)) === 200) break;
        if (Date.now() > deadline) throw new Error('候选预览服务启动超时');
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      // Warm the entry module so the first paint in the Studio does not wait for dependency optimisation.
      await probe(port, `${previewBase(id)}src/main.tsx`);
    } catch (error) {
      if (!child) this.reservedPorts.delete(port);
      await this.stop(id);
      throw error;
    }
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
    if (incoming.method !== 'GET' && incoming.method !== 'HEAD') return fail(405, '候选预览代理只允许 GET/HEAD');
    if (!port) return fail(404, '该候选版本的预览未在运行');
    const upstream = httpRequest({
      host: '127.0.0.1', port, method: incoming.method, path: incoming.url,
      headers: { host: `127.0.0.1:${port}`, accept: incoming.headers.accept ?? '*/*', connection: 'close' },
    }, response => {
      outgoing.statusCode = response.statusCode ?? 502;
      for (const name of ['content-type', 'cache-control', 'etag']) if (response.headers[name]) outgoing.setHeader(name, response.headers[name]!);
      response.pipe(outgoing);
    });
    const timer = setTimeout(() => upstream.destroy(), 30_000);
    upstream.on('error', () => fail(502, '候选预览服务没有响应'));
    outgoing.on('close', () => { clearTimeout(timer); upstream.destroy(); });
    upstream.end();
  }
}
