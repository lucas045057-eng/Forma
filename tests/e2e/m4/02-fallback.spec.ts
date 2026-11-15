import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BACKEND_BASE, FALLBACK_DIR, REPO_ROOT, TEMPLATE_SCENE_CONFIG, WORK_ROOT } from './env';
import {
  adoptAsset, getAsset, getScene, importFallback, listFallbacks, modelProvenance, restoreTemplate, revertVersion, waitFor, writeArtifact,
} from './helpers';

/**
 * M4-D3：固定本地备用模型导入 → 来源 sidecar（按实际 GLB 字节哈希）→ 采用/回退 → 新数据目录。
 *
 * 只用仓库里三份指定 fallback 素材（按 preset SHA256 核对），不经网络：
 * 导入由后端直接读本地固定目录，Lux3D 仍指向无人监听的 loopback。
 */

/**
 * preset 声明以**产品源码**为准（apps/server/src/assets/fallbacks.ts），哈希由**真实 GLB 字节**算出后比对。
 * 这样既不会出现手写 literal 抄错（旧版把 ...e5d05253a... 抄成 ...e5d05352a...），
 * 也不拿产品 helper 当行为 oracle —— 比较的是"文件字节 vs 产品声明"。
 */
const PRESET_SOURCE = path.join(REPO_ROOT, 'apps', 'server', 'src', 'assets', 'fallbacks.ts');
const PRESETS = [...readFileSync(PRESET_SOURCE, 'utf8').matchAll(/file:'([^']+)',hash:'([0-9a-f]{64})'/g)]
  .map((match) => ({ file: match[1], hash: match[2] }))
  .filter((preset) => preset.file.startsWith('lux3d-'));

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
    expect(ids).toHaveLength(PRESETS.length);
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
  test('F5 preset 导入接受界面真实发出的空对象 POST，危险字段仍被拒', async () => {
    for (const preset of PRESETS) {
      const response = await fetch(`${BACKEND_BASE}/assets/fallbacks/${preset.id}/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      expect([200, 202], `${preset.id} 空对象 POST 返回 ${response.status}`).toContain(response.status);
    }
    const unsafe = await fetch(`${BACKEND_BASE}/assets/fallbacks/diffuser-split/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: '/etc/passwd' }),
    });
    expect([400]).toContain(unsafe.status);
    writeArtifact('fallback-empty-body-post.json', { accepted: PRESETS.map((preset) => preset.id), unsafe: unsafe.status });
  });

  test('F4 坏来源 sidecar 三类都安全 409，作品四份字节不变', async () => {
    const response = await importFallback('diffuser-split');
    expect([200, 202]).toContain(response.status);
    const assetId = (response.body as any)?.id;
    await waitFor(async () => (await getAsset(assetId)).body?.status === 'ready', 180_000, 500);
    const adopted = await adoptAsset(assetId);
    expect(adopted.status, adopted.text.slice(0, 300)).toBe(200);

    const assetsDir = path.join(WORK_ROOT, 'public', 'assets');
    const files = {
      glb: path.join(assetsDir, `${assetId}.glb`),
      parts: path.join(assetsDir, `${assetId}.parts.json`),
      sidecar: path.join(assetsDir, `${assetId}.provenance.json`),
      scene: TEMPLATE_SCENE_CONFIG,
    };
    const before = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, sha256(readFileSync(file))]));

    const writeFile = (await import('node:fs')).writeFileSync;
    const valid = JSON.parse(readFileSync(files.sidecar, 'utf8'));
    const cases = [
      { name: 'bad-json', bytes: Buffer.from('{not json', 'utf8') },
      { name: 'too-large', bytes: Buffer.concat([Buffer.from(JSON.stringify(valid), 'utf8'), Buffer.alloc(16385, 0x20)]) },
      { name: 'different-provenance', bytes: Buffer.from(JSON.stringify({ ...valid, sourceHash: '0'.repeat(64) }), 'utf8') },
    ];
    const results: Array<{ name: string; status: number; code: string }> = [];
    for (const item of cases) {
      writeFile(files.sidecar, item.bytes);
      const retry = await adoptAsset(assetId);
      expect(retry.status, `${item.name} 没有被安全拒绝：${retry.text.slice(0, 200)}`).toBe(409);
      const code = (retry.body as any)?.error?.code ?? '';
      expect(['ASSET_NAME_CONFLICT', 'ASSET_NAME_CONFLICT_SAFE', 'CONFLICT'].includes(code) || /CONFLICT/.test(code), `${item.name} 的错误码不安全：${code}`).toBe(true);
      const after = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, sha256(readFileSync(file))]));
      expect(after, `${item.name} 之后作品字节被改动了`).toEqual(before);
      results.push({ name: item.name, status: retry.status, code });
    }
    writeArtifact('fallback-bad-sidecar.json', { assetId, results, bytes: before });
  });

});
