import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import {
  ARTIFACT_DIR,
  BACKEND_LAUNCHER,
  GUARD_SCRIPT_ARG,
  M0A_DATA,
  SERVER_DIR,
  SENTINEL_KEY,
  STUB_UPSTREAM,
} from './env';

const requireFromServer = createRequire(path.join(SERVER_DIR, 'package.json'));

/* ------------------------------------------------------------------ 进程管理 */

export interface Child {
  pid: number;
  stop(): Promise<void>;
  /** 模拟 SIGTERM 的优雅停机：stdin 发 close，等进程自己退出。 */
  gracefulClose(timeoutMs?: number): Promise<{ code: number | null; output: string }>;
  output(): string;
}

export async function freePort(): Promise<number> {
  // Windows 的 TCP 随机范围包含 Node fetch 禁用的低位端口（例如 6000），
  // 仅在本机 loopback 的高位范围取候选；绑定后立即释放，子进程接手（仍存在释放窗口）。
  let lastCode = '';
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = 20000 + Math.floor(Math.random() * 45536);
    const result = await new Promise<{ ok: true; port: number } | { ok: false; error: NodeJS.ErrnoException }>((resolve) => {
      const server = net.createServer();
      const onError = (error: NodeJS.ErrnoException) => resolve({ ok: false, error });
      server.once('error', onError);
      server.listen(candidate, '127.0.0.1', () => {
        server.off('error', onError);
        server.close((error) => {
          if (error) resolve({ ok: false, error });
          else resolve({ ok: true, port: candidate });
        });
      });
    });
    if (result.ok) return result.port;
    lastCode = result.error.code ?? '';
    // 仅“该候选被占用”或 Windows 绑定被 ACL 拒绝（EACCES）可以换下一个；其它错误停止。
    if (lastCode === 'EADDRINUSE' || (process.platform === 'win32' && lastCode === 'EACCES')) continue;
    throw result.error;
  }
  throw new Error(`freePort: 32 个高位候选均不可用（最后一次 ${lastCode || 'unknown'}）`);
}

export async function waitForHttp(url: string, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`等待 ${url} 就绪超时：${lastError}`);
}

interface StartOptions {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  readyUrl: string;
  label: string;
  timeoutMs?: number;
}

export async function startChild(options: StartOptions): Promise<Child> {
  const child: ChildProcess = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', (chunk) => { output += String(chunk); });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const stop = async () => {
    if (child.exitCode !== null || child.pid === undefined) return;
    // Windows 下需要整棵进程树
    spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 150));
  };
  const gracefulClose = async (timeoutMs = 30_000) => {
    child.stdin?.write('close\n');
    const code = await Promise.race([
      exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), timeoutMs)),
    ]);
    if (code === 'timeout') {
      await stop();
      return { code: null, output };
    }
    return { code, output };
  };
  try {
    await Promise.race([
      waitForHttp(options.readyUrl, options.timeoutMs ?? 60_000),
      exited.then((code) => { throw new Error(`${options.label} 在就绪前退出（code=${code}）\n${output}`); }),
    ]);
  } catch (error) {
    await stop();
    throw new Error(`${options.label} 启动失败：${error instanceof Error ? error.message : String(error)}\n${output}`);
  }
  return { pid: child.pid ?? -1, stop, gracefulClose, output: () => output };
}

/**
 * 启动一个「应该拒绝启动」的后端：不等就绪，直接等退出码。
 * 用于验证 `LUX3D_BASE` 配成非 loopback 的 http:// 时会在发请求前就被拒。
 */
export async function startBackendExpectingRejection(options: {
  base: string;
  assetsDir: string;
  guardLog?: string;
  timeoutMs?: number;
}): Promise<{ code: number | null; output: string; guardLog: string; guardMarker: Record<string, unknown> | null }> {
  const guardLog = options.guardLog ?? path.join(M0A_DATA, `net-guard-reject-${Date.now()}.log`);
  mkdirSync(M0A_DATA, { recursive: true });
  writeFileSync(guardLog, '', 'utf8');
  rmSync(`${guardLog}.loaded`, { force: true });
  const child = spawn(process.execPath, [BACKEND_LAUNCHER], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: '1',
      LUX3D_BASE: options.base,
      LUX3D_API_KEY: SENTINEL_KEY,
      ASSETS_DIR: options.assetsDir,
      PI_NET_GUARD_LOG: guardLog,
      NODE_OPTIONS: `--require ${GUARD_SCRIPT_ARG}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  child.stdout?.on('data', (chunk) => { output += String(chunk); });
  child.stderr?.on('data', (chunk) => { output += String(chunk); });
  const code = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => { spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore' }); }, options.timeoutMs ?? 30_000);
    child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  return { code, output, guardLog, guardMarker: readGuardMarker(guardLog) };
}

/** 等一个端口不再被监听（换 mock 场景时避免 TIME_WAIT / 旧进程占口）。 */
export async function waitPortFree(port: number, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inUse = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.setTimeout(500, () => { socket.destroy(); resolve(false); });
    });
    if (!inUse) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** 启动 CodeBuddy 提供的 mock Lux3D 服务（apps/server/src/assets/mock-server.ts）。 */
export async function startMock(options: { port?: number; scenario?: string; fixture?: string } = {}) {
  const port = options.port ?? (await freePort());
  const env: Record<string, string> = { MOCK_PORT: String(port), MOCK_SCENARIO: options.scenario ?? 'success' };
  if (options.fixture) env.MOCK_GLB = options.fixture;
  const child = await startChild({
    command: process.execPath,
    args: ['src/assets/mock-server.ts'],
    cwd: SERVER_DIR,
    env,
    readyUrl: `http://127.0.0.1:${port}/__stats`,
    label: `mock(${env.MOCK_SCENARIO})`,
  });
  return { ...child, port, base: `http://127.0.0.1:${port}` };
}

/** 给 CodeBuddy 的 mock 补覆盖不到的剧本（并发超限 / create 500 / 无 GLB）。 */
export async function startStub(options: { port?: number; mode: string }) {
  const port = options.port ?? (await freePort());
  const child = await startChild({
    command: process.execPath,
    args: [STUB_UPSTREAM],
    cwd: SERVER_DIR,
    env: { STUB_PORT: String(port), STUB_MODE: options.mode },
    readyUrl: `http://127.0.0.1:${port}/__stats`,
    label: `stub(${options.mode})`,
  });
  return { ...child, port, base: `http://127.0.0.1:${port}` };
}

/** 启动被测后端（走 createApp，同一条代码路径；只把轮询间隔/超时改成毫秒级）。 */
export async function startBackend(options: {
  port?: number;
  base: string;
  assetsDir: string;
  pollMs?: number;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
  guardLog?: string;
}) {
  const port = options.port ?? (await freePort());
  const guardLog = options.guardLog ?? path.join(M0A_DATA, `net-guard-${port}.log`);
  mkdirSync(M0A_DATA, { recursive: true });
  writeFileSync(guardLog, '', 'utf8');
  rmSync(`${guardLog}.loaded`, { force: true });
  const env: Record<string, string> = {
    PORT: String(port),
    LUX3D_BASE: options.base,
    LUX3D_API_KEY: SENTINEL_KEY,
    ASSETS_DIR: options.assetsDir,
    POLL_MS: String(options.pollMs ?? 60),
    TIMEOUT_MS: String(options.timeoutMs ?? 20_000),
    PI_NET_GUARD_LOG: guardLog,
    NODE_OPTIONS: `--require ${GUARD_SCRIPT_ARG}`,
  };
  if (options.downloadTimeoutMs !== undefined) env.ASSET_DOWNLOAD_TIMEOUT_MS = String(options.downloadTimeoutMs);
  const child = await startChild({
    command: process.execPath,
    args: [BACKEND_LAUNCHER],
    cwd: SERVER_DIR,
    env,
    readyUrl: `http://127.0.0.1:${port}/health`,
    label: 'backend',
  });
  return { ...child, port, base: `http://127.0.0.1:${port}`, guardLog };
}

/* ------------------------------------------------------------------ HTTP */

export interface HttpResponse<T> {
  status: number;
  body: T;
  text: string;
  headers: Record<string, string>;
}

async function request<T>(url: string, init?: RequestInit): Promise<HttpResponse<T>> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* 保持文本 */ }
  return { status: response.status, body: body as T, text, headers: Object.fromEntries(response.headers.entries()) };
}

export function getJson<T = any>(url: string) {
  return request<T>(url);
}

export function postJson<T = any>(url: string, payload: unknown) {
  // 不带 Origin 头：应用只在收到跨源 Origin 时才拒绝，测试用同源语义更贴近真实调用
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export async function getBytes(url: string) {
  const response = await fetch(url);
  return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()), headers: Object.fromEntries(response.headers.entries()) };
}

/* ------------------------------------------------------------------ WebSocket */

export interface AssetEventShape {
  type: string;
  ts?: string;
  sequence?: number;
  asset?: { id?: string; status?: string; error?: { code?: string; message?: string } };
  [key: string]: unknown;
}

export async function collectEvents(url: string) {
  const events: AssetEventShape[] = [];
  const raw: string[] = [];
  const WebSocketImpl = (globalThis as unknown as { WebSocket: new (url: string) => any }).WebSocket;
  const socket = new WebSocketImpl(url);
  socket.addEventListener('message', (event: { data: unknown }) => {
    const text = String(event.data);
    raw.push(text);
    try { events.push(JSON.parse(text) as AssetEventShape); } catch { /* 忽略非 JSON */ }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error(`WebSocket 连接失败：${url}`)));
  });
  return {
    events,
    raw,
    close: () => { try { socket.close(); } catch { /* ignore */ } },
    waitFor: async (predicate: (events: AssetEventShape[]) => boolean, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(events)) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(`等待 WebSocket 事件超时，已收到：${JSON.stringify(events.map((event) => `${event.type}:${event.asset?.status}`))}`);
    },
  };
}

/* ------------------------------------------------------------------ 资产轮询 */

export async function waitForAsset(
  base: string,
  id: string,
  isDone: (asset: any) => boolean,
  options: { timeoutMs?: number; onPoll?: (asset: any) => void } = {},
) {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const seen: string[] = [];
  while (Date.now() < deadline) {
    const response = await getJson(`${base}/assets/${id}`);
    const asset = response.body as any;
    if (asset?.status) {
      if (seen[seen.length - 1] !== asset.status) seen.push(asset.status);
      options.onPoll?.(asset);
      if (isDone(asset)) return { asset, seen, elapsedMs: options.timeoutMs ?? 30_000 };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`资产 ${id} 在超时前没有进入终态，观察到的状态：${seen.join(' → ')}`);
}

export const TERMINAL = new Set(['ready', 'failed', 'cancelled', 'submit_unknown']);

/* ------------------------------------------------------------------ GLB */

export function glbHeader(buffer: Buffer) {
  if (buffer.length < 12) return { valid: false, reason: '不足 12 字节' };
  return {
    magic: buffer.toString('ascii', 0, 4),
    version: buffer.readUInt32LE(4),
    declaredLength: buffer.readUInt32LE(8),
    actualLength: buffer.length,
    valid: buffer.toString('ascii', 0, 4) === 'glTF' && buffer.readUInt32LE(4) === 2 && buffer.readUInt32LE(8) === buffer.length,
  };
}

/** 用 @gltf-transform/core 真正解析一遍，顺带算顶点数和世界包围盒。 */
export async function inspectGlb(buffer: Buffer) {
  const { NodeIO, getBounds } = requireFromServer('@gltf-transform/core');
  const { ALL_EXTENSIONS } = requireFromServer('@gltf-transform/extensions');
  const { MeshoptDecoder } = requireFromServer('meshoptimizer');
  await MeshoptDecoder.ready;
  // 处理后的模型用 Meshopt 压缩，读的时候必须挂解码器，否则只能验证文件头
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
  });
  const document = await io.readBinary(new Uint8Array(buffer));
  const root = document.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const bounds = getBounds(scene);
  let vertices = 0;
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute('POSITION');
      if (position) vertices += position.getCount();
    }
  }
  const size = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
  return {
    meshes: root.listMeshes().length,
    materials: root.listMaterials().length,
    textures: root.listTextures().length,
    vertices,
    bounds: { min: [...bounds.min], max: [...bounds.max] },
    size,
    maxEdge: Math.max(...size),
  };
}

/* ------------------------------------------------------------------ 图片对比 */

export async function imageStats(png: Buffer) {
  const sharp = requireFromServer('sharp');
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const colors = new Set<number>();
  let sum = 0;
  let sumSquares = 0;
  const pixels = info.width * info.height;
  for (let index = 0; index < data.length; index += 4) {
    const value = (data[index] << 16) | (data[index + 1] << 8) | data[index + 2];
    colors.add(value);
    sum += data[index] + data[index + 1] + data[index + 2];
    sumSquares += data[index] ** 2 + data[index + 1] ** 2 + data[index + 2] ** 2;
  }
  const mean = sum / (pixels * 3);
  const variance = sumSquares / (pixels * 3) - mean ** 2;
  return { width: info.width, height: info.height, uniqueColors: colors.size, mean, stdDev: Math.sqrt(Math.max(0, variance)) };
}

export async function pixelDiff(pngA: Buffer, pngB: Buffer) {
  const sharp = requireFromServer('sharp');
  const a = await sharp(pngA).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(pngB).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const length = Math.min(a.data.length, b.data.length);
  let changed = 0;
  let total = 0;
  for (let index = 0; index < length; index += 4) {
    total += 1;
    const delta = Math.abs(a.data[index] - b.data[index]) + Math.abs(a.data[index + 1] - b.data[index + 1]) + Math.abs(a.data[index + 2] - b.data[index + 2]);
    if (delta > 12) changed += 1;
  }
  return { ratio: total ? changed / total : 0, changed, total };
}

/* ------------------------------------------------------------------ 证据 */

export function writeArtifact(name: string, data: unknown): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, name);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
}

export function readGuardLog(file: string): Array<{ kind: string; detail: string; pid: number }> {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return { kind: 'unparsable', detail: line, pid: 0 }; } });
}

/** 启动器写下的「守卫已加载」标记；缺了就说明日志为空的说法不可信。 */
export function readGuardMarker(logFile: string): { active?: boolean; pid?: number; nodeOptions?: string } | null {
  const file = `${logFile}.loaded`;
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function scenarioDir(name: string): string {
  return path.join(M0A_DATA, `scenario-${name}`);
}

export { SENTINEL_KEY };
