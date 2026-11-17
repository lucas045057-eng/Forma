import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { APIRequestContext, APIResponse } from '@playwright/test';
import { ARTIFACT_DIR, BACKEND_BASE, FAKE_BASE, FIXTURES, REPO_ROOT } from '../env';

export interface HttpResponseEvidence {
  method: string; pathname: string; status: number; contentType: string | null;
  jsonParsed: boolean; rawTextPrefix: string;
}
export interface HttpResult<T = unknown> { status: number; body: T; response?: HttpResponseEvidence }

let responseSequence = 0;

/** Preserve the actual envelope before an assertion can fail; never normalize error codes. */
export async function readHttpResult<T = unknown>(response: APIResponse, request: { method: string; pathname: string }): Promise<HttpResult<T>> {
  const text = await response.text();
  let body: unknown = text ? text : undefined;
  let jsonParsed = false;
  try {
    if (text) { body = JSON.parse(text); jsonParsed = true; }
  } catch { /* Keep the unparsed body and record that parsing failed. */ }
  const evidence: HttpResponseEvidence = {
    ...request, status: response.status(), contentType: response.headers()['content-type'] ?? null,
    jsonParsed, rawTextPrefix: text.slice(0, 300),
  };
  if (!response.ok()) writeEvidence(`http-error-${process.pid}-${++responseSequence}.json`, evidence);
  return { status: response.status(), body: body as T, response: evidence };
}

export async function api<T = unknown>(request: APIRequestContext, method: 'GET' | 'POST' | 'PUT', pathname: string, data?: unknown, options: { timeout?: number } = {}): Promise<HttpResult<T>> {
  const response = await request.fetch(`${BACKEND_BASE}${pathname}`, {
    method,
    data: data === undefined ? undefined : data,
    headers: data === undefined ? undefined : { 'content-type': 'application/json' },
    failOnStatusCode: false,
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
  });
  return readHttpResult<T>(response, { method, pathname });
}

export async function uploadBytes(request: APIRequestContext, input: { kind: 'image' | 'glb'; filename: string; bytes: Buffer }): Promise<HttpResult<{ id: string; kind: string; rigged?: boolean; bytes: number; sha256: string }>> {
  const response = await request.post(`${BACKEND_BASE}/assets/uploads?kind=${input.kind}&filename=${encodeURIComponent(input.filename)}`, {
    headers: { 'content-type': 'application/octet-stream' }, data: input.bytes, failOnStatusCode: false,
  });
  return readHttpResult<{ id: string; kind: string; rigged?: boolean; bytes: number; sha256: string }>(response, {
    method: 'POST', pathname: `/assets/uploads?kind=${input.kind}&filename=${encodeURIComponent(input.filename)}`,
  });
}

export const fixtureBytes = (name: string) => readFileSync(path.join(FIXTURES, name));

export async function fake(pathname: string, data?: unknown): Promise<unknown> {
  const response = await fetch(`${FAKE_BASE}${pathname}`, {
    method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? undefined : { 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return response.json();
}

export interface FakeCounters {
  scenario: string; blockSize: number; creates: number; createAttempts: number; gets: number; token: number;
  ous: { single: number; init: number; part: number; status: number };
  headers: { token: { authorization: string | null; ousToken: string | null } | null; ous: { ousToken: string | null; authorization: string | null } | null };
  createsLog: Array<{ operation: string; body: Record<string, unknown> }>;
  listQueries: Array<Record<string, string>>;
}
export const counters = () => fake('/__counters') as Promise<FakeCounters>;
export const control = (patch: Record<string, unknown>) => fake('/__control', patch);
export const resetFake = () => fake('/__reset', {});

export interface LuxTaskView {
  localId: string; operation: string; providerTaskId?: string; stage: string; inputRefs?: string[];
  artifacts: Array<{ id: string; kind: string; format: string; variant: string; bytes: number; sha256: string; assetId?: string; label?: string; animationId?: string; animationIds?: string[]; sourceUrlHash?: string; downloadUrl: string }>;
  error?: { code: string; message: string; classification?: string };
  note?: string; manualLink?: { providerTaskId: string; candidateCount: number };
  resumeCandidates?: Array<{ providerTaskId: string; status: number }>;
}

export async function waitTask(request: APIRequestContext, localId: string, options: { until?: (task: LuxTaskView) => boolean; timeoutMs?: number; label?: string } = {}): Promise<LuxTaskView> {
  const until = options.until ?? ((task: LuxTaskView) => ['ready', 'failed', 'cancelled', 'submit_unknown'].includes(task.stage));
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  let last: LuxTaskView | undefined;
  while (Date.now() < deadline) {
    const result = await api<LuxTaskView>(request, 'GET', `/assets/lux3d/tasks/${localId}`);
    if (result.status !== 200) throw new Error(`读取任务失败 ${result.status}: ${JSON.stringify(result.body).slice(0, 200)}`);
    last = result.body;
    if (until(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`等待任务超时${options.label ? `（${options.label}）` : ''}：${JSON.stringify(last)?.slice(0, 400)}`);
}

export function writeEvidence(name: string, value: unknown) {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeFileSync(path.join(ARTIFACT_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
}

export const git = (args: string[]) => execFileSync('git', ['-c', 'core.longpaths=true', '-c', 'core.quotePath=false', ...args], { cwd: REPO_ROOT, encoding: 'utf8' });

/** 运行期模板可能被采用/写回；测试结束按 Git 还原：先删本轮未跟踪文件，再 checkout 跟踪文件。 */
export function restoreWorkRoot(): { before: string[]; removed: string[]; after: string } {
  const status = () => git(['status', '--porcelain', '--untracked-files=all', '--', 'templates/product-page']);
  const before = status().split('\n').map((line) => line.trim()).filter(Boolean);
  const removed: string[] = [];
  for (const line of before) {
    if (!line.startsWith('??')) continue;
    const relative = line.slice(3).trim();
    const absolute = path.join(REPO_ROOT, relative);
    if (existsSync(absolute)) { unlinkSync(absolute); removed.push(relative); }
  }
  // 空目录不会出现在 Git 状态里，但保持作品目录整洁。
  const modulesDir = path.join(REPO_ROOT, 'templates/product-page/src/scene-modules');
  if (existsSync(modulesDir)) { try { rmdirSync(modulesDir); } catch { /* not empty */ } }
  git(['checkout', '--', 'templates/product-page']);
  return { before, removed, after: status().trim() };
}

/** 作品根：放置目标身份对外一律是作品根相对的 src/... 路径，不能带模板绝对前缀。 */
const SUPPORTED_WORK_ROOTS = [path.join(REPO_ROOT, 'templates', 'product-page')];

/** 由源码里第一个 needle 的偏移算出 JSX 元素起点（"src/...:line:col"）。 */
export function jsxTarget(file: string, needle: string): string {
  const absolute = path.resolve(REPO_ROOT, file);
  const root = SUPPORTED_WORK_ROOTS.find((candidate) => {
    const relative = path.relative(candidate, absolute);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  if (!root) throw new Error(`unsupported work root for ${file}`);
  const sourceIdentity = path.relative(root, absolute).split(path.sep).join('/');
  if (!sourceIdentity.startsWith('src/')) throw new Error(`source identity must live under src/: ${file}`);
  const source = readFileSync(absolute, 'utf8');
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`needle not found in ${file}: ${needle}`);
  const before = source.slice(0, index);
  const line = before.split('\n').length;
  const column = index - before.lastIndexOf('\n');
  return `${sourceIdentity}:${line}:${column}`;
}
