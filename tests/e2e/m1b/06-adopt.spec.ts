import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { SPLIT_GLB, TEMPLATE_ASSETS } from './env';
import {
  adoptAsset, createSandbox, getScene, mutateIndex, processLocal, readSceneFile, restoreSceneFile,
  snapshotSceneFile, waitFor,
} from './api';
import { freePort } from '../m0a/harness';
import { importAsset } from '../m1a/viewport';
import { openEditor } from './editor';
import { writeArtifactFrom } from './artifact';

/**
 * 采用模型：
 * - 沙箱里验证正常采用、force 门槛、同名冲突（不往仓库里写东西）；
 * - 主后端验证“采用后作品页真的换了模型”，测完删产物并还原配置。
 */

test.describe('采用模型', () => {
  test('沙箱：ready 资产采用后模型与 parts 落盘、配置 model 更新', async () => {
    const sandbox = createSandbox('adopt-ok', await freePort());
    const processed = await processLocal({ input: SPLIT_GLB, id: 'demo-model', assetsDir: sandbox.assetsDir });
    expect(processed.ok, processed.output).toBe(true);
    const backend = await sandbox.start();
    try {
      const before = (await getScene(backend.base)).body;
      const response = await adoptAsset(backend.base, 'demo-model');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const after = (await getScene(backend.base)).body;
      expect(after.model).toBe('/assets/demo-model.glb');
      expect(before.model).not.toBe(after.model);

      const glb = path.join(sandbox.workRoot, 'public', 'assets', 'demo-model.glb');
      const parts = path.join(sandbox.workRoot, 'public', 'assets', 'demo-model.parts.json');
      expect(existsSync(glb), '模型文件没有落到作品 public/assets').toBe(true);
      expect(existsSync(parts), 'parts sidecar 没有落盘').toBe(true);
      const metadata = JSON.parse(readFileSync(parts, 'utf8'));
      expect(metadata.recognized).toBe(true);
      const diff = (response.body as any).diff as Array<{ path: string }>;
      expect(diff.some((entry) => entry.path === '/model')).toBe(true);
      writeArtifactFrom('adopt-sandbox-ok.json', { before: before.model, after: after.model, metadata, diff });
    } finally {
      await backend.stop();
      sandbox.cleanup();
    }
  });

  test('沙箱：webReady=false 必须 force；同名不同内容 409', async () => {
    const sandbox = createSandbox('adopt-guard', await freePort());
    const big = await processLocal({ input: SPLIT_GLB, id: 'big-model', assetsDir: sandbox.assetsDir });
    const other = await processLocal({ input: SPLIT_GLB, id: 'other-model', assetsDir: sandbox.assetsDir });
    expect(big.ok && other.ok, `${big.output}\n${other.output}`).toBe(true);
    // 管线不会产出 webReady=false（处理后总是 <3MB / <10 万顶点），直接改索引构造该状态
    mutateIndex(sandbox.assetsDir, (entries) => {
      const entry = entries.find((item) => item.id === 'big-model');
      if (!entry?.metrics) throw new Error('没有找到刚处理的资产');
      entry.metrics.webReady = false;
    });
    // 同名不同内容：作品里先放一份不同的字节
    writeFileSync(path.join(sandbox.workRoot, 'public', 'assets', 'other-model.glb'), Buffer.from('different bytes'));

    const backend = await sandbox.start();
    try {
      const withoutForce = await adoptAsset(backend.base, 'big-model');
      expect(withoutForce.status, JSON.stringify(withoutForce.body)).toBe(409);
      expect((withoutForce.body as any).error.code).toBe('FORCE_REQUIRED');

      const withForce = await adoptAsset(backend.base, 'big-model', true);
      expect(withForce.status, JSON.stringify(withForce.body)).toBe(200);
      expect((await getScene(backend.base)).body.model).toBe('/assets/big-model.glb');

      const conflict = await adoptAsset(backend.base, 'other-model');
      expect(conflict.status, JSON.stringify(conflict.body)).toBe(409);
      expect((conflict.body as any).error.code).toBe('ASSET_NAME_CONFLICT');
      // 冲突时不能把作品里已有的文件覆盖掉
      expect(readFileSync(path.join(sandbox.workRoot, 'public', 'assets', 'other-model.glb'), 'utf8')).toBe('different bytes');

      writeArtifactFrom('adopt-guard.json', {
        withoutForce: { status: withoutForce.status, code: (withoutForce.body as any).error.code },
        withForce: withForce.status,
        conflict: { status: conflict.status, code: (conflict.body as any).error.code },
      });
    } finally {
      await backend.stop();
      sandbox.cleanup();
    }
  });

  test('主后端：采用 mock 资产后作品页换了模型，测完清理干净', async ({ page }) => {
    snapshotSceneFile();
    const imported = await importAsset('8400001');
    expect(imported.status).toBe('ready');
    const originalConfig = readSceneFile();
    const adoptedFile = path.join(TEMPLATE_ASSETS, `${imported.id}.glb`);
    const adoptedParts = path.join(TEMPLATE_ASSETS, `${imported.id}.parts.json`);
    // 采用会写 provenance sidecar（M4-D3）。测试前先记录它的原状（是否存在 + 原字节），
    // finally 里恢复原状：原本不存在就删掉；原本已存在则按原字节写回——不能删历史文件、也不能留残留。
    const adoptedSidecar = path.join(TEMPLATE_ASSETS, `${imported.id}.provenance.json`);
    const sidecarBefore = existsSync(adoptedSidecar) ? readFileSync(adoptedSidecar) : null;
    const glbBefore = existsSync(adoptedFile) ? readFileSync(adoptedFile) : null;
    const partsBefore = existsSync(adoptedParts) ? readFileSync(adoptedParts) : null;
    const failures: unknown[] = [];
    let cleanupScene: boolean | null = null;
    let sidecarBytesMatch = false;
    try {
      const { frame } = await openEditor(page);
      const beforeModel = originalConfig.model;
      const response = await adoptAsset('http://127.0.0.1:3001', imported.id);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const after = (await getScene()).body;
      expect(after.model).toBe(`/assets/${imported.id}.glb`);
      expect(existsSync(adoptedFile), '采用后 model.glb 没有出现在作品 public/assets').toBe(true);
      expect(existsSync(adoptedParts)).toBe(true);

      // 作品页把新模型加载出来（HMR 后重新挂载）
      const loaded = await waitFor(async () => {
        const state = await frame.evaluate(() => {
          const scene = document.querySelector('[data-testid="product-scene"]');
          return { state: scene?.getAttribute('data-state'), canvas: Boolean(scene?.querySelector('canvas')) };
        });
        const resources = await frame.evaluate(() => performance.getEntriesByType('resource')
          .filter((entry) => entry.name.includes('.glb')).map((entry) => entry.name));
        return state.state === 'ready' && state.canvas && resources.some((name) => name.includes(imported.id));
      }, 60_000, 300);

      writeArtifactFrom('adopt-primary.json', {
        beforeModel, afterModel: after.model, loaded,
        file: { glb: existsSync(adoptedFile), parts: existsSync(adoptedParts) },
        fileBytes: readFileSync(adoptedFile).length,
        diff: (response.body as any).diff,
      });
      expect(typeof loaded === 'number' && loaded > 0, '作品页没有加载新模型').toBe(true);
    } catch (error) { failures.push(error); } finally {
      // 每一步均执行，原异常与收尾/证据错误全部保留。
      const attempt = (label: string, work: () => void) => {
        try { work(); } catch (error) { failures.push(new Error(label, { cause: error })); }
      };
      attempt('restore-scene', () => { cleanupScene = restoreSceneFile().matches; });
      for (const [file, before] of [[adoptedFile, glbBefore], [adoptedParts, partsBefore], [adoptedSidecar, sidecarBefore]] as const) {
        attempt('restore ' + file, () => {
          if (before !== null) writeFileSync(file, before);
          else rmSync(file, { force: true });
        });
        attempt('verify original bytes ' + file, () => {
          expect(existsSync(file), '采用文件的存在性未恢复：' + file).toBe(before !== null);
          if (before !== null) expect(readFileSync(file).equals(before), '采用文件字节未恢复：' + file).toBe(true);
        });
      }
      try { await page.waitForTimeout(1_500); } catch (error) { failures.push(error); }
      attempt('verify scene snapshot', () => { expect(cleanupScene, '配置没有按快照还原').toBe(true); });
      attempt('verify sidecar', () => {
        sidecarBytesMatch = sidecarBefore !== null
          ? existsSync(adoptedSidecar) && readFileSync(adoptedSidecar).equals(sidecarBefore)
          : !existsSync(adoptedSidecar);
        expect(sidecarBytesMatch, 'provenance sidecar 没有恢复原状').toBe(true);
      });
      attempt('write cleanup evidence', () => writeArtifactFrom('adopt-provenance-cleanup.json', {
        sidecar: adoptedSidecar,
        existedBefore: sidecarBefore !== null,
        existsAfter: existsSync(adoptedSidecar),
        sidecarBytesMatch,
        sceneRestored: cleanupScene,
        glbExistedBefore: glbBefore !== null, partsExistedBefore: partsBefore !== null,
        errors: failures.map(error => error instanceof Error ? { message: error.message, stack: error.stack, cause: String(error.cause ?? '') } : String(error)),
      }));
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) throw new AggregateError(failures, '采用用例失败；主错和各项收尾错误分别保留');
  });
});
