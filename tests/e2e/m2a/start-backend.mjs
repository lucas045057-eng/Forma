/**
 * M2-A 被测后端的启动器：与 `apps/server/src/index.ts` 同一条 `createApp()`，
 * 只是把 WORK_ROOT / WORK_DATA_DIR / 编码 Agent 上游等都由测试显式注入。
 *
 * - 不读 apps/server/.env（真实 key 不进测试进程）；
 * - `PI_NET_GUARD_LOG` 出站守卫只放行回环地址；
 * - createApp 报错以退出码 12 结束（用于配置错误断言）；
 * - stdin 收到 `close` 调 `app.close()`（Windows 上拿不到 SIGTERM 的优雅停机）。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const workRoot = path.resolve(process.env.WORK_ROOT ?? path.join(repoRoot, 'templates', 'product-page'));
const dataDirectory = path.resolve(process.env.ASSETS_DIR ?? path.join(repoRoot, '.data', 'pi-m2a', 'assets'));
const workDataDirectory = path.resolve(process.env.WORK_DATA_DIR ?? path.join(repoRoot, '.data', 'pi-m2a', 'work-data'));
const historyDirectory = path.resolve(process.env.SCENE_HISTORY_DIR ?? path.join(repoRoot, '.data', 'pi-m2a', 'scene-history'));

if (process.env.PI_FRESH === '1') {
  await rm(dataDirectory, { recursive: true, force: true });
  await rm(workDataDirectory, { recursive: true, force: true });
  await rm(historyDirectory, { recursive: true, force: true });
  if (process.env.PI_NET_GUARD_LOG) await rm(process.env.PI_NET_GUARD_LOG, { force: true });
}
for (const directory of [dataDirectory, workDataDirectory, historyDirectory]) await mkdir(directory, { recursive: true });

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
    workRoot,
    workDataDirectory,
    dataDirectory,
    historyDirectory,
    base: process.env.LUX3D_BASE,
    key: process.env.LUX3D_API_KEY,
    pollMs: Number(process.env.POLL_MS ?? 80),
    timeoutMs: Number(process.env.TIMEOUT_MS ?? 60_000),
    codingAgentBaseUrl: process.env.CODING_AGENT_BASE_URL,
    codingAgentApiKey: process.env.CODING_AGENT_API_KEY,
    codingAgentModel: process.env.CODING_AGENT_MODEL,
    agentTimeoutMs: process.env.AGENT_TIMEOUT_MS ? Number(process.env.AGENT_TIMEOUT_MS) : undefined,
    agentMaxRounds: process.env.AGENT_MAX_ROUNDS ? Number(process.env.AGENT_MAX_ROUNDS) : undefined,
    previewStartTimeoutMs: process.env.PREVIEW_START_TIMEOUT_MS ? Number(process.env.PREVIEW_START_TIMEOUT_MS) : undefined,
    logger: false,
  }));
} catch (error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  console.error(`createApp rejected${code ? ` [${code}]` : ''}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(12);
}
try {
  // 测试专用故障注入（不进入生产 app.ts）：仅在该 launcher 环境变量下替换预览启动。
  if (process.env.M3A_PREVIEW_FAIL === '1' && work) {
    work.previews.start = async () => { throw new Error('injected preview failure'); };
  }
  if (process.env.M3A_PREVIEW_FAIL_ONCE === '1' && work) {
    const originalStart = work.previews.start.bind(work.previews);
    let calls = 0;
    work.previews.start = async (...args) => {
      if (calls++ === 0) throw new Error('injected preview failure once');
      return originalStart(...args);
    };
  }
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
console.log(`pi-m2a backend ready on ${port} (workRoot=${workRoot})`);

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (!String(chunk).includes('close')) return;
  console.log('pi-m2a backend graceful close requested');
  void app.close().then(() => process.exit(0), (error) => {
    console.error(`close failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(13);
  });
});
