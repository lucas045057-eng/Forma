import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Pass the Studio port to occupy as the first argument');
const root = fileURLToPath(new URL('../..', import.meta.url));
const studioRoot = fileURLToPath(new URL('.', import.meta.url));
async function run(command) {
  console.log(`[verify] start ${command}`);
  await new Promise((resolve, reject) => {
    let outputTail = '';
    const child = process.platform === 'win32'
      ? spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
      : spawn('sh', ['-c', command], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const [source, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      source.setEncoding('utf8');
      source.on('data', text => {
        destination.write(text);
        outputTail = (outputTail + text).slice(-64_000);
      });
    }
    child.once('error', reject);
    child.once('close', (code, signal) => {
      console.log(`[verify] end code=${code} signal=${signal ?? 'none'} ${command}`);
      if (code === 0) resolve(); else reject(new Error(`Validation command failed: ${command} (code=${code}, signal=${signal ?? 'none'})\n${outputTail.trim() || '(no child output)'}`));
    });
  });
}
async function confirmVite(stage, owned) {
  const response = await fetch(`http://127.0.0.1:${port}/@vite/client`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok || !(await response.text()).includes('createHotContext')) throw new Error(`Port ${port} is not serving a Vite dev client`);
  console.log(`[port-check] ${JSON.stringify({ stage, port, owned, vite: true })}`);
}
let blocker;
let cacheDir;
try {
  await run('pnpm --filter @spatial/studio exec vitest run src/dev-proxy.test.ts');
  cacheDir = await mkdtemp(path.join(tmpdir(), 'studio-port-owner-'));
  blocker = await createServer({ configFile: false, envFile: false, root: studioRoot, cacheDir,
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null, proxy: {} },
    optimizeDeps: { noDiscovery: true, include: [] }, logLevel: 'silent' });
  try {
    await blocker.listen(port);
  } catch (error) {
    await blocker.close();
    blocker = undefined;
    if (!String(error).includes('already in use') && error.code !== 'EADDRINUSE') throw error;
    // An external Studio is never stopped or reconfigured by this verifier.
  }
  await confirmVite('before-full-test', !!blocker);
  await run('pnpm test');
  await confirmVite('after-full-test', !!blocker);
  await run('pnpm typecheck');
  await run('pnpm build');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    if (blocker) {
      blocker.httpServer?.closeAllConnections();
      await blocker.close();
      console.log(`[cleanup] owned Studio listening=${blocker.httpServer?.listening ?? false}`);
      if (blocker.httpServer?.listening) process.exitCode = 1;
    } else console.log('[cleanup] no owned Studio listener; external listeners untouched');
  } finally {
    if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
  }
}
