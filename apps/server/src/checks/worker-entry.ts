import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { installNetworkGuard } from './network-guard.ts';
import { isRunPacket, record, type WorkerPacket } from './protocol.ts';
import type { ArtifactRef } from './artifacts.ts';
import type { CheckContext } from './runner.ts';

if (!process.send || !/^[a-f0-9]{32}$/.test(process.argv[2] ?? '')) throw new Error('WORKER_IPC_REQUIRED');
installNetworkGuard();
const runId = process.argv[2]!;
let stopping = false;
let active: Promise<void> | undefined;
let controller: AbortController | undefined;
let artifactToken = 0;
const artifacts = new Map<number, { resolve: (ref: ArtifactRef) => void; reject: (error: unknown) => void }>();
function send(packet: WorkerPacket) {
  if (!stopping && process.connected) process.send!(packet, () => {});
}
async function shutdown() {
  if (stopping) return;
  stopping = true; controller?.abort();
  for (const waiter of artifacts.values()) waiter.reject(new Error('CANCELLED'));
  artifacts.clear();
  // esbuild owns a service subprocess; stop it before exiting this worker.
  try { const require = createRequire(import.meta.url); const viteRequire = createRequire(require.resolve('vite')); const esbuild = await import(pathToFileURL(viteRequire.resolve('esbuild')).href); esbuild.stop(); } catch { /* not loaded or already stopped */ }
  process.exit(0);
}
process.on('disconnect', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('message', message => {
  if (!record(message)) { void shutdown(); return; }
  if (message.kind === 'stop') { void shutdown(); return; }
  if (message.kind === 'artifact-result') {
    const waiter = artifacts.get(Number(message.token));
    if (!waiter) return;
    artifacts.delete(Number(message.token));
    if (record(message.ref) && typeof message.ref.hash === 'string') waiter.resolve(message.ref as unknown as ArtifactRef);
    else waiter.reject(new Error('ARTIFACT_FAILED'));
    return;
  }
  if (!isRunPacket(message) || message.runId !== runId || message.buildRoot !== process.cwd() || active || stopping) {
    void shutdown(); return;
  }
  const packet = message;
  controller = new AbortController();
  const current = controller;
  active = (async () => {
    const ctx: CheckContext = {
      runId, candidateRoot: packet.buildRoot, buildRoot: packet.buildRoot, snapshot: packet.snapshot,
      signal: current.signal, buildTimeoutMs: packet.buildTimeoutMs, browserTimeoutMs: packet.browserTimeoutMs,
      artifactsDir: path.join(packet.buildRoot, '.unused-evidence'),
      writeArtifact: async (name, content) => {
        current.signal.throwIfAborted();
        const token = ++artifactToken;
        return new Promise<ArtifactRef>((resolve, reject) => {
          artifacts.set(token, { resolve, reject });
          send({ kind: 'artifact', token, requestToken: packet.token, name,
            encoding: Buffer.isBuffer(content) ? 'base64' : 'utf8',
            content: Buffer.isBuffer(content) ? content.toString('base64') : content });
        });
      },
    };
    try {
      const result = packet.name === 'schema' ? await (await import('./schema.ts')).checkSchema(ctx) :
        packet.name === 'build' ? await (await import('./build.ts')).checkBuild(ctx) :
        { name: packet.name, status: 'not_run' as const, message: '浏览器检查尚未实现（B3）' };
      current.signal.throwIfAborted();
      send({ kind: 'result', requestToken: packet.token, result });
    } catch (error) {
      if (!stopping) send({ kind: 'error', requestToken: packet.token, message: error instanceof Error ? error.message.slice(0, 600) : 'WORKER_FAILED' });
    }
  })().finally(() => { active = undefined; });
});
send({ kind: 'ready' });

