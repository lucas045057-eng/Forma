import { expect, test } from '@playwright/test';
import path from 'node:path';
import { adoptCandidate, getCandidate, httpJson, readArtifact } from './checks';
import { summarizeRun, writeArtifact } from './artifact';
import {
  createCandidate, disposeAllFixtures, startAndWatch, startFixture, startMockAgent, type Fixture,
} from './fixture';

/**
 * 四类真实故障（独立验收准备）：
 * schema（场景配置坏） / build（编译错误） / 运行错误（页面未捕获异常） / 遮挡（交互元素被盖住）。
 * 每类都跑真实检查，断言"前序失败停止后续 + 下游 not_run 有原因 + 采用被拒"。
 */

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

test('四类真实故障分别让检查失败，采用被拒，服务仍可继续', async () => {
  test.setTimeout(600_000);
  const root = path.join(process.cwd(), '.data', `m3b-faults-${Date.now().toString(36)}`);
  const fixture = await startFixture({ root });
  fixtures.push(fixture);

  const results: Record<string, unknown> = {};

  /* ---------------- schema ---------------- */
  {
    const created = await createCandidate(fixture, SCHEMA_FAULT, { instruction: '把场景配置写坏' });
    const { run } = await startAndWatch(fixture, created.candidateId, { timeoutMs: 300_000 });
    expect(run.status).toBe('completed');
    expect(run.outcome).toBe('failed');
    expectStoppedAfter(run, 0, 'schema');
    const schema = JSON.parse((await readArtifact(fixture.base, run.id, 'schema.json')).text);
    expect(schema.status).toBe('failed');
    expect(schema.error).toBe('INVALID_JSON');
    const view = (await getCandidate(fixture.base, created.candidateId)).body;
    expect(view.checks.map((check: any) => check.status)).toEqual(['failed', 'not_run', 'not_run', 'not_run']);
    const adopt = await adoptCandidate(fixture.base, created.candidateId);
    expect(adopt.status).toBe(409);
    expect((adopt.body as any)?.error?.code).toBe('CHECKS_NOT_PASSED');
    results.schema = { run: summarizeRun(run), evidence: schema, adopt: { status: adopt.status, code: (adopt.body as any)?.error?.code } };
    expect((await httpJson(`${fixture.base}/candidates/${created.candidateId}/discard`, { method: 'POST' })).status).toBe(200);
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

