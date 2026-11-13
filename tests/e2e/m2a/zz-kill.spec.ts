import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { freePort, startChild } from '../m0a/harness';
import {
  BACKEND_LAUNCHER, GUARD_SCRIPT_ARG, M2A_DATA, MOCK_BASE, MOCK_KEY, MOCK_MODEL, REPO_ROOT, SERVER_DIR, WORK_ROOT,
} from './env';
import { http, resetMock, restoreTemplate, setScript, waitFor } from './api';
import { writeArtifactFrom } from './artifact';

/**
 * R6 / D3 进程归属复核（接管后专项）。
 *
 * 旧 `zz-kill.spec.ts` 用一句全局 PowerShell 计数“命令行含 vite.js 且含 preview-cache”的进程；该口径：
 *   1. 执行计数的 `cmd.exe` 与 `powershell.exe` 自己的命令行里就含有这两个字符串 → 计数至少为 2，
 *      “杀掉后应为 0”永远不成立；
 *   2. 实际候选预览 worker 的命令行是 `node preview-worker.ts <...>/vite.js`，缓存目录只在环境变量里，
 *      旧口径根本统计不到正在测试的 worker（piMatch=false）；
 *   3. 没有归属：其他会话/工具的进程也会被算进来。
 *
 * 本轮判据：本轮实际 backend 的进程树 + 创建时间 + 候选预览端口/HTTP 200（只针对自己启动的进程）。
 *   - 杀 backend PID（不带 /T）→ 只检查该 backend 与其 worker 的身份是否消失；
 *   - 杀启动树（/T）→ 检查该 backend 与全部后代身份是否消失；
 *   - 同一 backend 下 3 个待定候选：每个候选都要有自己的 worker/端口/模块内容证据，再杀 backend；
 *   - 预览启动窗口：worker 已存在、尚未绑定端口时杀 backend（测试专用预载注入 4s 启动暂停）；
 *   - decoy 负向对照：旧全局口径被无关进程骗到，归属判据不误失败、也不误杀。
 *
 * 时间证据：记录单调时钟（hrtime）相对“杀命令开始”的偏移，并把杀命令耗时与每次 WMI 采样耗时
 * 分开记录；快照只表示“采样窗口内某刻仍存活/已消失”，不当作精确退出时刻。
 * 旧证据 `isolation-r6.json` 与首轮 attributed 证据保留不覆盖（归档在 d3-run-c0b6a407/）。
 * 强杀只针对本文件自己启动的 backend/worker；不读取/不结束其他会话的进程。
 */

const PREVIEW_BASELINES = ['5377b52', '81558a7'];
const PREVIEW_FILES = ['apps/server/src/work/preview.ts', 'apps/server/src/work/preview-worker.ts'];
const SUCCESS = (oldText: string, newText: string) => [
  [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
  [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: oldText, new: newText } }],
  [{ name: 'finish', args: { summary: `D3 归属验证：${newText}` } }],
];

interface ProcIdentity { pid: number; ppid: number; created: string; summary: string }

const arrayify = <T,>(value: T | T[] | null | undefined): T[] => (value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]);
const summaryOf = (command: string | null | undefined) => (command ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
const nowMs = () => Number(process.hrtime.bigint() / 1_000_000n);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function ps(script: string): string {
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim();
}

/** 旧口径：原 zz-kill 用的同一条命令（经 cmd.exe 执行，会把 cmd/powershell 自己算进来）。 */
function oldStyleGlobalCount(): number {
  const output = execSync("powershell -NoProfile -Command \"(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'vite.js' -and $_.CommandLine -match 'preview-cache' } | Measure-Object).Count\"", { encoding: 'utf8', windowsHide: true });
  return Number(output.trim());
}

/** 结构化版本：只看匹配到的 PID，并报告计数脚本自身是否被匹配（自指污染）。 */
function structuredMatcher(): { selfPid: number; selfMatched: boolean; pids: number[]; nodePids: number[] } {
  const script = [
    '$self=$PID',
    "$m=@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'vite.js' -and $_.CommandLine -match 'preview-cache' })",
    '[pscustomobject]@{ selfPid=[int]$self; selfMatched=[bool](@($m | Where-Object { $_.ProcessId -eq $self }).Count); pids=@($m | ForEach-Object { [int]$_.ProcessId }); nodePids=@($m | Where-Object { $_.Name -eq "node.exe" } | ForEach-Object { [int]$_.ProcessId }) } | ConvertTo-Json -Compress',
  ].join('\n');
  const parsed = JSON.parse(ps(script)) as { selfPid: number; selfMatched: boolean; pids: number | number[]; nodePids: number | number[] };
  return { selfPid: parsed.selfPid, selfMatched: parsed.selfMatched, pids: arrayify(parsed.pids), nodePids: arrayify(parsed.nodePids) };
}

function identityOf(pid: number): ProcIdentity | null {
  const script = [
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    "if($p){ [pscustomobject]@{ pid=[int]$p.ProcessId; ppid=[int]$p.ParentProcessId; created=$p.CreationDate.ToString('o'); cmd=$p.CommandLine } | ConvertTo-Json -Compress } else { '' }",
  ].join('\n');
  const output = ps(script);
  if (!output) return null;
  const parsed = JSON.parse(output) as { pid: number; ppid: number; created: string; cmd: string };
  return { pid: parsed.pid, ppid: parsed.ppid, created: parsed.created, summary: summaryOf(parsed.cmd) };
}

function descendantsOf(rootPid: number): ProcIdentity[] {
  const script = [
    '$all=Get-CimInstance Win32_Process',
    'function Get-Kids([int]$id){ $out=@(); foreach($c in ($all | Where-Object { $_.ParentProcessId -eq $id })) { $out += [pscustomobject]@{ pid=[int]$c.ProcessId; ppid=[int]$c.ParentProcessId; created=$c.CreationDate.ToString(\'o\'); cmd=$c.CommandLine }; $out += Get-Kids ([int]$c.ProcessId) }; return $out }',
    `@(Get-Kids ${rootPid}) | ConvertTo-Json -Compress -Depth 4`,
  ].join('\n');
  const output = ps(script);
  if (!output) return [];
  return arrayify(JSON.parse(output) as Array<{ pid: number; ppid: number; created: string; cmd: string }>)
    .map((entry) => ({ pid: entry.pid, ppid: entry.ppid, created: entry.created, summary: summaryOf(entry.cmd) }));
}

function listeningPorts(pid: number): number[] {
  const output = ps(`@(Get-NetTCPConnection -State Listen -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort) -join ','`);
  return output ? output.split(',').map(Number).filter(Number.isFinite) : [];
}

/** 只把 PID + 创建时间都对上的进程当作还活着，避免 PID 重用误判。 */
function aliveIdentities(targets: Array<{ pid: number; created: string }>): number[] {
  if (targets.length === 0) return [];
  const list = targets.map((target) => `@{pid=${target.pid};created='${target.created.replace(/'/g, "''")}'}`).join(',');
  const script = [
    `$targets=@(${list})`,
    '$alive=@()',
    'foreach($t in $targets){ $p=Get-CimInstance Win32_Process -Filter "ProcessId = $($t.pid)"; if($p -and $p.CreationDate.ToString(\'o\') -eq $t.created){ $alive += [int]$t.pid } }',
    '@($alive) -join \',\'',
  ].join('\n');
  const output = ps(script);
  return output ? output.split(',').map(Number) : [];
}

interface Snapshot {
  label: string; requestedOffsetMs: number;
  sampleStartedOffsetMs: number; sampleFinishedOffsetMs: number; alive: number[];
}

/**
 * 采样判定：每次快照都记录单调时钟偏移和采样本身耗时。第一次快照在杀命令返回后立即做，
 * 之后 1 秒确认一次，再按 250ms 轮询到超时。快照只给“存活/已消失”的区间证据，不是精确退出时刻。
 */
async function waitGone(targets: Array<{ pid: number; created: string }>, timeoutMs: number, killStartedAt: number) {
  const snapshots: Snapshot[] = [];
  const take = (label: string, requestedOffsetMs: number): number[] => {
    const started = nowMs();
    const alive = aliveIdentities(targets);
    const finished = nowMs();
    snapshots.push({
      label, requestedOffsetMs,
      sampleStartedOffsetMs: started - killStartedAt,
      sampleFinishedOffsetMs: finished - killStartedAt,
      alive,
    });
    return alive;
  };
  let alive = take('immediately-after-kill-command', 0);
  const deadline = killStartedAt + timeoutMs;
  while (nowMs() < deadline) {
    const elapsed = nowMs() - killStartedAt;
    const wait = elapsed < 1000 ? 1000 - elapsed : 250;
    await sleep(wait);
    alive = take(elapsed < 1000 ? 'confirm-at-1000ms' : 'poll-250ms', nowMs() - killStartedAt);
    if (alive.length === 0) break;
  }
  const last = snapshots.at(-1)!;
  return {
    gone: alive.length === 0,
    stillAlive: alive,
    snapshots,
    lastSnapshot: last,
    firstSnapshotAlive: snapshots[0].alive,
    // 结论只落在“采样区间”：最后一次存活快照之后、第一次消失快照之前。
    aliveLastSeenAtMs: [...snapshots].reverse().find((snapshot) => snapshot.alive.length > 0)?.sampleFinishedOffsetMs ?? null,
    goneFirstSeenAtMs: snapshots.find((snapshot) => snapshot.alive.length === 0)?.sampleFinishedOffsetMs ?? null,
  };
}

function killPid(pid: number, tree: boolean): number {
  const started = nowMs();
  execFileSync('taskkill', ['/F', ...(tree ? ['/T'] : []), '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
  return nowMs() - started;
}

async function statusOf(url: string): Promise<number> {
  try { return (await http(url)).status; } catch { return 0; }
}

function hashAt(rev: string, file: string): string {
  return createHash('sha256').update(execFileSync('git', ['show', `${rev}:${file}`], { cwd: REPO_ROOT, encoding: 'utf8' })).digest('hex');
}

function previewCodeFacts() {
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const files = PREVIEW_FILES.map((file) => {
    const headHash = hashAt('HEAD', file);
    const baselines = Object.fromEntries(PREVIEW_BASELINES.map((rev) => [rev, hashAt(rev, file)]));
    return { file, headHash, baselines, identicalToAllBaselines: Object.values(baselines).every((hash) => hash === headHash) };
  });
  return { head, baselines: PREVIEW_BASELINES, files, identicalToAllBaselines: files.every((file) => file.identicalToAllBaselines) };
}

interface Fixture {
  base: string; previewOrigin: string; pid: number; created: string;
  stop(): Promise<void>;
}

async function startFixture(root: string, label: string, options: { workRoot?: string } = {}): Promise<Fixture> {
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  mkdirSync(path.join(root, 'scene'), { recursive: true });
  const workRoot = options.workRoot ?? WORK_ROOT;
  const port = await freePort();
  const previewPort = await freePort();
  const child = await startChild({
    command: process.execPath, args: [BACKEND_LAUNCHER], cwd: SERVER_DIR,
    env: {
      PORT: String(port), PREVIEW_ORIGIN_PORT: String(previewPort), MAIN_PREVIEW_PORT: '5174',
      STUDIO_ORIGIN: 'http://127.0.0.1:5173',
      WORK_ROOT: workRoot, WORK_DATA_DIR: path.join(root, 'work-data'),
      ASSETS_DIR: path.join(root, 'assets'), SCENE_HISTORY_DIR: path.join(root, 'scene'),
      LUX3D_BASE: 'http://127.0.0.1:4019', LUX3D_API_KEY: 'unused',
      CODING_AGENT_BASE_URL: MOCK_BASE, CODING_AGENT_API_KEY: MOCK_KEY, CODING_AGENT_MODEL: MOCK_MODEL,
      PI_NET_GUARD_LOG: path.join(root, `guard-${label}.log`), NODE_OPTIONS: `--require ${GUARD_SCRIPT_ARG}`,
    },
    readyUrl: `http://127.0.0.1:${port}/health`, label,
  });
  const created = identityOf(child.pid)?.created ?? '';
  return { base: `http://127.0.0.1:${port}`, previewOrigin: `http://127.0.0.1:${previewPort}`, pid: child.pid, created, stop: child.stop };
}

function copyTree(from: string, to: string) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else copyFileSync(source, target);
  }
}

/**
 * 测试专用作品副本：真实模板的 src/根文件 + 一个“延迟启动”的 vite 替身。
 * 替身在 CommonJS 里用 setTimeout 异步等待 delayMs 后才 import 真正的 Vite，因此 preview-worker.ts
 * 已经注册了 IPC disconnect 监听、进程已经存在，但端口尚未绑定。生产 preview 代码不改；
 * 该副本只用于“预览启动窗口”场景。
 */
function buildDelayedWorkRoot(root: string, delayMs: number): string {
  const workRoot = path.join(root, 'work');
  copyTree(path.join(WORK_ROOT, 'src'), path.join(workRoot, 'src'));
  for (const file of ['index.html', 'package.json', 'tsconfig.json', 'vite.config.ts']) copyFileSync(path.join(WORK_ROOT, file), path.join(workRoot, file));
  mkdirSync(path.join(workRoot, 'public'), { recursive: true });

  const sourceModules = path.join(WORK_ROOT, 'node_modules');
  const targetModules = path.join(workRoot, 'node_modules');
  mkdirSync(targetModules, { recursive: true });
  const realVite = realpathSync(path.join(sourceModules, 'vite', 'bin', 'vite.js'));
  for (const entry of readdirSync(sourceModules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const source = path.join(sourceModules, entry.name);
    const target = path.join(targetModules, entry.name);
    if (entry.name === 'vite') {
      mkdirSync(path.join(target, 'bin'), { recursive: true });
      writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name: 'vite', version: '0.0.0-d3-fixture', type: 'commonjs' }));
      writeFileSync(path.join(target, 'bin', 'vite.js'), [
        "'use strict';",
        '// D3 test fixture only: keep the real preview worker alive without binding a port, then import real Vite.',
        `setTimeout(() => { import(${JSON.stringify(pathToFileURL(realVite).href)}).catch(() => {}); }, ${delayMs});`,
        '',
      ].join('\n'));
      continue;
    }
    if (entry.name.startsWith('@')) {
      mkdirSync(target, { recursive: true });
      for (const child of readdirSync(source)) symlinkSync(realpathSync(path.join(source, child)), path.join(target, child), 'junction');
      continue;
    }
    symlinkSync(realpathSync(source), target, 'junction');
  }
  return workRoot;
}

async function submitTask(base: string, instruction: string) {
  const submitted = await http(`${base}/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction }),
  });
  expect(submitted.status, submitted.text).toBe(202);
  return submitted.body.id as string;
}

async function waitTask(base: string, id: string) {
  let task: any;
  await waitFor(async () => {
    task = (await http(`${base}/tasks/${id}`)).body;
    return ['done', 'failed', 'cancelled'].includes(task.status);
  }, 180_000, 300);
  return task;
}

async function readyCandidate(base: string, instruction: string) {
  await resetMock();
  await setScript(SUCCESS('立即购买', '马上购买'));
  const id = await submitTask(base, instruction);
  const task = await waitTask(base, id);
  expect(task.status, JSON.stringify(task.error)).toBe('done');
  const candidate = (await http(`${base}/candidates/${task.candidateId}`)).body as { id: string; previewUrl: string };
  return { id: candidate.id, previewUrl: candidate.previewUrl };
}

function workersOf(backendPid: number): ProcIdentity[] {
  return descendantsOf(backendPid).filter((entry) => entry.summary.includes('preview-worker'));
}

/** 候选真正 ready：preview-origin 200，且 worker 自己的监听端口也 200。 */
async function previewProof(fixture: Fixture, candidate: { previewUrl: string }, worker: ProcIdentity) {
  const originStatus = await statusOf(`${fixture.previewOrigin}${candidate.previewUrl}`);
  const workerPorts = listeningPorts(worker.pid);
  const directStatuses: Array<{ port: number; status: number }> = [];
  for (const port of workerPorts) directStatuses.push({ port, status: await statusOf(`http://127.0.0.1:${port}${candidate.previewUrl}`) });
  return { originStatus, workerPorts, directStatuses };
}

function killRecord(method: string, commandDurationMs: number, killStartedAt: number, wallStartedAt: number, gone: Awaited<ReturnType<typeof waitGone>>) {
  return {
    method,
    killStartedAtWall: new Date(wallStartedAt).toISOString(),
    killCommandDurationMs: commandDurationMs,
    snapshots: gone.snapshots,
    gone: gone.gone,
    stillAlive: gone.stillAlive,
    firstSnapshotAlive: gone.firstSnapshotAlive,
    aliveLastSeenAtMs: gone.aliveLastSeenAtMs,
    goneFirstSeenAtMs: gone.goneFirstSeenAtMs,
    timingNote: '快照只说明采样时仍存活/已消失；真实退出时刻位于最后一次存活快照与首次消失快照之间，不把标签当精确退出时间',
  };
}

test.describe('R6/D3 进程归属复核', () => {
  test.describe.configure({ mode: 'serial' });
  const stored: {
    decoy?: { pid: number; created: string; summary: string };
    pidKill?: Record<string, any>;
    treeKill?: Record<string, any>;
    multiCandidate?: Record<string, any>;
    startupWindow?: Record<string, any>;
    negativeControl?: Record<string, unknown>;
  } = {};
  let decoyProcess: ChildProcess | null = null;

  test.beforeAll(async () => {
    const restored = restoreTemplate();
    expect(restored.clean, restored.status).toBe(true);
    decoyProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'vite.js', 'preview-cache-d3-decoy'], { stdio: 'ignore', windowsHide: true });
    const pid = decoyProcess.pid!;
    await waitFor(() => identityOf(pid) !== null, 10_000, 200);
    const identity = identityOf(pid);
    expect(identity, 'decoy 没有起来').toBeTruthy();
    stored.decoy = { pid, created: identity!.created, summary: identity!.summary };
  });

  test.afterAll(async () => {
    // 只结束本文件自己启动的 decoy（按 PID + 创建时间确认身份），不碰其他会话的进程。
    let cleanup: Record<string, unknown> = { attempted: false };
    if (decoyProcess && stored.decoy) {
      const before = identityOf(stored.decoy.pid);
      const stillOurs = before !== null && before.created === stored.decoy.created;
      cleanup = { attempted: true, matchedIdentity: stillOurs, pid: stored.decoy.pid };
      if (stillOurs) {
        const killStartedAt = nowMs();
        const commandDurationMs = killPid(stored.decoy.pid, true);
        const gone = await waitGone([{ pid: stored.decoy.pid, created: stored.decoy.created }], 10_000, killStartedAt);
        cleanup = { ...cleanup, killCommandDurationMs: commandDurationMs, gone: gone.gone, snapshots: gone.snapshots };
      }
    }
    writeArtifactFrom('isolation-r6-attributed-negative-control.json', { ...stored, decoyCleanup: cleanup });
    const restored = restoreTemplate();
    expect(restored.clean, restored.status).toBe(true);
  });

  test('D3 归属：杀 backend PID（不带 /T），只核对该 backend 的 worker 身份', async () => {
    const environment = previewCodeFacts();
    expect(environment.identicalToAllBaselines, '生产预览代码与旧基线不一致，需要重新判断').toBe(true);
    const root = path.join(M2A_DATA, `d3-attributed-pid-${Date.now()}`);
    const fixture = await startFixture(root, 'd3-pid');
    expect(fixture.created, '没有取到 backend 的创建时间，归属判据不成立').toBeTruthy();
    try {
      const candidate = await readyCandidate(fixture.base, 'D3 归属验证：把首屏按钮改成“马上购买”');
      const worker = workersOf(fixture.pid)[0];
      expect(worker, '没有找到本轮 backend 的 preview-worker').toBeTruthy();
      expect(worker!.ppid).toBe(fixture.pid);
      expect(worker!.created, '没有取到 worker 的创建时间').toBeTruthy();
      const preview = await previewProof(fixture, candidate, worker!);
      expect(preview.originStatus, '候选预览没有真正 ready').toBe(200);
      expect(preview.workerPorts.length, '没有找到 worker 的监听端口').toBeGreaterThan(0);
      expect(preview.directStatuses.some((entry) => entry.status === 200), 'worker 端口没有返回候选页面').toBe(true);

      const matcher = structuredMatcher();
      const oldStyleCount = oldStyleGlobalCount();
      const decoy = identityOf(stored.decoy!.pid);
      expect(matcher.pids.includes(worker!.pid), '旧全局口径不应能统计到实际 worker').toBe(false);
      expect(matcher.nodePids.includes(stored.decoy!.pid), '旧全局口径应被无关 decoy 骗到').toBe(true);
      expect(matcher.nodePids.includes(worker!.pid), '旧全局口径把 worker 也算进去了').toBe(false);
      expect(oldStyleCount, '旧口径至少把执行计数的 cmd/powershell 自己算进来').toBeGreaterThanOrEqual(2);

      const targets = [{ pid: fixture.pid, created: fixture.created }, { pid: worker!.pid, created: worker!.created }];
      const killStartedAt = nowMs();
      const wallStartedAt = Date.now();
      const commandDurationMs = killPid(fixture.pid, false);
      const gone = await waitGone(targets, 30_000, killStartedAt);
      const previewAfter = await statusOf(`${fixture.previewOrigin}${candidate.previewUrl}`);
      const decoyAfter = identityOf(stored.decoy!.pid);
      const leftoverIdentities = aliveIdentities(targets);
      const artifact = {
        environment,
        kind: 'backend-pid-only',
        backend: { pid: fixture.pid, created: fixture.created, base: fixture.base, previewOrigin: fixture.previewOrigin },
        candidate,
        preview,
        worker,
        oldMetric: {
          oldStyleCount, matcher,
          nodePidsOtherThanDecoy: matcher.nodePids.filter((pid) => pid !== stored.decoy!.pid),
          note: '实际 worker 的命令行含 preview-worker.ts 与 vite.js，缓存目录只在环境变量里，旧口径看不见它',
        },
        decoy: { ...stored.decoy, alive: decoy !== null && decoy.created === stored.decoy!.created },
        kill: {
          ...killRecord(`taskkill /F /PID ${fixture.pid}（无 /T）`, commandDurationMs, killStartedAt, wallStartedAt, gone),
          previewStatusAfter: previewAfter, leftoverIdentities,
          decoyAliveAfter: decoyAfter !== null && decoyAfter.created === stored.decoy!.created,
          matcherAfter: structuredMatcher(),
        },
      };
      stored.pidKill = artifact;
      writeArtifactFrom('isolation-r6-attributed-pid-kill.json', artifact);

      expect(gone.gone, `杀 backend PID 后仍有本轮身份存活：${JSON.stringify(gone.stillAlive)}`).toBe(true);
      expect(previewAfter, 'backend 已死但候选预览端口仍在返回 200').not.toBe(200);
      expect(leftoverIdentities, '还残留本轮 backend 的进程身份').toEqual([]);
      expect(artifact.kill.decoyAliveAfter, '无关 decoy 被误杀').toBe(true);
    } finally {
      await fixture.stop().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('D3 归属：杀实际启动树（/T），核对整树后代身份回收', async () => {
    const environment = previewCodeFacts();
    const root = path.join(M2A_DATA, `d3-attributed-tree-${Date.now()}`);
    const fixture = await startFixture(root, 'd3-tree');
    expect(fixture.created, '没有取到 backend 的创建时间，归属判据不成立').toBeTruthy();
    try {
      const candidate = await readyCandidate(fixture.base, 'D3 归属验证：树杀前的候选');
      const worker = workersOf(fixture.pid)[0];
      expect(worker, '没有找到本轮 backend 的 preview-worker').toBeTruthy();
      expect(worker!.ppid).toBe(fixture.pid);
      expect(worker!.created, '没有取到 worker 的创建时间').toBeTruthy();
      const preview = await previewProof(fixture, candidate, worker!);
      expect(preview.originStatus).toBe(200);
      expect(preview.directStatuses.some((entry) => entry.status === 200)).toBe(true);
      const tree = descendantsOf(fixture.pid);
      expect(tree.some((entry) => entry.pid === worker!.pid), 'worker 不在 backend 的进程树里').toBe(true);

      const matcher = structuredMatcher();
      const oldStyleCount = oldStyleGlobalCount();
      expect(matcher.pids.includes(worker!.pid), '旧全局口径不应能统计到实际 worker').toBe(false);

      const targets = [{ pid: fixture.pid, created: fixture.created }, ...tree.map((entry) => ({ pid: entry.pid, created: entry.created }))];
      const killStartedAt = nowMs();
      const wallStartedAt = Date.now();
      const commandDurationMs = killPid(fixture.pid, true);
      const gone = await waitGone(targets, 30_000, killStartedAt);
      const previewAfter = await statusOf(`${fixture.previewOrigin}${candidate.previewUrl}`);
      const decoyAfter = identityOf(stored.decoy!.pid);
      const leftovers = aliveIdentities(targets);
      const artifact = {
        environment,
        kind: 'launcher-tree',
        backend: { pid: fixture.pid, created: fixture.created, base: fixture.base, previewOrigin: fixture.previewOrigin },
        candidate,
        preview,
        worker,
        tree,
        oldMetric: { oldStyleCount, matcher, nodePidsOtherThanDecoy: matcher.nodePids.filter((pid) => pid !== stored.decoy!.pid) },
        decoy: { ...stored.decoy, alive: decoyAfter !== null && decoyAfter.created === stored.decoy!.created },
        kill: {
          ...killRecord(`taskkill /T /F /PID ${fixture.pid}`, commandDurationMs, killStartedAt, wallStartedAt, gone),
          previewStatusAfter: previewAfter, leftoversAfter: leftovers,
          decoyAliveAfter: decoyAfter !== null && decoyAfter.created === stored.decoy!.created,
        },
      };
      stored.treeKill = artifact;
      writeArtifactFrom('isolation-r6-attributed-tree-kill.json', artifact);

      expect(gone.gone, `杀启动树后仍有本轮身份存活：${JSON.stringify(gone.stillAlive)}`).toBe(true);
      expect(leftovers, '整树回收后仍有本轮后代存活').toEqual([]);
      expect(previewAfter).not.toBe(200);
      expect(artifact.kill.decoyAliveAfter, '无关 decoy 被误杀').toBe(true);
    } finally {
      await fixture.stop().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('D3 归属：同一 backend 下 3 个待定候选都有独立 worker/端口，杀 backend PID 后全部回收', async () => {
    const environment = previewCodeFacts();
    const root = path.join(M2A_DATA, `d3-attributed-multi-${Date.now()}`);
    const fixture = await startFixture(root, 'd3-multi');
    expect(fixture.created).toBeTruthy();
    try {
      const specs = [
        { instruction: '多候选 A：改成甲', text: '马上购买甲', marker: '马上购买甲' },
        { instruction: '多候选 B：改成乙', text: '马上购买乙', marker: '马上购买乙' },
        { instruction: '多候选 C：改成丙', text: '马上购买丙', marker: '马上购买丙' },
      ];
      const candidates: Array<{ id: string; previewUrl: string; marker: string }> = [];
      for (const spec of specs) {
        await resetMock();
        await setScript(SUCCESS('立即购买', spec.text));
        const taskId = await submitTask(fixture.base, spec.instruction);
        const task = await waitTask(fixture.base, taskId);
        expect(task.status, JSON.stringify(task.error)).toBe('done');
        const candidate = (await http(`${fixture.base}/candidates/${task.candidateId}`)).body as { id: string; previewUrl: string };
        candidates.push({ id: candidate.id, previewUrl: candidate.previewUrl, marker: spec.marker });
      }
      const pending = ((await http(`${fixture.base}/candidates`)).body as Array<{ decision: string }>).filter((item) => item.decision === 'pending');
      expect(pending.length, '待定候选不是 3 个').toBe(3);

      const workers = workersOf(fixture.pid);
      expect(workers.length, `没有找到 3 个候选 worker：${JSON.stringify(workers.map((w) => w.pid))}`).toBe(3);
      const workerDetails: Array<{ worker: ProcIdentity; ports: number[] }> = [];
      for (const worker of workers) {
        expect(worker.created).toBeTruthy();
        expect(worker.ppid).toBe(fixture.pid);
        workerDetails.push({ worker, ports: listeningPorts(worker.pid) });
      }
      for (const detail of workerDetails) expect(detail.ports.length, `worker ${detail.worker.pid} 没有监听端口`).toBeGreaterThan(0);

      // 用候选自己的模块内容把 worker/端口映射回候选，避免把 200/404 的兜底页当证据。
      const matrix: Array<{ workerPid: number; port: number; candidateId: string; status: number; textHasMarker: boolean }> = [];
      for (const detail of workerDetails) {
        for (const port of detail.ports) {
          for (const candidate of candidates) {
            const response = await http(`http://127.0.0.1:${port}${candidate.previewUrl}src/App.tsx`);
            matrix.push({
              workerPid: detail.worker.pid, port, candidateId: candidate.id,
              status: response.status,
              textHasMarker: response.status === 200 && response.text.includes(candidate.marker),
            });
          }
        }
      }
      const mapping = candidates.map((candidate) => {
        const matches = matrix.filter((entry) => entry.candidateId === candidate.id && entry.textHasMarker);
        expect(matches.length, `候选 ${candidate.id} 没有唯一的 worker/端口证据：${JSON.stringify(matches)}`).toBe(1);
        return { candidateId: candidate.id, marker: candidate.marker, workerPid: matches[0].workerPid, port: matches[0].port };
      });
      expect(new Set(mapping.map((entry) => entry.workerPid)).size, '候选映射到了重复 worker').toBe(3);
      expect(new Set(mapping.map((entry) => entry.port)).size, '候选映射到了重复端口').toBe(3);

      const originBefore = [];
      for (const candidate of candidates) originBefore.push({ candidateId: candidate.id, status: await statusOf(`${fixture.previewOrigin}${candidate.previewUrl}`) });
      expect(originBefore.every((entry) => entry.status === 200), `preview-origin 没有全部 ready：${JSON.stringify(originBefore)}`).toBe(true);

      const matcher = structuredMatcher();
      for (const worker of workers) expect(matcher.pids.includes(worker.pid), `旧口径统计到了 worker ${worker.pid}`).toBe(false);

      const targets = [{ pid: fixture.pid, created: fixture.created }, ...workers.map((worker) => ({ pid: worker.pid, created: worker.created }))];
      const killStartedAt = nowMs();
      const wallStartedAt = Date.now();
      const commandDurationMs = killPid(fixture.pid, false);
      const gone = await waitGone(targets, 30_000, killStartedAt);
      const originAfter = [];
      for (const candidate of candidates) originAfter.push({ candidateId: candidate.id, status: await statusOf(`${fixture.previewOrigin}${candidate.previewUrl}`) });
      const portsAfter = [];
      for (const entry of mapping) portsAfter.push({ candidateId: entry.candidateId, port: entry.port, status: await statusOf(`http://127.0.0.1:${entry.port}${candidates.find((c) => c.id === entry.candidateId)!.previewUrl}`) });
      const decoyAfter = identityOf(stored.decoy!.pid);
      const leftovers = aliveIdentities(targets);
      const artifact = {
        environment,
        kind: 'multi-candidate-backend-pid-only',
        backend: { pid: fixture.pid, created: fixture.created, base: fixture.base, previewOrigin: fixture.previewOrigin },
        candidates,
        workers,
        workerDetails,
        mappingMatrix: matrix,
        mapping,
        originBefore,
        oldMetric: { matcher, oldStyleCount: oldStyleGlobalCount() },
        decoy: { ...stored.decoy, alive: decoyAfter !== null && decoyAfter.created === stored.decoy!.created },
        kill: {
          ...killRecord(`taskkill /F /PID ${fixture.pid}（无 /T）`, commandDurationMs, killStartedAt, wallStartedAt, gone),
          originAfter, portsAfter, leftoversAfter: leftovers,
          decoyAliveAfter: decoyAfter !== null && decoyAfter.created === stored.decoy!.created,
        },
      };
      stored.multiCandidate = artifact;
      writeArtifactFrom('isolation-r6-attributed-multi-candidate-pid-kill.json', artifact);

      expect(gone.gone, `3 候选场景杀 backend 后仍有本轮身份存活：${JSON.stringify(gone.stillAlive)}`).toBe(true);
      expect(leftovers, '3 候选场景仍有本轮后代存活').toEqual([]);
      expect(originAfter.every((entry) => entry.status !== 200), `backend 已死但候选预览仍返回 200：${JSON.stringify(originAfter)}`).toBe(true);
      expect(portsAfter.every((entry) => entry.status !== 200), `worker 端口仍返回 200：${JSON.stringify(portsAfter)}`).toBe(true);
      expect(artifact.kill.decoyAliveAfter, '无关 decoy 被误杀').toBe(true);
    } finally {
      await fixture.stop().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('D3 归属：候选 worker 已产生但预览尚未 ready 时杀 backend PID，worker 仍应回收', async () => {
    const environment = previewCodeFacts();
    const root = path.join(M2A_DATA, `d3-attributed-startup-${Date.now()}`);
    const fixtureWorkRoot = buildDelayedWorkRoot(root, 4000);
    const fixture = await startFixture(root, 'd3-startup', { workRoot: fixtureWorkRoot });
    expect(fixture.created).toBeTruthy();
    try {
      await resetMock();
      await setScript(SUCCESS('立即购买', '马上购买'));
      const submittedAt = nowMs();
      const taskId = await submitTask(fixture.base, '启动窗口验证：worker 已产生但预览未 ready 时杀 backend');

      // 正面对照：必须真的看到 worker 进程存在（PID/PPID/创建时间），而不是“还没创建 worker”。
      let window: { worker: ProcIdentity; ports: number[]; originStatus: number; taskStatus: string; observations: Array<Record<string, unknown>> } | null = null;
      const observations: Array<Record<string, unknown>> = [];
      const deadline = nowMs() + 30_000;
      while (nowMs() < deadline) {
        const worker = workersOf(fixture.pid)[0];
        if (worker) {
          const ports = listeningPorts(worker.pid);
          const served: Array<{ port: number; status: number }> = [];
          for (const port of ports) served.push({ port, status: await statusOf(`http://127.0.0.1:${port}/preview/c/${taskId}/`) });
          const originStatus = await statusOf(`${fixture.previewOrigin}/preview/c/${taskId}/`);
          const taskStatus = (await http(`${fixture.base}/tasks/${taskId}`)).body.status as string;
          observations.push({
            atOffsetMs: nowMs() - submittedAt,
            worker: { pid: worker.pid, ppid: worker.ppid, created: worker.created, summary: worker.summary },
            ports, served, originStatus, taskStatus,
          });
          if (originStatus !== 200) {
            window = { worker, ports, originStatus, taskStatus, observations };
            break;
          }
        }
        await sleep(100);
      }
      expect(window, `没有在超时前到达“worker 存在但预览未 ready”的窗口：${JSON.stringify(observations.slice(-3))}`).toBeTruthy();
      expect(window!.worker.created, '窗口内 worker 没有创建时间，身份证据不足').toBeTruthy();
      expect(window!.worker.ppid).toBe(fixture.pid);
      expect(window!.originStatus, '窗口内预览已经是 200，不能证明是启动中途').not.toBe(200);
      expect(window!.observations.length).toBeGreaterThan(0);

      const targets = [{ pid: fixture.pid, created: fixture.created }, { pid: window!.worker.pid, created: window!.worker.created }];
      const killStartedAt = nowMs();
      const wallStartedAt = Date.now();
      const commandDurationMs = killPid(fixture.pid, false);
      const gone = await waitGone(targets, 30_000, killStartedAt);
      const originAfter = await statusOf(`${fixture.previewOrigin}/preview/c/${taskId}/`);
      const portStatusAfter: Array<{ port: number; status: number }> = [];
      for (const port of window!.ports) portStatusAfter.push({ port, status: await statusOf(`http://127.0.0.1:${port}/preview/c/${taskId}/`) });
      const decoyAfter = identityOf(stored.decoy!.pid);
      const leftovers = aliveIdentities(targets);
      const artifact = {
        environment,
        kind: 'preview-startup-window-backend-pid-only',
        backend: { pid: fixture.pid, created: fixture.created, base: fixture.base, previewOrigin: fixture.previewOrigin },
        fixture: {
          workRoot: fixtureWorkRoot,
          note: '临时作品副本的 node_modules/vite 是测试替身：CommonJS 异步等待 4s 后才 import 真实 Vite；生产 preview 代码未改',
        },
        task: { id: taskId, statusAtWindow: window!.taskStatus },
        window: {
          worker: window!.worker, ports: window!.ports, originStatus: window!.originStatus,
          observations,
          proof: 'worker 进程存在且 PPID=backend，但 preview-origin 在该阶段不是 200',
        },
        oldMetric: { oldStyleCount: oldStyleGlobalCount(), matcher: structuredMatcher() },
        decoy: { ...stored.decoy, alive: decoyAfter !== null && decoyAfter.created === stored.decoy!.created },
        kill: {
          ...killRecord(`taskkill /F /PID ${fixture.pid}（无 /T，窗口内）`, commandDurationMs, killStartedAt, wallStartedAt, gone),
          originStatusAfter: originAfter, portStatusAfter, leftoversAfter: leftovers,
          decoyAliveAfter: decoyAfter !== null && decoyAfter.created === stored.decoy!.created,
        },
      };
      stored.startupWindow = artifact;
      writeArtifactFrom('isolation-r6-attributed-startup-window-pid-kill.json', artifact);

      expect(gone.gone, `启动窗口杀 backend 后仍有本轮身份存活：${JSON.stringify(gone.stillAlive)}`).toBe(true);
      expect(leftovers, '启动窗口场景仍有本轮后代存活').toEqual([]);
      expect(originAfter, 'backend 已死但启动窗口的预览仍返回 200').not.toBe(200);
      expect(portStatusAfter.every((entry) => entry.status !== 200), `启动窗口 worker 端口仍返回 200：${JSON.stringify(portStatusAfter)}`).toBe(true);
      expect(artifact.kill.decoyAliveAfter, '无关 decoy 被误杀').toBe(true);
    } finally {
      await fixture.stop().catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('负向对照：旧全局口径被无关进程骗到，归属判据不误失败也不误杀', async () => {
    const targets: Array<{ pid: number; created: string }> = [];
    for (const key of ['pidKill', 'treeKill', 'multiCandidate', 'startupWindow'] as const) {
      const record = stored[key];
      if (!record) continue;
      targets.push({ pid: record.backend.pid, created: record.backend.created });
      if (record.worker) targets.push({ pid: record.worker.pid, created: record.worker.created });
      if (Array.isArray(record.workers)) for (const worker of record.workers) targets.push({ pid: worker.pid, created: worker.created });
      if (Array.isArray(record.tree)) for (const entry of record.tree) targets.push({ pid: entry.pid, created: entry.created });
      if (record.window?.worker) targets.push({ pid: record.window.worker.pid, created: record.window.worker.created });
    }

    const matcher = structuredMatcher();
    const oldStyleCount = oldStyleGlobalCount();
    const decoy = identityOf(stored.decoy!.pid);
    const attributedLeftovers = targets.filter((target) => matcher.pids.includes(target.pid));
    const facts = {
      environment: previewCodeFacts(),
      oldStyleCount,
      matcher,
      selfMatch: { selfPid: matcher.selfPid, selfMatched: matcher.selfMatched, note: '旧口径的计数进程自身命令行含两个关键字' },
      decoy: { ...stored.decoy, alive: decoy !== null && decoy.created === stored.decoy!.created, inOldMatcher: matcher.pids.includes(stored.decoy!.pid) },
      attribution: {
        oldCriterionWouldPass: oldStyleCount === 0,
        oldCriterionWouldFailDespiteCleanup: oldStyleCount > 0,
        attributedLeftovers,
        targetCount: targets.length,
        note: '本轮判据只检查 targets（自己启动的 backend/worker/后代）的 PID+创建时间；无关 decoy 与计数进程不参与',
      },
    };
    writeArtifactFrom('isolation-r6-attributed-negative-control.json', { ...stored, negativeControl: facts });
    stored.negativeControl = facts;

    expect(decoy, 'decoy 不在运行，负向对照不成立').toBeTruthy();
    expect(facts.decoy.alive).toBe(true);
    expect(facts.decoy.inOldMatcher, '旧全局口径没有把无关 decoy 算进来').toBe(true);
    expect(matcher.selfMatched, '旧口径的计数进程没有自指匹配').toBe(true);
    expect(oldStyleCount, '旧口径至少包含 decoy + 计数进程').toBeGreaterThanOrEqual(3);
    expect(facts.attribution.oldCriterionWouldFailDespiteCleanup, '旧口径在本轮会误判为失败').toBe(true);
    expect(attributedLeftovers, '归属判据把无关进程/已结束目标当成残留').toEqual([]);
  });
});
