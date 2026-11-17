import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { api, control, fixtureBytes, jsxTarget, resetFake, restoreWorkRoot, uploadBytes, waitTask, writeEvidence } from './support/api';
import { approvePlacementTaskOnce } from './support/approvals';
import { assertLedgerMatrix } from './support/ledger-matrix';
import { WORK_DATA, WORK_ROOT } from './env';

/** 实例模块全链：插入候选 → 检查 → 采用 → 调整 → 撤回 → 主场景交叉写入使游标失效 → 移除候选。 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(600_000);

test.beforeEach(async ({ request }) => {
  await resetFake();
  await control({ blockSize: 1024 * 1024 });
  expect((await api(request, 'GET', '/health')).status).toBe(200);
});

test.afterAll(() => {
  const cleanup = restoreWorkRoot();
  expect(cleanup.after).toBe('');
});

interface TaskLike { id: string; candidateId?: string; status: string }

const insertCandidate = async (request: APIRequestContext, key: string) => {
  const version = (await api<{ version: string }>(request, 'GET', '/version')).body.version;
  const image = await uploadBytes(request, { kind: 'image', filename: 'image.png', bytes: fixtureBytes('image.png') });
  expect(image.status).toBe(201);
  const created = await api<{ localId: string }>(request, 'POST', '/assets/lux3d/operations', {
    operation: 'image-to-3d', parameters: { imageUploadId: image.body.id, version: 'G1', outputFormat: ['glb'] }, idempotencyKey: key,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(202);
  const task = await waitTask(request, created.body.localId);
  const assetId = task.artifacts.find((item) => item.kind === 'model' && item.assetId)!.assetId!;
  const session = await api<{ sessionId: string }>(request, 'POST', '/assets/placements/sessions', { assetId, baseVersion: version });
  expect(session.status).toBe(200);
  const target = {
    kind: 'insert',
    src: jsxTarget('templates/product-page/src/App.tsx', '<Button data-testid="buy-button"'),
    cid: 'Button', ancestors: ['src/App.tsx:1:1'], position: 'after',
  };
  const confirmed = await api<{ kind: string; task: TaskLike }>(request, 'POST', `/assets/placements/${session.body.sessionId}/confirm`, {
    target, adjustment: { layout: { widthPercent: 60, align: 'center', offsetY: 12 }, rotation: [0, 0.4, 0], scale: 1 },
  });
  expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
  expect(confirmed.body.kind).toBe('insert');
  const approvedTask = await approvePlacementTaskOnce((method, pathname, data) => api<unknown>(request, method, pathname, data), confirmed.body.task);
  expect(approvedTask.candidateId).toBe(approvedTask.id);
  return { version, assetId, task: approvedTask, candidateId: approvedTask.candidateId! };
};

test('插入候选：ledger 与 src-only 差异，检查通过后采用，调整/撤回与 stale 游标，最后移除候选', async ({ request }) => {
  const inserted = await insertCandidate(request, 'k-module');
  const candidateId = inserted.candidateId;

  const candidate = await api<{ id: string; baseVersion: string; diff: Array<{ path: string; patch: string }> }>(request, 'GET', `/candidates/${candidateId}`);
  expect(candidate.status, JSON.stringify(candidate.body)).toBe(200);
  const files = candidate.body.diff.map((item) => item.path).sort();
  expect(new Set(files).size, '候选 diff 不应有重复路径').toBe(files.length);
  expect(files.some((file) => file.startsWith('src/scene-modules/') && file.endsWith('.json'))).toBe(true);
  const moduleFile = files.find((file) => file.startsWith('src/scene-modules/') && file.endsWith('.json'))!;
  const instanceId = path.basename(moduleFile, '.json');
  expect(instanceId).toMatch(/^[a-f0-9]{32}$/);
  expect(candidate.body.baseVersion).toBe(inserted.version);

  const ledgerDir = path.join(WORK_DATA, 'lux3d-ledgers');
  expect(existsSync(ledgerDir)).toBe(true);
  const ledgerFiles = readdirSync(ledgerDir).filter((name) => name === `${candidateId}.json`);
  expect(ledgerFiles).toHaveLength(1);
  const ledger = JSON.parse(readFileSync(path.join(ledgerDir, ledgerFiles[0]), 'utf8')) as {
    schemaVersion: number; candidateId: string; baseVersion: string; intent: string; instanceId?: string;
    entries: Array<{ path: string; operation: 'create' | 'modify' | 'delete'; role: string; beforeHash: string | null; afterHash: string | null; bytes: number; assetId?: string; instanceId?: string }>;
    reference?: { action?: string; file?: string; instanceId?: string; anchor?: string };
  };
  expect(ledger.schemaVersion).toBe(1);
  expect(ledger.candidateId).toBe(candidateId);
  expect(ledger.baseVersion).toBe(inserted.version);
  expect(ledger.intent).toBe('insert');
  expect(ledger.instanceId).toBe(instanceId);
  expect(ledger.reference).toMatchObject({ action: 'add', file: 'src/App.tsx', instanceId });
  expect(typeof ledger.reference?.anchor).toBe('string');
  const entriesByPath = new Map(ledger.entries.map((entry) => [entry.path, entry]));
  expect(entriesByPath.size, 'ledger 条目路径不应重复').toBe(ledger.entries.length);
  const candidateRoot = path.join(WORK_DATA, 'candidates', candidateId);
  assertLedgerMatrix(ledger, candidateRoot, ledger.reference?.file);
  const configEntry = entriesByPath.get(moduleFile);
  expect(configEntry, `ledger 缺少 ${moduleFile}`).toBeTruthy();
  expect(configEntry).toMatchObject({ role: 'config', operation: 'create', beforeHash: null, instanceId, assetId: inserted.assetId });
  expect(configEntry!.afterHash).toMatch(/^[a-f0-9]{64}$/);
  expect(configEntry!.bytes).toBeGreaterThan(0);
  const modelEntry = ledger.entries.find((entry) => entry.role === 'model');
  expect(modelEntry).toMatchObject({ path: `public/assets/${inserted.assetId}.glb`, operation: 'create', beforeHash: null, assetId: inserted.assetId });
  expect(modelEntry!.afterHash).toMatch(/^[a-f0-9]{64}$/);
  expect(modelEntry!.bytes).toBeGreaterThan(0);
  const provenanceEntry = ledger.entries.find((entry) => entry.role === 'provenance');
  expect(provenanceEntry?.path).toBe(`public/assets/${inserted.assetId}.provenance.json`);
  expect(provenanceEntry?.afterHash).toMatch(/^[a-f0-9]{64}$/);
  const managedRoles: Record<string, (file: string) => boolean> = {
    model: (file) => file === `public/assets/${inserted.assetId}.glb`,
    provenance: (file) => file === `public/assets/${inserted.assetId}.provenance.json`,
    parts: (file) => file === `public/assets/${inserted.assetId}.parts.json`,
    config: (file) => file === moduleFile,
    component: (file) => file === `src/scene-modules/${instanceId}.tsx`,
    runtime: (file) => file === 'src/spatial-module.tsx',
    tsconfig: (file) => file === 'tsconfig.json',
  };
  const componentEntry = entriesByPath.get(`src/scene-modules/${instanceId}.tsx`);
  expect(componentEntry).toMatchObject({ role: 'component', operation: 'create', beforeHash: null, instanceId });
  expect(componentEntry!.afterHash).toMatch(/^[a-f0-9]{64}$/);
  const managedEntries = ledger.entries.filter((entry) => Object.hasOwn(managedRoles, entry.role));
  for (const entry of managedEntries) {
    expect(managedRoles[entry.role](entry.path), `ledger ${entry.role} 路径不符合约定：${entry.path}`).toBe(true);
    expect(entry.afterHash).toMatch(/^[a-f0-9]{64}$/);
  }
  const managedExtra = new Set(managedEntries.map((entry) => entry.path));
  for (const file of files) {
    expect(file.startsWith('src/') || managedExtra.has(file), `diff 出现未由 ledger 证明的路径：${file}`).toBe(true);
    expect(file).not.toMatch(/(^|\/)(package\.json|pnpm-lock\.yaml|vite\.config\.ts)$/);
    if (file.startsWith('public/')) expect(managedExtra.has(file)).toBe(true);
  }

  const started = await api<{ id: string; status: string }>(request, 'POST', `/candidates/${candidateId}/checks`, {});
  expect(started.status, JSON.stringify(started.body)).toBe(202);
  const runId = started.body.id;
  const deadline = Date.now() + 480_000;
  let run: { status: string; outcome?: string; checks: Array<{ name: string; status: string }> } | undefined;
  while (Date.now() < deadline) {
    const polled = await api<typeof run>(request, 'GET', `/checks/${runId}`);
    expect(polled.status).toBe(200);
    run = polled.body;
    if (run!.status === 'completed' || run!.status === 'cancelled') break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  writeEvidence('module-checks.json', run);
  expect(run?.status).toBe('completed');
  expect(run?.outcome, JSON.stringify(run)).toBe('passed');

  const adopted = await api<{ version: string }>(request, 'POST', `/candidates/${candidateId}/adopt`);
  expect(adopted.status, JSON.stringify(adopted.body)).toBe(200);
  const adoptedVersion = adopted.body.version;
  const modulePath = path.join(WORK_ROOT, 'src', 'scene-modules', `${instanceId}.json`);
  expect(existsSync(modulePath)).toBe(true);
  const appSource = readFileSync(path.join(WORK_ROOT, 'src', 'App.tsx'), 'utf8');
  expect(appSource).toContain(instanceId);

  const modules = await api<Array<{ id: string; config: { assetId: string }; canUndo: boolean; stale: boolean }>>(request, 'GET', '/assets/modules');
  expect(modules.status).toBe(200);
  const entry = modules.body.find((item) => item.id === instanceId);
  expect(entry?.config.assetId).toBe(inserted.assetId);
  expect(entry?.canUndo).toBe(false);

  const adjusted = await api<{ version: string }>(request, 'POST', `/assets/modules/${instanceId}/adjust`, { baseVersion: adoptedVersion, adjustment: { rotation: [0, 0.9, 0], scale: 1.2 } });
  expect(adjusted.status, JSON.stringify(adjusted.body)).toBe(200);
  const afterAdjust = JSON.parse(readFileSync(modulePath, 'utf8')) as { rotation: number[]; scale: number };
  expect(afterAdjust.rotation[1]).toBeCloseTo(0.9, 5);
  expect(afterAdjust.scale).toBeCloseTo(1.2, 5);

  const undone = await api<{ version: string }>(request, 'POST', `/assets/modules/${instanceId}/undo`, { baseVersion: adjusted.body.version });
  expect(undone.status, JSON.stringify(undone.body)).toBe(200);
  const afterUndo = JSON.parse(readFileSync(modulePath, 'utf8')) as { rotation: number[]; scale: number };
  expect(afterUndo.rotation[1]).toBeCloseTo(0.4, 5);

  const adjustedAgain = await api<{ version: string }>(request, 'POST', `/assets/modules/${instanceId}/adjust`, { baseVersion: undone.body.version, adjustment: { scale: 1.1 } });
  expect(adjustedAgain.status).toBe(200);
  const scene = (await api<Record<string, unknown>>(request, 'GET', '/scene')).body as { hero: { lights: { ambient: number } } } & Record<string, unknown>;
  const changedScene = { ...scene, hero: { ...scene.hero, lights: { ...scene.hero.lights, ambient: scene.hero.lights.ambient + 0.05 } } };
  const wrote = await api(request, 'PUT', '/scene', changedScene);
  expect(wrote.status, JSON.stringify(wrote.body)).toBe(200);
  const staleUndo = await api(request, 'POST', `/assets/modules/${instanceId}/undo`, { baseVersion: adjustedAgain.body.version });
  expect(staleUndo.status).toBe(409);
  expect((staleUndo.body as unknown as { error?: { code?: string } }).error?.code).toBe('MODULE_HISTORY_STALE');
  const staleList = await api<Array<{ id: string; stale: boolean }>>(request, 'GET', '/assets/modules');
  expect(staleList.body.find((item) => item.id === instanceId)?.stale).toBe(true);

  const currentVersion = (await api<{ version: string }>(request, 'GET', '/version')).body.version;
  const removal = await api<{ candidateId?: string; id: string }>(request, 'POST', `/assets/modules/${instanceId}/remove`, { baseVersion: currentVersion });
  expect(removal.status, JSON.stringify(removal.body)).toBe(200);
  const removalTask = await approvePlacementTaskOnce(
    (method, pathname, data) => api<unknown>(request, method, pathname, data),
    removal.body as unknown as TaskLike,
  );
  const removeCandidateId = removalTask.candidateId ?? removalTask.id;
  const removeCandidate = await api<{ diff: Array<{ path: string }> }>(request, 'GET', `/candidates/${removeCandidateId}`);
  const removedFiles = removeCandidate.body.diff.map((item) => item.path);
  expect(removedFiles).toContain(moduleFile);
  const removeLedgerFiles = readdirSync(ledgerDir).filter((name) => name === `${removeCandidateId}.json`);
  expect(removeLedgerFiles).toHaveLength(1);
  const removeLedger = JSON.parse(readFileSync(path.join(ledgerDir, removeLedgerFiles[0]), 'utf8')) as {
    candidateId: string; intent: string; instanceId?: string;
    entries: Array<{ path: string; operation: 'create' | 'modify' | 'delete'; role: string; beforeHash: string | null; afterHash: string | null; bytes: number; instanceId?: string }>;
    reference?: { action?: string; file?: string; instanceId?: string };
  };
  expect(removeLedger.candidateId).toBe(removeCandidateId);
  expect(removeLedger.intent).toBe('remove');
  expect(removeLedger.instanceId).toBe(instanceId);
  expect(removeLedger.reference).toMatchObject({ action: 'remove', file: 'src/App.tsx', instanceId });
  const removedConfig = removeLedger.entries.find((entry) => entry.path === moduleFile);
  expect(removedConfig).toMatchObject({ role: 'config', operation: 'delete', afterHash: null, bytes: 0, instanceId });
  expect(removedConfig!.beforeHash).toMatch(/^[a-f0-9]{64}$/);
  const removeCandidateRoot = path.join(WORK_DATA, 'candidates', removeCandidateId);
  assertLedgerMatrix(removeLedger, removeCandidateRoot, removeLedger.reference?.file);
  const removeManagedRoles: Record<string, (file: string) => boolean> = {
    config: (file) => file === moduleFile,
    component: (file) => file === `src/scene-modules/${instanceId}.tsx`,
    runtime: (file) => file === 'src/spatial-module.tsx',
    tsconfig: (file) => file === 'tsconfig.json',
  };
  const removeManagedEntries = removeLedger.entries.filter((entry) => Object.hasOwn(removeManagedRoles, entry.role));
  for (const entry of removeManagedEntries) {
    expect(removeManagedRoles[entry.role](entry.path), `remove ledger ${entry.role} 路径不符合约定：${entry.path}`).toBe(true);
  }
  const removeManagedExtra = new Set(removeManagedEntries.map((entry) => entry.path));
  for (const file of removedFiles) {
    expect(file.startsWith('src/') || removeManagedExtra.has(file), `移除 diff 出现未由 ledger 证明的路径：${file}`).toBe(true);
    if (file.startsWith('public/')) expect(removeManagedExtra.has(file)).toBe(true);
  }

  const cleanup = restoreWorkRoot();
  expect(cleanup.after).toBe('');
  writeEvidence('module-history.json', {
    instanceId, moduleFile, candidateId, run, adoptedVersion, adjusted: adjusted.body.version, staleCode: (staleUndo.body as { error?: { code?: string } }).error?.code,
    removedFiles, cleanup: cleanup.before,
  });
});
