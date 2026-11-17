/**
 * Lux3D focused 验收后端 launcher：与 apps/server/src/index.ts 走同一条启动路径
 * （createApp + preview-origin 监听），只用 env 注入 fake 云、隔离数据目录与关闭真实语音。
 *
 * 安全边界：
 * - 不读 apps/server/.env；NODE_OPTIONS 由 playwright 显式设置为只允许回环的 guard；
 * - provider/agent 都是 loopback fake，key 为固定 fake 值；
 * - PI_LUX_FRESH 的递归清理只允许落在本验收 `.data/pi-lux3d` 下，拒绝树外/根本身/符号链接逃逸。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const dataRoot = path.join(repoRoot, '.data', 'pi-lux3d');
const workRoot = path.resolve(process.env.WORK_ROOT ?? path.join(repoRoot, 'templates', 'product-page'));
const dataDirectory = path.resolve(process.env.ASSETS_DIR ?? path.join(dataRoot, 'assets'));
const workDataDirectory = path.resolve(process.env.WORK_DATA_DIR ?? path.join(dataRoot, 'work-data'));
const historyDirectory = path.resolve(process.env.SCENE_HISTORY_DIR ?? path.join(dataRoot, 'scene-history'));

const numeric = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`invalid numeric env value: ${value}`);
  return parsed;
};

/** PI_LUX_FRESH 只允许清理这三个**精确目录**（不接受任意子目录或 env 自造路径）。 */
const CLEANABLE_DIRECTORIES = ['assets', 'work-data', 'scene-history'];

/** 递归清理只接受 `.data/pi-lux3d` 下白名单目录；树外、根本身、任意子目录、符号链接链一律拒绝。 */
function assertSafeForFreshCleanup(target, label) {
  const root = path.resolve(dataRoot);
  const absolute = path.resolve(target);
  const name = path.basename(absolute);
  if (!CLEANABLE_DIRECTORIES.includes(name) || absolute !== path.join(root, name)) {
    throw new Error(`${label} 不是白名单目录（${CLEANABLE_DIRECTORIES.join('/')}），拒绝递归清理：${absolute}`);
  }
  const relative = path.relative(root, absolute);
  if (existsSync(root)) {
    if (lstatSync(root).isSymbolicLink()) throw new Error(`${root} 是符号链接，拒绝递归清理`);
    if (realpathSync(root) !== root) throw new Error(`${root} realpath 与解析路径不一致，拒绝递归清理`);
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) throw new Error(`${current} 是符号链接，拒绝递归清理`);
  }
  return absolute;
}

if (process.env.PI_LUX_FRESH === '1') {
  for (const [label, directory] of [['ASSETS_DIR', dataDirectory], ['WORK_DATA_DIR', workDataDirectory], ['SCENE_HISTORY_DIR', historyDirectory]]) {
    await rm(assertSafeForFreshCleanup(directory, label), { recursive: true, force: true });
  }
}
for (const directory of [dataDirectory, workDataDirectory, historyDirectory]) await mkdir(directory, { recursive: true });

if (process.env.PI_NET_GUARD_LOG) {
  const marker = `${process.env.PI_NET_GUARD_LOG}.loaded`;
  const active = globalThis.__piNetGuard?.ready === true;
  await mkdir(path.dirname(marker), { recursive: true });
  await writeFile(marker, JSON.stringify({
    active,
    pid: process.pid,
    nodeOptions: process.env.NODE_OPTIONS ?? '',
    logPath: process.env.PI_NET_GUARD_LOG ?? '',
    guardDir: process.env.LUX3D_GUARD_DIR ?? '',
  }));
  if (!active) {
    console.error('network guard was not loaded; refusing to start without it');
    process.exit(9);
  }
}

const { createApp } = await import('../../../../apps/server/src/app.ts');
const { listenWithPreview } = await import('../../shared/server.mjs');
const { app, work } = await createApp({
  workRoot,
  dataDirectory,
  workDataDirectory,
  historyDirectory,
  base: process.env.LUX3D_BASE,
  key: process.env.LUX3D_API_KEY,
  pollMs: numeric(process.env.POLL_MS, 80),
  timeoutMs: numeric(process.env.TIMEOUT_MS, 60_000),
  codingAgentBaseUrl: process.env.CODING_AGENT_BASE_URL,
  codingAgentApiKey: process.env.CODING_AGENT_API_KEY,
  codingAgentModel: process.env.CODING_AGENT_MODEL,
  agentTimeoutMs: numeric(process.env.AGENT_TIMEOUT_MS, 30_000),
  agentMaxRounds: numeric(process.env.AGENT_MAX_ROUNDS, 16),
  previewStartTimeoutMs: numeric(process.env.PREVIEW_START_TIMEOUT_MS, 60_000),
  // 显式空对象：阻止 createApp 回退读取 SPEECH_* env，同时让 SpeechClient 保持 disabled
  // （不传非法 model，也不接触任何真实 key/base）。
  speech: {},
  logger: false,
});

const port = Number(process.env.PORT ?? 3001);
const previewPort = Number(process.env.PREVIEW_ORIGIN_PORT ?? 5175);
const mainPort = Number(process.env.MAIN_PREVIEW_PORT ?? 5174);
const studioOrigin = process.env.STUDIO_ORIGIN ?? 'http://127.0.0.1:5173';
try {
  await listenWithPreview({ app, work, apiPort: port, previewPort, mainPort, studioOrigin });
} catch (error) {
  console.error(`listen failed: ${error instanceof Error ? error.message : String(error)}`);
  await app.close().catch(() => {});
  process.exit(14);
}
console.log(`Lux3D focused backend on http://127.0.0.1:${port} (preview origin ${previewPort}, fake provider only)`);

let closing = false;
const stop = async () => {
  if (closing) return;
  closing = true;
  await app.close().catch((error) => { console.error('close failed', error); process.exitCode = 1; });
  process.exit(process.exitCode ?? 0);
};
process.stdin.on('close', () => void stop());
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void stop());
