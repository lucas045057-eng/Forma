import { expect, test, type Frame, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CASES, type CaseDef } from './cases';
import {
  AGENT_BUDGET_MS, API_BASE, PREVIEW_BASE, STUDIO_URL, createWorkRoot, discardCandidate, flatten, getCandidate,
  getTask, getVersion, httpJson, json, listCandidates, mockAgentConfig, readAgentEnv, removeTree, resetMock,
  revertVersion, setMockScript, snapshotInPage, startStack, waitFor, workDigest, writeJson, type Snapshot,
} from './helpers';

const MODE = process.env.REAL_MODEL_MODE === 'real' ? 'real' as const : 'mock' as const;
const RUN_DIR = process.env.REAL_MODEL_RUN_DIR;
if (!RUN_DIR) throw new Error('REAL_MODEL_RUN_DIR 未设置');
const LIMIT = Number(process.env.REAL_MODEL_CASE_LIMIT ?? CASES.length);
const MIN_PASS = Number(process.env.REAL_MODEL_MIN_PASS ?? (MODE === 'real' ? 8 : Math.min(LIMIT, CASES.length)));
const SHOTS = path.join(RUN_DIR, 'screenshots');
const TASKS = path.join(RUN_DIR, 'tasks');
mkdirSync(SHOTS, { recursive: true });
mkdirSync(TASKS, { recursive: true });

const normalize = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
const roundCount = (events: Array<{ message?: string }>) => {
  let max = 0;
  for (const event of events) {
    const match = /请求编码模型（第 (\d+)\/\d+ 轮）/.exec(event.message ?? '');
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max;
};

async function frameOf(page: Page, testId: string): Promise<Frame> {
  const handle = await page.locator(`[data-testid="${testId}"]`).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error(`没有取到 ${testId} iframe`);
  return frame;
}

async function pickElement(page: Page, selector: string) {
  await page.getByTestId('pick-toggle').click();
  const frame = await frameOf(page, 'preview-frame');
  const target = frame.locator(selector).first();
  await target.waitFor({ state: 'visible', timeout: 60_000 });
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error(`找不到选中对象 ${selector}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('[data-testid="selection-json"]').waitFor({ state: 'visible', timeout: 30_000 });
  const selection = JSON.parse(await page.locator('[data-testid="selection-json"]').innerText()) as Record<string, unknown>;
  await page.getByTestId('pick-toggle').click();
  return selection;
}

async function waitFrameSceneReady(frame: Frame, timeoutMs = 60_000) {
  await waitFor(async () => {
    try { return (await frame.evaluate(() => document.querySelector('[data-testid="product-scene"]')?.getAttribute('data-state'))) === 'ready'; }
    catch { return false; }
  }, timeoutMs, 300);
}

function assertOnlyAllowed(baseline: Record<string, unknown>, after: Record<string, unknown>, allowed: string[], label: string) {
  expect(Object.keys(after).sort(), `${label}: 快照键变化`).toEqual(Object.keys(baseline).sort());
  for (const key of Object.keys(baseline)) {
    if (allowed.includes(key)) continue;
    expect(after[key], `${label}: 非目标字段 ${key} 发生变化`).toEqual(baseline[key]);
  }
}

function effectReady(caseDef: CaseDef, snapshot: Snapshot, baseline: Snapshot): boolean {
  const buttons = snapshot.buttons as Record<string, any>;
  const benefits = snapshot.benefits as Array<{ h3Size: string }>;
  switch (caseDef.id) {
    case 1: return snapshot.buttonTexts?.['buy-button'] === '加入购物袋';
    case 2: return snapshot.h1 === '把森林，带回家。';
    case 3: return String(snapshot.price).includes('¥ 198');
    case 4: return snapshot.navText === '探索香气';
    case 5: return snapshot.fine === '给自己一份安静的礼物。';
    case 6: return (snapshot.introStyle as any)?.['font-size'] === '16px';
    case 7: return snapshot.actionsGap === '24px';
    case 8: return ['buy-button', 'save-button', 'gift-button'].every((id) => buttons[id]?.radius === '12px');
    case 9: return benefits?.every((item) => item.h3Size === '20px');
    case 10: return snapshot.sceneState === 'ready';
    default: return false;
  }
}

function mockStepsFor(caseDef: CaseDef, workRoot: string) {
  if (caseDef.id !== 10) return caseDef.mockSteps;
  const config = JSON.parse(readFileSync(path.join(workRoot, 'src', 'scene.config.json'), 'utf8'));
  config.hero.lights.ambient = 0.8;
  return [
    [{ name: 'write_file', args: { path: 'src/scene.config.json', content: `${JSON.stringify(config, null, 2)}\n` } }],
    [{ name: 'finish', args: { summary: '环境光强度已改为 0.8' } }],
  ];
}

test.describe.configure({ mode: 'serial' });

test('固定十题真实模型验收（同一冻结实现）', async ({ page }) => {
  test.setTimeout(60 * 60_000);
  const agent = MODE === 'real' ? readAgentEnv() : mockAgentConfig();
  const startedAt = new Date().toISOString();
  const results: Array<Record<string, any>> = [];
  let notStarted = false;
  const cases = CASES.slice(0, Math.max(0, Math.min(LIMIT, CASES.length)));

  for (const caseDef of cases) {
    const taskStarted = Date.now();
    const taskRoot = path.join(TASKS, `${caseDef.id}`);
    const workRoot = path.join(taskRoot, 'work');
    const dataDir = path.join(taskRoot, 'data');
    const record: Record<string, any> = {
      id: caseDef.id, title: caseDef.title, instruction: caseDef.instruction, selector: caseDef.selector,
      mode: MODE, agentSource: agent.source, taskStartedAt: new Date().toISOString(),
    };
    let stack: Awaited<ReturnType<typeof startStack>> | null = null;
    let adoptedVersion: string | null = null;
    try {
      createWorkRoot(workRoot);
      const baselineDigest = workDigest(workRoot);
      const baselineConfig = readFileSync(path.join(workRoot, 'src', 'scene.config.json'), 'utf8');
      record.workDigest = { baseline: baselineDigest };
      stack = await startStack({ workRoot, dataDir, agent, mode: MODE });

      await page.goto(STUDIO_URL);
      await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 60_000 });
      await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 60_000 });
      const mainFrame = await frameOf(page, 'preview-frame');
      await mainFrame.locator('[data-testid="buy-button"]').waitFor({ state: 'visible', timeout: 60_000 });
      await waitFrameSceneReady(mainFrame);
      const baseline = await mainFrame.evaluate(snapshotInPage) as Snapshot;
      const baselineFlat = flatten(baseline);
      const baselineVersion = (await getVersion()).body.version as string;
      record.baselineVersion = baselineVersion;
      record.baselineSnapshot = baseline;
      record.baselineSceneConfig = JSON.parse(baselineConfig);

      const selection = await pickElement(page, caseDef.selector);
      record.selection = selection;
      if (!selection.src || !selection.baseVersion) throw new Error('点选没有返回 src/baseVersion');
      await page.getByTestId('instruction-input').fill(caseDef.instruction);

      if (MODE === 'mock') {
        await resetMock();
        await setMockScript(mockStepsFor(caseDef, workRoot), 0);
      }

      const [submitResponse] = await Promise.all([
        page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/tasks', { timeout: 30_000 }),
        page.getByTestId('generate-candidate').click(),
      ]);
      const submitted = await submitResponse.json() as { id: string; status: string };
      record.taskId = submitted.id;
      record.session = submitted.id;
      record.submittedAt = new Date().toISOString();

      let task: any = null;
      try {
        await waitFor(async () => {
          task = (await getTask(submitted.id)).body;
          return ['done', 'failed', 'cancelled'].includes(task.status);
        }, AGENT_BUDGET_MS + 30_000, 300);
      } catch (error) {
        await httpJson(`${API_BASE}/tasks/${submitted.id}/cancel`, { method: 'POST' }).catch(() => {});
        task = (await getTask(submitted.id)).body;
        record.taskTimeout = true;
      }
      const events = Array.isArray(task.events) ? task.events : [];
      record.task = {
        id: task.id, status: task.status, error: task.error ?? null,
        rounds: roundCount(events), roundsLimit: 16, budgetMs: AGENT_BUDGET_MS,
        createdAt: task.createdAt, updatedAt: task.updatedAt,
        usage: '未提供（CodingAgent 客户端未暴露上游 usage）',
        steps: events.map((event: any) => String(event.message ?? '')).slice(0, 80),
      };
      record.taskDurationMs = task.createdAt && task.updatedAt ? Date.parse(task.updatedAt) - Date.parse(task.createdAt) : Date.now() - taskStarted;

      if (task.status !== 'done' || !task.candidateId) {
        throw new Error(`任务未产出候选：status=${task.status}${task.error ? ` code=${task.error.code} message=${task.error.message}` : ''}`);
      }

      const candidateId = task.candidateId as string;
      const candidate = (await getCandidate(candidateId)).body as any;
      record.candidate = {
        id: candidate.id, baseVersion: candidate.baseVersion, previewUrl: candidate.previewUrl,
        diff: (candidate.diff ?? []).map((file: any) => ({ path: file.path, patch: String(file.patch ?? '').slice(0, 12_000) })),
        outOfScope: candidate.outOfScope ?? [], checks: candidate.checks ?? [],
      };

      await page.getByTestId('preview-candidate').click();
      const candidateFrame = await frameOf(page, 'candidate-frame');
      await candidateFrame.locator('[data-testid="buy-button"]').waitFor({ state: 'visible', timeout: 90_000 });
      await waitFrameSceneReady(candidateFrame);
      await waitFor(async () => effectReady(caseDef, await candidateFrame.evaluate(snapshotInPage) as Snapshot, baseline), 30_000, 300);
      const candidateSnapshot = await candidateFrame.evaluate(snapshotInPage) as Snapshot;
      const candidateFlat = flatten(candidateSnapshot);
      assertOnlyAllowed(baselineFlat, candidateFlat, caseDef.allowed, `候选 ${caseDef.id}`);
      caseDef.check(candidateSnapshot, baseline);
      record.candidateSnapshot = candidateSnapshot;
      record.screenshots = {};
      await page.screenshot({ path: path.join(SHOTS, `${caseDef.id}-candidate.png`), fullPage: true });
      record.screenshots.candidate = path.relative(RUN_DIR, path.join(SHOTS, `${caseDef.id}-candidate.png`));

      if (caseDef.id === 10) {
        const candidateConfig = JSON.parse(readFileSync(path.join(dataDir, 'candidates', candidateId, 'src', 'scene.config.json'), 'utf8'));
        const expected = JSON.parse(baselineConfig);
        expected.hero.lights.ambient = 0.8;
        expect(candidateConfig, 'scene.config.json 只允许 hero.lights.ambient 变为 0.8').toEqual(expected);
        record.candidateSceneConfig = candidateConfig;
      }

      // 行为类断言（在候选 frame 内点击，不影响作品）
      if (caseDef.id === 1 || caseDef.id === 8) {
        const before = Number(candidateSnapshot.purchases ?? 0);
        await candidateFrame.locator('[data-testid="buy-button"]').click();
        await waitFor(async () => Number((await candidateFrame.evaluate(() => document.querySelector('[data-testid="action-status"]')?.getAttribute('data-purchases'))) ?? -1) === before + 1, 10_000, 100);
        record.behavior = { purchasesBefore: before, purchasesAfter: before + 1 };
      }
      if (caseDef.id === 4) {
        await candidateFrame.locator('header a[href="#details"]').click();
        await waitFor(() => candidateFrame.url().includes('#details'), 10_000, 100);
        record.behavior = { hash: '#details' };
      }

      await page.getByTestId('candidate-adopt').click();
      await waitFor(async () => (await getVersion()).body.version !== baselineVersion, 30_000, 200);
      adoptedVersion = (await getVersion()).body.version as string;
      record.adoptedVersion = adoptedVersion;
      await waitFor(async () => effectReady(caseDef, await mainFrame.evaluate(snapshotInPage) as Snapshot, baseline), 30_000, 300);
      await waitFrameSceneReady(mainFrame);
      const adoptedSnapshot = await mainFrame.evaluate(snapshotInPage) as Snapshot;
      assertOnlyAllowed(baselineFlat, flatten(adoptedSnapshot), caseDef.allowed, `采用 ${caseDef.id}`);
      caseDef.check(adoptedSnapshot, baseline);
      record.adoptedSnapshot = adoptedSnapshot;
      await page.screenshot({ path: path.join(SHOTS, `${caseDef.id}-adopted.png`), fullPage: true });
      record.screenshots.adopted = path.relative(RUN_DIR, path.join(SHOTS, `${caseDef.id}-adopted.png`));
      if (caseDef.id === 10) {
        const adoptedConfig = JSON.parse(readFileSync(path.join(workRoot, 'src', 'scene.config.json'), 'utf8'));
        const expected = JSON.parse(baselineConfig);
        expected.hero.lights.ambient = 0.8;
        expect(adoptedConfig).toEqual(expected);
        record.adoptedSceneConfig = adoptedConfig;
      }

      await page.getByTestId('version-revert').click();
      await waitFor(async () => (await getVersion()).body.version !== adoptedVersion, 30_000, 200);
      const revertedVersion = (await getVersion()).body.version as string;
      record.revertedVersion = revertedVersion;
      await waitFor(async () => JSON.stringify(flatten(await mainFrame.evaluate(snapshotInPage) as Snapshot)) === JSON.stringify(baselineFlat), 30_000, 300);
      const restoredSnapshot = await mainFrame.evaluate(snapshotInPage) as Snapshot;
      assertOnlyAllowed(baselineFlat, flatten(restoredSnapshot), [], `回退 ${caseDef.id}`);
      expect(workDigest(workRoot), '回退后作品内容应回到基线').toBe(baselineDigest);
      expect(readFileSync(path.join(workRoot, 'src', 'scene.config.json'), 'utf8'), '回退后场景配置应回到基线').toBe(baselineConfig);
      record.revertedSnapshot = restoredSnapshot;
      record.workDigest.afterRevert = workDigest(workRoot);
      await page.screenshot({ path: path.join(SHOTS, `${caseDef.id}-reverted.png`), fullPage: true });
      record.screenshots.reverted = path.relative(RUN_DIR, path.join(SHOTS, `${caseDef.id}-reverted.png`));

      record.result = 'passed';
      record.durationMs = Date.now() - taskStarted;
    } catch (error) {
      const taskError = record.task?.error;
      const authFailure = Boolean(taskError && taskError.code === 'AGENT_UPSTREAM' && /HTTP (401|403)/.test(String(taskError.message)));
      const noTaskStarted = caseDef.id === 1 && !record.taskId;
      record.result = caseDef.id === 1 && (noTaskStarted || authFailure) ? 'not-started' : 'failed';
      record.error = error instanceof Error ? error.message : String(error);
      record.durationMs = Date.now() - taskStarted;
      try { await page.screenshot({ path: path.join(SHOTS, `${caseDef.id}-failed.png`), fullPage: true }).catch(() => {}); } catch { /* ignore */ }
      if (adoptedVersion) await revertVersion().catch(() => {});
      for (const candidate of (await listCandidates().catch(() => ({ body: [] as any[] }))).body.filter((item: any) => item.decision === 'pending')) {
        await discardCandidate(candidate.id).catch(() => {});
      }
    } finally {
      try { await stack?.stop(); } catch { /* ignore */ }
      removeTree(taskRoot);
      writeJson(path.join(TASKS, `${caseDef.id}.json`), record);
      results.push(record);
      console.log(`[${record.result === 'passed' ? 'PASS' : record.result === 'not-started' ? 'NOT-STARTED' : 'FAIL'}] case ${caseDef.id} ${caseDef.title}${record.error ? ` -> ${record.error}` : ''}`);
    }
    if (record.result === 'not-started') { notStarted = true; break; }
  }

  writeJson(path.join(RUN_DIR, 'results.json'), {
    mode: MODE, status: notStarted ? 'not-started' : (results.filter((record) => record.result === 'passed').length >= MIN_PASS ? 'passed' : 'failed'),
    notStarted,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim(),
    startedAt, finishedAt: new Date().toISOString(), moduleSource: agent.source,
    cases: results.map((record) => ({ id: record.id, title: record.title, result: record.result, error: record.error ?? null, taskId: record.taskId ?? null, candidate: record.candidate?.id ?? null, rounds: record.task?.rounds ?? null, durationMs: record.durationMs ?? null })),
    passed: results.filter((record) => record.result === 'passed').length, total: results.length,
  });

  const passed = results.filter((record) => record.result === 'passed').length;
  if (!notStarted && process.env.REAL_MODEL_ONLY_RESULTS !== '1') {
    expect(passed, `固定十题通过 ${passed}/${results.length}（门槛 ${MIN_PASS}）`).toBeGreaterThanOrEqual(MIN_PASS);
  }
});
