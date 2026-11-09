import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { BACKEND_BASE, MOCK_BASE, PRIMARY_ASSETS, RUN_ID } from './env';
import {
  getBytes,
  getJson,
  glbHeader,
  imageStats,
  postJson,
  readGuardLog,
  readGuardMarker,
  scenarioDir,
  startBackend,
  startBackendExpectingRejection,
  startMock,
  TERMINAL,
  waitForAsset,
  waitPortFree,
  writeArtifact,
} from './harness';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Codex 对 M0-A 的审查整改（docs/reports/M0-A-review.md）回归：
 * R1 残留临时文件不阻断重试、R2 下载总时限与优雅停机恢复、R3 ready 缺文件可修复、
 * S3 非 loopback 的 http 上游拒绝启动。
 */

test.describe('M0-A 审查整改回归', () => {
  test('R1 资产目录预置残留 model.glb.tmp / raw.glb.tmp 后重试仍能成功', async () => {
    const directory = scenarioDir('r1-leftover');
    rmSync(directory, { recursive: true, force: true });
    const mock = await startMock();
    const backend = await startBackend({ base: mock.base, assetsDir: directory, pollMs: 60 });
    try {
      // mock 的编号从 9000001 开始，先把残留文件放进它将要使用的目录
      const taskDir = path.join(directory, '9000001');
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(path.join(taskDir, 'model.glb.tmp'), 'stale model temp', 'utf8');
      writeFileSync(path.join(taskDir, 'raw.glb.tmp'), 'stale raw temp', 'utf8');

      const submitted = await postJson(`${backend.base}/assets/lux3d`, {
        prompt: 'stale temp regression',
        version: 'G1-Turbo',
        idempotencyKey: `r1-${RUN_ID}`,
      });
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(202);
      const created = submitted.body as any;

      const { asset } = await waitForAsset(backend.base, created.id, (item) => TERMINAL.has(item.status), { timeoutMs: 60_000 });
      expect(asset.status, `有残留临时文件时处理失败：${JSON.stringify(asset.error)}`).toBe('ready');
      expect(JSON.stringify(asset)).not.toContain('EEXIST');

      const model = await getBytes(`${backend.base}${asset.modelUrl}`);
      expect(model.status).toBe(200);
      expect(glbHeader(model.buffer).valid).toBe(true);

      // 残留文件不被删除（实现只清理本次自己产生的临时文件），也不能多出新的 .tmp
      const files = readdirSync(taskDir).sort();
      const temps = files.filter((name) => name.endsWith('.tmp'));
      const indexTemps = readdirSync(directory).filter((name) => name.endsWith('.tmp'));

      writeArtifact('review-r1-leftover-temp.json', { files, temps, indexTemps, asset });
      expect(temps).toEqual(['model.glb.tmp', 'raw.glb.tmp']);
      expect(indexTemps, '资产目录里残留了本次产生的临时文件').toEqual([]);
    } finally {
      await backend.stop();
      await mock.stop();
    }
  });

  test('R2a 滴流下载被总时限中止，错误清晰且不卡死', async () => {
    const directory = scenarioDir('r2-drip');
    rmSync(directory, { recursive: true, force: true });
    const mock = await startMock({ scenario: 'drip' });
    const backend = await startBackend({ base: mock.base, assetsDir: directory, pollMs: 50, downloadTimeoutMs: 1_500 });
    const startedAt = Date.now();
    try {
      const submitted = await postJson(`${backend.base}/assets/lux3d`, {
        prompt: 'drip download',
        version: 'G1-Turbo',
        idempotencyKey: `r2-drip-${RUN_ID}`,
      });
      expect(submitted.status).toBe(202);
      const created = submitted.body as any;

      const { asset } = await waitForAsset(backend.base, created.id, (item) => TERMINAL.has(item.status), { timeoutMs: 40_000 });
      const elapsedMs = Date.now() - startedAt;

      expect(asset.status).toBe('failed');
      expect(asset.error?.code).toBe('DOWNLOAD_TIMEOUT');
      expect(asset.error?.message).toContain('总时限');
      expect(elapsedMs, '滴流下载没有被总时限中止').toBeLessThan(25_000);

      // 中止后不留自己的临时文件
      const taskDir = path.join(directory, String(created.taskId));
      const temps = readdirSync(taskDir).filter((name) => name.endsWith('.tmp'));
      writeArtifact('review-r2-drip-timeout.json', { asset, elapsedMs, temps });
      expect(temps).toEqual([]);
    } finally {
      await backend.stop();
      await mock.stop();
    }
  });

  test('R2b 下载中优雅停机 → 记录可恢复 → 重启后继续原 taskId 且不新建任务', async () => {
    const directory = scenarioDir('r2-stop');
    rmSync(directory, { recursive: true, force: true });
    const drip = await startMock({ scenario: 'drip' });
    const healthyPort = drip.port;
    const backend = await startBackend({ base: drip.base, assetsDir: directory, pollMs: 50, downloadTimeoutMs: 60_000 });
    let healthy: Awaited<ReturnType<typeof startMock>> | null = null;
    let restarted: Awaited<ReturnType<typeof startBackend>> | null = null;
    try {
      const submitted = await postJson(`${backend.base}/assets/lux3d`, {
        prompt: 'stop during download',
        version: 'G1-Turbo',
        idempotencyKey: `r2-stop-${RUN_ID}`,
      });
      const created = submitted.body as any;
      const taskId = String(created.taskId);

      // 等到真的进入下载阶段（滴流很慢，一定来得及）
      await waitForAsset(backend.base, created.id, (item) => item.status === 'downloading', { timeoutMs: 30_000 });

      const closed = await backend.gracefulClose(30_000);
      expect(closed.code, `优雅停机没有正常退出：${closed.output}`).toBe(0);

      // 停机后索引里应是可恢复状态：polling + SERVICE_STOPPED，taskId 保留
      const index = JSON.parse(readFileSync(path.join(directory, 'index.json'), 'utf8')) as any[];
      const record = index.find((item) => item.id === created.id);
      expect(record.status).toBe('polling');
      expect(record.error?.code).toBe('SERVICE_STOPPED');
      expect(record.taskId).toBe(taskId);

      // 换一个健康的 mock（同端口）后重启，后端应继续查询原任务并完成
      await drip.stop();
      expect(await waitPortFree(healthyPort), `mock 端口 ${healthyPort} 没释放`).toBe(true);
      healthy = await startMock({ port: healthyPort, scenario: 'success' });
      restarted = await startBackend({ base: healthy.base, assetsDir: directory, pollMs: 50 });
      const resumed = await waitForAsset(restarted.base, created.id, (item) => TERMINAL.has(item.status), { timeoutMs: 60_000 });

      expect(resumed.asset.status, JSON.stringify(resumed.asset.error)).toBe('ready');
      expect(resumed.asset.taskId).toBe(taskId);
      const stats = (await getJson(`${healthy.base}/__stats`)).body as { creates: number; gets: number };
      expect(stats.creates, '重启后新建了付费任务').toBe(0);
      expect(stats.gets, '重启后没有继续查询原任务').toBeGreaterThan(0);

      const model = await getBytes(`${restarted.base}${resumed.asset.modelUrl}`);
      expect(glbHeader(model.buffer).valid).toBe(true);

      writeArtifact('review-r2-resume.json', { record, resumed: resumed.asset, stats, modelBytes: model.buffer.length });
    } finally {
      await restarted?.stop();
      await healthy?.stop();
      await backend.stop();
      await drip.stop();
    }
  });

  test('R3 ready 资产模型丢失：视口报错 → 重新导入 → 画布恢复（不新建任务）', async ({ page }) => {
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });

    const mockBefore = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };
    const taskId = '7000003';

    await page.goto('/');
    await page.getByTestId('asset-open').click();
    await page.getByTestId('asset-task-id').fill(taskId);
    await page.getByTestId('asset-import').click();
    const viewport = page.locator('[data-testid="model-viewport"]');
    await expect(viewport).toHaveAttribute('data-loaded', 'true', { timeout: 90_000 });
    const asset = (await getJson(`${BACKEND_BASE}/assets/lux3d-${taskId}`)).body as any;
    expect(asset.status).toBe('ready');
    const oldUrl = asset.modelUrl as string;

    // 删掉已发布模型，模拟磁盘丢失
    const modelFile = path.join(PRIMARY_ASSETS, taskId, 'model.glb');
    rmSync(modelFile, { force: true });

    // 重新进面板并选中同一个资产 → 加载失败 → 错误边界提示
    await page.reload();
    await page.getByTestId('asset-open').click();
    await page.getByTestId('asset-select').selectOption(asset.id);
    const alert = page.getByRole('alert').filter({ hasText: '3D 模型加载失败' });
    await expect(alert, '模型文件丢失时视口没有报错').toBeVisible({ timeout: 60_000 });
    await expect(viewport).toHaveAttribute('data-loaded', 'false');

    // 用原 taskId 重新导入修复
    await page.getByTestId('asset-task-id').fill(taskId);
    await page.getByTestId('asset-import').click();
    await expect(page.getByTestId('asset-status')).toContainText('可查看', { timeout: 90_000 });
    await expect(viewport).toHaveAttribute('data-loaded', 'true', { timeout: 90_000 });
    await expect(alert).toHaveCount(0);
    await page.waitForTimeout(800);

    const canvas = viewport.locator('canvas');
    const shot = await canvas.screenshot();
    const stats = await imageStats(shot);
    const repaired = (await getJson(`${BACKEND_BASE}/assets/${asset.id}`)).body as any;
    const mockAfter = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };

    writeArtifact('review-r3-model-missing.json', {
      oldUrl,
      newUrl: repaired.modelUrl,
      creates: mockAfter.creates - mockBefore.creates,
      canvas: stats,
      pageErrors,
      consoleErrors,
    });

    expect(repaired.modelUrl, '修复后模型 URL 的 revision 没有更新').not.toBe(oldUrl);
    expect(mockAfter.creates - mockBefore.creates, '重新导入时创建了新任务').toBe(0);
    expect(stats.uniqueColors, `画布没有恢复：${JSON.stringify(stats)}`).toBeGreaterThan(20);
    // 模型文件被删后，useGLTF 的 fetch 会以未捕获异常暴露到页面；这是预期内的“加载失败”。
    // 只要求：报错都指向旧模型 URL，且修复后的新 URL 不再报错。
    expect(pageErrors.some((line) => line.includes(oldUrl)), '视口没有报出加载失败').toBe(true);
    expect(pageErrors.filter((line) => !line.includes(oldUrl))).toEqual([]);
    expect(pageErrors.some((line) => line.includes(repaired.modelUrl))).toBe(false);
  });

  test('S3 非 loopback 的 http 上游在启动时被拒绝，且没有发出任何请求', async () => {
    const directory = scenarioDir('s3-http-base');
    rmSync(directory, { recursive: true, force: true });
    const result = await startBackendExpectingRejection({ base: 'http://192.0.2.10:4010', assetsDir: directory });
    const guards = readGuardLog(result.guardLog);
    writeArtifact('review-s3-http-base.json', {
      exitCode: result.code,
      guardLog: guards,
      guardMarker: result.guardMarker,
      output: result.output.slice(-600),
    });

    expect(result.code, `应当拒绝启动，实际退出码 ${result.code}：${result.output}`).toBe(12);
    expect(result.output).toContain('LUX3D_BASE');
    expect(result.guardMarker?.active, '守卫必须已加载，日志为空才有意义').toBe(true);
    expect(guards, `拒绝启动前发出了出站请求：${JSON.stringify(guards)}`).toEqual([]);
    await sleep(50);
  });
});
