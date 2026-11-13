import { execFileSync, execSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
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
 *      所以旧口径根本统计不到正在测试的 worker（piMatch=false）；
 *   3. 没有归属：其他会话/工具的进程也会被算进来。
 *
 * 本轮判据：本轮实际 backend 的进程树 + 创建时间 + 候选预览端口/HTTP 200。
 *   - 先证明候选 preview-origin 与 worker 端口都返回 200，并记录 worker 的 PID/PPID/创建时间/摘要；
 *   - 杀 backend PID（不带 /T）→ 只检查该 backend 与其 worker 的身份是否消失；
 *   - 杀启动树（/T）→ 检查该 backend 与全部后代身份是否消失；
 *   - 用可控 decoy 证明旧全局口径会被无关进程骗到，而归属判据不会误失败、也不误杀 decoy。
 *
 * 旧证据 `isolation-r6.json` 保留不覆盖；本文件只写 `isolation-r6-attributed-*.json`。
 * 强杀只针对本文件自己启动的 backend/worker；不读取/不结束其他会话的进程。
 */

const PREVIEW_BASELINES = ['5377b52', '81558a7'];
const PREVIEW_FILES = ['apps/server/src/work/preview.ts', 'apps/server/src/work/preview-worker.ts'];
const SUCCESS = [
  [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
  [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
  [{ name: 'finish', args: { summary: 'D3 归属验证：候选已就绪' } }],
];

interface ProcIdentity { pid: number; ppid: number; created: string; summary: string }

const arrayify = <T,>(value: T | T[] | null | undefined): T[] => (value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]);
const summaryOf = (command: string | null | undefined) => (command ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);

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

async function waitGone(targets: Array<{ pid: number; created: string }>, timeoutMs = 30_000) {
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const at1s = aliveIdentities(targets);
  let alive = at1s;
  while (Date.now() - started < timeoutMs && alive.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    alive = aliveIdentities(targets);
  }
  return { gone: alive.length === 0, elapsedMs: Date.now() - started, at1s, stillAlive: alive };
}

function killPid(pid: number, tree: boolean): void {
  execFileSync('taskkill', ['/F', ...(tree ? ['/T'] : []), '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
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

async function startFixture(root: string, label: string): Promise<Fixture> {
  mkdirSync(path.join(root, 'assets'), { recursive: true });
  mkdirSync(path.join(root, 'scene'), { recursive: true });
  const port = await freePort();
  const previewPort = await freePort();
  const child = await startChild({
    command: process.execPath, args: [BACKEND_LAUNCHER], cwd: SERVER_DIR,
    env: {
      PORT: String(port), PREVIEW_ORIGIN_PORT: String(previewPort), MAIN_PREVIEW_PORT: '5174',
      STUDIO_ORIGIN: 'http://127.0.0.1:5173',
      WORK_ROOT, WORK_DATA_DIR: path.join(root, 'work-data'),
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

async function readyCandidate(base: string) {
  await resetMock();
  await setScript(SUCCESS);
  const submitted = await http(`${base}/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruction: 'D3 归属验证：把首屏按钮改成“马上购买”' }),
  });
  expect(submitted.status, submitted.text).toBe(202);
  let task: any;
  await waitFor(async () => {
    task = (await http(`${base}/tasks/${submitted.body.id}`)).body;
    return ['done', 'failed', 'cancelled'].includes(task.status);
  }, 180_000, 300);
  expect(task.status, JSON.stringify(task.error)).toBe('done');
  const candidate = (await http(`${base}/candidates/${task.candidateId}`)).body as { id: string; previewUrl: string };
  return { id: candidate.id, previewUrl: candidate.previewUrl };
}

function workerOf(backendPid: number): ProcIdentity | null {
  return descendantsOf(backendPid).find((entry) => entry.summary.includes('preview-worker')) ?? null;
}

/** 候选真正 ready：preview-origin 200，且 worker 自己的监听端口也 200。 */
async function previewProof(fixture: Fixture, candidate: { previewUrl: string }, worker: ProcIdentity) {
  const originStatus = await statusOf(`${fixture.previewOrigin}${candidate.previewUrl}`);
  const workerPorts = listeningPorts(worker.pid);
  const directStatuses: Array<{ port: number; status: number }> = [];
  for (const port of workerPorts) directStatuses.push({ port, status: await statusOf(`http://127.0.0.1:${port}${candidate.previewUrl}`) });
  return { originStatus, workerPorts, directStatuses };
}

test.describe('R6/D3 进程归属复核', () => {
  test.describe.configure({ mode: 'serial' });
  const stored: {
    decoy?: { pid: number; created: string; summary: string };
    pidKill?: Record<string, any>;
    treeKill?: Record<string, any>;
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
        killPid(stored.decoy.pid, true);
        const gone = await waitGone([{ pid: stored.decoy.pid, created: stored.decoy.created }], 10_000);
        cleanup = { ...cleanup, gone: gone.gone, elapsedMs: gone.elapsedMs };
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
      const candidate = await readyCandidate(fixture.base);
      const worker = workerOf(fixture.pid);
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
      const killStarted = Date.now();
      killPid(fixture.pid, false);
      const gone = await waitGone(targets, 30_000);
      const previewAfter = await statusOf(`${fixture.previewOrigin}${candidate.previewUrl}`);
      const decoyAfter = identityOf(stored.decoy!.pid);
      const matcherAfter = structuredMatcher();
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
          method: `taskkill /F /PID ${fixture.pid}（无 /T）`, startedAt: killStarted,
          elapsedMs: gone.elapsedMs, at1s: gone.at1s, gone: gone.gone, stillAlive: gone.stillAlive,
          previewStatusAfter: previewAfter, leftoverIdentities,
          decoyAliveAfter: decoyAfter !== null && decoyAfter.created === stored.decoy!.created,
          matcherAfter,
        },
      };
      stored.pidKill = artifact;
      writeArtifactFrom('isolation-r6-attributed-pid-kill.json', artifact);

      expect(gone.gone, `杀 backend PID 后仍有本轮身份存活：${JSON.stringify(gone.stillAlive)}`).toBe(true);
      expect(previewAfter, 'backend 已死但候选预览端口仍在返回 200').not.toBe(200);
      expect(leftoverIdentities, '还残留本 backend 的进程身份').toEqual([]);
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
      const candidate = await readyCandidate(fixture.base);
      const worker = workerOf(fixture.pid);
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
      const killStarted = Date.now();
      killPid(fixture.pid, true);
      const gone = await waitGone(targets, 30_000);
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
          method: `taskkill /T /F /PID ${fixture.pid}`, startedAt: killStarted,
          elapsedMs: gone.elapsedMs, at1s: gone.at1s, gone: gone.gone, stillAlive: gone.stillAlive,
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

  test('负向对照：旧全局口径被无关进程骗到，归属判据不误失败也不误杀', async () => {
    const targets: Array<{ pid: number; created: string }> = [];
    if (stored.pidKill) {
      targets.push({ pid: stored.pidKill.backend.pid, created: stored.pidKill.backend.created });
      targets.push({ pid: stored.pidKill.worker.pid, created: stored.pidKill.worker.created });
    }
    if (stored.treeKill) {
      targets.push({ pid: stored.treeKill.backend.pid, created: stored.treeKill.backend.created });
      for (const entry of stored.treeKill.tree as Array<{ pid: number; created: string }>) targets.push({ pid: entry.pid, created: entry.created });
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
