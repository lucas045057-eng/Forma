import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import type { Child } from '../m0a/harness';
import { freePort, startChild, waitPortFree } from '../m0a/harness';
import { BACKEND_LAUNCHER, GUARD_SCRIPT_ARG, SERVER_DIR, WORK_ROOT } from '../m2a/env';
import { createWorkRoot } from '../real-model/helpers';

export const MOCK_BASE = 'http://127.0.0.1:4011';
export const MOCK_KEY = 'mock-only';
export const MOCK_MODEL = 'mock-coder';
export const DEAD_LUX3D = 'http://127.0.0.1:4019';

export interface Fixture {
  root: string;
  workRoot: string;
  dataDir: string;
  base: string;
  previewOrigin: string;
  /** 后端端口与预览源端口：拆除时用来等端口彻底释放（不是断言面）。 */
  port: number;
  previewPort: number;
  backend: Child;
  stop(): Promise<void>;
}

/**
 * 拆除收尾的等待预算。原实现只有 `rmSync` 的 5 × 200ms（≈ 1 秒），Windows 上子进程句柄
 * 释放稍慢就假失败（2026-11-15 run5 的 `EPERM` 就是这么来的）。这里改成有界轮询。
 */
const TEARDOWN_TIMEOUT_MS = 30_000;
const TEARDOWN_POLL_MS = 250;
/** 只有“句柄还没放/目录非空”这类瞬时错误值得重试；其它错误立即抛出。 */
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startMockAgent(): Promise<Child> {
  return startChild({
    command: process.execPath, args: [path.join(SERVER_DIR, '..', '..', 'tests', 'e2e', 'm2a', 'agent-mock.mjs')],
    cwd: SERVER_DIR, env: { MOCK_PORT: '4011', MOCK_KEY }, readyUrl: `${MOCK_BASE}/__stats`, label: 'm3a-agent-mock',
  });
}

export async function startBackendFixture(options: {
  root: string; previewFail?: 'all' | 'once'; customizer?: (workRoot: string) => void; reuse?: { dataDir: string; workRoot: string };
}): Promise<Fixture> {
  const workRoot = options.reuse?.workRoot ?? path.join(options.root, 'work');
  const dataDir = options.reuse?.dataDir ?? path.join(options.root, 'data');
  if (!options.reuse) {
    createWorkRoot(workRoot);
    options.customizer?.(workRoot);
  }
  mkdirSync(dataDir, { recursive: true });
  const port = await freePort();
  const previewPort = await freePort();
  const backend = await startChild({
    command: process.execPath, args: [BACKEND_LAUNCHER], cwd: SERVER_DIR,
    env: {
      PORT: String(port), PREVIEW_ORIGIN_PORT: String(previewPort), MAIN_PREVIEW_PORT: '5274', STUDIO_ORIGIN: 'http://127.0.0.1:5173',
      WORK_ROOT: workRoot, WORK_DATA_DIR: dataDir,
      ASSETS_DIR: path.join(dataDir, '..', 'assets'), SCENE_HISTORY_DIR: path.join(dataDir, '..', 'history'),
      LUX3D_BASE: DEAD_LUX3D, LUX3D_API_KEY: 'unused',
      CODING_AGENT_BASE_URL: MOCK_BASE, CODING_AGENT_API_KEY: MOCK_KEY, CODING_AGENT_MODEL: MOCK_MODEL,
      AGENT_TIMEOUT_MS: '30000', AGENT_MAX_ROUNDS: '16',
      ...(options.previewFail === 'all' ? { M3A_PREVIEW_FAIL: '1' } : {}),
      ...(options.previewFail === 'once' ? { M3A_PREVIEW_FAIL_ONCE: '1' } : {}),
      PI_NET_GUARD_LOG: path.join(dataDir, 'guard.log'), NODE_OPTIONS: `--require ${GUARD_SCRIPT_ARG}`,
    },
    readyUrl: `http://127.0.0.1:${port}/health`, label: options.previewFail ? 'm3a-backend-fault' : 'm3a-backend', timeoutMs: 60_000,
  });
  return {
    root: options.root, workRoot, dataDir, base: `http://127.0.0.1:${port}`, previewOrigin: `http://127.0.0.1:${previewPort}`, port, previewPort, backend,
    async stop() {
      await backend.gracefulClose(20_000).catch(async () => { await backend.stop(); });
      // 收尾硬化（2026-11-15）：后端父进程 exit 之后，它的子孙（Vite 预览 Worker、agent worker、
      // git 子进程）可能还持有 data/ 下的句柄。先等本 fixture 自己的两个端口真正不再监听，
      // 再交给 removeFixture 删目录；否则 Windows 上 rmdir(data) 会报 EPERM。
      await Promise.all([waitPortFree(port, TEARDOWN_TIMEOUT_MS), waitPortFree(previewPort, TEARDOWN_TIMEOUT_MS)]);
    },
  };
}

/**
 * 最终仍删不掉时落盘的定位材料：卡住的路径、目录清单（含大小）、该时刻的端口/进程表。
 * 写到 `.data/m3a-teardown/`（不入库），同时打一行 stderr——它会进本轮步骤日志，成为轮目录里的证据。
 */
function writeTeardownSnapshot(root: string, stuck: string, code: string, ports: number[]) {
  const entries: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (entries.length >= 400) return;
    let items: import('node:fs').Dirent[];
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      if (entries.length >= 400) return;
      const full = path.join(dir, item.name);
      const shown = path.relative(root, full).split(path.sep).join('/');
      if (item.isDirectory()) {
        entries.push(`dir  ${shown}/`);
        if (depth < 4) walk(full, depth + 1);
      } else {
        let bytes = -1;
        try { bytes = statSync(full).size; } catch { /* 已被删掉 */ }
        entries.push(`file ${bytes}\t${shown}`);
      }
    }
  };
  walk(root, 0);
  const shell = (command: string, args: string[]) => {
    if (process.platform !== 'win32') return '';
    return spawnSync(command, args, { encoding: 'utf8', timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }).stdout ?? '';
  };
  const listening = shell('netstat', ['-ano']).split('\n')
    .filter((line) => line.includes('LISTENING') && ports.some((port) => line.includes(`:${port} `)))
    .map((line) => line.trim());
  const nodePids = shell('tasklist', ['/FI', 'IMAGENAME eq node.exe', '/FO', 'CSV', '/NH']).split('\n')
    .filter(Boolean).slice(0, 200)
    .map((line) => (line.split(',')[1] ?? '').replaceAll('"', ''))
    .filter(Boolean);
  const snapshot = { at: new Date().toISOString(), root, stuck, code, ports, truncated: entries.length >= 400, entries, listening, nodePids };
  const directory = path.join('.data', 'm3a-teardown');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${Date.now()}-${path.basename(stuck) || 'root'}.json`);
  writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return { file, listening: listening.length, nodePids: nodePids.length };
}

/**
 * 有界等待一个路径可删：每 250ms 试一次，最长 30s；逐个子目录（data → work → root）删。
 * `ports` 只用于失败时的诊断快照（哪些端口还在监听），不参与判定。
 */
export async function removeFixture(root: string, ports: number[] = []) {
  for (const target of [path.join(root, 'data'), path.join(root, 'work'), root]) {
    const deadline = Date.now() + TEARDOWN_TIMEOUT_MS;
    for (;;) {
      try {
        rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (!TRANSIENT_CODES.has(code)) throw error;
        if (Date.now() >= deadline) {
          const info = writeTeardownSnapshot(root, target, code, ports);
          console.error(`[m3a-teardown] ${target} 在 ${TEARDOWN_TIMEOUT_MS}ms 内仍不可删（${code}）；诊断写入 ${info.file}（listening=${info.listening}, nodePids=${info.nodePids}）`);
          throw error;
        }
        await pause(TEARDOWN_POLL_MS);
      }
    }
  }
}

export async function http<T = any>(url: string, init?: RequestInit): Promise<{ status: number; body: T; text: string }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { status: response.status, body, text };
}
export const jsonRequest = (method: string, payload?: unknown): RequestInit => ({ method, ...(payload === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) });
export const getVersion = (base: string) => http<{ version: string }>(`${base}/version`);
export const listApprovals = (base: string) => http<any[]>(`${base}/approvals`);
export const getApproval = (base: string, id: string) => http<any>(`${base}/approvals/${id}`);
export const answerApproval = (base: string, id: string, option: number) => http<any>(`${base}/approvals/${id}`, jsonRequest('POST', { option }));
export const listCandidates = (base: string) => http<any[]>(`${base}/candidates`);
export const getCandidate = (base: string, id: string) => http<any>(`${base}/candidates/${id}`);
export const adoptCandidate = (base: string, id: string) => http(`${base}/candidates/${id}/adopt`, { method: 'POST' });
export const discardCandidate = (base: string, id: string) => http(`${base}/candidates/${id}/discard`, { method: 'POST' });
export const getTask = (base: string, id: string) => http<any>(`${base}/tasks/${id}`);
export const listTasks = (base: string) => http<any[]>(`${base}/tasks`);
export const cancelTask = (base: string, id: string) => http(`${base}/tasks/${id}/cancel`, { method: 'POST' });
export const history = (base: string) => http<any>(`${base}/events/history?since=0`);
export const resetMock = () => http(`${MOCK_BASE}/__reset`, { method: 'POST' });
export const setScript = (steps: unknown[], delayMs = 0) => http(`${MOCK_BASE}/__script`, jsonRequest('POST', { steps, delayMs }));
export const mockStats = () => http<any>(`${MOCK_BASE}/__stats`);

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 30_000, intervalMs = 150): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return Date.now() - started;
    await sleep(intervalMs);
  }
  throw new Error(`等待条件超时（${timeoutMs}ms）`);
}

export async function waitTask(base: string, id: string, timeoutMs = 60_000) {
  let task: any;
  await waitFor(async () => {
    task = (await getTask(base, id)).body;
    return !['queued', 'running'].includes(task.status);
  }, timeoutMs, 100);
  return task;
}
export async function waitDone(base: string, id: string, timeoutMs = 60_000) {
  let task: any;
  await waitFor(async () => {
    task = (await getTask(base, id)).body;
    if (task.status === 'awaiting_approval') {
      for (const card of (await listApprovals(base)).body.filter((item: any) => item.taskId === id && item.status === 'pending')) {
        const answer = await answerApproval(base, card.id, 0);
        if (answer.status !== 200) throw new Error(`自动批准失败：${answer.text}`);
      }
      return false;
    }
    return task.status === 'done';
  }, timeoutMs, 150);
  return task;
}

const selectionStyles = {
  display: 'inline-block', position: 'static', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)',
  fontSize: '16px', fontFamily: 'Arial', fontWeight: '400', lineHeight: '16px', padding: '0px', margin: '0px',
  borderRadius: '0px', width: '10px', height: '10px',
};
export function selection(baseVersion: string, src: string, options: { instances?: number; ancestors?: string[] } = {}) {
  return { src, baseVersion, cid: 'Node', text: '', bbox: [0, 0, 10, 10], styles: selectionStyles,
    instances: options.instances ?? 1, ancestors: options.ancestors ?? [] };
}

export async function submit(base: string, instruction: string, sel?: ReturnType<typeof selection>) {
  const response = await http<any>(`${base}/tasks`, jsonRequest('POST', sel ? { instruction, selection: sel } : { instruction }));
  if (response.status !== 202) throw new Error(`提交失败：${response.status} ${response.text}`);
  return response.body as { id: string; status: string };
}

export function readWorkFile(workRoot: string, file: string) {
  return readFileSync(path.join(workRoot, file), 'utf8');
}
export function writeWorkFile(workRoot: string, file: string, content: string) {
  writeFileSync(path.join(workRoot, file), content);
}

/** 读取批准前 staging 是否存在（仅测试 Fixture 使用）。 */
export function stagingExists(fixture: Fixture, taskId: string) {
  return readFileSync(path.join(fixture.dataDir, 'tasks.json'), 'utf8').includes('"approvals"') && path.join(fixture.dataDir, 'candidates', taskId);
}
