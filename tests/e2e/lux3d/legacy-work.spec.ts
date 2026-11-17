import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { control, fixtureBytes, readHttpResult, writeEvidence } from './support/api';
import { approvePlacementTaskOnce } from './support/approvals';
import { assertLedgerMatrix } from './support/ledger-matrix';
import { AGENT_BASE, AGENT_KEY, AGENT_MODEL, DATA_ROOT, FAKE_BASE, FAKE_KEY, REPO_ROOT, TEMPLATE_DIR } from './env';

/**
 * N56 / N3 / N8：旧作品（没有受信渲染器）首次插入时，由服务端安装 canonical runtime；
 * 同名自定义文件冲突必须拒绝且不覆盖。用独立的作品副本 + 进程内 createApp，不碰模板与在测实例。
 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(600_000);

const legacyRoot = path.join(DATA_ROOT, 'legacy-work');
const legacyData = path.join(DATA_ROOT, 'legacy-data');
const legacyWork = path.join(DATA_ROOT, 'legacy-work-data');
const legacyHistory = path.join(DATA_ROOT, 'legacy-history');
const legacyAssets = path.join(DATA_ROOT, 'legacy-assets');

function resetLegacy() {
  for (const dir of [legacyRoot, legacyData, legacyWork, legacyHistory, legacyAssets]) rmSync(dir, { recursive: true, force: true });
  mkdirSync(legacyRoot, { recursive: true });
  const tar = execFileSync('git', ['-c', 'core.longpaths=true', 'archive', '--format=tar', 'HEAD:templates/product-page'], { cwd: REPO_ROOT, maxBuffer: 256 * 1024 * 1024 });
  const archive = path.join(DATA_ROOT, 'legacy-work.tar');
  writeFileSync(archive, tar);
  execFileSync('tar', ['-xf', archive, '-C', legacyRoot], { cwd: REPO_ROOT });
  unlinkSync(archive);
  // 旧作品：没有受信运行时。
  unlinkSync(path.join(legacyRoot, 'src', 'spatial-module.tsx'));
  symlinkSync(path.join(TEMPLATE_DIR, 'node_modules'), path.join(legacyRoot, 'node_modules'), 'junction');
}

function srcTarget(root: string, file: string, needle: string) {
  const source = readFileSync(path.join(root, file), 'utf8');
  const index = source.indexOf(needle);
  if (index < 0) throw new Error(`needle not found: ${needle}`);
  const before = source.slice(0, index);
  return `${file}:${before.split('\n').length}:${index - before.lastIndexOf('\n')}`;
}

/**
 * 记录本 worker 的 guard 加载证据（SF1）：必须是本轮（LUX3D_GUARD_DIR 指定）真实加载，
 * 不是只看日志缺省值；缺证据时由 runner 判失败，而不是当作“零拦截”。
 */
function recordGuardProof() {
  const guardDir = (process.env.LUX3D_GUARD_DIR ?? '').replace(/\\/g, '/');
  if (!guardDir) return { recorded: false, reason: 'LUX3D_GUARD_DIR 未设置（历史 runner）' };
  const guard = (globalThis as { __piNetGuard?: { ready?: boolean; log?: string } }).__piNetGuard;
  const ready = guard?.ready === true;
  const guardLog = guard?.log ?? '';
  const expectedLogPath = `${guardDir}/test-worker.log`;
  // Windows 比较：统一分隔符/去尾部斜杠/大小写不敏感，但仍要求**完整绝对路径相等**（不是前缀）。
  const normalized = (value: string) => String(value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const logMatches = normalized(guardLog) === normalized(expectedLogPath);
  const proof = {
    role: 'legacy-worker', pid: process.pid, ready, guardLog, expectedLogPath, logMatches,
    envLogPath: process.env.PI_NET_GUARD_LOG ?? '', runDir: guardDir, at: new Date().toISOString(),
    logPath: guardLog,
  };
  mkdirSync(guardDir, { recursive: true });
  writeFileSync(path.join(guardDir, 'legacy-worker.loaded.json'), `${JSON.stringify(proof, null, 2)}\n`);
  expect(ready, 'worker 进程未加载 loopback guard').toBe(true);
  expect(logMatches, `worker guard 实际捕获的日志不是本轮 test-worker.log：${guardLog}（期望 ${expectedLogPath}）`).toBe(true);
  return { recorded: true, ...proof };
}

async function withApp<T>(run: (base: string) => Promise<T>): Promise<T> {
  recordGuardProof();
  resetLegacy();
  const { createApp } = await import('../../../apps/server/src/app.ts');
  const created = await createApp({
    workRoot: legacyRoot, dataDirectory: legacyAssets, workDataDirectory: legacyWork, historyDirectory: legacyHistory,
    base: FAKE_BASE, key: FAKE_KEY,
    pollMs: 80, timeoutMs: 60_000, previewStartTimeoutMs: 60_000,
    codingAgentBaseUrl: AGENT_BASE, codingAgentApiKey: AGENT_KEY, codingAgentModel: AGENT_MODEL,
    // 显式空对象：不回退读 SPEECH_* env，SpeechClient 保持 disabled（不传非法 model/key）。
    speech: {},
  });
  const address = await created.app.listen({ port: 0, host: '127.0.0.1' });
  const base = address.replace(/\/$/, '');
  try {
    return await run(base);
  } finally {
    await created.app.close();
  }
}

const post = async (request: APIRequestContext, base: string, pathname: string, data: unknown) => {
  const response = await request.post(`${base}${pathname}`, { data, headers: { 'content-type': 'application/json' }, failOnStatusCode: false });
  return readHttpResult<Record<string, unknown>>(response, { method: 'POST', pathname });
};
const get = async (request: APIRequestContext, base: string, pathname: string) => {
  const response = await request.get(`${base}${pathname}`, { failOnStatusCode: false });
  return readHttpResult<Record<string, unknown>>(response, { method: 'GET', pathname });
};
const pollTask = async (request: APIRequestContext, base: string, id: string) => {
  const deadline = Date.now() + 180_000;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const result = await get(request, base, `/assets/lux3d/tasks/${id}`);
    last = result.body;
    if (['ready', 'failed', 'cancelled', 'submit_unknown'].includes(String(last?.stage))) return last;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`legacy task timeout: ${JSON.stringify(last)?.slice(0, 300)}`);
};

test.beforeEach(async ({ request }) => {
  await control({ blockSize: 1024 * 1024 });
  expect(request).toBeTruthy();
});

test('N56 旧作品插入：安装 canonical runtime 并写 ledger；同名自定义文件冲突时拒绝且不覆盖', async ({ request }) => {
  await withApp(async (base) => {
    const uploadResponse = await request.post(`${base}/assets/uploads?kind=image&filename=image.png`, { headers: { 'content-type': 'application/octet-stream' }, data: fixtureBytes('image.png'), failOnStatusCode: false });
    expect(uploadResponse.status()).toBe(201);
    const upload = await uploadResponse.json() as { id: string };
    const created = await post(request, base, '/assets/lux3d/operations', { operation: 'image-to-3d', parameters: { imageUploadId: upload.id, version: 'G1', outputFormat: ['glb'] }, idempotencyKey: 'k-legacy' });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    const task = await pollTask(request, base, String((created.body as { localId: string }).localId));
    const assetId = ((task.artifacts as Array<{ kind: string; assetId?: string }>).find((item) => item.kind === 'model' && item.assetId))?.assetId;
    expect(assetId).toBeTruthy();
    const version = (await get(request, base, '/version')).body.version as string;
    const target = { kind: 'insert', src: srcTarget(legacyRoot, 'src/App.tsx', '<Button data-testid="buy-button"'), cid: 'Button', ancestors: [], position: 'after' };

    // 1) 先在干净基线上建立会话，再写同名自定义文件：确认时由服务端受管审计拒绝，且不得覆盖文件。
    const conflictSession = await post(request, base, '/assets/placements/sessions', { assetId, baseVersion: version });
    expect(conflictSession.status).toBe(200);
    const custom = path.join(legacyRoot, 'src', 'spatial-module.tsx');
    writeFileSync(custom, 'export function SpatialModule() { return null; }\n');
    const customBytes = readFileSync(custom);
    try {
      const conflict = await post(request, base, `/assets/placements/${(conflictSession.body as { sessionId: string }).sessionId}/confirm`, { target, adjustment: { layout: { widthPercent: 70, align: 'center', offsetY: 0 } } });
      expect(conflict.status, JSON.stringify(conflict.body)).toBeGreaterThanOrEqual(400);
      expect(conflict.status).toBeLessThan(500);
      // 拒绝且不覆盖：自定义文件必须逐字节保持原样。
      expect(readFileSync(custom).equals(customBytes), '自定义运行时被覆盖').toBe(true);
    } finally {
      unlinkSync(custom);
    }

    // 2) 旧作品正常插入 → 候选里出现 canonical runtime 与实例文件，ledger 记录运行时条目。
    const cleanVersion = (await get(request, base, '/version')).body.version as string;
    const session = await post(request, base, '/assets/placements/sessions', { assetId, baseVersion: cleanVersion });
    expect(session.status).toBe(200);
    const confirmed = await post(request, base, `/assets/placements/${(session.body as { sessionId: string }).sessionId}/confirm`, { target, adjustment: { layout: { widthPercent: 70, align: 'center', offsetY: 0 } } });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const confirmedTask = (confirmed.body as { task?: { id: string; status: string; candidateId?: string } }).task;
    expect(confirmedTask, JSON.stringify(confirmed.body)).toBeTruthy();
    const approvedTask = await approvePlacementTaskOnce(
      (method, pathname, data) => (method === 'POST' ? post(request, base, pathname, data) : get(request, base, pathname)),
      confirmedTask!,
    );
    const candidateId = approvedTask.candidateId ?? approvedTask.id;
    expect(candidateId).toBeTruthy();
    const candidate = await get(request, base, `/candidates/${candidateId}`);
    expect(candidate.status, JSON.stringify(candidate.body)).toBe(200);
    const files = ((candidate.body.diff ?? []) as Array<{ path: string }>).map((item) => item.path);
    expect(new Set(files).size, '候选 diff 不应有重复路径').toBe(files.length);
    expect(files).toContain('src/spatial-module.tsx');
    const moduleFile = files.find((file) => file.startsWith('src/scene-modules/') && file.endsWith('.json'));
    expect(moduleFile, '候选缺少实例配置').toBeTruthy();
    const instanceId = path.basename(moduleFile!, '.json');
    expect(instanceId).toMatch(/^[a-f0-9]{32}$/);

    const ledgerDir = path.join(legacyWork, 'lux3d-ledgers');
    const ledgerNames = existsSync(ledgerDir)
      ? readdirSync(ledgerDir).filter((name) => name === `${candidateId}.json`)
      : [];
    expect(ledgerNames).toHaveLength(1);
    const ledger = JSON.parse(readFileSync(path.join(ledgerDir, ledgerNames[0]), 'utf8')) as {
      schemaVersion: number; candidateId: string; baseVersion: string; intent: string; instanceId?: string;
      entries: Array<{ path: string; operation: 'create' | 'modify' | 'delete'; role: string; beforeHash: string | null; afterHash: string | null; bytes: number; assetId?: string; instanceId?: string }>;
      reference?: { action?: string; file?: string; instanceId?: string; anchor?: string };
    };
    expect(ledger.schemaVersion).toBe(1);
    expect(ledger.candidateId).toBe(candidateId);
    expect(ledger.baseVersion).toBe(cleanVersion);
    expect(ledger.intent).toBe('insert');
    expect(ledger.instanceId).toBe(instanceId);
    expect(ledger.reference).toMatchObject({ action: 'add', file: 'src/App.tsx', instanceId });
    expect(typeof ledger.reference?.anchor).toBe('string');
    const entriesByPath = new Map(ledger.entries.map((entry) => [entry.path, entry]));
    expect(entriesByPath.size, 'ledger 条目路径不应重复').toBe(ledger.entries.length);
    const candidateRoot = path.join(legacyWork, 'candidates', candidateId);
    assertLedgerMatrix(ledger, candidateRoot, ledger.reference?.file);
    const runtimeEntry = entriesByPath.get('src/spatial-module.tsx');
    expect(runtimeEntry).toMatchObject({ role: 'runtime', operation: 'create', beforeHash: null });
    expect(runtimeEntry!.afterHash).toMatch(/^[a-f0-9]{64}$/);
    expect(runtimeEntry!.bytes).toBeGreaterThan(0);
    const configEntry = entriesByPath.get(moduleFile!);
    expect(configEntry).toMatchObject({ role: 'config', operation: 'create', beforeHash: null, instanceId, assetId });
    expect(configEntry!.afterHash).toMatch(/^[a-f0-9]{64}$/);
    expect(configEntry!.bytes).toBeGreaterThan(0);
    const modelEntry = ledger.entries.find((entry) => entry.role === 'model');
    expect(modelEntry).toMatchObject({ path: `public/assets/${assetId}.glb`, operation: 'create', beforeHash: null, assetId });
    expect(modelEntry!.afterHash).toMatch(/^[a-f0-9]{64}$/);
    expect(modelEntry!.bytes).toBeGreaterThan(0);
    expect(ledger.entries.some((entry) => entry.role === 'provenance' && entry.path === `public/assets/${assetId}.provenance.json`)).toBe(true);
    const managedRoles: Record<string, (file: string) => boolean> = {
      model: (file) => file === `public/assets/${assetId}.glb`,
      provenance: (file) => file === `public/assets/${assetId}.provenance.json`,
      parts: (file) => file === `public/assets/${assetId}.parts.json`,
      config: (file) => file === moduleFile!,
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
    writeEvidence('legacy-work-runtime.json', {
      candidateId, files,
      ledgerEntries: ledger.entries.map((entry) => `${entry.role}:${entry.operation}:${entry.path}`),
      runtimeAfterHash: runtimeEntry!.afterHash,
    });
  });
});
