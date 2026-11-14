# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 03-gate.spec.ts >> 同身份幂等、显式 rerun、严格请求体、证据篡改与过期候选
- Location: tests\e2e\m3b\03-gate.spec.ts:38:1

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: "STALE_CANDIDATE"
Received: "CHECKS_NOT_PASSED"
```

# Test source

```ts
  29  | test.afterEach(async () => {
  30  |   // 收尾也要有证据：先优雅关闭，失败才显式 fallback 强杀；端口/目录/进程身份都记下来，
  31  |   // 任何一项不干净都让用例失败，而不是 stop().catch(()=>{}) 后删目录继续绿灯。
  32  |   const { failures } = await disposeAllFixtures(fixtures, 'disposals-03-gate.json');
  33  |   expect(failures, `夹具收尾不干净：${JSON.stringify(failures)}`).toEqual([]);
  34  | });
  35  | 
  36  | test.describe.configure({ mode: 'serial' });
  37  | 
  38  | test('同身份幂等、显式 rerun、严格请求体、证据篡改与过期候选', async () => {
  39  |   test.setTimeout(600_000);
  40  |   const root = path.join(process.cwd(), '.data', `m3b-gate-${Date.now().toString(36)}`);
  41  |   const fixture = await startFixture({ root });
  42  |   fixtures.push(fixture);
  43  | 
  44  |   const record: Record<string, unknown> = {};
  45  |   const createdA = await createCandidate(fixture, CHANGE_A, { instruction: 'A：把按钮改成马上购买' });
  46  | 
  47  |   /* ---------- 未检查的候选不能采用 ---------- */
  48  |   const unchecked = await adoptCandidate(fixture.base, createdA.candidateId);
  49  |   expect(unchecked.status).toBe(409);
  50  |   expect((unchecked.body as any)?.error?.code).toBe('CHECKS_NOT_PASSED');
  51  | 
  52  |   /* ---------- 严格请求体 ---------- */
  53  |   const badBodies: Array<{ label: string; body: string; expected: number[] }> = [
  54  |     { label: 'rerun 非布尔', body: JSON.stringify({ rerun: 'yes' }), expected: [400] },
  55  |     { label: '未知字段 budget', body: JSON.stringify({ budget: 1000 }), expected: [400] },
  56  |     { label: '未知字段 force', body: JSON.stringify({ force: true }), expected: [400] },
  57  |     { label: '数组请求体', body: JSON.stringify([{ rerun: true }]), expected: [400] },
  58  |   ];
  59  |   const strictResults: Array<Record<string, unknown>> = [];
  60  |   for (const item of badBodies) {
  61  |     const response = await httpJson(`${fixture.base}/candidates/${createdA.candidateId}/checks`, {
  62  |       method: 'POST', headers: { 'Content-Type': 'application/json' }, body: item.body,
  63  |     });
  64  |     expect(item.expected, `${item.label} 的响应码不是预期：${response.status} ${response.text.slice(0, 200)}`).toContain(response.status);
  65  |     strictResults.push({ label: item.label, status: response.status, code: (response.body as any)?.error?.code });
  66  |   }
  67  |   record.strictBodies = strictResults;
  68  | 
  69  |   /* ---------- 同身份：第一次 POST 建 run，第二次返回同一 run ---------- */
  70  |   const first = await startChecks(fixture.base, createdA.candidateId);
  71  |   expect(first.status).toBe(202);
  72  |   const duplicate = await startChecks(fixture.base, createdA.candidateId);
  73  |   expect(duplicate.status, duplicate.text.slice(0, 200)).toBe(202);
  74  |   expect(duplicate.body.id, '同身份重复发起被当成了新 run').toBe(first.body.id);
  75  | 
  76  |   const run1 = await waitCheckRun(fixture.base, first.body.id, { timeoutMs: 300_000 });
  77  |   expect(run1.outcome).toBe('passed');
  78  | 
  79  |   /* ---------- 完成后取消：幂等，不能把 passed 改写成 cancelled ---------- */
  80  |   const cancelledAfterDone = await cancelCheckRun(fixture.base, run1.id);
  81  |   expect(cancelledAfterDone.status).toBe(200);
  82  |   expect(cancelledAfterDone.body.status).toBe('completed');
  83  |   expect(cancelledAfterDone.body.outcome).toBe('passed');
  84  | 
  85  |   /* ---------- 已完成的同身份再 POST：仍然返回同一个 run ---------- */
  86  |   const afterDone = await startChecks(fixture.base, createdA.candidateId);
  87  |   expect(afterDone.status).toBe(202);
  88  |   expect(afterDone.body.id).toBe(run1.id);
  89  | 
  90  |   /* ---------- 显式 rerun：新建 run，旧 run 仍是 passed ---------- */
  91  |   const rerun = await startChecks(fixture.base, createdA.candidateId, { rerun: true });
  92  |   expect(rerun.status, rerun.text.slice(0, 200)).toBe(202);
  93  |   expect(rerun.body.id).not.toBe(run1.id);
  94  |   expect((await getCheckRun(fixture.base, run1.id)).body.outcome).toBe('passed');
  95  |   const run2 = await waitCheckRun(fixture.base, rerun.body.id, { timeoutMs: 300_000 });
  96  |   expect(run2.outcome).toBe('passed');
  97  |   expect((await getCandidate(fixture.base, createdA.candidateId)).body.latestCheckRunId).toBe(run2.id);
  98  | 
  99  |   /* ---------- 证据被改：读取 409，采用 409 ---------- */
  100 |   const smokePath = path.join(fixture.dataDir, 'check-artifacts', run2.id, 'smoke.json');
  101 |   expect(existsSync(smokePath), `没有找到本次 run 的证据目录：${smokePath}`).toBe(true);
  102 |   const before = readFileSync(smokePath, 'utf8');
  103 |   appendFileSync(smokePath, '\n/* tampered by acceptance test */\n', 'utf8');
  104 |   const tampered = await readArtifact(fixture.base, run2.id, 'smoke.json');
  105 |   expect(tampered.status, `证据被改后仍能读取：${tampered.status}`).toBe(409);
  106 |   expect(JSON.parse(tampered.text).error?.code ?? tampered.text).toMatch(/EVIDENCE_CHANGED/);
  107 |   const adoptTampered = await adoptCandidate(fixture.base, createdA.candidateId);
  108 |   expect(adoptTampered.status).toBe(409);
  109 |   expect((adoptTampered.body as any)?.error?.code).toBe('CHECKS_NOT_PASSED');
  110 |   record.tamper = {
  111 |     runId: run2.id,
  112 |     artifactGet: tampered.status,
  113 |     adopt: { status: adoptTampered.status, code: (adoptTampered.body as any)?.error?.code },
  114 |     originalBytes: before.length,
  115 |   };
  116 |   // 撤回被篡改的候选（不改回证据，保留现场）
  117 |   expect((await httpJson(`${fixture.base}/candidates/${createdA.candidateId}/discard`, { method: 'POST' })).status).toBe(200);
  118 | 
  119 |   /* ---------- 主版本变化后旧绿灯失效 ---------- */
  120 |   const createdB = await createCandidate(fixture, CHANGE_B, { instruction: 'B：把按钮改成立刻下单' });
  121 |   const { run: run3 } = await startAndWatch(fixture, createdB.candidateId, { timeoutMs: 300_000 });
  122 |   expect(run3.outcome).toBe('passed');
  123 |   const versionBefore = (await getVersion(fixture.base)).body.version;
  124 |   appendFileSync(path.join(fixture.workRoot, 'src', 'App.tsx'), '\n// 验收准备：主作品直接改一行\n', 'utf8');
  125 |   const versionAfter = (await getVersion(fixture.base)).body.version;
  126 |   expect(versionAfter, '主作品没有产生新版本，过期用例不成立').not.toBe(versionBefore);
  127 |   const adoptedStale = await adoptCandidate(fixture.base, createdB.candidateId);
  128 |   expect(adoptedStale.status, adoptedStale.text.slice(0, 300)).toBe(409);
> 129 |   expect((adoptedStale.body as any)?.error?.code).toBe('STALE_CANDIDATE');
      |                                                   ^ Error: expect(received).toBe(expected) // Object.is equality
  130 |   record.stale = { runId: run3.id, versionBefore, versionAfter, status: adoptedStale.status, code: (adoptedStale.body as any)?.error?.code };
  131 | 
  132 |   /* ---------- 不存在的东西 ---------- */
  133 |   const unknownRun = await getCheckRun(fixture.base, 'ffffffffffffffff');
  134 |   expect(unknownRun.status).toBe(404);
  135 |   const unknownCandidate = await startChecks(fixture.base, 'not-a-candidate');
  136 |   expect([404, 409]).toContain(unknownCandidate.status);
  137 | 
  138 |   const currentWorkRoot = readFileSync(path.join(fixture.workRoot, 'src', 'App.tsx'), 'utf8');
  139 |   writeArtifact('gate.json', {
  140 |     candidateA: createdA.candidateId,
  141 |     run1: summarizeRun(run1),
  142 |     run2: summarizeRun(run2),
  143 |     run3: summarizeRun(run3),
  144 |     idempotent: { duplicate: duplicate.body.id === first.body.id, afterDone: afterDone.body.id === run1.id },
  145 |     rerunCreatedNew: rerun.body.id !== run1.id,
  146 |     cancelAfterDone: { status: cancelledAfterDone.body.status, outcome: cancelledAfterDone.body.outcome },
  147 |     ...record,
  148 |     mainChangedDirectly: currentWorkRoot.includes('验收准备：主作品直接改一行'),
  149 |   });
  150 | });
  151 | 
```