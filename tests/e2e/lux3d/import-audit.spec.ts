import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { api, control, resetFake, restoreWorkRoot, writeEvidence } from './support/api';
import { AGENT_BASE, WORK_ROOT } from './env';

/**
 * R1 / F3 导入审计的端到端正反例（经产品自己的 agent → diff → 审计链路）：
 *  - 普通 DOM createElement / 字面量动态 import / React.lazy 应放行；
 *  - `/src/...` 绝对路径导入受信渲染器、`import.meta.glob` 命中受管目录应拒绝。
 * 不伪造成功消息：结论取自任务状态与候选差异。
 */
test.describe.configure({ mode: 'serial' });
test.setTimeout(420_000);

const agentControl = async (scenario: string) => {
  const response = await fetch(`${AGENT_BASE}/__scenario`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenario }) });
  expect(response.status, await response.text().catch(() => '')).toBe(200);
};

const treeDigest = () => {
  const files = ['src/App.tsx', 'src/components/Button.tsx', 'src/components/ProductHero.tsx', 'src/scene.config.json'];
  const hash = createHash('sha256');
  for (const file of files) hash.update(readFileSync(path.join(WORK_ROOT, file)));
  return hash.digest('hex');
};

const submitAndSettle = async (request: APIRequestContext, instruction: string) => {
  const submitted = await api<{ id: string; status: string }>(request, 'POST', '/tasks', { instruction });
  expect(submitted.status, JSON.stringify(submitted.body)).toBeLessThan(400);
  const deadline = Date.now() + 240_000;
  let last: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const polled = await api<Record<string, unknown>>(request, 'GET', `/tasks/${submitted.body.id}`);
    last = polled.body;
    if (['awaiting_approval', 'done', 'failed'].includes(String(last.status))) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`task did not settle: ${JSON.stringify(last)?.slice(0, 400)}`);
};

const auditCode = (task: Record<string, unknown>) => String((task.error as { code?: string } | undefined)?.code ?? '');

test.beforeEach(async ({ request }) => {
  await resetFake();
  await control({ blockSize: 1024 * 1024 });
  expect((await api(request, 'GET', '/health')).status).toBe(200);
});

test.afterEach(() => {
  const cleanup = restoreWorkRoot();
  expect(cleanup.after).toBe('');
});

test('R1 正例：普通 document.createElement 与字面量动态 import 不被拒', async ({ request }) => {
  await agentControl('positive');
  const before = treeDigest();
  const task = await submitAndSettle(request, '在作品里加一段普通的动态加载说明');
  writeEvidence('import-audit-positive.json', task);
  expect(task.status, JSON.stringify(task).slice(0, 600)).not.toBe('failed');
  if (task.status === 'failed') expect(auditCode(task)).not.toMatch(/MANAGED|IMPORT|SPATIAL|FORBIDDEN/);
  expect(treeDigest()).toBe(before);
});

test('R1 负例：/src/... 绝对路径导入受信渲染器被拒', async ({ request }) => {
  await agentControl('negative-absolute');
  const before = treeDigest();
  const task = await submitAndSettle(request, '用绝对路径引入受信模块');
  writeEvidence('import-audit-absolute.json', task);
  expect(task.status).toBe('failed');
  expect(`${auditCode(task)} ${String((task.error as { message?: string } | undefined)?.message ?? '')}`).toMatch(/受管|managed|import|IMPORT|渲染器|spatial-module/i);
  expect(task.candidateId).toBeUndefined();
  expect(treeDigest()).toBe(before);
});

test('R1 负例：import.meta.glob 命中受管目录被拒', async ({ request }) => {
  await agentControl('negative-glob');
  const before = treeDigest();
  const task = await submitAndSettle(request, '用 glob 批量加载实例配置');
  writeEvidence('import-audit-glob.json', task);
  expect(task.status).toBe('failed');
  expect(`${auditCode(task)} ${String((task.error as { message?: string } | undefined)?.message ?? '')}`).toMatch(/受管|managed|glob|import|IMPORT/i);
  expect(task.candidateId).toBeUndefined();
  expect(treeDigest()).toBe(before);
});
