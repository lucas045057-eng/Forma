import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { REPO_ROOT, WORK_ROOT } from './env';
import {
  discardCandidate, getCandidate, getScene, getVersion, git, listCandidates, mockStats, pickSelection, previewFetch,
  resetMock, restoreTemplate, setScript, submitTask, waitForTask,
} from './api';
import { writeArtifactFrom } from './artifact';

/**
 * M2-A 审查整改验收（对照 docs/reports/M2-A-review.md B1/B2/R1）：
 * 预览源上的代码不能调用正式写入/付费接口；Vite 读不到作品外文件；快照不收敏感文件。
 */

const PREVIEW = 'http://127.0.0.1:5175';

test.describe('M2-A 整改验收', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });

  test('B1：候选预览页里的脚本调用正式写入/付费接口全部被拒，计数为 0', async ({ page }) => {
    await resetMock();
    await setScript([
      [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
      [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: '马上购买' } }],
      [{ name: 'finish', args: { summary: 'ok' } }],
    ]);
    const selection = await pickSelection(page);
    const task = await waitForTask((await submitTask('改按钮', selection)).body.id);
    const candidateId = task.candidateId!;
    const sceneBefore = JSON.stringify((await getScene()).body);
    const candidatesBefore = (await listCandidates()).body.length;
    const generationsBefore = (await mockStats()).body.calls;

    await page.goto(`${PREVIEW}/preview/c/${candidateId}/`);
    await page.locator('[data-testid="buy-button"]').waitFor({ state: 'visible', timeout: 60_000 });
    const attempts = await page.evaluate(async ({ api, candidate }) => {
      const results: Array<{ name: string; ok: boolean; error?: string }> = [];
      async function attempt(name: string, url: string, init: RequestInit) {
        try {
          const response = await fetch(url, { ...init, mode: 'cors' });
          results.push({ name, ok: response.ok, error: `HTTP ${response.status}` });
        } catch (error) { results.push({ name, ok: false, error: String(error) }); }
      }
      const scene = await fetch(`${api}/scene`, { mode: 'cors' }).then((response) => response.json()).catch(() => null);
      await attempt('PUT /scene', `${api}/scene`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(scene) });
      await attempt('POST /assets/lux3d', `${api}/assets/lux3d`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'x', version: 'G1', idempotencyKey: 'evil' }) });
      await attempt('POST /tasks', `${api}/tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction: 'evil' }) });
      await attempt('POST adopt', `${api}/candidates/${candidate}/adopt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      await attempt('POST revert', `${api}/version/revert`, { method: 'POST' });
      return results;
    }, { api: 'http://127.0.0.1:3001', candidate: candidateId });

    const sceneAfter = JSON.stringify((await getScene()).body);
    const candidatesAfter = (await listCandidates()).body.length;
    const generationsAfter = (await mockStats()).body.calls;

    writeArtifactFrom('isolation-b1.json', {
      attempts, sceneUnchanged: sceneBefore === sceneAfter,
      candidatesBefore, candidatesAfter, generationsBefore, generationsAfter,
    });

    expect(attempts.every((attempt) => !attempt.ok), `有请求成功了：${JSON.stringify(attempts)}`).toBe(true);
    expect(sceneBefore, '作品配置被预览页改了').toBe(sceneAfter);
    expect(candidatesAfter).toBe(candidatesBefore);
    expect(generationsAfter, '预览页触发了 Lux3D 生成').toBe(generationsBefore);
    expect((await getCandidate(candidateId)).body.decision).toBe('pending');
    await discardCandidate(candidateId);
  });

  test('B2：主作品的 Vite 读不到作品外文件，自己的源码仍然可读', async () => {
    const sentinels: string[] = [];
    const results: Array<{ folder: string; status: number; body: string }> = [];
    const targets = ['docs', 'orbital', '.data', path.join('apps', 'server')];
    try {
      for (const folder of targets) {
        const directory = path.join(REPO_ROOT, folder);
        mkdirSync(directory, { recursive: true });
        const file = path.join(directory, 'sentinel-m2.txt');
        writeFileSync(file, 'SENTINEL-SECRET', 'utf8');
        sentinels.push(file);
        const absolute = file.split(path.sep).join('/');
        const response = await previewFetch(`/preview/main/@fs/${absolute.replace(/^([A-Za-z]):/, '/$1:')}`);
        // Vite 可能用 index.html 做回退（200），真正要保证的是读不到哨兵内容
        expect(response.text, `主作品 Vite 读到了作品外文件：${folder}`).not.toContain('SENTINEL-SECRET');
        results.push({ folder, status: response.status, body: response.text.slice(0, 40) });
      }
      const own = await previewFetch('/preview/main/src/App.tsx');
      expect(own.status).toBe(200);
      expect(own.text).toContain('data-src');
      writeArtifactFrom('isolation-b2.json', { results, ownStatus: own.status });
    } finally {
      for (const file of sentinels) rmSync(file, { force: true });
    }
  });

  test('R1：自动快照不收录 .env / 备份 / 私钥', async () => {
    const files = [
      path.join(WORK_ROOT, '.env.local'),
      path.join(WORK_ROOT, 'src', 'notes.bak'),
      path.join(WORK_ROOT, 'src', 'secret.pem'),
    ];
    try {
      for (const file of files) writeFileSync(file, 'SENTINEL-SECRET', 'utf8');
      const version = await getVersion();
      expect(version.status, JSON.stringify(version.body)).toBe(200);
      const tree = git(['ls-tree', '-r', '--name-only', 'HEAD']).out;
      writeArtifactFrom('isolation-r1.json', { tree: tree.split('\n').filter(Boolean) });
      expect(tree).not.toContain('.env.local');
      expect(tree).not.toContain('notes.bak');
      expect(tree).not.toContain('secret.pem');
      expect(tree).toContain('src/App.tsx');
    } finally {
      for (const file of files) rmSync(file, { force: true });
      expect(restoreTemplate().clean).toBe(true);
    }
  });
});
