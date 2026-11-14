import { expect, test } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MOCK_BASE, adoptCandidate, answerApproval, cancelTask, discardCandidate, getApproval, getCandidate, getTask, getVersion,
  history, http, jsonRequest, listApprovals, listCandidates, listTasks, mockStats, removeFixture, resetMock,
  selection, setScript, sleep, startBackendFixture, startMockAgent, submit, waitFor, waitTask, type Fixture,
} from './fixture';

const LOCAL = [
  [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '一份给自己，也给生活的温柔礼物。', new: '给自己一份安静的礼物。' } }],
  [{ name: 'finish', args: { summary: '局部文案已修改' } }],
];
const SHARED = [
  [{ name: 'replace_in_file', args: { path: 'src/components/Button.tsx', old: '<button type="button"', new: '<button type="button" style={{ borderRadius: 12 }}' } }],
  [{ name: 'finish', args: { summary: '共享按钮圆角已修改' } }],
];
const GLOBAL = [
  [{ name: 'replace_in_file', args: { path: 'src/style.css', old: 'border-radius: 3px;', new: 'border-radius: 12px;' } }],
  [{ name: 'finish', args: { summary: '全局样式已修改' } }],
];
const MULTI = [
  [{ name: 'replace_in_file', args: { path: 'src/components/Button.tsx', old: '<button type="button"', new: '<button type="button" style={{ borderRadius: 12 }}' } }],
  [{ name: 'replace_in_file', args: { path: 'src/style.css', old: 'border-radius: 3px;', new: 'border-radius: 12px;' } }],
  [{ name: 'finish', args: { summary: '共享组件和全局样式已修改' } }],
];
const OUT = [
  [{ name: 'replace_in_file', args: { path: 'src/components/ProductHero.tsx', old: 'data-testid="product-scene"', new: 'data-testid="product-scene" data-probe="1"' } }],
  [{ name: 'finish', args: { summary: '越范围修改' } }],
];
const PACKAGE = [
  [{ name: 'write_file', args: { path: 'package.json', content: '{"changed":true}\n' } }],
  [{ name: 'finish', args: { summary: '试图修改构建配置' } }],
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

async function fixture(options: { previewFail?: 'all' | 'once'; customizer?: (workRoot: string) => void } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'm3a-e2e-'));
  const created = await startBackendFixture({ root, ...options });
  fixtures.push(created);
  return created;
}

function pendingCards(f: Fixture, taskId?: string) {
  return listApprovals(f.base).then((result) => result.body.filter((card: any) => card.status === 'pending' && (!taskId || card.taskId === taskId)));
}
async function createTask(f: Fixture, instruction: string, steps: unknown[], sel?: ReturnType<typeof selection>) {
  await resetMock();
  await setScript(steps);
  return submit(f.base, instruction, sel);
}
async function createAwaiting(f: Fixture, instruction = 'shared radius', steps: unknown[] = SHARED, sel?: ReturnType<typeof selection>) {
  const base = (await getVersion(f.base)).body.version;
  const task = await createTask(f, instruction, steps, sel ?? selection(base, 'src/components/Button.tsx:5:5', { instances: 3, ancestors: ['src/App.tsx:26:11'] }));
  await waitTask(f.base, task.id);
  const current = (await getTask(f.base, task.id)).body;
  const card = (await pendingCards(f, task.id))[0];
  expect(card, '应产生待批准卡').toBeTruthy();
  return { task: current, card, base };
}
function rawStatus(f: Fixture, pathname: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(f.base);
    const request = httpRequest({ hostname: url.hostname, port: url.port, path: pathname, method: 'GET', headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
    request.end();
  });
}
function postRaw(f: Fixture, cardId: string, body: string) {
  return http(`${f.base}/approvals/${cardId}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
}

test.describe.configure({ mode: 'serial' });

test('局部 App 文案直接产出候选，不产生请示；checks 保持 not_run', async () => {
  const f = await fixture();
  const base = (await getVersion(f.base)).body.version;
  const task = await createTask(f, '局部文案', LOCAL, selection(base, 'src/App.tsx:30:11'));
  const done = await waitTask(f.base, task.id);
  expect(done.status, JSON.stringify(done.error)).toBe('done');
  expect((await listApprovals(f.base)).body).toHaveLength(0);
  const candidates = (await listCandidates(f.base)).body;
  expect(candidates).toHaveLength(1);
  const candidate = await getCandidate(f.base, done.candidateId);
  expect(candidate.status).toBe(200);
  expect(candidate.body.checks.map((check: any) => check.status)).toEqual(['not_run', 'not_run', 'not_run', 'not_run']);
  expect(await readFile(path.join(f.workRoot, 'src/App.tsx'), 'utf8')).toContain('立即购买');
});

test('共享 Button：批准前私有、不公开候选/预览；批准不增加模型调用；等待不堵队列', async () => {
  const f = await fixture();
  const beforeButton = await readFile(path.join(f.workRoot, 'src/components/Button.tsx'), 'utf8');
  const { task, card, base } = await createAwaiting(f);
  expect(task.status).toBe('awaiting_approval');
  expect((await listCandidates(f.base)).body).toEqual([]);
  expect((await getCandidate(f.base, task.id)).status).toBe(404);
  expect((await adoptCandidate(f.base, task.id)).status).toBe(404);
  const previewProbe = await http(`${f.previewOrigin}/preview/c/${task.id}/`);
  expect(previewProbe.status).not.toBe(200);
  expect(await readFile(path.join(f.workRoot, 'src/components/Button.tsx'), 'utf8')).toBe(beforeButton);
  expect((await getVersion(f.base)).body.version).toBe(base);
  expect((await history(f.base)).body.events.filter((event: any) => event.type === 'candidate.ready')).toHaveLength(0);

  // 等待不占队列：下一条安全局部任务直接完成
  const local = await createTask(f, '排队期间局部文案', LOCAL, selection(base, 'src/App.tsx:30:11'));
  const localDone = await waitTask(f.base, local.id);
  expect(localDone.status).toBe('done');

  const callsBefore = (await mockStats()).body.calls;
  const approved = await answerApproval(f.base, card.id, 0);
  expect(approved.status, approved.text).toBe(200);
  expect(approved.body.approval.status).toBe('approved');
  expect(approved.body.task.status).toBe('done');
  expect((await mockStats()).body.calls).toBe(callsBefore);
  const candidates = (await listCandidates(f.base)).body;
  expect(candidates.some((candidate: any) => candidate.id === task.id)).toBe(true);
  const candidate = (await getCandidate(f.base, task.id)).body;
  expect(candidate.diff.map((file: any) => file.path)).toEqual(['src/components/Button.tsx']);
  expect((await http(`${f.previewOrigin}${candidate.previewUrl}`)).status).toBe(200);
  const events = (await history(f.base)).body.events;
  expect(events.filter((event: any) => event.type === 'approval.requested')).toHaveLength(1);
  expect(events.filter((event: any) => event.type === 'approval.resolved')).toHaveLength(1);
  expect(events.filter((event: any) => event.type === 'candidate.ready' && event.candidate?.id === task.id)).toHaveLength(1);
  const adopted = await adoptCandidate(f.base, task.id);
  expect(adopted.status).toBe(200);
  expect(await readFile(path.join(f.workRoot, 'src/components/Button.tsx'), 'utf8')).not.toBe(beforeButton);
  expect((await http(`${f.base}/version/revert`, { method: 'POST' })).status).toBe(200);
  expect(await readFile(path.join(f.workRoot, 'src/components/Button.tsx'), 'utf8')).toBe(beforeButton);
});

test('多规则合并一张卡：shared_component + global_style，不产生多张', async () => {
  const f = await fixture();
  const { task, card } = await createAwaiting(f, 'shared + global', MULTI);
  expect(card.ruleCodes).toEqual(expect.arrayContaining(['shared_component', 'global_style']));
  expect((await pendingCards(f)).length).toBe(1);
  const rejected = await answerApproval(f.base, card.id, 1);
  expect(rejected.body.approval.status).toBe('rejected');
  expect(rejected.body.task.status).toBe('cancelled');
  expect((await listCandidates(f.base)).body).toEqual([]);
  expect(await getCandidate(f.base, task.id)).toMatchObject({ status: 404 });
});

test('越范围与无 selection 都请示；拒绝/取消只清自己', async () => {
  const f = await fixture();
  const base = (await getVersion(f.base)).body.version;
  const out = await createAwaiting(f, 'out of scope', OUT, selection(base, 'src/App.tsx:23:11'));
  expect(out.card.ruleCodes).toContain('out_of_scope');
  const noSelection = await createTask(f, '无选中对象修改', LOCAL);
  await waitTask(f.base, noSelection.id);
  const noSelCards = await pendingCards(f, noSelection.id);
  expect(noSelCards).toHaveLength(1);
  expect(noSelCards[0].ruleCodes).toContain('out_of_scope');
  const rejected = await answerApproval(f.base, out.card.id, 1);
  expect(rejected.status).toBe(200);
  const cancelled = await cancelTask(f.base, noSelection.id);
  expect(cancelled.status).toBe(200);
  expect((await listCandidates(f.base)).body).toEqual([]);
  await expect.poll(async () => (await getTask(f.base, noSelection.id)).body.status).toBe('cancelled');
  expect((await listApprovals(f.base)).body.filter((card: any) => card.status === 'pending')).toHaveLength(0);
});

test('package/build 配置始终硬拒绝：无请示、无候选、原文件不变', async () => {
  const f = await fixture();
  const before = await readFile(path.join(f.workRoot, 'package.json'), 'utf8');
  const base = (await getVersion(f.base)).body.version;
  const task = await createTask(f, '修改构建配置', PACKAGE, selection(base, 'src/App.tsx:23:11'));
  const failed = await waitTask(f.base, task.id);
  expect(failed.status).toBe('failed');
  expect((await listApprovals(f.base)).body).toHaveLength(0);
  expect((await listCandidates(f.base)).body).toHaveLength(0);
  expect(await readFile(path.join(f.workRoot, 'package.json'), 'utf8')).toBe(before);
});

test('pending 上限 3：第四张 APPROVAL_LIMIT，只清自己；释放后新任务可申请', async () => {
  const f = await fixture();
  const cards: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const { card } = await createAwaiting(f, `shared ${index}`);
    cards.push(card.id);
  }
  expect((await pendingCards(f)).length).toBe(3);
  const base = (await getVersion(f.base)).body.version;
  const overflow = await createTask(f, 'shared overflow', SHARED, selection(base, 'src/components/Button.tsx:5:5', { instances: 3 }));
  const overflowTask = await waitTask(f.base, overflow.id);
  expect(overflowTask.status).toBe('failed');
  expect(overflowTask.error.code).toBe('APPROVAL_LIMIT');
  expect((await pendingCards(f)).length).toBe(3);
  expect((await listCandidates(f.base)).body).toHaveLength(0);
  expect((await answerApproval(f.base, cards[0], 1)).status).toBe(200);
  expect((await pendingCards(f)).length).toBe(2);
  const next = await createAwaiting(f, 'shared after release');
  expect(next.card.status).toBe('pending');
});

test('option 只接受原始 JSON 0/1；同答幂等、反答 409、取消/并发只有一终局', async () => {
  const f = await fixture();
  const { card } = await createAwaiting(f);
  for (const body of ['{"option":"0"}', '{"option":0.5}', '{"option":2}', '{"option":null}', '{"option":0,"extra":true}']) {
    const response = await postRaw(f, card.id, body);
    expect(response.status, body).toBe(400);
    expect(response.body.error.code).toBe('INVALID_OPTION');
  }
  const accepted = await postRaw(f, card.id, '{"option":0.0}');
  expect(accepted.status).toBe(200);
  expect(accepted.body.approval.status).toBe('approved');
  const repeated = await postRaw(f, card.id, '{"option":0.0}');
  expect(repeated.status).toBe(200);
  expect(repeated.body).toEqual(accepted.body);
  const opposite = await postRaw(f, card.id, '{"option":1}');
  expect(opposite.status).toBe(409);
  expect(opposite.body.error.code).toBe('APPROVAL_ALREADY_ANSWERED');

  const second = await createAwaiting(f, 'reject by 1e0');
  const rejected = await postRaw(f, second.card.id, '{"option":1e0}');
  expect(rejected.status).toBe(200);
  expect(rejected.body.approval.status).toBe('rejected');

  const third = await createAwaiting(f, 'cancel awaiting');
  const cancelled = await cancelTask(f.base, third.task.id);
  expect(cancelled.status).toBe(200);
  const cancelledAnswer = await answerApproval(f.base, third.card.id, 0);
  expect(cancelledAnswer.status).toBe(409);
  expect(['APPROVAL_NOT_PENDING', 'APPROVAL_ALREADY_ANSWERED']).toContain(cancelledAnswer.body.error.code);
  const cancelledAgain = await answerApproval(f.base, third.card.id, 1);
  expect(cancelledAgain.status).toBe(409);
  expect(cancelledAgain.body.error.code).toBe(cancelledAnswer.body.error.code);

  const fourth = await createAwaiting(f, 'concurrent answer');
  const results = await Promise.all([answerApproval(f.base, fourth.card.id, 0), answerApproval(f.base, fourth.card.id, 1), cancelTask(f.base, fourth.task.id)]);
  const successes = results.filter((result) => result.status === 200).length;
  expect(successes).toBeLessThanOrEqual(1);
  const finalCard = (await getApproval(f.base, fourth.card.id)).body;
  expect(['approved', 'rejected', 'cancelled']).toContain(finalCard.status);
  const finalTask = (await getTask(f.base, fourth.task.id)).body;
  expect(['done', 'cancelled']).toContain(finalTask.status);
});

test('主作品版本变化 → 批准 409 STALE_APPROVAL，卡片 stale/任务 failed/名额释放/重复回答稳定 409', async () => {
  const f = await fixture();
  const { task, card } = await createAwaiting(f);
  await writeFile(path.join(f.workRoot, 'src/App.tsx'), `${await readFile(path.join(f.workRoot, 'src/App.tsx'), 'utf8')}\n// stale probe\n`);
  const changedVersion = (await getVersion(f.base)).body.version;
  expect(changedVersion).not.toBe(card.baseVersion);
  const stale = await answerApproval(f.base, card.id, 0);
  expect(stale.status).toBe(409);
  expect(stale.body.error.code).toBe('STALE_APPROVAL');
  expect((await getApproval(f.base, card.id)).body.status).toBe('stale');
  expect((await getTask(f.base, task.id)).body).toMatchObject({ status: 'failed', error: { code: 'STALE_APPROVAL' } });
  expect((await pendingCards(f)).length).toBe(0);
  expect((await listCandidates(f.base)).body).toHaveLength(0);
  expect((await answerApproval(f.base, card.id, 0)).status).toBe(409);
  expect((await answerApproval(f.base, card.id, 1)).status).toBe(409);
  const next = await createAwaiting(f, 'new risk after stale');
  expect(next.card.status).toBe('pending');
});

test('重启保留等待卡/staging，不重跑模型；损坏 tasks.json 拒绝启动而非静默重置', async () => {
  const f = await fixture();
  const { task, card, base } = await createAwaiting(f);
  const calls = (await mockStats()).body.calls;
  await f.stop();
  fixtures.pop();
  const restarted = await startBackendFixture({ root: f.root, reuse: { workRoot: f.workRoot, dataDir: f.dataDir } });
  fixtures.push(restarted);
  expect((await listApprovals(restarted.base)).body.find((item: any) => item.id === card.id)?.status).toBe('pending');
  expect((await getTask(restarted.base, task.id)).body.status).toBe('awaiting_approval');
  expect(await readdir(path.join(restarted.dataDir, 'candidates'))).toContain(task.id);
  const approved = await answerApproval(restarted.base, card.id, 0);
  expect(approved.status).toBe(200);
  expect(approved.body.task.status).toBe('done');
  expect((await mockStats()).body.calls).toBe(calls);
  expect((await getVersion(restarted.base)).body.version).toBe(base);

  await restarted.stop();
  fixtures.pop();
  const tasksFile = path.join(restarted.dataDir, 'tasks.json');
  await writeFile(tasksFile, '{not-json');
  let rejected = false;
  try {
    const broken = await startBackendFixture({ root: f.root, reuse: { workRoot: f.workRoot, dataDir: f.dataDir } });
    fixtures.push(broken);
  } catch (error) {
    rejected = /createApp rejected|无法读取|Invalid|tasks\.json/i.test(String(error));
  }
  expect(rejected, '损坏 tasks.json 应拒绝启动').toBe(true);
  removeFixture(f.root);
});

test('R1：首次批准预览失败 → failed/PREVIEW_FAILED，无候选；另一卡仍可回答，同答不重启预览', async () => {
  const f = await fixture({ previewFail: 'once' });
  const a = await createAwaiting(f, 'preview fail A');
  const b = await createAwaiting(f, 'preview fail B');
  const calls = (await mockStats()).body.calls;
  const failed = await answerApproval(f.base, a.card.id, 0);
  expect(failed.status, failed.text).toBe(200);
  expect(failed.body.approval.status).toBe('failed');
  expect(failed.body.task.status).toBe('failed');
  expect(failed.body.task.error.code).toBe('PREVIEW_FAILED');
  expect((await listCandidates(f.base)).body).toHaveLength(0);
  expect((await history(f.base)).body.events.filter((event: any) => event.type === 'candidate.ready')).toHaveLength(0);
  expect(JSON.stringify(failed.body)).not.toContain(f.dataDir);
  const repeated = await answerApproval(f.base, a.card.id, 0);
  expect(repeated.status).toBe(200);
  expect(repeated.body.approval.status).toBe('failed');
  expect((await mockStats()).body.calls).toBe(calls);
  const bAnswer = await answerApproval(f.base, b.card.id, 0);
  expect(bAnswer.status, bAnswer.text).toBe(200);
  expect(bAnswer.body.approval.status).toBe('approved');
  const candidate = (await listCandidates(f.base)).body.find((item: any) => item.id === b.task.id);
  expect(candidate).toBeTruthy();
  expect((await http(`${f.previewOrigin}${candidate.previewUrl}`)).status).toBe(200);
  expect((await getApproval(f.base, a.card.id)).body.status).toBe('failed');
});

test('别名/default/barrel 的共享组件仍请示；无绝对路径/跨源保护不回退', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'm3a-alias-'));
  const f = await startBackendFixture({
    root,
    customizer: (workRoot) => {
      writeFileSync(path.join(workRoot, 'src/components/AliasButton.tsx'), 'export default function AliasButton(){ return <button>Alias</button>; }\n');
      writeFileSync(path.join(workRoot, 'src/components/barrel.ts'), "export { default as AliasButton } from './AliasButton';\n");
      const appPath = path.join(workRoot, 'src/App.tsx');
      let app = readFileSync(appPath, 'utf8');
      app = app.replace("import { ProductHero } from './components/ProductHero';", "import { ProductHero } from './components/ProductHero';\nimport { AliasButton as Alias } from './components/barrel';");
      app = app.replace('<footer>', '<div className="alias-row"><Alias/><Alias/><Alias/></div>\n      <footer>');
      writeFileSync(appPath, app);
    },
  });
  fixtures.push(f);
  const f2 = f;
  const base = (await getVersion(f2.base)).body.version;
  const script = [
    [{ name: 'replace_in_file', args: { path: 'src/components/AliasButton.tsx', old: '<button>Alias</button>', new: '<button style={{ borderRadius: 12 }}>Alias</button>' } }],
    [{ name: 'finish', args: { summary: 'alias shared' } }],
  ];
  const task = await createTask(f2, 'alias shared', script, selection(base, 'src/components/AliasButton.tsx:1:1'));
  await waitTask(f2.base, task.id);
  const cards = await pendingCards(f2, task.id);
  expect(cards).toHaveLength(1);
  expect(cards[0].ruleCodes).toContain('shared_component');
  const listed = await listApprovals(f2.base);
  expect(JSON.stringify(listed.body)).not.toContain(f2.dataDir);
  expect(await rawStatus(f2, '/approvals', { Host: 'evil.example' })).toBe(403);
  expect(await rawStatus(f2, '/approvals', { Origin: 'https://evil.example' })).toBe(403);
});
