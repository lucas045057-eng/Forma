# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 02-fallback.spec.ts >> M4-D3 本地备用模型与来源 >> 导入 → 来源 sidecar 绑定真实字节 → 采用 → 回退
- Location: tests\e2e\m4\02-fallback.spec.ts:70:3

# Error details

```
Error: {"error":{"code":"NO_ADOPTION","message":"没有可以回退的采用记录"}}

expect(received).toBe(expected) // Object.is equality

Expected: 200
Received: 409
```

# Test source

```ts
  1   | import { expect, test } from '@playwright/test';
  2   | import { createHash } from 'node:crypto';
  3   | import { readFileSync } from 'node:fs';
  4   | import path from 'node:path';
  5   | import { BACKEND_BASE, FALLBACK_DIR, REPO_ROOT, TEMPLATE_SCENE_CONFIG, WORK_ROOT } from './env';
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
  17  | /**
  18  |  * 固定三份 preset 的 id/file/SHA 合同（SHA 由**实际 fallback 目录里的原始 GLB 字节**重新算出后写定）。
  19  |  * 另外单独断言"产品声明里的 file→hash 与这里一致"，这样：
  20  |  * - 列表用例有**精确 ID 集合**断言，不会退化成"长度对/空集合也算过"；
  21  |  * - importFallback 用的是真实存在的 preset.id（旧版只有 file/hash，preset.id 是 undefined）；
  22  |  * - 文件字节、本契约、产品声明三者互相校验，且不拿产品 helper 当行为 oracle。
  23  |  */
  24  | const PRESETS = [
  25  |   { id: 'diffuser-split', file: 'lux3d-split-4969889.glb', hash: '239b77d757cd50b377c8d9bd1f9313b1017f11681606ecf234b4fbf0549032e0' },
  26  |   { id: 'diffuser-original', file: 'lux3d-4969293.glb', hash: '7770579bb7deb2880c252b2369ecefd4a5e427af2611bb8de4622c413c7b55d7' },
  27  |   { id: 'diffuser-alternate', file: 'lux3d-4969298.glb', hash: '09f9085858ace106b7dc5c7b9355320e5d05253a565eb01a73d670c1754ac9bf' },
  28  | ] as const;
  29  | 
  30  | const PRESET_SOURCE = path.join(REPO_ROOT, 'apps', 'server', 'src', 'assets', 'fallbacks.ts');
  31  | 
  32  | const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  33  | 
  34  | test.describe.configure({ mode: 'serial' });
  35  | 
  36  | test.describe('M4-D3 本地备用模型与来源', () => {
  37  |   test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  38  |   test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  39  | 
  40  |   test('三份本地素材的字节哈希与 preset 声明一致（不联网）', () => {
  41  |     const actual = PRESETS.map((preset) => {
  42  |       const bytes = readFileSync(path.join(FALLBACK_DIR, preset.file));
  43  |       return { id: preset.id, file: preset.file, bytes: bytes.length, sha256: sha256(bytes), expected: preset.hash, match: sha256(bytes) === preset.hash };
  44  |     });
  45  |     for (const item of actual) {
  46  |       expect(item.match, `${item.file} 的实际字节 SHA256 与固定合同不一致：${JSON.stringify(item)}`).toBe(true);
  47  |     }
  48  |     // 产品声明里的 file→hash 也必须与固定合同一致（声明被改动同样要被发现）。
  49  |     const declared = new Map([...readFileSync(PRESET_SOURCE, 'utf8').matchAll(/file:'([^']+)',hash:'([0-9a-f]{64})'/g)].map((match) => [match[1], match[2]]));
  50  |     for (const preset of PRESETS) {
  51  |       expect(declared.get(preset.file), `产品声明里缺少 ${preset.file}`).toBe(preset.hash);
  52  |     }
  53  |     writeArtifact('fallback-factor-presets.json', { presets: actual });
  54  |   });
  55  | 
  56  |   test('列表只暴露固定 preset，非法输入被拒', async () => {
  57  |     const listed = await listFallbacks();
  58  |     expect(listed.status, listed.text.slice(0, 200)).toBe(200);
  59  |     const ids = (Array.isArray(listed.body) ? listed.body : []).map((item: any) => item.id).sort();
  60  |     expect(ids, `preset 列表不是固定三份：${JSON.stringify(ids)}`).toEqual(PRESETS.map((preset) => preset.id).sort());
  61  |     const unknown = await importFallback('not-a-preset');
  62  |     expect([400, 404]).toContain(unknown.status);
  63  |     const bodyRejected = await fetch(`${BACKEND_BASE}/assets/fallbacks/diffuser-split/import`, {
  64  |       method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '../../etc/passwd' }),
  65  |     });
  66  |     expect([400]).toContain(bodyRejected.status);
  67  |     writeArtifact('fallback-list-and-rejects.json', { ids, unknown: unknown.status, bodyRejected: bodyRejected.status });
  68  |   });
  69  | 
  70  |   test('导入 → 来源 sidecar 绑定真实字节 → 采用 → 回退', async () => {
  71  |     const imported: Array<{ id: string; preset: string; status: string; provenance: unknown }> = [];
  72  |     for (const preset of PRESETS) {
  73  |       const response = await importFallback(preset.id);
  74  |       expect([200, 202], `${preset.id} 导入返回 ${response.status} ${response.text.slice(0, 200)}`).toContain(response.status);
  75  |       const assetId: string = (response.body as any)?.id;
  76  |       expect(assetId, `${preset.id} 没有返回 asset id`).toBeTruthy();
  77  |       const ready = await waitFor(async () => {
  78  |         const asset = await getAsset(assetId);
  79  |         return asset.status === 200 && asset.body?.status === 'ready' ? asset : false;
  80  |       }, 180_000, 500);
  81  |       void ready;
  82  |       const asset = (await getAsset(assetId)).body;
  83  |       expect(asset.status).toBe('ready');
  84  |       const provenance = asset.provenance ?? asset.model?.provenance ?? null;
  85  |       const text = JSON.stringify(provenance ?? asset);
  86  |       expect(text, `${preset.id} 的来源没有绑定 preset/hash`).toContain(preset.hash);
  87  |       imported.push({ id: assetId, preset: preset.id, status: asset.status, provenance });
  88  |     }
  89  | 
  90  |     const target = imported[0];
  91  |     const adopted = await adoptAsset(target.id);
  92  |     expect(adopted.status, adopted.text.slice(0, 300)).toBe(200);
  93  |     const afterAdopt = await modelProvenance();
  94  |     expect(afterAdopt.status).toBe(200);
  95  |     const adoptedText = JSON.stringify(afterAdopt.body);
  96  |     expect(adoptedText, '采用后来源里没有 fallback 的字节哈希').toContain(PRESETS[0].hash);
  97  |     const sceneAfter = await getScene();
  98  | 
  99  |     const reverted = await revertVersion();
> 100 |     expect(reverted.status, reverted.text.slice(0, 300)).toBe(200);
      |                                                          ^ Error: {"error":{"code":"NO_ADOPTION","message":"没有可以回退的采用记录"}}
  101 |     const afterRevert = await modelProvenance();
  102 |     expect(afterRevert.status).toBe(200);
  103 |     expect(JSON.stringify(afterRevert.body)).not.toBe(adoptedText);
  104 |     const sceneReverted = await getScene();
  105 |     expect(JSON.stringify(sceneReverted.body)).toBe(JSON.stringify(sceneAfter.body));
  106 | 
  107 |     writeArtifact('fallback-import-provenance.json', {
  108 |       imported, adopted: adopted.status,
  109 |       provenanceAfterAdopt: afterAdopt.body, provenanceAfterRevert: afterRevert.body,
  110 |     });
  111 |   });
  112 |   test('F5 preset 导入接受界面真实发出的空对象 POST，危险字段仍被拒', async () => {
  113 |     for (const preset of PRESETS) {
  114 |       const response = await fetch(`${BACKEND_BASE}/assets/fallbacks/${preset.id}/import`, {
  115 |         method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  116 |       });
  117 |       expect([200, 202], `${preset.id} 空对象 POST 返回 ${response.status}`).toContain(response.status);
  118 |     }
  119 |     const unsafe = await fetch(`${BACKEND_BASE}/assets/fallbacks/diffuser-split/import`, {
  120 |       method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: '/etc/passwd' }),
  121 |     });
  122 |     expect([400]).toContain(unsafe.status);
  123 |     writeArtifact('fallback-empty-body-post.json', { accepted: PRESETS.map((preset) => preset.id), unsafe: unsafe.status });
  124 |   });
  125 | 
  126 |   test('F4 坏来源 sidecar 三类都安全 409，作品四份字节不变', async () => {
  127 |     const response = await importFallback('diffuser-split');
  128 |     expect([200, 202]).toContain(response.status);
  129 |     const assetId = (response.body as any)?.id;
  130 |     await waitFor(async () => (await getAsset(assetId)).body?.status === 'ready', 180_000, 500);
  131 |     const adopted = await adoptAsset(assetId);
  132 |     expect(adopted.status, adopted.text.slice(0, 300)).toBe(200);
  133 | 
  134 |     const assetsDir = path.join(WORK_ROOT, 'public', 'assets');
  135 |     const files = {
  136 |       glb: path.join(assetsDir, `${assetId}.glb`),
  137 |       parts: path.join(assetsDir, `${assetId}.parts.json`),
  138 |       sidecar: path.join(assetsDir, `${assetId}.provenance.json`),
  139 |       scene: TEMPLATE_SCENE_CONFIG,
  140 |     };
  141 |     const before = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, sha256(readFileSync(file))]));
  142 | 
  143 |     const writeFile = (await import('node:fs')).writeFileSync;
  144 |     const valid = JSON.parse(readFileSync(files.sidecar, 'utf8'));
  145 |     const cases = [
  146 |       { name: 'bad-json', bytes: Buffer.from('{not json', 'utf8') },
  147 |       { name: 'too-large', bytes: Buffer.concat([Buffer.from(JSON.stringify(valid), 'utf8'), Buffer.alloc(16385, 0x20)]) },
  148 |       { name: 'different-provenance', bytes: Buffer.from(JSON.stringify({ ...valid, sourceHash: '0'.repeat(64) }), 'utf8') },
  149 |     ];
  150 |     const results: Array<{ name: string; status: number; code: string }> = [];
  151 |     for (const item of cases) {
  152 |       writeFile(files.sidecar, item.bytes);
  153 |       const retry = await adoptAsset(assetId);
  154 |       expect(retry.status, `${item.name} 没有被安全拒绝：${retry.text.slice(0, 200)}`).toBe(409);
  155 |       const code = (retry.body as any)?.error?.code ?? '';
  156 |       expect(['ASSET_NAME_CONFLICT', 'ASSET_NAME_CONFLICT_SAFE', 'CONFLICT'].includes(code) || /CONFLICT/.test(code), `${item.name} 的错误码不安全：${code}`).toBe(true);
  157 |       const after = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, sha256(readFileSync(file))]));
  158 |       expect(after, `${item.name} 之后作品字节被改动了`).toEqual(before);
  159 |       results.push({ name: item.name, status: retry.status, code });
  160 |     }
  161 |     writeArtifact('fallback-bad-sidecar.json', { assetId, results, bytes: before });
  162 |   });
  163 | 
  164 | });
  165 | 
```