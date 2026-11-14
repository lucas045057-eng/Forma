import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { startChild, type Child } from '../m0a/harness';
import { BACKEND_LAUNCHER, GUARD_SCRIPT_ARG, REPO_ROOT, SERVER_DIR, TEMPLATE_DIR, WORK_ROOT } from '../m2a/env';

export const STUDIO_URL = 'http://127.0.0.1:5173/';
export const API_BASE = 'http://127.0.0.1:3001';
export const PREVIEW_BASE = 'http://127.0.0.1:5175';
export const MOCK_BASE = 'http://127.0.0.1:4011';
export const AGENT_BUDGET_MS = 180_000;
export const AGENT_ROUNDS = 16;

export interface AgentConfig { baseUrl: string; apiKey: string; model: string; source: string }

/** 只读取根 apps/server/.env 的三个 Agent 字段；值不打印、不写证据。 */
export function readAgentEnv(): AgentConfig {
  const file = path.join(REPO_ROOT, 'apps', 'server', '.env');
  if (!existsSync(file)) throw new Error('缺少 apps/server/.env（需要 CODING_AGENT_BASE_URL / CODING_AGENT_API_KEY / CODING_AGENT_MODEL）');
  const wanted = new Set(['CODING_AGENT_BASE_URL', 'CODING_AGENT_API_KEY', 'CODING_AGENT_MODEL']);
  const values: Record<string, string> = {};
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) continue;
    const name = line.slice(0, index).trim();
    if (!wanted.has(name)) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    values[name] = value;
  }
  for (const name of wanted) if (!values[name]) throw new Error(`apps/server/.env 缺少 ${name}`);
  return { baseUrl: values.CODING_AGENT_BASE_URL, apiKey: values.CODING_AGENT_API_KEY, model: values.CODING_AGENT_MODEL, source: 'apps/server/.env（三个字段，值未记录）' };
}

export const mockAgentConfig = (): AgentConfig => ({ baseUrl: MOCK_BASE, apiKey: 'mock-only', model: 'mock-coder', source: 'loopback agent-mock' });

const copyTree = (from: string, to: string) => {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else copyFileSync(source, target);
  }
};

/** 作品副本：文本/配置逐文件复制，node_modules 逐包真实链接（不整目录 junction，不 fs.cpSync）。 */
export function createWorkRoot(work: string): void {
  mkdirSync(work, { recursive: true });
  copyTree(path.join(WORK_ROOT, 'src'), path.join(work, 'src'));
  copyTree(path.join(WORK_ROOT, 'public'), path.join(work, 'public'));
  for (const file of ['index.html', 'package.json', 'tsconfig.json', 'vite.config.ts']) {
    copyFileSync(path.join(WORK_ROOT, file), path.join(work, file));
  }
  const sourceModules = path.join(WORK_ROOT, 'node_modules');
  const targetModules = path.join(work, 'node_modules');
  mkdirSync(targetModules, { recursive: true });
  const link = (from: string, to: string) => symlinkSync(realpathSync(from), to, 'junction');
  for (const entry of readdirSync(sourceModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const source = path.join(sourceModules, entry.name), target = path.join(targetModules, entry.name);
    if (entry.name.startsWith('@')) {
      mkdirSync(target, { recursive: true });
      for (const child of readdirSync(source)) link(path.join(source, child), path.join(target, child));
    } else {
      link(source, target);
    }
  }
  assertNoLinks(path.join(work, 'src'));
  assertNoLinks(path.join(work, 'public'));
}

function assertNoLinks(folder: string) {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    const real = realpathSync(full);
    if (path.relative(full, real) !== '') throw new Error(`作品副本含链接：${full}`);
    if (entry.isDirectory()) assertNoLinks(full);
  }
}

export interface Stack { backend: Child; vite: Child; stop(): Promise<void> }

export async function startStack(options: { workRoot: string; dataDir: string; agent: AgentConfig; mode: 'mock' | 'real' }): Promise<Stack> {
  await assertPortFree(3001); await assertPortFree(5174); await assertPortFree(5175);
  mkdirSync(path.join(options.dataDir, 'assets'), { recursive: true });
  mkdirSync(path.join(options.dataDir, 'scene'), { recursive: true });
  const viteBin = realpathSync(path.join(WORK_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'));
  const cacheDir = path.join(options.dataDir, 'vite-cache');
  const backend = await startChild({
    command: process.execPath, args: [BACKEND_LAUNCHER], cwd: SERVER_DIR,
    env: {
      PORT: '3001', PREVIEW_ORIGIN_PORT: '5175', MAIN_PREVIEW_PORT: '5174', STUDIO_ORIGIN: 'http://127.0.0.1:5173',
      WORK_ROOT: options.workRoot, WORK_DATA_DIR: options.dataDir,
      ASSETS_DIR: path.join(options.dataDir, 'assets'), SCENE_HISTORY_DIR: path.join(options.dataDir, 'scene'),
      LUX3D_BASE: 'http://127.0.0.1:4019', LUX3D_API_KEY: 'unused-in-real-model-test',
      CODING_AGENT_BASE_URL: options.agent.baseUrl,
      CODING_AGENT_API_KEY: options.agent.apiKey,
      CODING_AGENT_MODEL: options.agent.model,
      AGENT_TIMEOUT_MS: String(AGENT_BUDGET_MS), AGENT_MAX_ROUNDS: String(AGENT_ROUNDS),
      PI_NET_GUARD_LOG: path.join(options.dataDir, 'guard.log'),
      ...(options.mode === 'real' ? { PI_NET_GUARD_ALLOW: 'xfastapi.ai' } : {}),
      NODE_OPTIONS: `--require ${GUARD_SCRIPT_ARG}`,
    },
    readyUrl: `${API_BASE}/health`, label: 'real-model backend', timeoutMs: 60_000,
  });
  try {
    const vite = await startChild({
      command: process.execPath, args: [viteBin], cwd: options.workRoot,
      env: {
        PREVIEW_BASE: '/preview/main/', PREVIEW_PORT: '5174', PREVIEW_ORIGIN_PORT: '5175', PREVIEW_CACHE_DIR: cacheDir,
        CI: 'true',
      },
      readyUrl: `${PREVIEW_BASE}/preview/main/`, label: 'real-model main vite',
    });
    return {
      backend, vite,
      async stop() {
        await backend.gracefulClose(20_000).catch(async () => { await backend.stop(); });
        await vite.stop();
      },
    };
  } catch (error) {
    await backend.gracefulClose(20_000).catch(async () => { await backend.stop(); });
    throw error;
  }
}

export function assertPortFree(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); reject(new Error(`端口 ${port} 已被占用，拒绝开始`)); });
    socket.once('error', () => resolve());
    socket.setTimeout(1000, () => { socket.destroy(); resolve(); });
  });
}

export async function httpJson(url: string, init?: RequestInit): Promise<{ status: number; body: any; text: string }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: response.status, body, text };
}
export const json = (method: string, payload?: unknown): RequestInit => ({ method, ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) });
export const getVersion = () => httpJson(`${API_BASE}/version`);
export const getTask = (id: string) => httpJson(`${API_BASE}/tasks/${id}`);
export const listCandidates = () => httpJson(`${API_BASE}/candidates`);
export const getCandidate = (id: string) => httpJson(`${API_BASE}/candidates/${id}`);
export const discardCandidate = (id: string) => httpJson(`${API_BASE}/candidates/${id}/discard`, { method: 'POST' });
export const revertVersion = () => httpJson(`${API_BASE}/version/revert`, { method: 'POST' });
export const resetMock = () => httpJson(`${MOCK_BASE}/__reset`, { method: 'POST' });
export const setMockScript = (steps: unknown[], delayMs = 0) => httpJson(`${MOCK_BASE}/__script`, json('POST', { steps, delayMs }));

export async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 30_000, intervalMs = 200): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待条件超时（${timeoutMs}ms）`);
}

export const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();

export type Snapshot = Record<string, any>;

/** 在 iframe 内计算的 DOM/样式快照；只读，不依赖 Pi 对模型的提示。 */
export function snapshotInPage(): Snapshot {
  const norm = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const css = (element: Element | null, keys: string[]) => {
    if (!element) return null;
    const style = getComputedStyle(element);
    return Object.fromEntries(keys.map((key) => [key, style.getPropertyValue(key)]));
  };
  const q = (selector: string) => document.querySelector(selector);
  const styleKeys = ['font-size', 'color', 'line-height', 'letter-spacing', 'font-family', 'font-weight'];
  const buttonIds = ['buy-button', 'save-button', 'gift-button'];
  const buttons: Record<string, unknown> = {};
  const buttonTexts: Record<string, string> = {};
  for (const id of buttonIds) {
    const element = q(`[data-testid="${id}"]`);
    if (!element) { buttons[id] = null; buttonTexts[id] = ''; continue; }
    buttonTexts[id] = norm(element.textContent);
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    buttons[id] = {
      width: Number(rect.width.toFixed(2)), height: Number(rect.height.toFixed(2)),
      radius: style.borderRadius, background: style.backgroundColor, color: style.color, fontSize: style.fontSize,
    };
  }
  const benefits = [...document.querySelectorAll('[data-testid="benefit-item"]')].map((item) => ({
    title: norm(item.querySelector('h3')?.textContent),
    h3Size: item.querySelector('h3') ? getComputedStyle(item.querySelector('h3')!).fontSize : '',
    text: norm(item.querySelector('p')?.textContent),
    pSize: item.querySelector('p') ? getComputedStyle(item.querySelector('p')!).fontSize : '',
  }));
  const h1 = q('h1'), intro = q('.intro'), actions = q('.actions'), price = q('.price'), status = q('[data-testid="action-status"]');
  return {
    brand: norm(q('.brand')?.textContent), eyebrow: norm(q('.hero .eyebrow')?.textContent),
    h1: norm(h1?.textContent), h1Tag: h1?.tagName, h1Style: css(h1, styleKeys),
    intro: norm(intro?.textContent), introStyle: css(intro, styleKeys),
    price: norm(price?.textContent), priceSpan: norm(q('.price span')?.textContent), priceStyle: css(price, styleKeys),
    navText: norm(q('header a[href="#details"]')?.textContent), navHref: q('header a[href="#details"]')?.getAttribute('href'),
    fine: norm(q('.fine-print')?.textContent), detailsH2: norm(q('#details h2')?.textContent), footer: norm(q('footer')?.textContent),
    actionsGap: actions ? getComputedStyle(actions).gap : '', actionsDisplay: actions ? getComputedStyle(actions).display : '',
    buttons, buttonTexts, benefits,
    purchases: status?.getAttribute('data-purchases') ?? null, actionStatus: norm(status?.textContent),
    sceneState: q('[data-testid="product-scene"]')?.getAttribute('data-state') ?? null,
    sceneCanvas: Boolean(q('[data-testid="product-scene"] canvas')),
  };
}

export function flatten(value: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (Array.isArray(value)) value.forEach((item, index) => flatten(item, `${prefix}.${index}`, out));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) flatten(item, prefix ? `${prefix}.${key}` : key, out);
  else out[prefix] = value;
  return out;
}

export function workDigest(workRoot: string): string {
  const files: string[] = [];
  const walk = (folder: string, prefix: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['node_modules', '.git', 'dist', '.vite', 'vite-cache'].includes(entry.name)) continue;
      const full = path.join(folder, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relative);
      else if (entry.isFile()) files.push(`${relative}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`);
    }
  };
  walk(workRoot, '');
  return createHash('sha256').update(files.join('\n')).digest('hex');
}

export function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function removeTree(folder: string) {
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

export const exists = existsSync;
export const fileStat = statSync;
