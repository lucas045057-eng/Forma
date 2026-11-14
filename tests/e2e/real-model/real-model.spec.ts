import { expect, test, type Frame, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { CASES, type CaseDef } from './cases';
import {
  AGENT_BUDGET_MS, API_BASE, STUDIO_URL, createWorkRoot, discardCandidate, flatten, getCandidate, getTask,
  getVersion, httpJson, listCandidates, mockAgentConfig, readAgentEnv, removeTree, resetMock, revertVersion,
  setMockScript, snapshotInPage, startStack, waitFor, workDigest, writeJson, type Snapshot,
} from './helpers';

const MODE = process.env.REAL_MODEL_MODE === 'real' ? 'real' as const : 'mock' as const;
const REAL = MODE === 'real';
const RUN_DIR = process.env.REAL_MODEL_RUN_DIR;
if (!RUN_DIR) throw new Error('REAL_MODEL_RUN_DIR 未设置');
// 真实模式固定十题与 8/10 门槛，不继承 limit/min-pass/only-results。
const LIMIT = REAL ? CASES.length : Number(process.env.REAL_MODEL_CASE_LIMIT ?? CASES.length);
const MIN_PASS = REAL ? 8 : Number(process.env.REAL_MODEL_MIN_PASS ?? Math.min(LIMIT, CASES.length));
const ONLY_RESULTS = !REAL && process.env.REAL_MODEL_ONLY_RESULTS === '1';
const FAULT = process.env.REAL_MODEL_FAULT ?? '';
if (REAL && FAULT) throw new Error('真实模式不允许故障注入');

const SHOTS = path.join(RUN_DIR, 'screenshots');
const TASKS = path.join(RUN_DIR, 'tasks');
const LOGS = path.join(RUN_DIR, 'logs');
const DIFFS = path.join(RUN_DIR, 'diffs');
for (const folder of [SHOTS, TASKS, LOGS, DIFFS]) mkdirSync(folder, { recursive: true });

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const redact = (value: unknown, secret: string): unknown => {
  if (typeof value === 'string') {
    let text = value;
    if (secret) text = text.split(secret).join('[REDACTED]');
    return text
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, '[REDACTED]')
      .replace(/authorization\s*[:=]\s*[^\s,}]+/gi, '[REDACTED]');
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secret));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item, secret)]));
  return value;
};
const writeSanitized = (file: string, value: unknown, secret: string) => writeJson(file, redact(value, secret));
const containsSecret = (value: unknown, secret: string) => {
  const text = JSON.stringify(value);
  return Boolean((secret && text.includes(secret)) || /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/i.test(text));
};
const readFrameErrors = async (frame: Frame) => {
  try { return await frame.evaluate(() => Array.isArray((window as any).__realModelErrors) ? (window as any).__realModelErrors.slice() : []); }
  catch { return []; }
};
const newErrors = (before: Array<{ message?: string }>, after: Array<{ message?: string }>) => {
  const known = new Set(before.map((entry) => String(entry.message ?? '')));
  return after.filter((entry) => !known.has(String(entry.message ?? '')));
};
const portFree = (port: number) => new Promise<boolean>((resolve) => {
  const socket = net.connect({ port, host: '127.0.0.1' });
  socket.once('connect', () => { socket.destroy(); resolve(false); });
  socket.once('error', () => resolve(true));
  socket.setTimeout(800, () => { socket.destroy(); resolve(true); });
});
const portsFree = async () => Object.fromEntries(await Promise.all([3001, 5174, 5175].map(async (port) => [port, await portFree(port)])));

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

function effectReady(caseDef: CaseDef, snapshot: Snapshot): boolean {
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
  let securityStop = false;
  let stage = 'baseline';
  const pageErrors: Array<{ stage: string; message: string }> = [];
  page.on('pageerror', (error) => { pageErrors.push({ stage, message: String(error.message || error) }); });
  await page.addInitScript(() => {
    const target = window as any;
    if (target.__realModelErrors) return;
    target.__realModelErrors = [];
    window.addEventListener('error', (event) => target.__realModelErrors.push({ type: 'error', message: String((event as ErrorEvent).message || (event as any).error || 'error') }));
    window.addEventListener('unhandledrejection', (event) => target.__realModelErrors.push({ type: 'unhandledrejection', message: String((event as PromiseRejectionEvent).reason?.message || (event as PromiseRejectionEvent).reason || 'rejection') }));
  });

  const cases = CASES.slice(0, Math.max(0, Math.min(LIMIT, CASES.length)));
  for (const caseDef of cases) {
    const taskStarted = Date.now();
    const taskRoot = path.join(TASKS, `${caseDef.id}`);
    const workRoot = path.join(taskRoot, 'work');
    const dataDir = path.join(taskRoot, 'data');
    const scenePath = path.join(workRoot, 'src', 'scene.config.json');
    const record: Record<string, any> = {
      id: caseDef.id, title: caseDef.title, instruction: caseDef.instruction, selector: caseDef.selector,
      mode: MODE, agentSource: agent.source, taskStartedAt: new Date().toISOString(),
    };
    let stack: Awaited<ReturnType<typeof startStack>> | null = null;
    let adoptedVersion: string | null = null;
    try {
      createWorkRoot(workRoot);
      const baselineDigest = workDigest(workRoot);
      const baselineConfig = readFileSync(scenePath, 'utf8');
      record.workDigest = { baseline: baselineDigest };
      stack = await startStack({ workRoot, dataDir, agent, mode: MODE });

      const guardLogPath = path.join(dataDir, 'guard.log'), guardMarkerPath = `${guardLogPath}.loaded`;
      const guardText = existsSync(guardLogPath) ? readFileSync(guardLogPath, 'utf8') : '';
      const guardEntries = guardText.split(/\r?\n/).filter(Boolean).map((line) => {
        try { const item = JSON.parse(line); return { kind: item.kind ?? 'unknown', detail: String(item.detail ?? '').slice(0, 160) }; }
        catch { return { kind: 'unparsable', detail: line.slice(0, 160) }; }
      });
      const guardMarker = existsSync(guardMarkerPath) ? JSON.parse(readFileSync(guardMarkerPath, 'utf8')) : null;
      writeFileSync(path.join(LOGS, `${caseDef.id}-guard.log`), redact(guardText, agent.apiKey) as string);
      record.guard = { markerActive: guardMarker?.active === true, marker: guardMarker, blocked: guardEntries };
      if (REAL && guardEntries.length) {
        securityStop = true;
        throw new Error(`安全停止：出站守卫记录了 ${guardEntries.length} 次被拒的越界请求`);
      }

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
      const baselineErrors = await readFrameErrors(mainFrame);
      const baselinePageErrorMark = pageErrors.length;
      record.errors = { baseline: baselineErrors, pageErrorBaseline: baselinePageErrorMark };
      await page.screenshot({ path: path.join(SHOTS, `${caseDef.id}-baseline.png`), fullPage: true });
      record.screenshots = { baseline: path.relative(RUN_DIR, path.join(SHOTS, `${caseDef.id}-baseline.png`)) };
      stage = 'candidate';
      if (FAULT === 'pageerror') {
        await mainFrame.evaluate(() => { setTimeout(() => { throw new Error('probe-uncaught-error'); }, 0); });
        await page.waitForTimeout(300);
      }

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
      } catch {
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
        diff: (candidate.diff ?? []).map((file: any, index: number) => {
          const patch = String(file.patch ?? '');
          const name = `${caseDef.id}-${index}.patch`;
          writeFileSync(path.join(DIFFS, name), patch);
          return { path: file.path, bytes: Buffer.byteLength(patch), sha256: sha256(patch), patchFile: path.relative(RUN_DIR, path.join(DIFFS, name)) };
        }),
        outOfScope: candidate.outOfScope ?? [], checks: candidate.checks ?? [],
      };

      await page.getByTestId('preview-candidate').click();
      const candidateFrame = await frameOf(page, 'candidate-frame');
      await candidateFrame.locator('[data-testid="buy-button"]').waitFor({ state: 'visible', timeout: 90_000 });
      await waitFrameSceneReady(candidateFrame);
      await waitFor(async () => effectReady(caseDef, await candidateFrame.evaluate(snapshotInPage) as Snapshot), 30_000, 300);
      const candidateSnapshot = await candidateFrame.evaluate(snapshotInPage) as Snapshot;
      assertOnlyAllowed(baselineFlat, flatten(candidateSnapshot), caseDef.allowed, `候选 ${caseDef.id}`);
      caseDef.check(candidateSnapshot, baseline);
      record.candidateSnapshot = candidateSnapshot;
      await page.screenshot({ path: path.join(SHOTS, `${caseDef.id}-candidate.png`), fullPage: true });
      record.screenshots.candidate = path.relative(RUN_DIR, path.join(SHOTS, `${caseDef.id}-candidate.png`));

      const candidateChecks = Array.isArray(candidate.checks) ? candidate.checks : [];
      expect(candidateChecks.length, '候选内建检查应为四项').toBe(4);
      expect(candidateChecks.every((check: any) => check.status === 'not_run'), `候选内建检查不应被标为通过：${JSON.stringify(candidateChecks)}`).toBe(true);
      const checkStatuses = await page.getByTestId('candidate-checks').locator('[data-status]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-status')));
      expect(checkStatuses, '候选检查 UI 应全部未检查').toEqual(['not_run', 'not_run', 'not_run', 'not_run']);
      expect(await page.getByTestId('candidate-checks').innerText(), '候选检查 UI 不应显示通过').not.toContain('通过');

      const candidateErrors = await readFrameErrors(candidateFrame);
      const candidatePageErrorMark = pageErrors.length;
      const newFrameErrors = newErrors(baselineErrors, candidateErrors);
      const newPageErrors = pageErrors.slice(baselinePageErrorMark, candidatePageErrorMark);
      record.errors = { ...record.errors, candidate: candidateErrors, newFrameErrors, newPageErrors };
      if (newFrameErrors.length || newPageErrors.length) {
        throw new Error(`新增未捕获脚本异常：${JSON.stringify([...newFrameErrors, ...newPageErrors]).slice(0, 800)}`);
      }

      if (FAULT === 'secret') record.probeLeak = 'Bearer probe-secret-123456';
      const diffPaths = (candidate.diff ?? []).map((item: any) => String(item.path));
      const unsafePaths = diffPaths.filter((item: string) => !/^(?:src|public)\//.test(item) || /(?:^|\/)(?:\.env|node_modules|\.git)(?:\/|$)/i.test(item) || /\.(?:pem|key|crt|p12|pfx)$/i.test(item) || item.includes('\\'));
      const diffSecret = containsSecret(candidate.diff ?? [], agent.apiKey);
      const recordSecret = containsSecret(record, agent.apiKey);
      if (unsafePaths.length || diffSecret || recordSecret) {
        securityStop = true;
        record.security = { unsafePaths, diffSecret, recordSecret };
      }
      record.security = { ...(record.security ?? {}), guardBlocked: REAL ? guardEntries.length : 0, unsafePaths };
      if (securityStop) throw new Error('安全停止：越权路径或凭据形态出现在任务证据中');

      if (caseDef.id === 10) {
        const candidateConfig = JSON.parse(readFileSync(path.join(dataDir, 'candidates', candidateId, 'src', 'scene.config.json'), 'utf8'));
        const expected = JSON.parse(baselineConfig);
        expected.hero.lights.ambient = 0.8;
        expect(candidateConfig, 'scene.config.json 只允许 hero.lights.ambient 变为 0.8').toEqual(expected);
        record.candidateSceneConfig = candidateConfig;
      }

      if (caseDef.id === 1 || caseDef.id === 8) {
        const before = Number(candidateSnapshot.purchases ?? 0);
        await candidateFrame.locator('[data-testid="buy-button"]').click();
        await waitFor(async () => Number((await candidateFrame.evaluate(() => document.querySelector('[data-testid="action-status"]')?.getAttribute('data-purchases'))) ?? -1) === before + 1, 10_000, 100);
        record.behavior = { purchasesBefore: before, purchasesAfter: before + 1 };
      }
      if (caseDef.id === 8) {
        await candidateFrame.locator('[data-testid="save-button"]').click();
        await waitFor(async () => String(await candidateFrame.evaluate(() => document.querySelector('[data-testid="action-status"]')?.textContent ?? '')).includes('已收藏这缕香气'), 10_000, 100);
        await candidateFrame.locator('[data-testid="gift-button"]').click();
        await waitFor(async () => String(await candidateFrame.evaluate(() => document.querySelector('[data-testid="action-status"]')?.textContent ?? '')).includes('已选择礼盒装'), 10_000, 100);
        record.behavior = { ...(record.behavior ?? {}), save: '已收藏这缕香气（演示）', gift: '已选择礼盒装（演示）' };
      }
      if (caseDef.id === 4) {
        await candidateFrame.locator('header a[href="#details"]').click();
        await waitFor(() => candidateFrame.url().includes('#details'), 10_000, 100);
        record.behavior = { hash: '#details' };
      }

      await page.getByTestId('preview-current').click();
      await page.waitForTimeout(500);
      if (FAULT === 'preadopt') appendFileSync(path.join(workRoot, 'src', 'App.tsx'), '\n// probe-preadopt\n', 'utf8');
      const preAdoptSnapshot = await mainFrame.evaluate(snapshotInPage) as Snapshot;
      assertOnlyAllowed(baselineFlat, flatten(preAdoptSnapshot), [], `采用前 ${caseDef.id}`);
      expect(workDigest(workRoot), '采用前作品内容不应被候选修改').toBe(baselineDigest);
      expect(readFileSync(scenePath, 'utf8'), '采用前场景配置不应被候选修改').toBe(baselineConfig);
      record.preAdopt = { snapshot: preAdoptSnapshot, workDigest: workDigest(workRoot), sceneConfig: JSON.parse(readFileSync(scenePath, 'utf8')) };

      await page.getByTestId('candidate-adopt').click();
      await waitFor(async () => (await getVersion()).body.version !== baselineVersion, 30_000, 200);
      adoptedVersion = (await getVersion()).body.version as string;
      record.adoptedVersion = adoptedVersion;
      await waitFor(async () => effectReady(caseDef, await mainFrame.evaluate(snapshotInPage) as Snapshot), 30_000, 300);
      await waitFrameSceneReady(mainFrame);
      const adoptedSnapshot = await mainFrame.evaluate(snapshotInPage) as Snapshot;
      assertOnlyAllowed(baselineFlat, flatten(adoptedSnapshot), caseDef.allowed, `采用 ${caseDef.id}`);
      caseDef.check(adoptedSnapshot, baseline);
      record.adoptedSnapshot = adoptedSnapshot;
      stage = 'adopted';
      const adoptedErrors = await readFrameErrors(mainFrame);
      const newAdoptedErrors = newErrors(candidateErrors, adoptedErrors);
      const adoptedPageErrors = pageErrors.slice(candidatePageErrorMark);
      record.errors = { ...record.errors, adopted: adoptedErrors, newAdoptedErrors, adoptedPageErrors };
      if (newAdoptedErrors.length || adoptedPageErrors.length) {
        throw new Error(`采用阶段新增未捕获脚本异常：${JSON.stringify([...newAdoptedErrors, ...adoptedPageErrors]).slice(0, 800)}`);
      }
      await page.screenshot({ path: path.join(SHOTS, `${caseDef.id}-adopted.png`), fullPage: true });
      record.screenshots.adopted = path.relative(RUN_DIR, path.join(SHOTS, `${caseDef.id}-adopted.png`));
      if (caseDef.id === 10) {
        const adoptedConfig = JSON.parse(readFileSync(scenePath, 'utf8'));
        const expected = JSON.parse(baselineConfig);
        expected.hero.lights.ambient = 0.8;
        expect(adoptedConfig).toEqual(expected);
        record.adoptedSceneConfig = adoptedConfig;
      }

      await page.getByTestId('version-revert').click();
      await waitFor(async () => (await getVersion()).body.version !== adoptedVersion, 30_000, 200);
      record.revertedVersion = (await getVersion()).body.version as string;
      await waitFor(async () => JSON.stringify(flatten(await mainFrame.evaluate(snapshotInPage) as Snapshot)) === JSON.stringify(baselineFlat), 30_000, 300);
      const restoredSnapshot = await mainFrame.evaluate(snapshotInPage) as Snapshot;
      assertOnlyAllowed(baselineFlat, flatten(restoredSnapshot), [], `回退 ${caseDef.id}`);
      expect(workDigest(workRoot), '回退后作品内容应回到基线').toBe(baselineDigest);
      expect(readFileSync(scenePath, 'utf8'), '回退后场景配置应回到基线').toBe(baselineConfig);
      record.revertedSnapshot = restoredSnapshot;
      record.workDigest.afterRevert = workDigest(workRoot);
      await page.screenshot({ path: path.join(SHOTS, `${caseDef.id}-reverted.png`), fullPage: true });
      record.screenshots.reverted = path.relative(RUN_DIR, path.join(SHOTS, `${caseDef.id}-reverted.png`));

      record.result = 'passed';
      record.durationMs = Date.now() - taskStarted;
    } catch (error) {
      const noTaskStarted = caseDef.id === 1 && !record.taskId;
      record.result = securityStop ? 'security-failed' : (noTaskStarted ? 'not-started' : 'failed');
      record.error = error instanceof Error ? error.message : String(error);
      record.durationMs = Date.now() - taskStarted;
      try { await page.screenshot({ path: path.join(SHOTS, `${caseDef.id}-failed.png`), fullPage: true }).catch(() => {}); } catch { /* ignore */ }
      if (adoptedVersion) await revertVersion().catch(() => {});
      for (const candidate of (await listCandidates().catch(() => ({ body: [] as any[] }))).body.filter((item: any) => item.decision === 'pending')) {
        await discardCandidate(candidate.id).catch(() => {});
      }
    } finally {
      if (stack) {
        const guardAfter = path.join(dataDir, 'guard.log');
        const guardAfterText = existsSync(guardAfter) ? readFileSync(guardAfter, 'utf8') : '';
        const guardAfterEntries = guardAfterText.split(/\r?\n/).filter(Boolean).map((line) => {
          try { const item = JSON.parse(line); return { kind: item.kind ?? 'unknown', detail: String(item.detail ?? '').slice(0, 160) }; }
          catch { return { kind: 'unparsable', detail: line.slice(0, 160) }; }
        });
        writeFileSync(path.join(LOGS, `${caseDef.id}-guard.log`), redact(guardAfterText, agent.apiKey) as string);
        record.guard = { ...(record.guard ?? {}), blockedAfter: guardAfterEntries };
        if (REAL && guardAfterEntries.length) { securityStop = true; record.result = 'security-failed'; }
      }
      const backendOutput = stack ? String(redact(stack.backend.output(), agent.apiKey)) : '';
      record.backend = { outputTail: backendOutput.slice(-8000), outputBytes: Buffer.byteLength(backendOutput) };
      if (record.result !== 'passed' && backendOutput) writeFileSync(path.join(LOGS, `${caseDef.id}-backend.log`), backendOutput);
      try { await stack?.stop(); } catch { /* ignore */ }
      record.cleanup = { portsFree: await portsFree() };
      if (!Object.values(record.cleanup.portsFree).every(Boolean)) { record.result = 'failed'; record.error = `${record.error ? record.error + '；' : ''}清理后已知端口仍被占用`; }
      removeTree(taskRoot);
      writeSanitized(path.join(TASKS, `${caseDef.id}.json`), record, agent.apiKey);
      results.push(redact(record, agent.apiKey) as Record<string, any>);
      console.log(`[${record.result === 'passed' ? 'PASS' : record.result === 'not-started' ? 'NOT-STARTED' : record.result === 'security-failed' ? 'SECURITY-FAILED' : 'FAIL'}] case ${caseDef.id} ${caseDef.title}${record.error ? ` -> ${record.error}` : ''}`);
    }
    if (record.result === 'not-started') { notStarted = true; break; }
    if (record.result === 'security-failed') { securityStop = true; break; }
  }

  const templateStatus = execFileSync('git', ['status', '--porcelain', '--', 'templates/product-page'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
  const mainTemplateClean = !templateStatus;
  const passed = results.filter((record) => record.result === 'passed').length;
  const complete = results.length === CASES.length && CASES.every((caseDef) => existsSync(path.join(TASKS, `${caseDef.id}.json`)));
  const status = notStarted ? 'not-started' : securityStop ? 'security-failed' : (passed >= MIN_PASS && (!REAL || complete) ? 'passed' : 'failed');
  writeSanitized(path.join(RUN_DIR, 'results.json'), {
    mode: MODE, status, notStarted, securityStop, complete, mainTemplateClean, templateStatus,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: process.cwd(), encoding: 'utf8' }).trim(),
    startedAt, finishedAt: new Date().toISOString(), moduleSource: agent.source,
    cases: results.map((record) => ({ id: record.id, title: record.title, result: record.result, error: record.error ?? null, taskId: record.taskId ?? null, candidate: record.candidate?.id ?? null, rounds: record.task?.rounds ?? null, durationMs: record.durationMs ?? null })),
    passed, total: results.length,
  }, agent.apiKey);

  if (securityStop) expect(securityStop, '安全门禁触发，验收不得通过').toBe(false);
  expect(mainTemplateClean, `主模板不应被本题验收修改：${templateStatus}`).toBe(true);
  if (!notStarted && !securityStop) {
    if (REAL) {
      expect(results.length, '真实模式必须完成固定十题').toBe(CASES.length);
      expect(complete, '真实模式十题结果必须全部归档').toBe(true);
      expect(MIN_PASS, '真实模式门槛固定为 8').toBe(8);
    }
    if (!ONLY_RESULTS) expect(passed, `固定十题通过 ${passed}/${results.length}（门槛 ${MIN_PASS}）`).toBeGreaterThanOrEqual(MIN_PASS);
  }
});
