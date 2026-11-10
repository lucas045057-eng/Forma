import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import {
  ASSETS,
  BACKEND_BASE,
  BACKEND_LAUNCHER,
  GUARD_LOG,
  GUARD_SCRIPT_ARG,
  HISTORY,
  SANDBOX,
  SCENE_CONFIG,
  SERVER_DIR,
  SENTINEL_KEY,
  STUDIO_PORT,
  TEMPLATE_DIR,
  WORK_ROOT,
} from './env';
import { startChild, type Child } from '../m0a/harness';

export interface SceneConfigLike {
  model: string;
  hero: {
    camera: { position: number[]; target: number[]; fov: number };
    model: { rotation: number[]; scale: number };
    lights: { key: { intensity: number; color: string; direction: number[] }; ambient: number };
  };
  scroll: Array<{ at: number; model?: { rotation: number[] }; parts?: Record<string, { offset: number[] }> }>;
}

export interface SceneChangedLike {
  type: string;
  sequence: number;
  ts: string;
  config: SceneConfigLike;
  diff: Array<{ path: string; oldValue: unknown; newValue: unknown }>;
}

export interface HttpResult<T> { status: number; body: T; text: string; headers: Record<string, string> }

export async function http<T = any>(url: string, init?: RequestInit): Promise<HttpResult<T>> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: response.status, body: body as T, text, headers: Object.fromEntries(response.headers.entries()) };
}

export const json = (method: string, payload?: unknown): RequestInit => ({
  method,
  ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
});

export const getScene = (base = BACKEND_BASE) => http<SceneConfigLike>(`${base}/scene`);
export const putScene = (config: unknown, base = BACKEND_BASE) => http<SceneChangedLike>(`${base}/scene`, json('PUT', config));
export const undoScene = (base = BACKEND_BASE) => http<SceneChangedLike>(`${base}/scene/undo`, { method: 'POST' });
export const adoptAsset = (base: string, id: string, force?: boolean) =>
  http<SceneChangedLike>(`${base}/assets/${encodeURIComponent(id)}/adopt`, json('POST', force === undefined ? {} : { force }));

/** 经 Studio 的 Vite 代理访问后端（用于验证正常同源调用不受 Host 白名单影响）。 */
export const proxy = (pathname: string) => http(`http://127.0.0.1:${STUDIO_PORT}${pathname}`);

/** 用 node:http 发原始请求，才能自定义 Host 头（fetch 会忽略/覆盖它）。 */
export function rawRequest(options: { host: string; pathname: string; origin?: string; port?: number }): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: options.port ?? 3001,
      path: options.pathname,
      method: 'GET',
      headers: { Host: options.host, ...(options.origin ? { Origin: options.origin } : {}) },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
    });
    request.on('error', reject);
    request.end();
  });
}

/* ---------------------------------------------------------------- 场景文件快照 */

const snapshots = new Map<string, string | null>();

/** 记录 scene.config.json 当前内容（不存在记为 null），供 afterAll 还原。 */
export function snapshotSceneFile(file = SCENE_CONFIG): void {
  snapshots.set(file, existsSync(file) ? readFileSync(file, 'utf8') : null);
}

/** 还原到快照内容；返回是否成功。 */
export function restoreSceneFile(file = SCENE_CONFIG): { restored: boolean; matches: boolean } {
  const snapshot = snapshots.get(file);
  if (snapshot === undefined) return { restored: false, matches: false };
  if (snapshot === null) rmSync(file, { force: true });
  else writeFileSync(file, snapshot, 'utf8');
  const matches = existsSync(file) ? readFileSync(file, 'utf8') === snapshot : snapshot === null;
  return { restored: true, matches };
}

export function readSceneFile(file = SCENE_CONFIG): SceneConfigLike {
  return JSON.parse(readFileSync(file, 'utf8')) as SceneConfigLike;
}

export function sceneFileHash(file = SCENE_CONFIG): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/* ---------------------------------------------------------------- 沙箱 */

export interface Sandbox {
  root: string;
  workRoot: string;
  assetsDir: string;
  historyDir: string;
  port: number;
  base: string;
  /** 启动沙箱后端（拿实例锁、读自己那套工作根与历史） */
  start(options?: { assetsDir?: string; workRoot?: string }): Promise<Child & { base: string; port: number }>;
  cleanup(): void;
}

/** 准备一份作品目录副本（含 public/assets 与 src/scene.config.json），沙箱用例往里写。 */
export function createSandbox(name: string, port: number): Sandbox {
  const root = path.join(SANDBOX, name);
  const workRoot = path.join(root, 'work');
  const assetsDir = path.join(root, 'assets');
  const historyDir = path.join(root, 'history');
  rmSync(root, { recursive: true, force: true });
  mkdirSync(workRoot, { recursive: true });
  cpSync(path.join(TEMPLATE_DIR, 'src', 'scene.config.json'), path.join(workRoot, 'src', 'scene.config.json'));
  mkdirSync(path.join(workRoot, 'public', 'assets'), { recursive: true });
  for (const file of ['diffuser-4969889.glb', 'parts.json']) {
    const source = path.join(TEMPLATE_DIR, 'public', 'assets', file);
    if (existsSync(source)) copyFileSync(source, path.join(workRoot, 'public', 'assets', file));
  }
  mkdirSync(assetsDir, { recursive: true });
  mkdirSync(historyDir, { recursive: true });
  return {
    root, workRoot, assetsDir, historyDir, port, base: `http://127.0.0.1:${port}`,
    async start(options = {}) {
      const child = await startChild({
        command: process.execPath,
        args: [BACKEND_LAUNCHER],
        cwd: SERVER_DIR,
        env: {
          PORT: String(port),
          WORK_ROOT: options.workRoot ?? workRoot,
          SCENE_HISTORY_DIR: historyDir,
          LUX3D_BASE: 'http://127.0.0.1:4010',
          LUX3D_API_KEY: SENTINEL_KEY,
          ASSETS_DIR: options.assetsDir ?? assetsDir,
          POLL_MS: '80',
          PI_NET_GUARD_LOG: path.join(root, 'net-guard.log'),
          NODE_OPTIONS: `--require ${GUARD_SCRIPT_ARG}`,
        },
        readyUrl: `http://127.0.0.1:${port}/health`,
        label: `sandbox-backend:${name}`,
      });
      return { ...child, base: `http://127.0.0.1:${port}`, port };
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

/** 用离线 CLI 处理一个本地 GLB 并登记成资产（不经过 Lux3D）。 */
export async function processLocal(options: { input: string; id: string; assetsDir: string }): Promise<{ ok: boolean; output: string }> {
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(process.execPath, ['src/assets/process-cli.ts', options.input, options.id], {
    cwd: SERVER_DIR,
    env: { ...process.env, ASSETS_DIR: options.assetsDir },
    encoding: 'utf8',
    timeout: 180_000,
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

/** 改 index.json 里的资产指标（构造 webReady=false 这类管线不会产生的状态）。 */
export function mutateIndex(assetsDir: string, mutate: (entries: any[]) => void): void {
  const file = path.join(assetsDir, 'index.json');
  const entries = JSON.parse(readFileSync(file, 'utf8')) as any[];
  mutate(entries);
  writeFileSync(file, JSON.stringify(entries, null, 2), 'utf8');
}

export const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 20_000, intervalMs = 100): Promise<number> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return Date.now() - startedAt;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待条件超时（${timeoutMs}ms）`);
}

export { ASSETS, BACKEND_BASE, GUARD_LOG, HISTORY, SCENE_CONFIG, WORK_ROOT };
