import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Child } from '../m0a/harness';
import { freePort, startChild } from '../m0a/harness';
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
  backend: Child;
  stop(): Promise<void>;
}

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
    root: options.root, workRoot, dataDir, base: `http://127.0.0.1:${port}`, previewOrigin: `http://127.0.0.1:${previewPort}`, backend,
    async stop() {
      await backend.gracefulClose(20_000).catch(async () => { await backend.stop(); });
    },
  };
}

export function removeFixture(root: string) {
  rmSync(path.join(root, 'data'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(path.join(root, 'work'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(root, { recursive: true, force: true });
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
