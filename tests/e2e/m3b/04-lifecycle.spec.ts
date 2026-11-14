import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  adoptCandidate, cancelCheckRun, getCandidate, getCheckRun, readArtifact, startChecks, waitCheckRun,
} from './checks';
import { summarizeRun, writeArtifact } from './artifact';
import { createCandidate, disposeAllFixtures, sleep, startAndWatch, startFixture, startMockAgent, waitFor, type Fixture } from './fixture';

/**
 * 检查生命周期（独立验收准备）：取消 / 后端重启恢复 / 跨候选串行 / 缺浏览器。
 * 预算与超时（180s/120s/30s）不能从 HTTP 注入，这里的超时类只能在实现单测覆盖，报告里如实标注。
 */

const CHANGE = [
  [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
  [{ name: 'finish', args: { summary: '文案' } }],
];
const CHANGE_B = [
  [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '收藏香气', new: '收藏这缕香' } }],
  [{ name: 'finish', args: { summary: '按钮文案' } }],
];

let mock: Awaited<ReturnType<typeof startMockAgent>>;
const fixtures: Fixture[] = [];

test.beforeAll(async () => { mock = await startMockAgent(); });
test.afterAll(async () => { await mock.stop(); });
test.afterEach(async () => {
  // 收尾也要有证据：先优雅关闭，失败才显式 fallback 强杀；端口/目录/进程身份都记下来，
  // 任何一项不干净都让用例失败，而不是 stop().catch(()=>{}) 后删目录继续绿灯。
  const { failures } = await disposeAllFixtures(fixtures, 'disposals-04-lifecycle.json');
  expect(failures, `夹具收尾不干净：${JSON.stringify(failures)}`).toEqual([]);
});

test.describe.configure({ mode: 'serial' });

test('取消运行中的检查：run 变 cancelled，未完成项 not_run，不能采用', async () => {
  test.setTimeout(300_000);
  const root = path.join(process.cwd(), '.data', `m3b-cancel-${Date.now().toString(36)}`);
  const fixture = await startFixture({ root });
  fixtures.push(fixture);

  const created = await createCandidate(fixture, CHANGE, { instruction: '取消用例' });
  const started = await startChecks(fixture.base, created.candidateId);
  expect(started.status).toBe(202);
  await waitFor(async () => (await getCheckRun(fixture.base, started.body.id)).body.status === 'running', 60_000, 100);

  const cancelled = await cancelCheckRun(fixture.base, started.body.id);
  expect(cancelled.status, cancelled.text.slice(0, 200)).toBe(200);
  expect(['cancelled', 'completed']).toContain(cancelled.body.status);
  const run = await waitCheckRun(fixture.base, started.body.id, { timeoutMs: 120_000 });
  expect(run.status).toBe('cancelled');
  expect(run.outcome === 'cancelled' || run.outcome === 'failed').toBe(true);
  expect(run.checks.some((check) => check.status === 'not_run'), '取消后没有保留未完成项').toBe(true);
  expect(run.checks.every((check) => check.status !== 'passed' || check.evidence)).toBe(true);

  // 取消后再等：不能晚写 passed 或晚出证据
  const snapshotAfter = JSON.stringify(run.checks);
  await sleep(3000);
  const later = (await getCheckRun(fixture.base, started.body.id)).body;
  expect(JSON.stringify(later.checks)).toBe(snapshotAfter);
  expect(later.status).toBe('cancelled');

  const adopt = await adoptCandidate(fixture.base, created.candidateId);
  expect(adopt.status).toBe(409);
  expect((adopt.body as any)?.error?.code).toBe('CHECKS_NOT_PASSED');

  // 取消可以重复调用（幂等）
  expect((await cancelCheckRun(fixture.base, started.body.id)).status).toBe(200);
  writeArtifact('lifecycle-cancel.json', { run: summarizeRun(run), adopt: { status: adopt.status, code: (adopt.body as any)?.error?.code } });
});

test('后端被强杀后重启：运行中的检查变为 SERVICE_RESTARTED，不自动重跑、不能采用', async () => {
  test.setTimeout(300_000);
  const root = path.join(process.cwd(), '.data', `m3b-restart-${Date.now().toString(36)}`);
  const fixture = await startFixture({ root });
  fixtures.push(fixture);

  const created = await createCandidate(fixture, CHANGE, { instruction: '重启用例' });
  const started = await startChecks(fixture.base, created.candidateId);
  expect(started.status).toBe(202);
  await waitFor(async () => (await getCheckRun(fixture.base, started.body.id)).body.status === 'running', 60_000, 100);
  const beforeKill = (await getCheckRun(fixture.base, started.body.id)).body;

  await fixture.hardKill();
  await fixture.restart();

  const afterRestart = (await getCheckRun(fixture.base, started.body.id)).body;
  expect(afterRestart.id).toBe(started.body.id);
  expect(afterRestart.status, `重启后运行中的检查没有被置为失败：${afterRestart.status}`).toBe('completed');
  expect(afterRestart.outcome).toBe('failed');
  expect(afterRestart.error?.code).toBe('SERVICE_RESTARTED');
  expect(afterRestart.checks.length).toBe(4);

  // 不自动重跑：该候选只有一个 run
  const candidate = (await getCandidate(fixture.base, created.candidateId)).body;
  expect(candidate.latestCheckRunId).toBe(started.body.id);
  const adopt = await adoptCandidate(fixture.base, created.candidateId);
  expect(adopt.status).toBe(409);
  expect((adopt.body as any)?.error?.code).toBe('CHECKS_NOT_PASSED');

  // 重启后仍可发起一次新的显式检查（不是自动补跑）：本用例只记录该能力，不等它跑完
  const explicit = await startChecks(fixture.base, created.candidateId, { rerun: true });
  expect([202, 409]).toContain(explicit.status);
  if (explicit.status === 202) await cancelCheckRun(fixture.base, explicit.body.id).catch(() => {});

  writeArtifact('lifecycle-restart.json', {
    beforeKill: summarizeRun(beforeKill),
    afterRestart: summarizeRun(afterRestart),
    adopt: { status: adopt.status, code: (adopt.body as any)?.error?.code },
    explicitAfterRestart: { status: explicit.status },
  });
});

test('两个候选的检查串行：后一个在排队，不并行也不交错', async () => {
  test.setTimeout(420_000);
  const root = path.join(process.cwd(), '.data', `m3b-serial-${Date.now().toString(36)}`);
  const fixture = await startFixture({ root });
  fixtures.push(fixture);

  const first = await createCandidate(fixture, CHANGE, { instruction: '串行 A' });
  const second = await createCandidate(fixture, CHANGE_B, { instruction: '串行 B', src: 'src/App.tsx:30:11' });
  const runA = await startChecks(fixture.base, first.candidateId);
  const runB = await startChecks(fixture.base, second.candidateId);
  expect(runA.status).toBe(202);
  expect(runB.status).toBe(202);
  expect(runB.body.status, `第二个候选没有排队：${runB.body.status}`).toBe('queued');

  const observations: Array<{ at: number; a: string; b: string }> = [];
  let sawSerial = false;
  let sawOverlap = false;
  const started = Date.now();
  while (Date.now() - started < 300_000) {
    const [a, b] = await Promise.all([getCheckRun(fixture.base, runA.body.id), getCheckRun(fixture.base, runB.body.id)]);
    observations.push({ at: Date.now() - started, a: a.body.status, b: b.body.status });
    if (a.body.status === 'running' && b.body.status === 'queued') sawSerial = true;
    if (a.body.status === 'running' && b.body.status === 'running') sawOverlap = true;
    if (a.body.status === 'completed' || a.body.status === 'cancelled') break;
    await sleep(250);
  }
  expect(sawSerial, `没有观察到串行（前一个 running、后一个 queued）：${JSON.stringify(observations.slice(0, 6))}`).toBe(true);
  expect(sawOverlap, `两个候选的检查同时处于 running：${JSON.stringify(observations.filter((item) => item.a === 'running' && item.b === 'running'))}`).toBe(false);

  const finishedA = await waitCheckRun(fixture.base, runA.body.id, { timeoutMs: 300_000 });
  const finishedB = await waitCheckRun(fixture.base, runB.body.id, { timeoutMs: 300_000 });
  expect(finishedA.outcome).toBe('passed');
  expect(finishedB.outcome).toBe('passed');
  expect(Date.parse(finishedB.startedAt!) >= Date.parse(finishedA.finishedAt!)).toBe(true);

  writeArtifact('lifecycle-serial.json', {
    a: summarizeRun(finishedA), b: summarizeRun(finishedB),
    samples: observations.slice(0, 40), sawSerial, sawOverlap,
    ordering: { aFinishedAt: finishedA.finishedAt, bStartedAt: finishedB.startedAt },
  });
});

test('缺浏览器：schema/build 通过，smoke 如实失败，occlusion not_run', async () => {
  test.setTimeout(300_000);
  const root = path.join(process.cwd(), '.data', `m3b-nobrowser-${Date.now().toString(36)}`);
  const emptyLocalAppData = path.join(root, 'empty-localappdata');
  mkdirSync(emptyLocalAppData, { recursive: true });
  const fixture = await startFixture({ root, env: { LOCALAPPDATA: emptyLocalAppData } });
  fixtures.push(fixture);

  const created = await createCandidate(fixture, CHANGE, { instruction: '缺浏览器用例' });
  const { run } = await startAndWatch(fixture, created.candidateId, { timeoutMs: 300_000 });
  expect(run.outcome, `缺浏览器时检查没有如实失败：${JSON.stringify(run.checks)}`).toBe('failed');
  expect(run.checks[0].status).toBe('passed');
  expect(run.checks[1].status).toBe('passed');
  expect(run.checks[2].status).toBe('failed');
  expect(run.checks[3].status).toBe('not_run');
  const smoke = JSON.parse((await readArtifact(fixture.base, run.id, 'smoke.json')).text);
  expect(String(smoke.error ?? '')).toMatch(/browser|executable|playwright|launch/i);
  const adopt = await adoptCandidate(fixture.base, created.candidateId);
  expect(adopt.status).toBe(409);

  writeArtifact('lifecycle-missing-browser.json', {
    run: summarizeRun(run),
    smoke: { error: smoke.error, pageErrors: smoke.pageErrors },
    adopt: { status: adopt.status, code: (adopt.body as any)?.error?.code },
    localAppData: emptyLocalAppData,
  });
});

