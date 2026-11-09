/**
 * 被测后端的启动器。
 *
 * 和 `apps/server/src/index.ts` 走同一条 `createApp()` 路径，唯一区别是把轮询间隔和
 * 超时改成毫秒级：这两个值只能通过 createApp 的构造参数传入（不是环境变量），
 * 默认是 15 秒 / 15 分钟，真实服务里没法在测试中等待。
 * 下载总时限走 `ASSET_DOWNLOAD_TIMEOUT_MS` 环境变量（实现本身就支持）。
 *
 * 另外提供两个测试钩子：createApp 报配置错时以退出码 12 结束；stdin 收到 `close`
 * 时调 `app.close()`（Windows 上拿不到 SIGTERM 的优雅停机，用 stdin 代替）。
 *
 * 不读取 apps/server/.env：所有配置都由测试进程显式注入。
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const directory = process.env.ASSETS_DIR ? path.resolve(process.env.ASSETS_DIR) : path.join(repoRoot, '.data', 'pi-m0a', 'assets');

if (process.env.PI_FRESH === '1') {
  await rm(directory, { recursive: true, force: true });
  if (process.env.PI_NET_GUARD_LOG) await rm(process.env.PI_NET_GUARD_LOG, { force: true });
}
await mkdir(directory, { recursive: true });

// 证明出站守卫确实装进了这个进程（否则“守卫日志为空”是没有意义的）
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
const port = Number(process.env.PORT ?? 3001);
let app;
try {
  ({ app } = await createApp({
    dataDirectory: directory,
    base: process.env.LUX3D_BASE,
    key: process.env.LUX3D_API_KEY,
    pollMs: Number(process.env.POLL_MS ?? 100),
    timeoutMs: Number(process.env.TIMEOUT_MS ?? 30_000),
    logger: false,
  }));
} catch (error) {
  // 配置错误（例如非 loopback 的 http 上游）应该直接拒绝启动，而不是带着 key 发请求
  console.error(`createApp rejected configuration: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(12);
}
await app.listen({ port, host: '127.0.0.1' });
console.log(`pi-m0a backend ready on ${port} (base=${process.env.LUX3D_BASE ?? 'default'})`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void app.close(); });
}

// 测试用的优雅停机通道：stdin 收到 close 就调 app.close()（与 SIGTERM 同一条路径）。
// Windows 上 taskkill 是强制杀，拿不到优雅停机行为，所以用 stdin 触发。
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (!String(chunk).includes('close')) return;
  console.log('pi-m0a backend graceful close requested');
  void app.close().then(() => process.exit(0), (error) => {
    console.error(`close failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(13);
  });
});
