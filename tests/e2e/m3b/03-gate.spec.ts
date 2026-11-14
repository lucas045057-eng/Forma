import { expect, test } from '@playwright/test';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  adoptCandidate, cancelCheckRun, getCandidate, getCheckRun, getVersion, httpJson, readArtifact, startChecks, waitCheckRun,
} from './checks';
import { summarizeRun, writeArtifact } from './artifact';
import { createCandidate, disposeAllFixtures, startAndWatch, startFixture, startMockAgent, type Fixture } from './fixture';

/**
 * 采用门禁与检查身份（独立验收准备）：
 * 同身份幂等 / 显式 rerun 才新建 / 严格请求体 / 证据被改后拒绝采用 / 主版本变化后旧绿灯失效。
 */

const CHANGE_A = [
  [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
  [{ name: 'finish', args: { summary: 'A 文案' } }],
];
const CHANGE_B = [
  [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '立刻下单' } }],
  [{ name: 'finish', args: { summary: 'B 文案' } }],
];

let mock: Awaited<ReturnType<typeof startMockAgent>>;
const fixtures: Fixture[] = [];

test.beforeAll(async () => { mock = await startMockAgent(); });
test.afterAll(async () => { await mock.stop(); });
test.afterEach(async () => {
  // 收尾也要有证据：先优雅关闭，失败才显式 fallback 强杀；端口/目录/进程身份都记下来，
  // 任何一项不干净都让用例失败，而不是 stop().catch(()=>{}) 后删目录继续绿灯。
  const { failures } = await disposeAllFixtures(fixtures, 'disposals-03-gate.json');
  expect(failures, `夹具收尾不干净：${JSON.stringify(failures)}`).toEqual([]);
});

test.describe.configure({ mode: 'serial' });

test('同身份幂等、显式 rerun、严格请求体、证据篡改与过期候选', async () => {
  test.setTimeout(600_000);
  const root = path.join(process.cwd(), '.data', `m3b-gate-${Date.now().toString(36)}`);
  const fixture = await startFixture({ root });
  fixtures.push(fixture);

  const record: Record<string, unknown> = {};
  const createdA = await createCandidate(fixture, CHANGE_A, { instruction: 'A：把按钮改成马上购买' });

  /* ---------- 未检查的候选不能采用 ---------- */
  const unchecked = await adoptCandidate(fixture.base, createdA.candidateId);
  expect(unchecked.status).toBe(409);
  expect((unchecked.body as any)?.error?.code).toBe('CHECKS_NOT_PASSED');

  /* ---------- 严格请求体 ---------- */
  const badBodies: Array<{ label: string; body: string; expected: number[] }> = [
    { label: 'rerun 非布尔', body: JSON.stringify({ rerun: 'yes' }), expected: [400] },
    { label: '未知字段 budget', body: JSON.stringify({ budget: 1000 }), expected: [400] },
    { label: '未知字段 force', body: JSON.stringify({ force: true }), expected: [400] },
    { label: '数组请求体', body: JSON.stringify([{ rerun: true }]), expected: [400] },
  ];
  const strictResults: Array<Record<string, unknown>> = [];
  for (const item of badBodies) {
    const response = await httpJson(`${fixture.base}/candidates/${createdA.candidateId}/checks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: item.body,
    });
    expect(item.expected, `${item.label} 的响应码不是预期：${response.status} ${response.text.slice(0, 200)}`).toContain(response.status);
    strictResults.push({ label: item.label, status: response.status, code: (response.body as any)?.error?.code });
  }
  record.strictBodies = strictResults;

  /* ---------- 同身份：第一次 POST 建 run，第二次返回同一 run ---------- */
  const first = await startChecks(fixture.base, createdA.candidateId);
  expect(first.status).toBe(202);
  const duplicate = await startChecks(fixture.base, createdA.candidateId);
  expect(duplicate.status, duplicate.text.slice(0, 200)).toBe(202);
  expect(duplicate.body.id, '同身份重复发起被当成了新 run').toBe(first.body.id);

  const run1 = await waitCheckRun(fixture.base, first.body.id, { timeoutMs: 300_000 });
  expect(run1.outcome).toBe('passed');

  /* ---------- 完成后取消：幂等，不能把 passed 改写成 cancelled ---------- */
  const cancelledAfterDone = await cancelCheckRun(fixture.base, run1.id);
  expect(cancelledAfterDone.status).toBe(200);
  expect(cancelledAfterDone.body.status).toBe('completed');
  expect(cancelledAfterDone.body.outcome).toBe('passed');

  /* ---------- 已完成的同身份再 POST：仍然返回同一个 run ---------- */
  const afterDone = await startChecks(fixture.base, createdA.candidateId);
  expect(afterDone.status).toBe(202);
  expect(afterDone.body.id).toBe(run1.id);

  /* ---------- 显式 rerun：新建 run，旧 run 仍是 passed ---------- */
  const rerun = await startChecks(fixture.base, createdA.candidateId, { rerun: true });
  expect(rerun.status, rerun.text.slice(0, 200)).toBe(202);
  expect(rerun.body.id).not.toBe(run1.id);
  expect((await getCheckRun(fixture.base, run1.id)).body.outcome).toBe('passed');
  const run2 = await waitCheckRun(fixture.base, rerun.body.id, { timeoutMs: 300_000 });
  expect(run2.outcome).toBe('passed');
  expect((await getCandidate(fixture.base, createdA.candidateId)).body.latestCheckRunId).toBe(run2.id);

  /* ---------- 证据被改：读取 409，采用 409 ---------- */
  const smokePath = path.join(fixture.dataDir, 'check-artifacts', run2.id, 'smoke.json');
  expect(existsSync(smokePath), `没有找到本次 run 的证据目录：${smokePath}`).toBe(true);
  const before = readFileSync(smokePath, 'utf8');
  appendFileSync(smokePath, '\n/* tampered by acceptance test */\n', 'utf8');
  const tampered = await readArtifact(fixture.base, run2.id, 'smoke.json');
  expect(tampered.status, `证据被改后仍能读取：${tampered.status}`).toBe(409);
  expect(JSON.parse(tampered.text).error?.code ?? tampered.text).toMatch(/EVIDENCE_CHANGED/);
  const adoptTampered = await adoptCandidate(fixture.base, createdA.candidateId);
  expect(adoptTampered.status).toBe(409);
  expect((adoptTampered.body as any)?.error?.code).toBe('CHECKS_NOT_PASSED');
  record.tamper = {
    runId: run2.id,
    artifactGet: tampered.status,
    adopt: { status: adoptTampered.status, code: (adoptTampered.body as any)?.error?.code },
    originalBytes: before.length,
  };
  // 撤回被篡改的候选（不改回证据，保留现场）
  expect((await httpJson(`${fixture.base}/candidates/${createdA.candidateId}/discard`, { method: 'POST' })).status).toBe(200);

  /* ---------- 主版本变化后旧绿灯失效 ---------- */
  const createdB = await createCandidate(fixture, CHANGE_B, { instruction: 'B：把按钮改成立刻下单' });
  const { run: run3 } = await startAndWatch(fixture, createdB.candidateId, { timeoutMs: 300_000 });
  expect(run3.outcome).toBe('passed');
  const versionBefore = (await getVersion(fixture.base)).body.version;
  appendFileSync(path.join(fixture.workRoot, 'src', 'App.tsx'), '\n// 验收准备：主作品直接改一行\n', 'utf8');
  const versionAfter = (await getVersion(fixture.base)).body.version;
  expect(versionAfter, '主作品没有产生新版本，过期用例不成立').not.toBe(versionBefore);
  const adoptedStale = await adoptCandidate(fixture.base, createdB.candidateId);
  expect(adoptedStale.status, adoptedStale.text.slice(0, 300)).toBe(409);
  expect((adoptedStale.body as any)?.error?.code).toBe('STALE_CANDIDATE');
  record.stale = { runId: run3.id, versionBefore, versionAfter, status: adoptedStale.status, code: (adoptedStale.body as any)?.error?.code };

  /* ---------- 不存在的东西 ---------- */
  const unknownRun = await getCheckRun(fixture.base, 'ffffffffffffffff');
  expect(unknownRun.status).toBe(404);
  const unknownCandidate = await startChecks(fixture.base, 'not-a-candidate');
  expect([404, 409]).toContain(unknownCandidate.status);

  const currentWorkRoot = readFileSync(path.join(fixture.workRoot, 'src', 'App.tsx'), 'utf8');
  writeArtifact('gate.json', {
    candidateA: createdA.candidateId,
    run1: summarizeRun(run1),
    run2: summarizeRun(run2),
    run3: summarizeRun(run3),
    idempotent: { duplicate: duplicate.body.id === first.body.id, afterDone: afterDone.body.id === run1.id },
    rerunCreatedNew: rerun.body.id !== run1.id,
    cancelAfterDone: { status: cancelledAfterDone.body.status, outcome: cancelledAfterDone.body.outcome },
    ...record,
    mainChangedDirectly: currentWorkRoot.includes('验收准备：主作品直接改一行'),
  });
});
