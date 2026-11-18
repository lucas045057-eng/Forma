import path from 'node:path';
import { createApp } from '../../apps/server/src/app.ts';
import { createPreviewOrigin } from '../../apps/server/src/work/preview-origin.ts';

const repository = process.env.FORMA_REPO_ROOT;
const workspaceRoot = process.env.FORMA_WORKSPACE_ROOT;
const apiPort = Number(process.env.FORMA_API_PORT);
const mainPort = Number(process.env.FORMA_MAIN_PORT);
const previewPort = Number(process.env.FORMA_PREVIEW_PORT);
const studioPort = Number(process.env.FORMA_STUDIO_PORT);

if (!repository || !workspaceRoot || !apiPort || !mainPort || !previewPort || !studioPort) {
  throw new Error('Forma backend child missing required port/workspace configuration');
}

const closers = [];
let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const close of [...closers].reverse()) {
    try {
      await close();
    } catch {
      // continue closing remaining resources
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
  process.env.PREVIEW_ORIGIN_PORT = String(previewPort);
  const { app, workspace } = await createApp({
    workRoot: path.join(workspaceRoot, 'work'),
    dataDirectory: path.join(workspaceRoot, 'assets'),
    workDataDirectory: path.join(workspaceRoot, 'work-data'),
    historyDirectory: path.join(workspaceRoot, 'scene-history'),
    fallbackDirectory: path.join(repository, 'fallback'),
    logger: false,
  });
  closers.push(() => app.close());

  workspace.enableDynamicMainPreview(mainPort);
  await workspace.ensureActiveMainPreview();

  const preview = createPreviewOrigin(() => workspace.current().work.previews, {
    mainPort: () => workspace.activeMainPort() ?? mainPort,
    studioOrigin: `http://127.0.0.1:${studioPort}`,
  });
  const sockets = new Set();
  preview.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
    preview.closeAllConnections();
    if (preview.listening) {
      await new Promise(resolve => preview.close(() => resolve()));
    }
  });

  await new Promise((resolve, reject) => {
    preview.once('error', reject);
    preview.listen(previewPort, '127.0.0.1', resolve);
  });
  await app.listen({ host: '127.0.0.1', port: apiPort });

  if (process.connected) {
    process.send({ type: 'ready', role: 'backend', pid: process.pid });
  }
} catch (error) {
  console.error('[Forma Backend Startup Error]', error instanceof Error ? error.message : 'Unknown error');
  await shutdown();
  process.exitCode = 1;
}
