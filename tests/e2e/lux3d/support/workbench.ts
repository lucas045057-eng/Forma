import { expect, type APIRequestContext, type Locator, type Page, type Response as PlaywrightResponse } from '@playwright/test';
import path from 'node:path';
import { FIXTURES } from '../env';
import { api, type LuxTaskView } from './api';

/** File selection is not native image dragging; result-card dragging is tested separately. */
export async function uploadAndRevealImage(page: Page): Promise<Locator> {
  await page.getByTestId('lux-files').setInputFiles(path.join(FIXTURES, 'image.png'));
  const images = page.getByTestId('lux-workbench').locator('details').filter({
    has: page.locator('summary').filter({ hasText: /^选择已上传的图片（保持顺序）$/ }),
  });
  await expect(images).toHaveCount(1);
  if (await images.getAttribute('open') === null) await images.locator('summary').click();
  // Uploads from earlier cases may share a filename. The new upload is automatically selected;
  // verify that exact visible selection rather than selecting an arbitrary historical label.
  const selected = images.locator('input[type="checkbox"]:checked');
  await expect(selected).toHaveCount(1, { timeout: 60_000 });
  await expect(selected).toHaveAccessibleName('image.png');
  await expect(selected).toBeVisible({ timeout: 60_000 });
  return selected;
}

export type WorkbenchArtifact = LuxTaskView['artifacts'][number];

export interface WorkbenchTask {
  localId: string;
  task: LuxTaskView;
  /** 该任务 ready 后真实可用的 GLB 原件（downloadUrl/assetId 来自产品响应）。 */
  artifact: WorkbenchArtifact;
  /** 指向该原件真实下载 href 的链接（产品 DOM 里唯一的对应元素）。 */
  link: Locator;
  /** 承载该链接的 `.lux-artifact` 结果卡（即 hover/drag 的唯一目标）。 */
  card: Locator;
  /** 该结果卡所属的 `[data-testid="lux-task"]` 任务卡。 */
  article: Locator;
}

export interface CreateTaskOptions {
  /** 触发本次创建的 UI 动作。helper 只调用一次，不会重发 create 或代替用户再次点击。 */
  click: () => Promise<void>;
  /** 单次总预算（create 响应 + API ready + UI 卡/链接可见），不叠加。默认 240s。 */
  timeoutMs?: number;
  label?: string;
}

const ARTIFACT_LINK = (downloadUrl: string) => `a[href="${downloadUrl}"]`;

/**
 * 绑定“本次点击”的 create 响应 localId，等待该任务 ready 且有可用 GLB 原件，
 * 再用该原件真实 downloadUrl（href）在 DOM 中唯一定位任务卡/结果卡/下载链接。
 *
 * 原有的单次 create 计数断言留在调用方；本 helper 不重发 create、不替用户点击。
 * 失败只为**本例 localId** 发一次 stop（保留首错），不清理其它任务。
 */
export async function createTaskFromWorkbench(
  page: Page,
  request: APIRequestContext,
  options: CreateTaskOptions,
): Promise<WorkbenchTask> {
  const label = options.label ?? '工作台创建';
  const budgetMs = options.timeoutMs ?? 240_000;
  const deadline = Date.now() + budgetMs;
  const remaining = (phase: string) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`${label}：已超过 ${budgetMs}ms 总预算（${phase}）`);
    return left;
  };

  let localId: string | undefined;
  try {
    // 先挂 rejection handler：click 失败时 waiter 也不会成为未观察的拒绝。
    const waiting: Promise<{ response: PlaywrightResponse; error: null } | { response: null; error: unknown }> = page.waitForResponse((response) => {
      try {
        const url = new URL(response.url());
        return response.request().method() === 'POST' && url.pathname === '/assets/lux3d/operations';
      } catch {
        return false;
      }
    }, { timeout: remaining('等待 create 响应') }).then(
      (response) => ({ response, error: null } as const),
      (error) => ({ response: null, error } as const),
    );
    await options.click();
    const outcome = await waiting;
    if (!outcome.response) throw outcome.error instanceof Error ? outcome.error : new Error(`${label}：create 响应失败：${String(outcome.error)}`);
    const response = outcome.response;
    expect(response.status(), `${label}：create 必须返回 202`).toBe(202);
    const created = await response.json() as LuxTaskView;
    if (typeof created.localId !== 'string' || !created.localId) throw new Error(`${label}：create 响应缺少 localId`);
    localId = created.localId;

    let task: LuxTaskView | undefined;
    while (true) {
      remaining('轮询任务前');
      const result = await api<LuxTaskView>(request, 'GET', `/assets/lux3d/tasks/${localId}`, undefined, { timeout: remaining('轮询任务 HTTP') });
      remaining('轮询任务响应后');
      expect(result.status, `${label}：读取本任务失败`).toBe(200);
      task = result.body;
      if (task.stage === 'ready') break;
      if (task.stage === 'failed' || task.stage === 'cancelled') {
        throw new Error(`${label}：本任务 stage=${task.stage} ${JSON.stringify(task.error ?? null)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!task || task.stage !== 'ready') throw new Error(`${label}：本任务未在期限内 ready（最后 stage=${task?.stage ?? 'none'}）`);

    const artifact = task.artifacts.find((item) => item.variant === 'original' && item.kind === 'model' && item.format === 'glb' && Boolean(item.assetId));
    if (!artifact) {
      throw new Error(`${label}：ready 但没有可用 GLB 原件 ${JSON.stringify(task.artifacts.map((item) => ({ kind: item.kind, format: item.format, variant: item.variant, assetId: Boolean(item.assetId) })))}`);
    }

    // 用产品真实 href 定位：同一 href 只可能属于这个任务的这个原件。
    const link = page.locator(ARTIFACT_LINK(artifact.downloadUrl));
    const card = page.locator('.lux-artifact').filter({ has: link });
    const article = page.getByTestId('lux-task').filter({ has: card });
    await expect(article, `${label}：UI 应显示本次任务卡`).toHaveCount(1, { timeout: remaining('等待任务卡') });
    await expect(article).toHaveAttribute('data-stage', 'ready', { timeout: remaining('等待任务卡 ready') });
    await expect(card, `${label}：本任务应有唯一原件卡`).toHaveCount(1, { timeout: remaining('等待原件卡') });
    await expect(link, `${label}：本任务原件链接应唯一`).toHaveCount(1, { timeout: remaining('等待原件链接') });
    await expect(link, `${label}：原件下载链接应可见`).toBeVisible({ timeout: remaining('等待原件链接可见') });
    await expect(link).toHaveAttribute('href', artifact.downloadUrl, { timeout: remaining('核对原件 href') });
    return { localId, task, artifact, link, card, article };
  } catch (error) {
    // 只停本例自己的任务（已拿到 localId 时）一次；小而有界，保留首错。
    if (localId) {
      await api(request, 'POST', `/assets/lux3d/tasks/${localId}/stop`, undefined, { timeout: 5_000 }).catch(() => undefined);
    }
    throw error;
  }
}
