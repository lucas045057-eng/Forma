/**
 * 被测后端的启动器。
 *
 * 和 `apps/server/src/index.ts` 走同一条 `createApp()` 路径，唯一区别是把轮询间隔和
 * 超时改成毫秒级：这两个值只能通过 createApp 的构造参数传入（不是环境变量），
 * 默认是 15 秒 / 15 分钟，真实服务里没法在测试中等待。
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
const { app } = await createApp({
  dataDirectory: directory,
  base: process.env.LUX3D_BASE,
  key: process.env.LUX3D_API_KEY,
  pollMs: Number(process.env.POLL_MS ?? 100),
  timeoutMs: Number(process.env.TIMEOUT_MS ?? 30_000),
  logger: false,
});
await app.listen({ port, host: '127.0.0.1' });
console.log(`pi-m0a backend ready on ${port} (base=${process.env.LUX3D_BASE ?? 'default'})`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void app.close(); });
}
