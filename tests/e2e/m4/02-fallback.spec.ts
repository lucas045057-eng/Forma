import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BACKEND_BASE, FALLBACK_DIR, REPO_ROOT, TEMPLATE_SCENE_CONFIG, WORK_ROOT } from './env';
import {
  adoptAsset, assetModelHash, getAsset, getScene, importFallback, listFallbacks, modelProvenance, restoreTemplate, undoScene, waitFor, writeArtifact,
} from './helpers';

/**
 * M4-D3：固定本地备用模型导入 → 来源 sidecar（按实际 GLB 字节哈希）→ 采用/回退 → 新数据目录。
 *
 * 只用仓库里三份指定 fallback 素材（按 preset SHA256 核对），不经网络：
 * 导入由后端直接读本地固定目录，Lux3D 仍指向无人监听的 loopback。
 */

/**
 * 固定三份 preset 的 id/file/SHA 合同（SHA 由**实际 fallback 目录里的原始 GLB 字节**重新算出后写定）。
 * 另外单独断言"产品声明里的 file→hash 与这里一致"，这样：
 * - 列表用例有**精确 ID 集合**断言，不会退化成"长度对/空集合也算过"；
 * - importFallback 用的是真实存在的 preset.id（旧版只有 file/hash，preset.id 是 undefined）；
 * - 文件字节、本契约、产品声明三者互相校验，且不拿产品 helper 当行为 oracle。
 */
const PRESETS = [
  { id: 'diffuser-split', file: 'lux3d-split-4969889.glb', hash: '239b77d757cd50b377c8d9bd1f9313b1017f11681606ecf234b4fbf0549032e0' },
  { id: 'diffuser-original', file: 'lux3d-4969293.glb', hash: '7770579bb7deb2880c252b2369ecefd4a5e427af2611bb8de4622c413c7b55d7' },
  { id: 'diffuser-alternate', file: 'lux3d-4969298.glb', hash: '09f9085858ace106b7dc5c7b9355320e5d05253a565eb01a73d670c1754ac9bf' },
] as const;

const PRESET_SOURCE = path.join(REPO_ROOT, 'apps', 'server', 'src', 'assets', 'fallbacks.ts');

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
    for (const item of actual) {
      expect(item.match, `${item.file} 的实际字节 SHA256 与固定合同不一致：${JSON.stringify(item)}`).toBe(true);
    }
    // 产品声明里的 file→hash 也必须与固定合同一致（声明被改动同样要被发现）。
    const declared = new Map([...readFileSync(PRESET_SOURCE, 'utf8').matchAll(/file:'([^']+)',hash:'([0-9a-f]{64})'/g)].map((match) => [match[1], match[2]]));
    for (const preset of PRESETS) {
      expect(declared.get(preset.file), `产品声明里缺少 ${preset.file}`).toBe(preset.hash);
    }
    writeArtifact('fallback-factor-presets.json', { presets: actual });
  });

  test('列表只暴露固定 preset，非法输入被拒', async () => {
    const listed = await listFallbacks();
    expect(listed.status, listed.text.slice(0, 200)).toBe(200);
    const ids = (Array.isArray(listed.body) ? listed.body : []).map((item: any) => item.id).sort();
    expect(ids, `preset 列表不是固定三份：${JSON.stringify(ids)}`).toEqual(PRESETS.map((preset) => preset.id).sort());
    const unknown = await importFallback('not-a-preset');
    expect([400, 404]).toContain(unknown.status);
    const bodyRejected = await fetch(`${BACKEND_BASE}/assets/fallbacks/diffuser-split/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '../../etc/passwd' }),
    });
    expect([400]).toContain(bodyRejected.status);
    writeArtifact('fallback-list-and-rejects.json', { ids, unknown: unknown.status, bodyRejected: bodyRejected.status });
  });

  test('导入 → 来源 sidecar 绑定真实字节 → 采用 → scene undo 还原（不是 /version/revert）', async () => {
    // 说明：资产的采用是 SceneService.adopt（会压 scene history）；还原必须走 POST /scene/undo，
    // POST /version/revert 属于 WorkService 的候选采用回退，在没有 adopted 候选时正确返回 409 NO_ADOPTION。
    const imported: Array<{ id: string; preset: string; status: string; provenance: unknown; modelHash: string }> = [];
    for (const preset of PRESETS) {
      const response = await importFallback(preset.id);
      expect([200, 202], `${preset.id} 导入返回 ${response.status} ${response.text.slice(0, 200)}`).toContain(response.status);
      const assetId: string = (response.body as any)?.id;
      expect(assetId, `${preset.id} 没有返回 asset id`).toBeTruthy();
      await waitFor(async () => (await getAsset(assetId)).body?.status === 'ready', 180_000, 500);
      const asset = (await getAsset(assetId)).body;
      expect(asset.status).toBe('ready');
      const provenance = asset.provenance ?? asset.model?.provenance ?? null;
      const text = JSON.stringify(provenance ?? asset);
      expect(text, `${preset.id} 的来源没有绑定 preset/hash`).toContain(preset.hash);
      const modelHash = await assetModelHash(assetId);
      expect(asset.provenance?.sourceHash, `${preset.id} 来源必须绑定原始素材`).toBe(preset.hash);
      expect(asset.provenance?.outputHash, `${preset.id} 输出必须绑定实际优化后 model.glb 字节`).toBe(modelHash);
      imported.push({ id: assetId, preset: preset.id, status: asset.status, provenance, modelHash });
    }

    const sceneBefore = (await getScene()).body;
    const provenanceBefore = (await modelProvenance()).body;
    const target = imported[0];
    const adopted = await adoptAsset(target.id);
    expect(adopted.status, adopted.text.slice(0, 300)).toBe(200);

    const provenanceAfter = (await modelProvenance()).body;
    expect(provenanceAfter.verified, '采用后的作品来源必须通过模型字节核验').toBe(true);
    expect(provenanceAfter.provenance?.outputHash).toBe(target.modelHash);
    expect(JSON.stringify(provenanceAfter), '采用后来源里没有 fallback 的字节哈希').toContain(PRESETS[0].hash);
    const sceneAfter = (await getScene()).body;
    expect(sceneAfter.model).toBe(`/assets/${target.id}.glb`);
    expect(sha256(readFileSync(path.join(WORK_ROOT, 'public', 'assets', `${target.id}.glb`)))).toBe(target.modelHash);
    expect(JSON.stringify(sceneAfter), '采用后场景没有指向新模型').not.toBe(JSON.stringify(sceneBefore));

    // 真实还原路径：scene undo（SceneService 自己压的 history 栈）。
    const undone = await undoScene();
    expect(undone.status, undone.text.slice(0, 300)).toBe(200);
    expect(JSON.stringify((await getScene()).body), 'undo 后场景没有回到采用前').toBe(JSON.stringify(sceneBefore));
    expect(JSON.stringify((await modelProvenance()).body), 'undo 后来源没有回到采用前').toBe(JSON.stringify(provenanceBefore));

    writeArtifact('fallback-import-provenance.json', {
      imported, adopted: adopted.status,
      sceneBoundToModel: JSON.stringify(sceneAfter) !== JSON.stringify(sceneBefore),
      provenanceAfterAdopt: provenanceAfter, provenanceAfterUndo: provenanceBefore,
      undo: undone.status,
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
    const writeFile = (await import('node:fs')).writeFileSync;
    const validBytes = readFileSync(files.sidecar);
    const valid = JSON.parse(validBytes.toString('utf8'));
    const cases = [
      { name: 'bad-json', bytes: Buffer.from('{not json', 'utf8') },
      { name: 'too-large', bytes: Buffer.concat([Buffer.from(JSON.stringify(valid), 'utf8'), Buffer.alloc(16385, 0x20)]) },
      { name: 'different-provenance', bytes: Buffer.from(JSON.stringify({ ...valid, sourceHash: '0'.repeat(64) }), 'utf8') },
    ];
    const results: Array<{ name: string; status: number; code: string }> = [];
    try { for (const item of cases) {
      writeFile(files.sidecar, item.bytes);
      // 请求前已被测试写坏的 sidecar 也是基准的一部分：拒绝采用不得偷偷覆盖它。
      const before = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, sha256(readFileSync(file))]));
      const retry = await adoptAsset(assetId);
      const after = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, sha256(readFileSync(file))]));
      writeArtifact(`fallback-bad-sidecar-${item.name}.json`, { assetId, before, after, status: retry.status, body: retry.body });
      expect(retry.status, `${item.name} 没有被安全拒绝：${retry.text.slice(0, 200)}`).toBe(409);
      const code = (retry.body as any)?.error?.code ?? '';
      expect(['ASSET_NAME_CONFLICT', 'ASSET_NAME_CONFLICT_SAFE', 'CONFLICT'].includes(code) || /CONFLICT/.test(code), `${item.name} 的错误码不安全：${code}`).toBe(true);
      expect(after, `${item.name} 之后作品字节被改动了`).toEqual(before);
      results.push({ name: item.name, status: retry.status, code });
    } } finally { writeFile(files.sidecar, validBytes); }
    writeArtifact('fallback-bad-sidecar.json', { assetId, results });
  });

});
