import { createRequire } from 'node:module';
import { realpath, readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const repository = process.env.FORMA_REPO_ROOT;
const workspaceRoot = process.env.FORMA_WORKSPACE_ROOT;
const apiPort = Number(process.env.FORMA_API_PORT);
const mainPort = Number(process.env.FORMA_MAIN_PORT);
const previewPort = Number(process.env.FORMA_PREVIEW_PORT);
const studioPort = Number(process.env.FORMA_STUDIO_PORT);
const demoMode = process.env.FORMA_UI_MODE || 'real';

if (!repository || !workspaceRoot || !apiPort || !mainPort || !previewPort || !studioPort) {
  throw new Error('Forma frontends child missing required port/workspace configuration');
}

const serverRequire = createRequire(path.join(repository, 'apps/server/package.json'));
const templateRequire = createRequire(path.join(repository, 'templates/product-page/package.json'));

const servers = [];
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const server of [...servers].reverse()) {
    try {
      server.httpServer?.closeAllConnections?.();
      await server.close();
    } catch {
      // continue closing remaining Vite servers
    }
  }
  if (process.connected) process.disconnect();
}

process.on('message', msg => {
  if (msg?.type === 'shutdown') void shutdown();
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => void shutdown());
}

try {
  const { createServer } = await import(pathToFileURL(serverRequire.resolve('vite')).href);
  const { default: react } = await import(pathToFileURL(serverRequire.resolve('@vitejs/plugin-react')).href);
  const { default: sourceTag } = await import(pathToFileURL(templateRequire.resolve('@spatial/vite-plugin-source-tag')).href);

  const defaultWorkDir = path.join(workspaceRoot, 'work');
  const allow = new Set([defaultWorkDir, path.join(repository, 'packages')]);
  async function collectLinkedPackages(folder) {
    for (const entry of await readdir(folder)) {
      if (entry.startsWith('.')) continue;
      const location = path.join(folder, entry);
      if (entry.startsWith('@')) {
        await collectLinkedPackages(location);
        continue;
      }
      const actual = await realpath(location);
      allow.add(actual);
      const pieces = actual.split(path.sep);
      const index = pieces.lastIndexOf('.pnpm');
      if (index >= 0) allow.add(pieces.slice(0, index + 1).join(path.sep));
    }
  }
  await collectLinkedPackages(path.join(defaultWorkDir, 'node_modules'));

  const deny = ['**/.env*', '**/*.{pem,key,crt,p12,pfx,bak,tmp}', '**/.git/**'];

  const main = await createServer({
    root: defaultWorkDir,
    configFile: false,
    envFile: false,
    cacheDir: path.join(workspaceRoot, 'cache-main'),
    base: '/preview/main/',
    plugins: [sourceTag(), react()],
    server: {
      host: '127.0.0.1',
      port: mainPort,
      strictPort: true,
      fs: { strict: true, allow: [...allow], deny },
      hmr: { clientPort: previewPort, path: '/hmr' },
    },
  });
  servers.push(main);
  await main.listen();

  const target = `http://127.0.0.1:${apiPort}`;
  const proxyPrefixes = [
    '/health', '/models', '/speech', '/scene', '/assets',
    '/tasks', '/candidates', '/version', '/works', '/approvals', '/checks', '/events',
  ];
  const proxy = Object.fromEntries(
    proxyPrefixes.map(prefix => [prefix, { target, ...(prefix === '/events' ? { ws: true } : {}) }]),
  );

  const studio = await createServer({
    root: path.join(repository, 'apps/studio'),
    configFile: false,
    envFile: false,
    cacheDir: path.join(workspaceRoot, 'cache-studio'),
    plugins: [react()],
    define: {
      'import.meta.env.VITE_PREVIEW_ORIGIN': JSON.stringify(`http://127.0.0.1:${previewPort}`),
      'import.meta.env.VITE_DEMO_MODE': JSON.stringify(demoMode),
    },
    server: {
      host: '127.0.0.1',
      port: studioPort,
      strictPort: true,
      cors: false,
      headers: { 'Cross-Origin-Resource-Policy': 'same-origin' },
      proxy,
      fs: {
        strict: true,
        allow: [
          path.join(repository, 'apps/studio'),
          path.join(repository, 'packages'),
          path.join(repository, 'node_modules'),
        ],
        deny,
      },
    },
  });
  servers.push(studio);
  await studio.listen();

  if (process.connected) {
    process.send({ type: 'ready', role: 'frontends', pid: process.pid });
  }
} catch (error) {
  console.error('[Forma Frontends Startup Error]', error instanceof Error ? error.message : 'Unknown error');
  await shutdown();
  process.exitCode = 1;
}
