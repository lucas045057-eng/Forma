# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 02-fallback.spec.ts >> M4-D3 本地备用模型与来源 >> 三份本地素材的字节哈希与 preset 声明一致（不联网）
- Location: tests\e2e\m4\02-fallback.spec.ts:31:3

# Error details

```
Error: [{"id":"diffuser-split","file":"lux3d-split-4969889.glb","bytes":11192096,"sha256":"239b77d757cd50b377c8d9bd1f9313b1017f11681606ecf234b4fbf0549032e0","expected":"239b77d757cd50b377c8d9bd1f9313b1017f11681606ecf234b4fbf0549032e0","match":true},{"id":"diffuser-original","file":"lux3d-4969293.glb","bytes":13345788,"sha256":"7770579bb7deb2880c252b2369ecefd4a5e427af2611bb8de4622c413c7b55d7","expected":"7770579bb7deb2880c252b2369ecefd4a5e427af2611bb8de4622c413c7b55d7","match":true},{"id":"diffuser-alternate","file":"lux3d-4969298.glb","bytes":11107988,"sha256":"09f9085858ace106b7dc5c7b9355320e5d05253a565eb01a73d670c1754ac9bf","expected":"09f9085858ace106b7dc5c7b9355320e5d05352a565eb01a73d670c1754ac9bf","match":false}]

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
  1   | import { expect, test } from '@playwright/test';
  2   | import { createHash } from 'node:crypto';
  3   | import { readFileSync } from 'node:fs';
  4   | import path from 'node:path';
  5   | import { BACKEND_BASE, FALLBACK_DIR, TEMPLATE_SCENE_CONFIG, WORK_ROOT } from './env';
  6   | import {
  7   |   adoptAsset, getAsset, getScene, importFallback, listFallbacks, modelProvenance, restoreTemplate, revertVersion, waitFor, writeArtifact,
  8   | } from './helpers';
  9   | 
  10  | /**
  11  |  * M4-D3：固定本地备用模型导入 → 来源 sidecar（按实际 GLB 字节哈希）→ 采用/回退 → 新数据目录。
  12  |  *
  13  |  * 只用仓库里三份指定 fallback 素材（按 preset SHA256 核对），不经网络：
  14  |  * 导入由后端直接读本地固定目录，Lux3D 仍指向无人监听的 loopback。
  15  |  */
  16  | 
  17  | const PRESETS = [
  18  |   { id: 'diffuser-split', file: 'lux3d-split-4969889.glb', hash: '239b77d757cd50b377c8d9bd1f9313b1017f11681606ecf234b4fbf0549032e0' },
  19  |   { id: 'diffuser-original', file: 'lux3d-4969293.glb', hash: '7770579bb7deb2880c252b2369ecefd4a5e427af2611bb8de4622c413c7b55d7' },
  20  |   { id: 'diffuser-alternate', file: 'lux3d-4969298.glb', hash: '09f9085858ace106b7dc5c7b9355320e5d05352a565eb01a73d670c1754ac9bf' },
  21  | ];
  22  | 
  23  | const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  24  | 
  25  | test.describe.configure({ mode: 'serial' });
  26  | 
  27  | test.describe('M4-D3 本地备用模型与来源', () => {
  28  |   test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  29  |   test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  30  | 
  31  |   test('三份本地素材的字节哈希与 preset 声明一致（不联网）', () => {
  32  |     const actual = PRESETS.map((preset) => {
  33  |       const bytes = readFileSync(path.join(FALLBACK_DIR, preset.file));
  34  |       return { id: preset.id, file: preset.file, bytes: bytes.length, sha256: sha256(bytes), expected: preset.hash, match: sha256(bytes) === preset.hash };
  35  |     });
> 36  |     expect(actual.every((item) => item.match), JSON.stringify(actual)).toBe(true);
      |                                                                        ^ Error: [{"id":"diffuser-split","file":"lux3d-split-4969889.glb","bytes":11192096,"sha256":"239b77d757cd50b377c8d9bd1f9313b1017f11681606ecf234b4fbf0549032e0","expected":"239b77d757cd50b377c8d9bd1f9313b1017f11681606ecf234b4fbf0549032e0","match":true},{"id":"diffuser-original","file":"lux3d-4969293.glb","bytes":13345788,"sha256":"7770579bb7deb2880c252b2369ecefd4a5e427af2611bb8de4622c413c7b55d7","expected":"7770579bb7deb2880c252b2369ecefd4a5e427af2611bb8de4622c413c7b55d7","match":true},{"id":"diffuser-alternate","file":"lux3d-4969298.glb","bytes":11107988,"sha256":"09f9085858ace106b7dc5c7b9355320e5d05253a565eb01a73d670c1754ac9bf","expected":"09f9085858ace106b7dc5c7b9355320e5d05352a565eb01a73d670c1754ac9bf","match":false}]
  37  |     writeArtifact('fallback-factor-presets.json', { presets: actual });
  38  |   });
  39  | 
  40  |   test('列表只暴露固定 preset，非法输入被拒', async () => {
  41  |     const listed = await listFallbacks();
  42  |     expect(listed.status, listed.text.slice(0, 200)).toBe(200);
  43  |     const ids = (Array.isArray(listed.body) ? listed.body : []).map((item: any) => item.id).sort();
  44  |     expect(ids).toEqual(PRESETS.map((preset) => preset.id).sort());
  45  |     const unknown = await importFallback('not-a-preset');
  46  |     expect([400, 404]).toContain(unknown.status);
  47  |     const bodyRejected = await fetch(`${BACKEND_BASE}/assets/fallbacks/diffuser-split/import`, {
  48  |       method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '../../etc/passwd' }),
  49  |     });
  50  |     expect([400]).toContain(bodyRejected.status);
  51  |     writeArtifact('fallback-list-and-rejects.json', { ids, unknown: unknown.status, bodyRejected: bodyRejected.status });
  52  |   });
  53  | 
  54  |   test('导入 → 来源 sidecar 绑定真实字节 → 采用 → 回退', async () => {
  55  |     const imported: Array<{ id: string; preset: string; status: string; provenance: unknown }> = [];
  56  |     for (const preset of PRESETS) {
  57  |       const response = await importFallback(preset.id);
  58  |       expect([200, 202], `${preset.id} 导入返回 ${response.status} ${response.text.slice(0, 200)}`).toContain(response.status);
  59  |       const assetId: string = (response.body as any)?.id;
  60  |       expect(assetId, `${preset.id} 没有返回 asset id`).toBeTruthy();
  61  |       const ready = await waitFor(async () => {
  62  |         const asset = await getAsset(assetId);
  63  |         return asset.status === 200 && asset.body?.status === 'ready' ? asset : false;
  64  |       }, 180_000, 500);
  65  |       void ready;
  66  |       const asset = (await getAsset(assetId)).body;
  67  |       expect(asset.status).toBe('ready');
  68  |       const provenance = asset.provenance ?? asset.model?.provenance ?? null;
  69  |       const text = JSON.stringify(provenance ?? asset);
  70  |       expect(text, `${preset.id} 的来源没有绑定 preset/hash`).toContain(preset.hash);
  71  |       imported.push({ id: assetId, preset: preset.id, status: asset.status, provenance });
  72  |     }
  73  | 
  74  |     const target = imported[0];
  75  |     const adopted = await adoptAsset(target.id);
  76  |     expect(adopted.status, adopted.text.slice(0, 300)).toBe(200);
  77  |     const afterAdopt = await modelProvenance();
  78  |     expect(afterAdopt.status).toBe(200);
  79  |     const adoptedText = JSON.stringify(afterAdopt.body);
  80  |     expect(adoptedText, '采用后来源里没有 fallback 的字节哈希').toContain(PRESETS[0].hash);
  81  |     const sceneAfter = await getScene();
  82  | 
  83  |     const reverted = await revertVersion();
  84  |     expect(reverted.status, reverted.text.slice(0, 300)).toBe(200);
  85  |     const afterRevert = await modelProvenance();
  86  |     expect(afterRevert.status).toBe(200);
  87  |     expect(JSON.stringify(afterRevert.body)).not.toBe(adoptedText);
  88  |     const sceneReverted = await getScene();
  89  |     expect(JSON.stringify(sceneReverted.body)).toBe(JSON.stringify(sceneAfter.body));
  90  | 
  91  |     writeArtifact('fallback-import-provenance.json', {
  92  |       imported, adopted: adopted.status,
  93  |       provenanceAfterAdopt: afterAdopt.body, provenanceAfterRevert: afterRevert.body,
  94  |     });
  95  |   });
  96  |   test('F5 preset 导入接受界面真实发出的空对象 POST，危险字段仍被拒', async () => {
  97  |     for (const preset of PRESETS) {
  98  |       const response = await fetch(`${BACKEND_BASE}/assets/fallbacks/${preset.id}/import`, {
  99  |         method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  100 |       });
  101 |       expect([200, 202], `${preset.id} 空对象 POST 返回 ${response.status}`).toContain(response.status);
  102 |     }
  103 |     const unsafe = await fetch(`${BACKEND_BASE}/assets/fallbacks/diffuser-split/import`, {
  104 |       method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: '/etc/passwd' }),
  105 |     });
  106 |     expect([400]).toContain(unsafe.status);
  107 |     writeArtifact('fallback-empty-body-post.json', { accepted: PRESETS.map((preset) => preset.id), unsafe: unsafe.status });
  108 |   });
  109 | 
  110 |   test('F4 坏来源 sidecar 三类都安全 409，作品四份字节不变', async () => {
  111 |     const response = await importFallback('diffuser-split');
  112 |     expect([200, 202]).toContain(response.status);
  113 |     const assetId = (response.body as any)?.id;
  114 |     await waitFor(async () => (await getAsset(assetId)).body?.status === 'ready', 180_000, 500);
  115 |     const adopted = await adoptAsset(assetId);
  116 |     expect(adopted.status, adopted.text.slice(0, 300)).toBe(200);
  117 | 
  118 |     const assetsDir = path.join(WORK_ROOT, 'public', 'assets');
  119 |     const files = {
  120 |       glb: path.join(assetsDir, `${assetId}.glb`),
  121 |       parts: path.join(assetsDir, `${assetId}.parts.json`),
  122 |       sidecar: path.join(assetsDir, `${assetId}.provenance.json`),
  123 |       scene: TEMPLATE_SCENE_CONFIG,
  124 |     };
  125 |     const before = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, sha256(readFileSync(file))]));
  126 | 
  127 |     const writeFile = (await import('node:fs')).writeFileSync;
  128 |     const valid = JSON.parse(readFileSync(files.sidecar, 'utf8'));
  129 |     const cases = [
  130 |       { name: 'bad-json', bytes: Buffer.from('{not json', 'utf8') },
  131 |       { name: 'too-large', bytes: Buffer.concat([Buffer.from(JSON.stringify(valid), 'utf8'), Buffer.alloc(16385, 0x20)]) },
  132 |       { name: 'different-provenance', bytes: Buffer.from(JSON.stringify({ ...valid, sourceHash: '0'.repeat(64) }), 'utf8') },
  133 |     ];
  134 |     const results: Array<{ name: string; status: number; code: string }> = [];
  135 |     for (const item of cases) {
  136 |       writeFile(files.sidecar, item.bytes);
```