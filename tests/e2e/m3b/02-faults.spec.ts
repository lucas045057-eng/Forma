import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { adoptCandidate, getCandidate, httpJson, readArtifact } from './checks';
import { summarizeRun, writeArtifact } from './artifact';
import {
  createCandidate, disposeAllFixtures, getTask, getVersion, listCandidatesApi, resetMock, selection, setScript,
  startAndWatch, startFixture, startMockAgent, waitTask, type Fixture,
} from './fixture';

/**
 * 真实故障与故障面边界：
 * build（编译错误）/ 运行错误（页面未捕获异常）/ 遮挡（交互元素被盖住）三类真故障分别让检查失败；
 * 第四类 schema 故障（非法场景配置）**在 HTTP 支持面上不可达**：
 * 沙箱（apps/server/src/agent/tools.ts:86-89）拒写非法 scene.config.json，
 * 绕过 Agent 直改候选又会被 checks/runner.ts:246 的 SNAPSHOT_MISMATCH 拦住；
 * 所以这里改成断言“沙箱确实拒绝造出坏配置”（任务 NO_CHANGES、无候选、磁盘文件未变），
 * INVALID_JSON 路径由实现侧 worker-boundary.test.ts 直接改 buildRoot 覆盖。
 */

/** 试图把场景配置写坏：产品沙箱应当拒绝，因此永远产不出候选。 */
const SCHEMA_FAULT = [
  [{ name: 'write_file', args: { path: 'src/scene.config.json', content: '{"hero": {"lights": ' } }],
  [{ name: 'finish', args: { summary: '写坏场景配置' } }],
];

const BUILD_FAULT = [
  [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: 'export default function App() {', new: 'export default function App() {{' } }],
  [{ name: 'finish', args: { summary: '制造语法错误' } }],
];

const RUNTIME_FAULT = [
  [{
    name: 'replace_in_file',
    args: {
      path: 'src/App.tsx',
      old: "const [action, setAction] = useState('');",
      new: "const [action, setAction] = useState('');\n  if (typeof window !== 'undefined' && !(window as any).__probeScheduled) {\n    (window as any).__probeScheduled = true;\n    setTimeout(() => { throw new Error('probe-runtime'); }, 0);\n  }",
    },
  }],
  [{ name: 'finish', args: { summary: '页面启动后抛未捕获异常' } }],
];

const OCCLUSION_FAULT = [
  [{
    name: 'replace_in_file',
    args: {
      path: 'src/App.tsx',
      old: '    <main>\n      <header className="navigation">',
      new: '    <main>\n      <div data-testid="probe-overlay" style={{ position: \'fixed\', left: 0, top: 0, right: 0, height: 120, zIndex: 9999, background: \'rgba(0,0,0,0.01)\' }} />\n      <header className="navigation">',
    },
  }],
  [{ name: 'finish', args: { summary: '用一个覆盖层挡住顶部导航' } }],
];

let mock: Awaited<ReturnType<typeof startMockAgent>>;
const fixtures: Fixture[] = [];

test.beforeAll(async () => { mock = await startMockAgent(); });
test.afterAll(async () => { await mock.stop(); });
test.afterEach(async () => {
  // 收尾也要有证据：先优雅关闭，失败才显式 fallback 强杀；端口/目录/进程身份都记下来，
  // 任何一项不干净都让用例失败，而不是 stop().catch(()=>{}) 后删目录继续绿灯。
  const { failures } = await disposeAllFixtures(fixtures, 'disposals-02-faults.json');
  expect(failures, `夹具收尾不干净：${JSON.stringify(failures)}`).toEqual([]);
});

test.describe.configure({ mode: 'serial' });

function expectStoppedAfter(run: { checks: Array<{ name: string; status: string; message?: string }> }, failedIndex: number, code: string) {
  const failed = run.checks[failedIndex];
  expect(failed.status, `${failed.name} 应该是 failed：${JSON.stringify(run.checks)}`).toBe('failed');
  for (let index = failedIndex + 1; index < run.checks.length; index += 1) {
    const later = run.checks[index];
    expect(later.status, `${later.name} 应该 not_run：${JSON.stringify(run.checks)}`).toBe('not_run');
    expect(String(later.message ?? ''), `${later.name} 没有写明被谁阻塞`).toContain('前序检查');
    expect(String(later.message ?? '')).toContain(code);
  }
}

test('build / 运行错误 / 遮挡三类真实故障让检查失败，且沙箱拒绝写坏场景配置', async () => {
  test.setTimeout(600_000);
  const root = path.join(process.cwd(), '.data', `m3b-faults-${Date.now().toString(36)}`);
  const fixture = await startFixture({ root });
  fixtures.push(fixture);

  const results: Record<string, unknown> = {};

  /* ---------------- schema：故障面不可达（沙箱拒绝） ---------------- */
  {
    const configPath = path.join(fixture.workRoot, 'src', 'scene.config.json');
    const before = readFileSync(configPath, 'utf8');
    expect(() => JSON.parse(before), '初始场景配置本身不是合法 JSON，前提不成立').not.toThrow();
    const candidatesBefore = (await listCandidatesApi(fixture.base)).body.length;

    const base = (await getVersion(fixture.base)).body.version;
    await resetMock();
    await setScript(SCHEMA_FAULT);
    const submitted = await httpJson<any>(`${fixture.base}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: '把场景配置写坏', selection: selection(base, 'src/App.tsx:30:11') }),
    });
    expect(submitted.status).toBe(202);
    const task = await getTask(fixture.base, submitted.body.id);
    const settled = await waitTask(fixture.base, submitted.body.id, 120_000);
    // 沙箱拒绝写入非法配置 → Agent 没有任何文件改动 → 任务以 NO_CHANGES 失败，不产出候选。
    expect(settled.status, `任务不是 failed：${JSON.stringify(settled).slice(0, 400)}`).toBe('failed');
    expect(settled.error?.code, `错误码不是 NO_CHANGES：${JSON.stringify(settled.error)}`).toBe('NO_CHANGES');
    expect(settled.candidateId ?? null, '沙箱本应拒绝，却产出了候选').toBeNull();
    expect((await listCandidatesApi(fixture.base)).body.length, '候选列表里多了一个候选').toBe(candidatesBefore);
    // 磁盘上的场景配置一字未动，且仍然是合法 JSON。
    const after = readFileSync(configPath, 'utf8');
    expect(after, '场景配置被写坏了').toBe(before);
    expect(() => JSON.parse(after)).not.toThrow();
    results.schemaUnreachable = {
      taskStatus: settled.status,
      error: settled.error ?? null,
      candidateCreated: Boolean(settled.candidateId),
      configUnchanged: after === before,
      configStillValidJson: true,
      taskSnapshotAt: task.body?.updatedAt ?? null,
    };
  }

  /* ---------------- build ---------------- */
  {
    const created = await createCandidate(fixture, BUILD_FAULT, { instruction: '制造语法错误' });
    const { run } = await startAndWatch(fixture, created.candidateId, { timeoutMs: 300_000 });
    expect(run.outcome).toBe('failed');
    expect(run.checks[0].status).toBe('passed');
    expectStoppedAfter(run, 1, 'build');
    const buildLog = (await readArtifact(fixture.base, run.id, 'build.log')).text;
    expect(buildLog.length).toBeGreaterThan(0);
    expect(buildLog).toMatch(/error|Error|Expected|Unexpected|Syntax/i);
    const adopt = await adoptCandidate(fixture.base, created.candidateId);
    expect(adopt.status).toBe(409);
    results.build = { run: summarizeRun(run), buildLogHead: buildLog.split(/\r?\n/).slice(0, 6), adopt: { status: adopt.status, code: (adopt.body as any)?.error?.code } };
    expect((await httpJson(`${fixture.base}/candidates/${created.candidateId}/discard`, { method: 'POST' })).status).toBe(200);
  }

  /* ---------------- 运行错误 ---------------- */
  {
    const created = await createCandidate(fixture, RUNTIME_FAULT, { instruction: '让页面启动后抛异常' });
    const { run } = await startAndWatch(fixture, created.candidateId, { timeoutMs: 300_000 });
    expect(run.outcome).toBe('failed');
    expect(run.status).toBe('completed');
    expect(run.checks[0].status).toBe('passed');
    expect(run.checks[1].status).toBe('passed');
    const smoke = JSON.parse((await readArtifact(fixture.base, run.id, 'smoke.json')).text);
    expect(smoke.pageErrors.length, `未捕获异常没有被记录：${JSON.stringify(smoke.pageErrors)}`).toBeGreaterThan(0);
    expect(String(smoke.error ?? '')).toContain('UNCAUGHT_PAGE_ERROR');
    expect(run.checks[2].status).toBe('failed');
    expect(run.checks[3].status).toBe('not_run');
    const adopt = await adoptCandidate(fixture.base, created.candidateId);
    expect(adopt.status).toBe(409);
    results.runtime = { run: summarizeRun(run), smoke: { error: smoke.error, pageErrors: smoke.pageErrors, purchases: smoke.purchases }, adopt: { status: adopt.status, code: (adopt.body as any)?.error?.code } };
    expect((await httpJson(`${fixture.base}/candidates/${created.candidateId}/discard`, { method: 'POST' })).status).toBe(200);
  }

  /* ---------------- 遮挡 ---------------- */
  {
    const created = await createCandidate(fixture, OCCLUSION_FAULT, { instruction: '用覆盖层挡住顶部导航' });
    const { run } = await startAndWatch(fixture, created.candidateId, { timeoutMs: 300_000 });
    expect(run.outcome).toBe('failed');
    expect(run.checks[0].status).toBe('passed');
    expect(run.checks[1].status).toBe('passed');
    expect(String(run.checks[2].message ?? run.checks[2].status), '冒烟检查不该因为顶部遮挡失败（购买入口仍可点）').toBe('passed');
    expect(run.checks[3].status).toBe('failed');
    const occlusion = JSON.parse((await readArtifact(fixture.base, run.id, 'occlusion.json')).text);
    expect(String(occlusion.error ?? '')).toContain('INTERACTIVE_TARGET_OCCLUDED');
    const occluded = (occlusion.targets ?? []).filter((target: any) => target.passed !== true);
    expect(occluded.length, `没有记录到被遮挡的元素：${JSON.stringify(occlusion.targets ?? []).slice(0, 400)}`).toBeGreaterThan(0);
    expect(occluded[0].samples.some((sample: any) => sample.hitSelf === false)).toBe(true);
    const adopt = await adoptCandidate(fixture.base, created.candidateId);
    expect(adopt.status).toBe(409);
    results.occlusion = {
      run: summarizeRun(run),
      occlusion: { error: occlusion.error, occluded: occluded.map((target: any) => ({ tag: target.tag, rect: target.rect, centerHit: target.centerHit })) },
      adopt: { status: adopt.status, code: (adopt.body as any)?.error?.code },
    };
    expect((await httpJson(`${fixture.base}/candidates/${created.candidateId}/discard`, { method: 'POST' })).status).toBe(200);
  }

  // 四类故障之后服务仍然健康：再起一个正常候选并跑通四项（不是复用旧绿灯）
  const healthy = await startAndWatch(fixture, (await createCandidate(fixture, [
    [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
    [{ name: 'finish', args: { summary: '回到正常改动' } }],
  ], { instruction: '恢复正常文案' })).candidateId, { timeoutMs: 300_000 });
  expect(healthy.run.outcome, `故障后服务没有恢复：${JSON.stringify(healthy.run.checks)}`).toBe('passed');
  results.recovered = { run: summarizeRun(healthy.run) };

  writeArtifact('fault-classes.json', results);
});

