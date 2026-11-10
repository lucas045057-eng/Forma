import { expect, test } from '@playwright/test';
import { SCENE_CONFIG, getScene, readSceneFile, restoreSceneFile, sameJson, snapshotSceneFile, waitFor } from './api';
import { captureCanvases, enableCompare, openEditor, readScrollAt, setSlider } from './editor';
import { compareAligned } from '../m1a/visual';
import { writeArtifactFrom } from './artifact';
import { readFileSync } from 'node:fs';

/**
 * 写回即时同步：滑杆/设为首屏 → 作品页画面变化，且 iframe 没有整页刷新。
 * 同时核对 scene-diff 里的字段路径与实际改动一致、落盘文件确实更新。
 */

const IDENTITY = 20261110;

test.describe('写回与即时同步', () => {
  test.beforeAll(() => { snapshotSceneFile(); });
  test.afterAll(() => { expect(restoreSceneFile().matches, 'scene.config.json 没有还原').toBe(true); });

  test('设为首屏后作品页在秒级内更新，iframe 不整页刷新，diff 字段与实际改动一致', async ({ page }) => {
    const { frame } = await openEditor(page);
    // 标记页面身份，重载会丢掉它
    await page.evaluate((value) => { (window as unknown as { __m1bIdentity: number }).__m1bIdentity = value; }, IDENTITY);
    const frameIdentityBefore = await frame.evaluate(() => window.name || 'preview');

    const before = await getScene();
    const baseline = await captureCanvases(page, frame);

    await setSlider(page, 'scene-ambient', 2.6);
    await setSlider(page, 'scene-rotation-y', 1.24);
    const clickedAt = Date.now();
    await page.getByTestId('scene-save-hero').click();
    const latencyMs = await waitFor(async () => {
      const current = await captureCanvases(page, frame);
      return (await compareAligned(baseline.preview.png, current.preview.png, 3)).changedRatio > 0.01;
    }, 30_000, 100);

    const identity = await page.evaluate(() => (window as unknown as { __m1bIdentity?: number }).__m1bIdentity);
    const frameIdentityAfter = await frame.evaluate(() => window.name || 'preview');
    const after = await getScene();
    const onDisk = readSceneFile();
    const diffText = (await page.getByTestId('scene-diff').textContent()) ?? '';
    const diff = JSON.parse(diffText) as Array<{ path: string; oldValue: unknown; newValue: unknown }>;

    writeArtifactFrom('writeback-hero.json', {
      latencyMs,
      wallClockMs: Date.now() - clickedAt,
      identity: { before: IDENTITY, after: identity },
      frameIdentity: { before: frameIdentityBefore, after: frameIdentityAfter },
      configBefore: before.body.hero,
      configAfter: after.body.hero,
      onDisk: onDisk.hero,
      diff,
      file: SCENE_CONFIG,
    });

    // 1) 作品页确实更新了
    expect(after.body.hero.lights.ambient).toBeCloseTo(2.6, 1);
    expect(after.body.hero.model.rotation[1]).toBeCloseTo(1.24, 1);
    expect(sameJson(onDisk, after.body), '落盘文件与 GET /scene 不一致').toBe(true);
    // 2) 没有整页刷新
    expect(identity, '作品页发生了整页刷新').toBe(IDENTITY);
    // 3) diff 字段（JSON Pointer）与实际改动一致
    const paths = diff.map((entry) => entry.path);
    expect(paths).toContain('/hero/lights/ambient');
    expect(paths).toContain('/hero/model/rotation/1');
    for (const entry of diff) {
      const actual = entry.path.split('/').slice(1).reduce((node: any, key) => node?.[key], after.body);
      expect(JSON.stringify(actual), `diff 路径 ${entry.path} 的新值对不上`).toBe(JSON.stringify(entry.newValue));
    }
    expect(diff.every((entry) => entry.oldValue !== entry.newValue), 'diff 里出现了没有变化的字段').toBe(true);
    // 4) 延迟记录（秒级）
    expect(latencyMs, '写回后作品页更新太慢').toBeLessThan(10_000);
    expect(readFileSync(SCENE_CONFIG, 'utf8').length).toBeGreaterThan(50);
  });

  test('改开盖滑杆 + 记关键帧也会立刻反映到作品页', async ({ page }) => {
    const { frame } = await openEditor(page);
    const at = await frame.evaluate(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      window.scrollTo(0, Math.round(max * 0.5));
      return Math.round(max * 0.5);
    });
    await page.waitForTimeout(600);
    expect(await readScrollAt(page)).toBeGreaterThan(0.1);

    const baseline = await captureCanvases(page, frame);
    await setSlider(page, 'scene-lid', 0.13);
    await page.getByTestId('scene-save-keyframe').click();
    const latencyMs = await waitFor(async () => {
      const current = await captureCanvases(page, frame);
      return (await compareAligned(baseline.preview.png, current.preview.png, 3)).changedRatio > 0.005;
    }, 30_000, 100);
    expect(at).toBeGreaterThan(0);

    const config = readSceneFile();
    const frameAt = await readScrollAt(page);
    const written = config.scroll.filter((entry) => Math.abs(entry.at - frameAt) <= 0.021);
    writeArtifactFrom('writeback-keyframe.json', { at: frameAt, latencyMs, config: config.scroll, matchedFrames: written.length });
    expect(written.length, '没写进关键帧').toBe(1);
    expect(written[0].parts?.lid?.offset?.[1]).toBeCloseTo(0.13, 2);
    expect(latencyMs, '关键帧写回后作品页更新太慢').toBeLessThan(10_000);

    // 对照模式再看一眼：两边画面仍然一致
    await enableCompare(page);
    const pair = await captureCanvases(page, frame);
    const aligned = await compareAligned(pair.preview.png, pair.studio.png, 3);
    expect(aligned.changedRatio, `改完关键帧后一致性超阈值：${JSON.stringify({ changed: aligned.changedRatio })}`).toBeLessThan(0.01);
  });
});
