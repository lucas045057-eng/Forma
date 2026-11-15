import { expect, test } from '@playwright/test';
import { getScene, putScene, readSceneFile, restoreSceneFile, sameJson, snapshotSceneFile, undoScene, waitFor } from './api';
import { captureCanvases, openEditor, setSlider } from './editor';
import { captureReadyBaseline, runPairChange, summarizeAttempts } from './window-compare';
import { writeArtifactFrom } from './artifact';

/** 撤回：配置值与网页画面都恢复；历史为空时 409 且界面有错误提示。 */

test.describe('撤回', () => {
  test.beforeAll(() => { snapshotSceneFile(); });
  test.afterAll(() => { expect(restoreSceneFile().matches, 'scene.config.json 没有还原').toBe(true); });

  test('界面写入 → 撤回：配置与网页画面都恢复', async ({ page }) => {
    const { frame } = await openEditor(page);
    const original = (await getScene()).body;
    const readiness = await captureReadyBaseline(page, frame, 'undo-ui-baseline.json');
    const baseline = readiness.pair;

    await setSlider(page, 'scene-ambient', 3.4);
    const changed = await runPairChange(page, frame, baseline, {
      method: 'PUT', pathname: '/scene', button: 'scene-save-hero', artifact: 'undo-ui-write-sampling.json',
      threshold: 0.01, timeoutMs: 30_000, intervalMs: 100,
    });
    const writeResult = changed.response;
    expect(writeResult.status, 'PUT /scene 未成功：' + JSON.stringify(writeResult).slice(0, 300)).toBe(200);
    const changedMs = changed.elapsedMs;
    const afterWrite = (await getScene()).body;
    expect(afterWrite.hero.lights.ambient).toBeCloseTo(3.4, 1);

    const recovered = await runPairChange(page, frame, baseline, {
      method: 'POST', pathname: '/scene/undo', button: 'scene-undo', artifact: 'undo-ui-recover-sampling.json',
      threshold: 0.002, timeoutMs: 30_000, intervalMs: 150, mode: 'decrease',
    });
    // 界面撤回后配置应恢复到写入前
    await waitFor(async () => sameJson((await getScene()).body, original), 20_000, 200);
    const restored = (await getScene()).body;
    expect(sameJson(restored, original), '撤回后配置没有恢复').toBe(true);
    expect(sameJson(readSceneFile(), original), '撤回后文件内容没有恢复').toBe(true);

    const undoResult = recovered.response;
    expect(undoResult.status, 'POST /scene/undo 未成功').toBe(200);
    const recoveredMs = recovered.elapsedMs;

    writeArtifactFrom('undo-ui.json', {
      changedMs, recoveredMs,
      changedRatio: changed.changedRatio, recoveredRatio: recovered.changedRatio,
      write: writeResult, undo: undoResult,
      readiness: readiness.gate, baselineWindow: readiness.window,
      captureAttempts: { changed: summarizeAttempts(changed.attempts), recovered: summarizeAttempts(recovered.attempts) },
      originalAmbient: original.hero.lights.ambient, afterWriteAmbient: afterWrite.hero.lights.ambient,
    });
  });

  test('历史为空时撤回返回 409，界面显示错误提示', async ({ page }) => {
    // 先把主后端的历史抽干（撤回到底会回到最初那份配置）
    const drained = await (async () => {
      const results: number[] = [];
      for (let index = 0; index < 40; index += 1) {
        const response = await undoScene();
        results.push(response.status);
        if (response.status !== 200) return { results, final: response };
      }
      throw new Error('40 次撤回还没抽干历史，可能没有上限或撤回不生效');
    })();
    expect(drained.final.status).toBe(409);
    expect((drained.final.body as any).error.code).toBe('NO_SCENE_HISTORY');

    const before = readSceneFile();
    const { frame } = await openEditor(page);
    await page.getByTestId('scene-undo').click();
    const error = page.getByTestId('scene-error');
    await expect(error, '历史为空时界面没有报错').toBeVisible({ timeout: 20_000 });
    const message = (await error.textContent()) ?? '';
    expect(message).toContain('没有可以撤回');
    expect(sameJson(readSceneFile(), before), '空历史撤回不应改动文件');

    writeArtifactFrom('undo-empty.json', { drainedStatuses: drained.results, message, frame: Boolean(frame) });
  });

  test('接口层：PUT 后撤回恢复上一份配置，diff 记录撤回', async () => {
    const original = (await getScene()).body;
    const variant = structuredClone(original);
    variant.hero.camera.fov = 48;
    const written = await putScene(variant);
    expect(written.status).toBe(200);
    expect(written.body.diff.some((entry) => entry.path === '/hero/camera/fov')).toBe(true);

    const undone = await undoScene();
    expect(undone.status).toBe(200);
    expect(sameJson(undone.body.config, original), '接口撤回没有恢复配置').toBe(true);
    expect(undone.body.diff.some((entry) => entry.path === '/hero/camera/fov')).toBe(true);
    expect(sameJson((await getScene()).body, original)).toBe(true);
    writeArtifactFrom('undo-api.json', { written: written.body.sequence, undone: undone.body.sequence });
  });
});
