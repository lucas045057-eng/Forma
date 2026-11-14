import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  REQUIRED_ARTIFACTS, CHECK_ORDER, adoptCandidate, assertPassedRun, getCandidate, history, readArtifact, revertVersion, sha256, startChecks,
} from './checks';
import { summarizeRun, writeArtifact } from './artifact';
import {
  createCandidate, getVersion, removeFixture, resetMock, setScript, startAndWatch, startFixture, startMockAgent, type Fixture,
} from './fixture';

/**
 * M3-B 成功路径（独立验收准备，不是正式验收）：
 * 真实候选 → 四项真检查（真 Vite 构建 + 真 Chromium）→ 六份证据 → 采用 → 回退。
 */

const LOCAL = [
  [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
  [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '一份给自己，也给生活的温柔礼物。', new: '给自己一份安静的礼物。' } }],
  [{ name: 'finish', args: { summary: '局部文案已修改' } }],
];

let mock: Awaited<ReturnType<typeof startMockAgent>>;
const fixtures: Fixture[] = [];

test.beforeAll(async () => { mock = await startMockAgent(); });
test.afterAll(async () => { await mock.stop(); });
test.afterEach(async () => {
  while (fixtures.length) {
    const fixture = fixtures.pop()!;
    await fixture.stop().catch(() => {});
    removeFixture(fixture.root);
  }
});

test.describe.configure({ mode: 'serial' });

test('四项真实检查通过 → 证据可读 → 采用 → 回退', async () => {
  test.setTimeout(420_000);
  const root = path.join(process.cwd(), '.data', `m3b-accept-${Date.now().toString(36)}`);
  const fixture = await startFixture({ root });
  fixtures.push(fixture);

  const versionBefore = (await getVersion(fixture.base)).body.version;
  const created = await createCandidate(fixture, LOCAL, { instruction: '把介绍文案改成安静的礼物' });
  const candidateId = created.candidateId;

  // 检查前：四项 not_run、没有 run 引用；采用被门禁拒绝（不能自动放行）
  expect(created.candidate.checks.map((check: any) => check.status)).toEqual(['not_run', 'not_run', 'not_run', 'not_run']);
  expect(created.candidate.latestCheckRunId ?? null).toBeNull();
  const earlyAdopt = await adoptCandidate(fixture.base, candidateId);
  expect(earlyAdopt.status, `未检查就采用应被拒绝：${earlyAdopt.text.slice(0, 200)}`).toBe(409);
  expect((earlyAdopt.body as any)?.error?.code).toBe('CHECKS_NOT_PASSED');

  // 发起检查：202，run 属于本候选、四项初始 not_run
  const started = await startChecks(fixture.base, candidateId);
  expect(started.status, started.text.slice(0, 300)).toBe(202);
  expect(started.body.id).toMatch(/^[a-z0-9]{6,32}$/);
  expect(started.body.candidateId).toBe(candidateId);
  expect(started.body.status === 'queued' || started.body.status === 'running').toBe(true);
  expect(started.body.checks.map((check) => check.name)).toEqual([...CHECK_ORDER]);

  const { run } = await startAndWatch(fixture, candidateId, { timeoutMs: 300_000 });
  expect(run.id).toBe(started.body.id);
  expect(run.candidateId).toBe(candidateId);
  expect(run.baseVersion).toBe(versionBefore);
  assertPassedRun(run);
  expect(run.checks.every((check) => typeof check.durationMs === 'number' && check.durationMs >= 0)).toBe(true);
  expect(run.error).toBeUndefined();

  // 检查跑完的候选视图：四项 passed，且都指向本次 run
  const afterRun = (await getCandidate(fixture.base, candidateId)).body;
  expect(afterRun.latestCheckRunId).toBe(run.id);
  expect(afterRun.checks.map((check: any) => check.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
  expect(afterRun.checks.every((check: any) => check.runId === run.id)).toBe(true);
  // 检查本身不改作品
  expect((await getVersion(fixture.base)).body.version).toBe(versionBefore);
  expect(readFileSync(path.join(fixture.workRoot, 'src', 'App.tsx'), 'utf8')).toContain('一份给自己，也给生活的温柔礼物。');

  // 证据读取：六份必需证据都能取到，字节数与 sha256 与 run 记录一致
  const refs = run.artifacts ?? [];
  expect(new Set(refs.map((ref) => ref.name)).size).toBe(refs.length);
  const artifactChecks: Array<Record<string, unknown>> = [];
  for (const ref of refs) {
    const response = await readArtifact(fixture.base, run.id, ref.name);
    expect(response.status, `读取证据 ${ref.name} 失败`).toBe(200);
    expect(response.bytes.length, `证据 ${ref.name} 字节数不符`).toBe(ref.bytes);
    expect(sha256(response.bytes), `证据 ${ref.name} sha256 不符`).toBe(ref.hash);
    expect(response.headers['etag']).toBe(`"${ref.hash}"`);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-type']).toBe(ref.mime);
    artifactChecks.push({ name: ref.name, bytes: ref.bytes, mime: ref.mime, hash: ref.hash });
  }
  for (const required of REQUIRED_ARTIFACTS) {
    expect(refs.map((ref) => ref.name), `缺少证据 ${required}`).toContain(required);
  }
  // 证据摘要绑定：每个检查的 evidence 必须等于对应证据文件的 hash
  for (const check of run.checks) {
    const name = check.name === 'build' ? 'build.log' : `${check.name}.json`;
    expect(check.evidence, `${check.name} 的证据摘要没有绑定 ${name}`).toBe(refs.find((ref) => ref.name === name)?.hash);
  }

  // 未知证据名 / 路径穿越：不能读到东西
  const unknown = await readArtifact(fixture.base, run.id, 'unknown.json');
  expect(unknown.status).toBe(404);
  const traversal = await readArtifact(fixture.base, run.id, '..%2F..%2Ftasks.json');
  expect([403, 404]).toContain(traversal.status);
  expect((await readArtifact(fixture.base, 'ffffffff00000000', 'smoke.json')).status).toBe(404);

  // 证据内容本身是不是真检查（不是 mock 标签）
  const schema = JSON.parse((await readArtifact(fixture.base, run.id, 'schema.json')).text);
  expect(schema.status).toBe('passed');
  expect(schema.configHash).toMatch(/^[0-9a-f]{64}$/);
  const smoke = JSON.parse((await readArtifact(fixture.base, run.id, 'smoke.json')).text);
  expect(smoke.viewport).toEqual({ width: 1440, height: 900 });
  expect(smoke.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
  expect(String(smoke.browserVersion)).toMatch(/\d+\.\d+/);
  expect(smoke.purchases?.after).toBe(smoke.purchases?.before + 1);
  expect(String(smoke.feedback ?? '').trim().length).toBeGreaterThan(0);
  expect(smoke.pageErrors).toEqual([]);
  expect(smoke.blockedRequests).toEqual([]);
  expect(['ready', 'fallback']).toContain(smoke.scene?.state);
  const occlusion = JSON.parse((await readArtifact(fixture.base, run.id, 'occlusion.json')).text);
  expect(Array.isArray(occlusion.targets) && occlusion.targets.length > 0).toBe(true);
  expect(occlusion.targets.every((target: any) => target.passed === true)).toBe(true);
  const buy = occlusion.targets.find((target: any) => target.testId === 'buy-button');
  expect(buy, '遮挡报告里没有购买入口').toBeTruthy();
  expect(buy.centerHit, '购买入口中心没有命中自己').toBe(true);
  expect(occlusion.targets.every((target: any) => Array.isArray(target.samples) && target.samples.length > 0)).toBe(true);
  for (const target of occlusion.targets) expect(target.rect.width > 0 && target.rect.height > 0).toBe(true);

  // 事件：先落盘再广播（history 里能查到本次 run 的 check.started/finished）
  const journal = (await history(fixture.base, 0)).body;
  const runEvents = journal.events.filter((event) => String(event.type).startsWith('check.'));
  expect(runEvents.some((event) => event.type === 'check.finished' && event.run?.id === run.id), '事件里没有 check.finished').toBe(true);
  const finished = runEvents.filter((event) => event.type === 'check.finished' && event.run?.id === run.id).at(-1)!;
  expect(finished.run.outcome).toBe('passed');

  // 采用：门禁通过后才允许；采用后作品变化、候选关闭
  const adopted = await adoptCandidate(fixture.base, candidateId);
  expect(adopted.status, adopted.text.slice(0, 300)).toBe(200);
  const versionAfter = (await getVersion(fixture.base)).body.version;
  expect(versionAfter).not.toBe(versionBefore);
  expect(readFileSync(path.join(fixture.workRoot, 'src', 'App.tsx'), 'utf8')).toContain('给自己一份安静的礼物。');
  expect((await getCandidate(fixture.base, candidateId)).body.decision).toBe('adopted');
  const adoptEvent = (await history(fixture.base, 0)).body.events.filter((event) => event.type === 'version.changed' && event.reason === 'adopt').at(-1);
  expect(adoptEvent, '没有 version.changed(adopt) 事件').toBeTruthy();
  expect(adoptEvent!.seq, '检查事件应早于采用事件').toBeGreaterThan(finished.seq);

  // 回退：作品恢复
  const reverted = await revertVersion(fixture.base);
  expect(reverted.status, reverted.text.slice(0, 300)).toBe(200);
  expect(readFileSync(path.join(fixture.workRoot, 'src', 'App.tsx'), 'utf8')).toContain('一份给自己，也给生活的温柔礼物。');
  expect(readFileSync(path.join(fixture.workRoot, 'src', 'App.tsx'), 'utf8')).not.toContain('给自己一份安静的礼物。');

  writeArtifact('happy-path.json', {
    candidateId,
    versionBefore,
    versionAfter,
    run: summarizeRun(run),
    artifacts: artifactChecks,
    artifactRejections: { unknown: unknown.status, traversal: traversal.status, unknownRun: 404 },
    schema,
    smoke: { viewport: smoke.viewport, url: smoke.url, browserVersion: smoke.browserVersion, scene: smoke.scene, purchases: smoke.purchases, feedback: smoke.feedback, pageErrors: smoke.pageErrors, blockedRequests: smoke.blockedRequests },
    occlusion: {
      targetCount: occlusion.targets.length,
      excluded: (occlusion.excluded ?? []).map((item: any) => item.reason),
      buyButton: buy,
    },
    events: { finishedSeq: finished.seq, adoptSeq: adoptEvent!.seq, types: [...new Set(journal.events.map((event) => event.type))] },
  });
});

