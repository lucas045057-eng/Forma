import { expect, test } from '@playwright/test';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { api, control, resetFake, restoreWorkRoot, writeEvidence } from './support/api';
import { PREVIEW_ORIGIN } from './env';
import { createTaskFromWorkbench, uploadAndRevealImage, type WorkbenchTask } from './support/workbench';

/**
 * 放置的浏览器覆盖（拖拽部分为**合成拖拽事件**）：
 *  - 合成 HTML5 拖拽事件（结果卡 dragstart → 跨 iframe dragover/drop），含滚动与 DPR=2 环境；
 *  - 外来 frame 伪造消息被拒；
 *  - 点击路径单独标注为「非原生拖拽」，不写进拖拽结论。
 * 说明：全部拖拽均由 DataTransfer + DragEvent 合成，不代表真实鼠标拖动/命中；DPR=2 只验证环境值下放置仍正确，
 * 不声称真实坐标。真实原生拖拽覆盖另批补。
 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(480_000);

test.beforeEach(async ({ request }) => {
  await resetFake();
  await control({ blockSize: 1024 * 1024 });
  expect((await api(request, 'GET', '/health')).status).toBe(200);
});

test.afterAll(() => {
  const cleanup = restoreWorkRoot();
  expect(cleanup.after).toBe('');
});

async function createReadyTask(page: Page, request: APIRequestContext): Promise<WorkbenchTask> {
  await page.goto('/');
  await page.getByTestId('asset-open').click();
  await expect(page.getByTestId('lux-workbench')).toBeVisible({ timeout: 60_000 });
  const image = await uploadAndRevealImage(page);
  await image.check();
  // 绑定本次点击的 create localId；UI 必须真实显示该任务的 ready 卡与原件链接。
  return createTaskFromWorkbench(page, request, { label: 'synthetic-create', click: () => page.getByTestId('lux-create').click() });
}

async function startSyntheticDrag(page: Page, card: Locator, downloadUrl: string) {
  await card.hover();
  await expect(card, '本次任务的结果卡已可拖（hover 已准备放置会话）').toHaveAttribute('draggable', 'true', { timeout: 60_000 });
  // 合成 dragstart：保留同一个 DataTransfer，dispatchEvent 同步返回后读取 React 写入的 payload。
  // 不用 capture 阶段监听：那时 React 还没写 dataTransfer，读到的是空串。
  const payload = await page.evaluate((href) => {
    const target = Array.from(document.querySelectorAll('.lux-artifact')).find((element) => element.querySelector(`a[href="${href}"]`));
    const data = new DataTransfer();
    target?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data }));
    return data.getData('application/x-spatial-asset');
  }, downloadUrl);
  await expect(page.getByTestId('asset-placement')).toBeVisible({ timeout: 30_000 });
  expect(payload).toBeTruthy();
  return payload;
}

async function dropInFrame(page: import('@playwright/test').Page, payload: string, scrollRatio: number) {
  const frame = page.frames().find((item) => item.url().includes('/preview/main/'));
  expect(frame).toBeTruthy();
  return frame!.evaluate(async ({ payload: dataPayload, ratio }) => {
    const scroller = document.scrollingElement ?? document.documentElement;
    const max = Math.max(0, scroller.scrollHeight - window.innerHeight);
    scroller.scrollTop = max * ratio;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const target = document.querySelector('[data-testid="product-scene"]');
    if (!target) return { dropped: false, reason: 'no target', at: scroller.scrollTop, dpr: window.devicePixelRatio };
    const data = new DataTransfer();
    data.setData('application/x-spatial-asset', dataPayload);
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
    return { dropped: true, at: scroller.scrollTop, dpr: window.devicePixelRatio };
  }, { payload, ratio: scrollRatio });
}

test('合成拖拽事件 + 页面滚动：结果卡 payload 送入主槽，确认后采用并可撤回', async ({ page, request }) => {
  const binding = await createReadyTask(page, request);
  const before = (await api<{ model: string }>(request, 'GET', '/scene')).body.model;
  const payload = await startSyntheticDrag(page, binding.card, binding.artifact.downloadUrl);
  const dropped = await dropInFrame(page, payload, 0.5);
  expect(dropped?.dropped).toBe(true);
  expect(dropped?.dpr).toBe(1);
  await expect(page.getByTestId('placement-target')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('placement-target')).toContainText('替换');
  await page.getByTestId('placement-confirm').click();
  await expect.poll(async () => (await api<{ model: string }>(request, 'GET', '/scene')).body.model, { timeout: 120_000 }).not.toBe(before);
  const after = (await api<{ model: string }>(request, 'GET', '/scene')).body.model;
  expect(after).toMatch(/^\/assets\/.+\.glb$/);
  expect((await api(request, 'POST', '/scene/undo')).status).toBe(200);
  expect((await api<{ model: string }>(request, 'GET', '/scene')).body.model).toBe(before);
  const cleanup = restoreWorkRoot();
  expect(cleanup.after).toBe('');
  writeEvidence('native-drag-scroll.json', { before, after, dropped, note: '合成 dragstart/dragover/drop；非原生鼠标拖拽' });
});

test('合成拖拽事件 · DPR=2 环境：放置仍正确（仅环境值，不代表真实坐标）', async ({ browser, request }) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  try {
    const binding = await createReadyTask(page, request);
    const before = (await api<{ model: string }>(request, 'GET', '/scene')).body.model;
    const payload = await startSyntheticDrag(page, binding.card, binding.artifact.downloadUrl);
    const dropped = await dropInFrame(page, payload, 0);
    expect(dropped?.dropped).toBe(true);
    expect(dropped?.dpr).toBe(2);
    await expect(page.getByTestId('placement-target')).toBeVisible({ timeout: 60_000 });
    await page.getByTestId('placement-confirm').click();
    await expect.poll(async () => (await api<{ model: string }>(request, 'GET', '/scene')).body.model, { timeout: 120_000 }).not.toBe(before);
    expect((await api(request, 'POST', '/scene/undo')).status).toBe(200);
    const cleanup = restoreWorkRoot();
    expect(cleanup.after).toBe('');
    writeEvidence('native-drag-dpr2.json', { before, dropped, note: '合成拖拽事件；DPR 仅 devicePixelRatio 环境值，未验证真实坐标/命中' });
  } finally {
    await context.close();
  }
});

test('外来 frame 伪造放置消息：不产生目标、不改作品', async ({ page, request }) => {
  const binding = await createReadyTask(page, request);
  const before = (await api<{ model: string }>(request, 'GET', '/scene')).body.model;
  await startSyntheticDrag(page, binding.card, binding.artifact.downloadUrl);
  await page.evaluate((origin) => {
    const frame = document.createElement('iframe');
    frame.id = 'foreign-preview';
    frame.src = `${origin}/preview/main/`;
    document.body.append(frame);
  }, PREVIEW_ORIGIN);
  await page.waitForTimeout(3_000);
  const previewFrames = page.frames().filter((item) => item.url().includes('/preview/main/'));
  const foreign = previewFrames[previewFrames.length - 1];
  expect(previewFrames.length).toBeGreaterThanOrEqual(2);
  await foreign.evaluate(() => {
    window.parent.postMessage({
      type: 'placement:target',
      payload: { sessionId: 'forged', target: { kind: 'replace', src: 'src/components/ProductHero.tsx:1:1', cid: 'div', ancestors: [], position: 'inside' } },
    }, '*');
  });
  await page.waitForTimeout(1_000);
  await expect(page.getByTestId('placement-target')).toHaveCount(0);
  expect((await api<{ model: string }>(request, 'GET', '/scene')).body.model).toBe(before);
  writeEvidence('native-drag-foreign-frame.json', { before, frames: previewFrames.length });
});

test('点击路径（非原生拖拽）：iframe 点击选择目标，单独记录，不当作拖拽结论', async ({ page, request }) => {
  const binding = await createReadyTask(page, request);
  const before = (await api<{ model: string }>(request, 'GET', '/scene')).body.model;
  await binding.card.getByRole('button', { name: '放入网页' }).click();
  await expect(page.getByTestId('asset-placement')).toBeVisible({ timeout: 30_000 });
  const frame = page.frameLocator('[data-testid="preview-frame"]');
  await expect.poll(async () => {
    await frame.locator('[data-testid="product-scene"]').click({ timeout: 5_000 }).catch(() => undefined);
    return await page.getByTestId('placement-target').count();
  }, { timeout: 90_000, intervals: [1_000] }).toBe(1);
  await page.getByTestId('placement-confirm').click();
  await expect.poll(async () => (await api<{ model: string }>(request, 'GET', '/scene')).body.model, { timeout: 120_000 }).not.toBe(before);
  expect((await api(request, 'POST', '/scene/undo')).status).toBe(200);
  const cleanup = restoreWorkRoot();
  expect(cleanup.after).toBe('');
  writeEvidence('click-placement-non-native.json', { before, note: '点击路径，非原生拖拽' });
});
