/**
 * M1-B 被测后端的启动器。
 *
 * 与 `apps/server/src/index.ts` 走同一条 `createApp()` 路径，区别只在测试需要的能力：
 * - `WORK_ROOT` 指向作品根（主用例指向真实模板目录，沙箱用例指向 `.data/pi-m1b/sandbox/work`）；
 * - 轮询/超时改成毫秒级；
 * - `PI_NET_GUARD_LOG` 出站守卫（只放行回环）；
 * - createApp 抛错以退出码 12 结束（用于实例锁 / Host 白名单等启动期断言）；
 * - stdin 收到 `close` 调 `app.close()`（Windows 上拿不到 SIGTERM 的优雅停机）。
 *
 * 不读取 apps/server/.env。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const directory = process.env.ASSETS_DIR ? path.resolve(process.env.ASSETS_DIR) : path.join(repoRoot, '.data', 'pi-m1b', 'assets');
const workRoot = process.env.WORK_ROOT ? path.resolve(process.env.WORK_ROOT) : path.join(repoRoot, 'templates', 'product-page');
const historyDirectory = process.env.SCENE_HISTORY_DIR ? path.resolve(process.env.SCENE_HISTORY_DIR) : path.join(repoRoot, '.data', 'pi-m1b', 'history');

if (process.env.PI_FRESH === '1') {
  await rm(directory, { recursive: true, force: true });
  if (process.env.PI_NET_GUARD_LOG) await rm(process.env.PI_NET_GUARD_LOG, { force: true });
}
await mkdir(directory, { recursive: true });
await mkdir(historyDirectory, { recursive: true });

// 证明出站守卫确实装进了这个进程
if (process.env.PI_NET_GUARD_LOG) {
  const marker = `${process.env.PI_NET_GUARD_LOG}.loaded`;
  const active = globalThis.__piNetGuard?.ready === true;
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify({ active, pid: process.pid, nodeOptions: process.env.NODE_OPTIONS ?? '' }));
  if (!active) {
    console.error('出站网络守卫没有加载，拒绝在无保护的情况下启动被测后端');
    process.exit(9);
  }
}

const { createApp } = await import('../../../apps/server/src/app.ts');
const { listenWithPreview } = await import('../shared/server.mjs');
const port = Number(process.env.PORT ?? 3001);
let app;
let work;
try {
  ({ app, work } = await createApp({
    dataDirectory: directory,
    workRoot,
    historyDirectory,
    base: process.env.LUX3D_BASE,
    key: process.env.LUX3D_API_KEY,
    pollMs: Number(process.env.POLL_MS ?? 80),
    timeoutMs: Number(process.env.TIMEOUT_MS ?? 60_000),
    allowedHosts: process.env.ALLOWED_HOSTS ? process.env.ALLOWED_HOSTS.split(',') : undefined,
    logger: false,
  }));
} catch (error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  console.error(`createApp rejected${code ? ` [${code}]` : ''}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(12);
}
try {
  await listenWithPreview({
    app,
    work,
    apiPort: port,
    previewPort: Number(process.env.PREVIEW_ORIGIN_PORT ?? 0),
    mainPort: Number(process.env.MAIN_PREVIEW_PORT ?? 5174),
    studioOrigin: process.env.STUDIO_ORIGIN ?? 'http://127.0.0.1:5173',
  });
} catch (error) {
  console.error(`listen failed: ${error instanceof Error ? error.message : String(error)}`);
  await app.close().catch(() => {});
  process.exit(14);
}
console.log(`pi-m1b backend ready on ${port} (workRoot=${workRoot})`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void app.close(); });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (!String(chunk).includes('close')) return;
  console.log('pi-m1b backend graceful close requested');
  void app.close().then(() => process.exit(0), (error) => {
    console.error(`close failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(13);
  });
});
