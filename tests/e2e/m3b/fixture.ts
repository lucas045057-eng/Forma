/**
 * M3-B 独立验收的测试夹具（不是正式验收）：每个用例自己起一个隔离后端 + 作品副本 + mock 编码上游。
 *
 * - 作品目录用 `createWorkRoot()` 复制模板 src/public，node_modules 走 junction；不碰真实 templates/；
 * - 后端是同一个 `createApp()`（tests/e2e/m2a/start-backend.mjs），带出站网络守卫，不读真实 .env；
 * - 只用 loopback、fake key；Lux3D 指向没人监听的端口。
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { freePort, startChild, type Child } from '../m0a/harness';
import { BACKEND_LAUNCHER, GUARD_SCRIPT_ARG, SERVER_DIR } from '../m2a/env';
import { createWorkRoot } from '../real-model/helpers';
import { writeArtifact } from './artifact';
import { getCandidate, getCheckRun, httpJson, sleep, startChecks, waitCheckRun } from './checks';

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
  /** 优雅关闭（stdin close）。 */
  stop(): Promise<void>;
  /** 强制杀整棵进程树（模拟崩溃，用于重启恢复用例）。 */
  hardKill(): Promise<void>;
  /** 用同一 dataDir/workRoot 重新起一个后端（重启恢复用例）。 */
  restart(env?: Record<string, string>): Promise<void>;
}

export async function startMockAgent(): Promise<Child> {
  return startChild({
    command: process.execPath,
    args: [path.join(SERVER_DIR, '..', '..', 'tests', 'e2e', 'm2a', 'agent-mock.mjs')],
    cwd: SERVER_DIR,
    env: { MOCK_PORT: '4011', MOCK_KEY },
    readyUrl: `${MOCK_BASE}/__stats`,
    label: 'm3b-agent-mock',
  });
}

async function launchBackend(options: {
  port: number; previewPort: number; mainPort: number; workRoot: string; dataDir: string; env?: Record<string, string>; label: string;
}): Promise<{ backend: Child; base: string; previewOrigin: string }> {
  const env: Record<string, string> = {
    PORT: String(options.port),
    PREVIEW_ORIGIN_PORT: String(options.previewPort),
    MAIN_PREVIEW_PORT: String(options.mainPort),
    STUDIO_ORIGIN: 'http://127.0.0.1:5173',
    WORK_ROOT: options.workRoot,
    WORK_DATA_DIR: options.dataDir,
    ASSETS_DIR: path.join(options.dataDir, '..', 'assets'),
    SCENE_HISTORY_DIR: path.join(options.dataDir, '..', 'history'),
    LUX3D_BASE: DEAD_LUX3D,
    LUX3D_API_KEY: 'unused-in-m3b',
    CODING_AGENT_BASE_URL: MOCK_BASE,
    CODING_AGENT_API_KEY: MOCK_KEY,
    CODING_AGENT_MODEL: MOCK_MODEL,
    AGENT_TIMEOUT_MS: '30000',
    AGENT_MAX_ROUNDS: '16',
    PI_NET_GUARD_LOG: path.join(options.dataDir, 'guard.log'),
    NODE_OPTIONS: `--require ${GUARD_SCRIPT_ARG}`,
    ...options.env,
  };
  const backend = await startChild({
    command: process.execPath,
    args: [BACKEND_LAUNCHER],
    cwd: SERVER_DIR,
    env,
    readyUrl: `http://127.0.0.1:${options.port}/health`,
    label: options.label,
    timeoutMs: 90_000,
  });
  return { backend, base: `http://127.0.0.1:${options.port}`, previewOrigin: `http://127.0.0.1:${options.previewPort}` };
}

export async function startFixture(options: {
  root: string;
  env?: Record<string, string>;
  seed?: (workRoot: string) => void;
  reuse?: { workRoot: string; dataDir: string; port: number; previewPort: number; mainPort: number };
}): Promise<Fixture> {
  const workRoot = options.reuse?.workRoot ?? path.join(options.root, 'work');
  const dataDir = options.reuse?.dataDir ?? path.join(options.root, 'data');
  if (!options.reuse) {
    createWorkRoot(workRoot);
    options.seed?.(workRoot);
  }
  mkdirSync(dataDir, { recursive: true });
  const port = options.reuse?.port ?? (await freePort());
  const previewPort = options.reuse?.previewPort ?? (await freePort());
  const mainPort = options.reuse?.mainPort ?? (await freePort());
  let current = await launchBackend({ port, previewPort, mainPort, workRoot, dataDir, env: options.env, label: 'm3b-backend' });
  const fixture: Fixture = {
    root: options.root, workRoot, dataDir, base: current.base, previewOrigin: current.previewOrigin,
    backend: current.backend,
    async stop() {
      await current.backend.gracefulClose(30_000).catch(async () => { await current.backend.stop(); });
    },
    async hardKill() {
      await current.backend.stop();
    },
    async restart(env) {
      current = await launchBackend({ port, previewPort, mainPort, workRoot, dataDir, env: options.env ? { ...options.env, ...env } : env, label: 'm3b-backend-restarted' });
      fixture.backend = current.backend;
      fixture.base = current.base;
      fixture.previewOrigin = current.previewOrigin;
    },
  };
  return fixture;
}

export function removeFixture(root: string): void {
  rmSync(path.join(root, 'data'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(path.join(root, 'work'), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/* ------------------------------------------------------- 收尾（带证据，不静默吞错） */

export interface DisposalRecord {
  root: string;
  pid: number;
  startTime: string | null;
  graceful: { code: number | null; forced: boolean; outputTail: string };
  ports: { base: string; preview: string };
  stillListening: string[];
  dirRemoved: boolean;
  problems: string[];
}

function processStartTime(pid: number): string | null {
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `try { (Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch { '' }`], { encoding: 'utf8' });
  const text = (result.stdout ?? '').trim();
  return result.status === 0 && text ? text : null;
}

function portAccepting(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const socket = net.connect({ host: parsed.hostname, port: Number(parsed.port) });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(700);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * 单个夹具收尾：先尝试优雅关闭，失败才显式 fallback 强杀整个进程树；
 * 保留 PID、OS 创建时间、端口终态、目录清理结果，不把失败吞成绿灯。
 */
export async function disposeFixture(fixture: Fixture): Promise<DisposalRecord> {
  const pid = fixture.backend.pid;
  const startTime = processStartTime(pid);
  const ports = { base: fixture.base, preview: fixture.previewOrigin };
  const problems: string[] = [];
  let graceful: DisposalRecord['graceful'];
  try {
    const closed = await fixture.backend.gracefulClose(30_000);
    if (closed.code === 0) {
      graceful = { code: 0, forced: false, outputTail: closed.output.slice(-400) };
    } else {
      await fixture.backend.stop();
      graceful = { code: closed.code, forced: true, outputTail: closed.output.slice(-400) };
      problems.push(`优雅关闭返回 ${closed.code}，已 fallback 强杀进程树`);
    }
  } catch (error) {
    await fixture.backend.stop().catch(() => {});
    graceful = { code: null, forced: true, outputTail: String(error).slice(-400) };
    problems.push(`优雅关闭抛错：${String(error).slice(0, 200)}`);
  }
  const stillListening: string[] = [];
  for (const url of [ports.base, ports.preview]) if (await portAccepting(url)) stillListening.push(url);
  if (stillListening.length) problems.push(`关闭后端口仍可连接：${stillListening.join(', ')}`);
  removeFixture(fixture.root);
  const dirRemoved = !existsSync(fixture.root);
  if (!dirRemoved) problems.push(`临时目录未删干净：${fixture.root}`);
  return { root: fixture.root, pid, startTime, graceful, ports, stillListening, dirRemoved, problems };
}

/** 所有夹具逐个收尾并归档证据；返回失败项供用例显式断言（不静默吞错）。 */
export async function disposeAllFixtures(fixtures: Fixture[], artifactName: string): Promise<{ records: DisposalRecord[]; failures: string[] }> {
  const records: DisposalRecord[] = [];
  const failures: string[] = [];
  while (fixtures.length) {
    const fixture = fixtures.pop()!;
    try {
      const record = await disposeFixture(fixture);
      records.push(record);
      failures.push(...record.problems.map((problem) => `${record.root}: ${problem}`));
    } catch (error) {
      failures.push(`${fixture.root}: 收尾抛错 ${String(error).slice(0, 300)}`);
    }
  }
  writeArtifact(artifactName, { at: new Date().toISOString(), records, failures });
  return { records, failures };
}

/* ------------------------------------------------------------------ 后端 API */

export const http = httpJson;

export const resetMock = () => httpJson(`${MOCK_BASE}/__reset`, { method: 'POST' });
export const setScript = (steps: unknown[], delayMs = 0) =>
  httpJson(`${MOCK_BASE}/__script`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ steps, delayMs }) });
export const mockStats = () => httpJson<{ calls: number }>(`${MOCK_BASE}/__stats`);

export const getVersion = (base: string) => httpJson<{ version: string }>(`${base}/version`);
export const listTasks = (base: string) => httpJson<any[]>(`${base}/tasks`);
export const getTask = (base: string, id: string) => httpJson<any>(`${base}/tasks/${encodeURIComponent(id)}`);
export const listApprovals = (base: string) => httpJson<any[]>(`${base}/approvals`);
export const answerApproval = (base: string, id: string, option: 0 | 1) =>
  httpJson(`${base}/approvals/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ option }) });
export const listCandidatesApi = (base: string) => httpJson<any[]>(`${base}/candidates`);

export async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 60_000, intervalMs = 200): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return Date.now() - started;
    await sleep(intervalMs);
  }
  throw new Error(`等待条件超时（${timeoutMs}ms）`);
}

const selectionStyles = {
  display: 'inline-block', position: 'static', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)',
  fontSize: '16px', fontFamily: 'Arial', fontWeight: '400', lineHeight: '16px', padding: '0px', margin: '0px',
  borderRadius: '0px', width: '10px', height: '10px',
};

export function selection(baseVersion: string, src: string, options: { instances?: number; ancestors?: string[]; text?: string } = {}) {
  return {
    src, baseVersion, cid: 'Node', text: options.text ?? '', bbox: [0, 0, 10, 10], styles: selectionStyles,
    instances: options.instances ?? 1, ancestors: options.ancestors ?? [],
  };
}

/** 等任务进终态；遇到请示按"批准"处理（M3-A 合同，不是本次被测对象）。 */
export async function waitTask(base: string, id: string, timeoutMs = 120_000) {
  let last: any = null;
  await waitFor(async () => {
    last = (await getTask(base, id)).body;
    if (last.status === 'awaiting_approval') {
      for (const card of (await listApprovals(base)).body.filter((item: any) => item.taskId === id && item.status === 'pending')) {
        const answered = await answerApproval(base, card.id, 0);
        if (answered.status !== 200) throw new Error(`自动批准失败：${answered.status} ${answered.text.slice(0, 200)}`);
      }
      return false;
    }
    return ['done', 'failed', 'cancelled'].includes(last.status);
  }, timeoutMs, 250);
  return last;
}

export interface CandidateContext { taskId: string; candidateId: string; task: any; candidate: any }

/** 用 mock 编码上游产出一个真实候选（真实 git 提交 + worktree，不伪造）。 */
export async function createCandidate(
  fixture: Fixture,
  steps: unknown[],
  options: { instruction?: string; src?: string; ancestors?: string[]; timeoutMs?: number } = {},
): Promise<CandidateContext> {
  const base = (await getVersion(fixture.base)).body.version;
  await resetMock();
  await setScript(steps);
  const submitted = await httpJson<any>(`${fixture.base}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instruction: options.instruction ?? '局部文案修改',
      selection: selection(base, options.src ?? 'src/App.tsx:30:11', { ancestors: options.ancestors }),
    }),
  });
  if (submitted.status !== 202) throw new Error(`提交任务失败：${submitted.status} ${submitted.text.slice(0, 400)}`);
  const task = await waitTask(fixture.base, submitted.body.id, options.timeoutMs);
  if (task.status !== 'done' || !task.candidateId) throw new Error(`任务没有产出候选：${JSON.stringify(task).slice(0, 600)}`);
  const candidate = await getCandidate(fixture.base, task.candidateId);
  return { taskId: task.id, candidateId: task.candidateId, task, candidate: candidate.body };
}

export interface RunProbe { polls: number; samples: Array<{ at: number; status: string; outcome?: string; runningIndexes: number[] }> }

/**
 * 发起检查并在轮询中记录状态序列（用于串行/取消/重启用例），返回 run 与采样。
 * 注意：这里只发一次 POST，不重试、不补跑。
 */
export async function startAndWatch(fixture: Fixture, candidateId: string, options: { timeoutMs?: number; intervalMs?: number; rerun?: boolean } = {}) {
  const started = await startChecks(fixture.base, candidateId, options.rerun === undefined ? undefined : { rerun: options.rerun });
  if (started.status !== 202) throw new Error(`发起检查失败：${started.status} ${started.text.slice(0, 400)}`);
  const probe: RunProbe = { polls: 0, samples: [] };
  const run = await waitCheckRun(fixture.base, started.body.id, {
    timeoutMs: options.timeoutMs ?? 240_000,
    intervalMs: options.intervalMs ?? 250,
    onPoll: (current) => {
      probe.polls += 1;
      probe.samples.push({
        at: Date.now(), status: current.status, outcome: current.outcome,
        runningIndexes: current.checks.map((check, index) => (check.status === 'passed' ? -1 : index)).filter((index) => index >= 0),
      });
    },
  });
  return { started: started.body, run, probe };
}

export { getCheckRun, waitCheckRun, startChecks, getCandidate, sleep };
