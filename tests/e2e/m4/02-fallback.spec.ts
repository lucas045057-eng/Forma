import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BACKEND_BASE, FALLBACK_DIR } from './env';
import {
  adoptAsset, getAsset, getScene, importFallback, listFallbacks, modelProvenance, restoreTemplate, revertVersion, waitFor, writeArtifact,
} from './helpers';

/**
 * M4-D3：固定本地备用模型导入 → 来源 sidecar（按实际 GLB 字节哈希）→ 采用/回退 → 新数据目录。
 *
 * 只用仓库里三份指定 fallback 素材（按 preset SHA256 核对），不经网络：
 * 导入由后端直接读本地固定目录，Lux3D 仍指向无人监听的 loopback。
 */

const PRESETS = [
  { id: 'diffuser-split', file: 'lux3d-split-4969889.glb', hash: '239b77d757cd50b377c8d9bd1f9313b1017f11681606ecf234b4fbf0549032e0' },
  { id: 'diffuser-original', file: 'lux3d-4969293.glb', hash: '7770579bb7deb2880c252b2369ecefd4a5e427af2611bb8de4622c413c7b55d7' },
  { id: 'diffuser-alternate', file: 'lux3d-4969298.glb', hash: '09f9085858ace106b7dc5c7b9355320e5d05352a565eb01a73d670c1754ac9bf' },
];

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test.describe.configure({ mode: 'serial' });

test.describe('M4-D3 本地备用模型与来源', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });

  test('三份本地素材的字节哈希与 preset 声明一致（不联网）', () => {
    const actual = PRESETS.map((preset) => {
      const bytes = readFileSync(path.join(FALLBACK_DIR, preset.file));
      return { id: preset.id, file: preset.file, bytes: bytes.length, sha256: sha256(bytes), expected: preset.hash, match: sha256(bytes) === preset.hash };
    });
    expect(actual.every((item) => item.match), JSON.stringify(actual)).toBe(true);
    writeArtifact('fallback-factor-presets.json', { presets: actual });
  });

  test('列表只暴露固定 preset，非法输入被拒', async () => {
    const listed = await listFallbacks();
    expect(listed.status, listed.text.slice(0, 200)).toBe(200);
    const ids = (Array.isArray(listed.body) ? listed.body : []).map((item: any) => item.id).sort();
    expect(ids).toEqual(PRESETS.map((preset) => preset.id).sort());
    const unknown = await importFallback('not-a-preset');
    expect([400, 404]).toContain(unknown.status);
    const bodyRejected = await fetch(`${BACKEND_BASE}/assets/fallbacks/diffuser-split/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '../../etc/passwd' }),
    });
    expect([400]).toContain(bodyRejected.status);
    writeArtifact('fallback-list-and-rejects.json', { ids, unknown: unknown.status, bodyRejected: bodyRejected.status });
  });

  test('导入 → 来源 sidecar 绑定真实字节 → 采用 → 回退', async () => {
    const imported: Array<{ id: string; preset: string; status: string; provenance: unknown }> = [];
    for (const preset of PRESETS) {
      const response = await importFallback(preset.id);
      expect([200, 202], `${preset.id} 导入返回 ${response.status} ${response.text.slice(0, 200)}`).toContain(response.status);
      const assetId: string = (response.body as any)?.id;
      expect(assetId, `${preset.id} 没有返回 asset id`).toBeTruthy();
      const ready = await waitFor(async () => {
        const asset = await getAsset(assetId);
        return asset.status === 200 && asset.body?.status === 'ready' ? asset : false;
      }, 180_000, 500);
      void ready;
      const asset = (await getAsset(assetId)).body;
      expect(asset.status).toBe('ready');
      const provenance = asset.provenance ?? asset.model?.provenance ?? null;
      const text = JSON.stringify(provenance ?? asset);
      expect(text, `${preset.id} 的来源没有绑定 preset/hash`).toContain(preset.hash);
      imported.push({ id: assetId, preset: preset.id, status: asset.status, provenance });
    }

    const target = imported[0];
    const adopted = await adoptAsset(target.id);
    expect(adopted.status, adopted.text.slice(0, 300)).toBe(200);
    const afterAdopt = await modelProvenance();
    expect(afterAdopt.status).toBe(200);
    const adoptedText = JSON.stringify(afterAdopt.body);
    expect(adoptedText, '采用后来源里没有 fallback 的字节哈希').toContain(PRESETS[0].hash);
    const sceneAfter = await getScene();

    const reverted = await revertVersion();
    expect(reverted.status, reverted.text.slice(0, 300)).toBe(200);
    const afterRevert = await modelProvenance();
    expect(afterRevert.status).toBe(200);
    expect(JSON.stringify(afterRevert.body)).not.toBe(adoptedText);
    const sceneReverted = await getScene();
    expect(JSON.stringify(sceneReverted.body)).toBe(JSON.stringify(sceneAfter.body));

    writeArtifact('fallback-import-provenance.json', {
      imported, adopted: adopted.status,
      provenanceAfterAdopt: afterAdopt.body, provenanceAfterRevert: afterRevert.body,
    });
  });
});
