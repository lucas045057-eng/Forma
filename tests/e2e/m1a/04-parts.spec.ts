import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { M1A_DATA, SERVER_DIR, SINGLE_GLB, SPLIT_GLB, TEMPLATE_MODEL, TEMPLATE_PARTS } from './env';
import { writeArtifactFrom } from './artifact';
import { importAsset } from './viewport';
import { startBackend, startMock, waitForAsset } from '../m0a/harness';

const requireFromServer = createRequire(path.join(SERVER_DIR, 'package.json'));

async function lidChildren(file: string): Promise<{ sceneNodes: string[]; lid: string[] | null; meshes: number }> {
  const { NodeIO } = requireFromServer('@gltf-transform/core');
  const { ALL_EXTENSIONS } = requireFromServer('@gltf-transform/extensions');
  const { MeshoptDecoder } = requireFromServer('meshoptimizer');
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const document = await io.readBinary(new Uint8Array(readFileSync(file)));
  const root = document.getRoot();
  const nodes = root.listNodes().map((node) => node.getName());
  const lid = root.listNodes().find((node) => node.getName() === 'lid');
  return {
    sceneNodes: nodes,
    lid: lid ? lid.listChildren().map((child) => child.getName()) : null,
    meshes: root.listMeshes().length,
  };
}

test('部件命名：4969889 拆分模型的 cap / reed_1..4 / body / lid 与 webReady 门槛', async () => {
  // 1) 提交在仓库里的 parts.json
  const parts = JSON.parse(readFileSync(TEMPLATE_PARTS, 'utf8')) as {
    recognized: boolean; lid: string; nodes: Array<{ sourceIndex: number; name: string }>;
  };
  const byIndex = [...parts.nodes].sort((a, b) => a.sourceIndex - b.sourceIndex).map((node) => node.name);

  // 2) 作品页实际使用的 GLB 里的场景层级
  const graph = await lidChildren(TEMPLATE_MODEL);

  // 3) 后端走同一条管线处理同一个输入，产出应一致（含 webReady）
  const asset = await importAsset('8200001');
  const metrics = asset.metrics!.parts!;

  const artifact = writeArtifactFrom('parts.json', {
    committedParts: parts,
    committedNames: byIndex,
    glbGraph: graph,
    backendMetrics: asset.metrics,
    inputFile: SPLIT_GLB,
  });
  expect(artifact).toBeTruthy();

  expect(parts.recognized).toBe(true);
  expect(byIndex).toEqual(['cap', 'reed_1', 'reed_2', 'reed_3', 'reed_4', 'body']);
  expect(parts.lid).toBe('lid');
  expect(graph.lid, '模型里没有 lid 节点').toBeTruthy();
  expect([...graph.lid!].sort()).toEqual(['cap', 'reed_1', 'reed_2', 'reed_3', 'reed_4']);

  expect(asset.status).toBe('ready');
  expect(asset.metrics!.webReady, '默认模型应满足网页体积门槛').toBe(true);
  expect(metrics.recognized).toBe(true);
  expect([...metrics.nodes].sort((a, b) => a.sourceIndex - b.sourceIndex).map((node) => node.name))
    .toEqual(['cap', 'reed_1', 'reed_2', 'reed_3', 'reed_4', 'body']);
  expect(metrics.lid).toBe('lid');
  expect(asset.metrics!.after.bytes).toBeLessThan(3_000_000);
  expect(asset.metrics!.after.vertices).toBeLessThan(100_000);
});

test('部件命名：单 mesh 模型 recognized=false 且不崩，仍可正常处理与预览', async () => {
  const directory = path.join(M1A_DATA, 'single-mesh');
  const mock = await startMock({ fixture: SINGLE_GLB });
  const backend = await startBackend({ base: mock.base, assetsDir: directory, pollMs: 60 });
  try {
    const submitted = await (
      await fetch(`${backend.base}/assets/lux3d/import`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: '8300001' }),
      })
    ).json() as { id: string; status: string };
    const { asset } = await waitForAsset(backend.base, submitted.id, (item) => ['ready', 'failed'].includes(item.status), { timeoutMs: 120_000 });

    const artifact = writeArtifactFrom('parts-single-mesh.json', { submitted, asset });
    expect(artifact).toBeTruthy();
    expect(asset.status, JSON.stringify(asset.error)).toBe('ready');
    expect(asset.metrics.parts.recognized, '单 mesh 模型不应被识别出部件').toBe(false);
    expect(asset.metrics.parts.reason, '未识别时应说明原因').toBeTruthy();
    // 未识别时保留原节点名，不编造 body/cap/reed/lid
    const fabricated = asset.metrics.parts.nodes.map((node: { name: string }) => node.name).filter((name: string) => /^(body|cap|lid|reed_\d+)$/.test(name));
    expect(fabricated, `未识别时编造了部件名：${JSON.stringify(fabricated)}`).toEqual([]);
    expect(asset.metrics.webReady).toBe(true);
    // 模型仍然可用（下载得到合法 GLB）
    const model = await fetch(`${backend.base}${asset.modelUrl}`);
    expect(model.status).toBe(200);
    const bytes = Buffer.from(await model.arrayBuffer());
    expect(bytes.toString('ascii', 0, 4)).toBe('glTF');
  } finally {
    await backend.stop();
    await mock.stop();
  }
});
