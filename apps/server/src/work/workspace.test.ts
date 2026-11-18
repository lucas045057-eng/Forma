import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultSceneConfig } from '@spatial/shared/scene-config';
import { CodingAgent } from '../agent/client.ts';
import { createApp } from '../app.ts';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'multi-work-test-'));
  roots.push(root);
  const workRoot = path.join(root, 'default-work');
  await mkdir(path.join(workRoot, 'src'), { recursive: true });
  await writeFile(path.join(workRoot, 'src/scene.config.json'), JSON.stringify(defaultSceneConfig, null, 2) + '\n');
  await writeFile(path.join(workRoot, 'src/App.tsx'), 'export default function App() { return <main>Default Work</main>; }\n');
  await writeFile(path.join(workRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, allowImportingTsExtensions: true } }, null, 2) + '\n');
  return {
    root,
    workRoot,
    assetsDir: path.join(root, 'assets'),
    workDataDir: path.join(root, 'work-data'),
    historyDir: path.join(root, 'history'),
  };
}

it('creates isolated blank works, switches between works without cross-talk, and persists across restarts', async () => {
  const f = await fixture();
  let instance = await createApp({
    workRoot: f.workRoot,
    dataDirectory: f.assetsDir,
    workDataDirectory: f.workDataDir,
    historyDirectory: f.historyDir,
    base: 'http://127.0.0.1:9',
    key: 'mock-only',
    codingAgentBaseUrl: 'http://127.0.0.1:9',
    codingAgentApiKey: 'mock-only',
    codingAgentModel: 'mock-model',
  });
  try {
    const initialList = (await instance.app.inject('/works')).json();
    expect(initialList).toMatchObject({
      activeId: 'default',
      works: [{ id: 'default', name: '木间香薰', starter: 'product-page', active: true }],
    });
    const defaultVersion = (await instance.app.inject('/version')).json().version as string;

    // Create a new blank 3D work
    const created = await instance.app.inject({
      method: 'POST',
      url: '/works',
      payload: { name: '极简月球灯展厅', starter: 'blank' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json();
    expect(body.work).toMatchObject({ name: '极简月球灯展厅', starter: 'blank', active: true });
    const blankWorkId = body.activeId as string;
    expect(blankWorkId).toMatch(/^work-[a-f0-9]{8}$/);

    // Active scene in blank work starts with empty model URL, independent of default work
    const blankScene = (await instance.app.inject('/scene')).json();
    expect(blankScene.model).toBe('');
    const updatedScene = structuredClone(blankScene);
    updatedScene.hero.lights.ambient = 3.5;
    expect((await instance.app.inject({ method: 'PUT', url: '/scene', payload: updatedScene })).statusCode).toBe(200);

    // Switch back to default work and verify default work was untouched
    const switchedBack = await instance.app.inject({ method: 'POST', url: '/works/default/select', payload: {} });
    expect(switchedBack.statusCode).toBe(200);
    expect((await instance.app.inject('/version')).json().version).toBe(defaultVersion);
    expect((await instance.app.inject('/scene')).json().model).toBe(defaultSceneConfig.model);
    expect((await instance.app.inject('/scene')).json().hero.lights.ambient).toBe(defaultSceneConfig.hero.lights.ambient);

    // Rename the blank work and switch to it again
    const renamed = await instance.app.inject({
      method: 'PATCH',
      url: `/works/${blankWorkId}`,
      payload: { name: '月球灯 · 旗舰空间版' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().name).toBe('月球灯 · 旗舰空间版');
    expect((await instance.app.inject({ method: 'POST', url: `/works/${blankWorkId}/select`, payload: {} })).statusCode).toBe(200);
    expect((await instance.app.inject('/scene')).json().hero.lights.ambient).toBe(3.5);
  } finally {
    await instance.app.close();
  }

  // Restart and confirm persisted activeId + work list
  instance = await createApp({
    workRoot: f.workRoot,
    dataDirectory: f.assetsDir,
    workDataDirectory: f.workDataDir,
    historyDirectory: f.historyDir,
    base: 'http://127.0.0.1:9',
    key: 'mock-only',
    codingAgentBaseUrl: 'http://127.0.0.1:9',
    codingAgentApiKey: 'mock-only',
    codingAgentModel: 'mock-model',
  });
  try {
    const resumedList = (await instance.app.inject('/works')).json();
    expect(resumedList.works).toHaveLength(2);
    expect(resumedList.works[1].name).toBe('月球灯 · 旗舰空间版');
    expect(resumedList.activeId).toBe(resumedList.works[1].id);
  } finally {
    await instance.app.close();
  }
});

it('bootstraps a first-edition 3D webpage from one sentence and reuses shared 3D assets directly into candidate preview', async () => {
  const f = await fixture();
  await mkdir(path.join(f.assetsDir, 'opt-earbuds'), { recursive: true });
  const glb = Buffer.from('glTF-earbuds-binary');
  const outputHash = createHash('sha256').update(glb).digest('hex');
  await writeFile(path.join(f.assetsDir, 'opt-earbuds/model.glb'), glb);
  await writeFile(path.join(f.assetsDir, 'index.json'), JSON.stringify([{
    id: 'opt-earbuds',
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    provenance: { kind: 'lux3d', sourceTaskId: '2002', outputHash },
    metrics: { webReady: true, parts: { recognized: false, nodes: [], reason: 'No part metadata' } },
  }]));

  let capturedBootstrapFlag: boolean | undefined;
  vi.spyOn(CodingAgent.prototype, 'run').mockImplementation(async ({ root, bootstrap, instruction }) => {
    capturedBootstrapFlag = bootstrap;
    await writeFile(
      path.join(root, 'src/App.tsx'),
      `import { ProductHero } from './components/ProductHero';\nexport default function App() { return <main data-spatial-page><h1>${instruction}</h1><button type="button">立即预约</button><ProductHero /></main>; }\n`,
    );
    await writeFile(path.join(root, 'src/style.css'), 'body { margin: 0; background: #090c12; color: #eef3ff; }\n');
    return { summary: '已生成首版黑钛耳机 3D 网页', written: ['src/App.tsx', 'src/style.css'] };
  });

  const instance = await createApp({
    workRoot: f.workRoot,
    dataDirectory: f.assetsDir,
    workDataDirectory: f.workDataDir,
    historyDirectory: f.historyDir,
    base: 'http://127.0.0.1:9',
    key: 'mock-only',
    codingAgentBaseUrl: 'http://127.0.0.1:9',
    codingAgentApiKey: 'mock-only',
    codingAgentModel: 'mock-model',
  });
  try {
    // Stub preview process spawn in unit test so candidate publishes immediately without needing full node_modules in temp dir
    const origCreate = instance.workspace.create.bind(instance.workspace);
    vi.spyOn(instance.workspace, 'create').mockImplementation(async input => {
      const res = await origCreate(input);
      return res;
    });

    // First create blank work with shared asset, then submit bootstrap task with stubbed preview start
    const created = await instance.app.inject({
      method: 'POST',
      url: '/works',
      payload: { name: '黑钛耳机发布页', starter: 'blank', assetId: 'opt-earbuds' },
    });
    expect(created.statusCode, created.body).toBe(201);
    expect((await instance.app.inject('/scene')).json().model).toBe('/assets/opt-earbuds.glb');

    const activeWork = instance.workspace.current().work;
    activeWork.previews.start = async id => `/preview/c/${id}/`;
    activeWork.previews.stop = async () => {};
    activeWork.previews.stopAll = async () => {};

    const taskRes = await instance.app.inject({
      method: 'POST',
      url: '/tasks',
      payload: { instruction: '黑钛旗舰无线降噪耳机 3D 新品发布页', bootstrap: true },
    });
    expect(taskRes.statusCode, taskRes.body).toBe(202);
    await activeWork.idle();

    expect(capturedBootstrapFlag).toBe(true);
    // Goes directly to candidate ('done'), NOT blocked on a pre-candidate approval card!
    const tasks = (await instance.app.inject('/tasks')).json();
    expect(tasks[0]).toMatchObject({ bootstrap: true, status: 'done' });
    expect((await instance.app.inject('/approvals')).json()).toEqual([]);
    const candidates = (await instance.app.inject('/candidates')).json();
    expect(candidates).toHaveLength(1);
    expect(candidates[0].outOfScope).toEqual([]);
    expect(await readFile(path.join(instance.workspace.current().workRoot, 'public/assets/opt-earbuds.glb'))).toEqual(glb);
  } finally {
    await instance.app.close();
  }
});
