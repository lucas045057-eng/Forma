# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 04-lifecycle.spec.ts >> 取消运行中的检查：run 变 cancelled，未完成项 not_run，不能采用
- Location: tests\e2e\m3b\04-lifecycle.spec.ts:38:1

# Error details

```
TypeError: (0 , _fixture.sleep) is not a function
```

# Test source

```ts
  1   | import { expect, test } from '@playwright/test';
  2   | import { mkdirSync } from 'node:fs';
  3   | import path from 'node:path';
  4   | import {
  5   |   adoptCandidate, cancelCheckRun, getCandidate, getCheckRun, readArtifact, startChecks, waitCheckRun,
  6   | } from './checks';
  7   | import { summarizeRun, writeArtifact } from './artifact';
  8   | import { createCandidate, disposeAllFixtures, sleep, startAndWatch, startFixture, startMockAgent, waitFor, type Fixture } from './fixture';
  9   | 
  10  | /**
  11  |  * 检查生命周期（独立验收准备）：取消 / 后端重启恢复 / 跨候选串行 / 缺浏览器。
  12  |  * 预算与超时（180s/120s/30s）不能从 HTTP 注入，这里的超时类只能在实现单测覆盖，报告里如实标注。
  13  |  */
  14  | 
  15  | const CHANGE = [
  16  |   [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
  17  |   [{ name: 'finish', args: { summary: '文案' } }],
  18  | ];
  19  | const CHANGE_B = [
  20  |   [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '收藏香气', new: '收藏这缕香' } }],
  21  |   [{ name: 'finish', args: { summary: '按钮文案' } }],
  22  | ];
  23  | 
  24  | let mock: Awaited<ReturnType<typeof startMockAgent>>;
  25  | const fixtures: Fixture[] = [];
  26  | 
  27  | test.beforeAll(async () => { mock = await startMockAgent(); });
  28  | test.afterAll(async () => { await mock.stop(); });
  29  | test.afterEach(async () => {
  30  |   // 收尾也要有证据：先优雅关闭，失败才显式 fallback 强杀；端口/目录/进程身份都记下来，
  31  |   // 任何一项不干净都让用例失败，而不是 stop().catch(()=>{}) 后删目录继续绿灯。
  32  |   const { failures } = await disposeAllFixtures(fixtures, 'disposals-04-lifecycle.json');
  33  |   expect(failures, `夹具收尾不干净：${JSON.stringify(failures)}`).toEqual([]);
  34  | });
  35  | 
  36  | test.describe.configure({ mode: 'serial' });
  37  | 
  38  | test('取消运行中的检查：run 变 cancelled，未完成项 not_run，不能采用', async () => {
  39  |   test.setTimeout(300_000);
  40  |   const root = path.join(process.cwd(), '.data', `m3b-cancel-${Date.now().toString(36)}`);
  41  |   const fixture = await startFixture({ root });
  42  |   fixtures.push(fixture);
  43  | 
  44  |   const created = await createCandidate(fixture, CHANGE, { instruction: '取消用例' });
  45  |   const started = await startChecks(fixture.base, created.candidateId);
  46  |   expect(started.status).toBe(202);
  47  |   await waitFor(async () => (await getCheckRun(fixture.base, started.body.id)).body.status === 'running', 60_000, 100);
  48  | 
  49  |   const cancelled = await cancelCheckRun(fixture.base, started.body.id);
  50  |   expect(cancelled.status, cancelled.text.slice(0, 200)).toBe(200);
  51  |   expect(['cancelled', 'completed']).toContain(cancelled.body.status);
  52  |   const run = await waitCheckRun(fixture.base, started.body.id, { timeoutMs: 120_000 });
  53  |   expect(run.status).toBe('cancelled');
  54  |   expect(run.outcome === 'cancelled' || run.outcome === 'failed').toBe(true);
  55  |   expect(run.checks.some((check) => check.status === 'not_run'), '取消后没有保留未完成项').toBe(true);
  56  |   expect(run.checks.every((check) => check.status !== 'passed' || check.evidence)).toBe(true);
  57  | 
  58  |   // 取消后再等：不能晚写 passed 或晚出证据
  59  |   const snapshotAfter = JSON.stringify(run.checks);
> 60  |   await sleep(3000);
      |         ^ TypeError: (0 , _fixture.sleep) is not a function
  61  |   const later = (await getCheckRun(fixture.base, started.body.id)).body;
  62  |   expect(JSON.stringify(later.checks)).toBe(snapshotAfter);
  63  |   expect(later.status).toBe('cancelled');
  64  | 
  65  |   const adopt = await adoptCandidate(fixture.base, created.candidateId);
  66  |   expect(adopt.status).toBe(409);
  67  |   expect((adopt.body as any)?.error?.code).toBe('CHECKS_NOT_PASSED');
  68  | 
  69  |   // 取消可以重复调用（幂等）
  70  |   expect((await cancelCheckRun(fixture.base, started.body.id)).status).toBe(200);
  71  |   writeArtifact('lifecycle-cancel.json', { run: summarizeRun(run), adopt: { status: adopt.status, code: (adopt.body as any)?.error?.code } });
  72  | });
  73  | 
  74  | test('后端被强杀后重启：运行中的检查变为 SERVICE_RESTARTED，不自动重跑、不能采用', async () => {
  75  |   test.setTimeout(300_000);
  76  |   const root = path.join(process.cwd(), '.data', `m3b-restart-${Date.now().toString(36)}`);
  77  |   const fixture = await startFixture({ root });
  78  |   fixtures.push(fixture);
  79  | 
  80  |   const created = await createCandidate(fixture, CHANGE, { instruction: '重启用例' });
  81  |   const started = await startChecks(fixture.base, created.candidateId);
  82  |   expect(started.status).toBe(202);
  83  |   await waitFor(async () => (await getCheckRun(fixture.base, started.body.id)).body.status === 'running', 60_000, 100);
  84  |   const beforeKill = (await getCheckRun(fixture.base, started.body.id)).body;
  85  | 
  86  |   await fixture.hardKill();
  87  |   await fixture.restart();
  88  | 
  89  |   const afterRestart = (await getCheckRun(fixture.base, started.body.id)).body;
  90  |   expect(afterRestart.id).toBe(started.body.id);
  91  |   expect(afterRestart.status, `重启后运行中的检查没有被置为失败：${afterRestart.status}`).toBe('completed');
  92  |   expect(afterRestart.outcome).toBe('failed');
  93  |   expect(afterRestart.error?.code).toBe('SERVICE_RESTARTED');
  94  |   expect(afterRestart.checks.length).toBe(4);
  95  | 
  96  |   // 不自动重跑：该候选只有一个 run
  97  |   const candidate = (await getCandidate(fixture.base, created.candidateId)).body;
  98  |   expect(candidate.latestCheckRunId).toBe(started.body.id);
  99  |   const adopt = await adoptCandidate(fixture.base, created.candidateId);
  100 |   expect(adopt.status).toBe(409);
  101 |   expect((adopt.body as any)?.error?.code).toBe('CHECKS_NOT_PASSED');
  102 | 
  103 |   // 重启后仍可发起一次新的显式检查（不是自动补跑）：本用例只记录该能力，不等它跑完
  104 |   const explicit = await startChecks(fixture.base, created.candidateId, { rerun: true });
  105 |   expect([202, 409]).toContain(explicit.status);
  106 |   if (explicit.status === 202) await cancelCheckRun(fixture.base, explicit.body.id).catch(() => {});
  107 | 
  108 |   writeArtifact('lifecycle-restart.json', {
  109 |     beforeKill: summarizeRun(beforeKill),
  110 |     afterRestart: summarizeRun(afterRestart),
  111 |     adopt: { status: adopt.status, code: (adopt.body as any)?.error?.code },
  112 |     explicitAfterRestart: { status: explicit.status },
  113 |   });
  114 | });
  115 | 
  116 | test('两个候选的检查串行：后一个在排队，不并行也不交错', async () => {
  117 |   test.setTimeout(420_000);
  118 |   const root = path.join(process.cwd(), '.data', `m3b-serial-${Date.now().toString(36)}`);
  119 |   const fixture = await startFixture({ root });
  120 |   fixtures.push(fixture);
  121 | 
  122 |   const first = await createCandidate(fixture, CHANGE, { instruction: '串行 A' });
  123 |   const second = await createCandidate(fixture, CHANGE_B, { instruction: '串行 B', src: 'src/App.tsx:30:11' });
  124 |   const runA = await startChecks(fixture.base, first.candidateId);
  125 |   const runB = await startChecks(fixture.base, second.candidateId);
  126 |   expect(runA.status).toBe(202);
  127 |   expect(runB.status).toBe(202);
  128 |   expect(runB.body.status, `第二个候选没有排队：${runB.body.status}`).toBe('queued');
  129 | 
  130 |   const observations: Array<{ at: number; a: string; b: string }> = [];
  131 |   let sawSerial = false;
  132 |   let sawOverlap = false;
  133 |   const started = Date.now();
  134 |   while (Date.now() - started < 300_000) {
  135 |     const [a, b] = await Promise.all([getCheckRun(fixture.base, runA.body.id), getCheckRun(fixture.base, runB.body.id)]);
  136 |     observations.push({ at: Date.now() - started, a: a.body.status, b: b.body.status });
  137 |     if (a.body.status === 'running' && b.body.status === 'queued') sawSerial = true;
  138 |     if (a.body.status === 'running' && b.body.status === 'running') sawOverlap = true;
  139 |     if (a.body.status === 'completed' || a.body.status === 'cancelled') break;
  140 |     await sleep(250);
  141 |   }
  142 |   expect(sawSerial, `没有观察到串行（前一个 running、后一个 queued）：${JSON.stringify(observations.slice(0, 6))}`).toBe(true);
  143 |   expect(sawOverlap, `两个候选的检查同时处于 running：${JSON.stringify(observations.filter((item) => item.a === 'running' && item.b === 'running'))}`).toBe(false);
  144 | 
  145 |   const finishedA = await waitCheckRun(fixture.base, runA.body.id, { timeoutMs: 300_000 });
  146 |   const finishedB = await waitCheckRun(fixture.base, runB.body.id, { timeoutMs: 300_000 });
  147 |   expect(finishedA.outcome).toBe('passed');
  148 |   expect(finishedB.outcome).toBe('passed');
  149 |   expect(Date.parse(finishedB.startedAt!) >= Date.parse(finishedA.finishedAt!)).toBe(true);
  150 | 
  151 |   writeArtifact('lifecycle-serial.json', {
  152 |     a: summarizeRun(finishedA), b: summarizeRun(finishedB),
  153 |     samples: observations.slice(0, 40), sawSerial, sawOverlap,
  154 |     ordering: { aFinishedAt: finishedA.finishedAt, bStartedAt: finishedB.startedAt },
  155 |   });
  156 | });
  157 | 
  158 | test('缺浏览器：schema/build 通过，smoke 如实失败，occlusion not_run', async () => {
  159 |   test.setTimeout(300_000);
  160 |   const root = path.join(process.cwd(), '.data', `m3b-nobrowser-${Date.now().toString(36)}`);
```