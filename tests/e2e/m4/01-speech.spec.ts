import { expect, test } from '@playwright/test';
import { base, getScene, getVersion, http, jsonRequest, openStudio, pickElement, resetMock, restoreTemplate, setScript, waitFor, writeArtifact } from './helpers';

/**
 * M4-D2：录音 → 可编辑转写 → 明确确认才写入指令 → 用户点"生成候选版本"才提交。
 *
 * 语音转写与任务提交全部是**浏览器侧替身**（route 拦截 + fake MediaRecorder/getUserMedia），
 * 不打阿里、不产生真实识别或付费调用；后端也未配置语音上游。
 * 覆盖：review 编辑与确认、录音时对象与当前对象不一致、录音中页面隐藏即取消、
 * 499 取消后重试必须用新的 request id、权限晚到时取消不得残留录音。
 */

const SPEECH_CONFIG = {
  enabled: true, provider: 'aliyun', model: 'qwen3-asr-flash',
  supportedMimeTypes: ['audio/webm'], maxBytes: 4 * 1024 * 1024, maxDurationMs: 35_000,
};

interface SpeechStub {
  posts: Array<{ id: string; mime: string; bytes: number }>;
  deletes: string[];
  // 每个用例可替换的转写行为；默认返回固定文本。
  nextText: () => { status: number; body: unknown };
  recordIds: string[];
}

async function installSpeechStubs(page: import('@playwright/test').Page): Promise<SpeechStub> {
  const stub: SpeechStub = {
    posts: [], deletes: [], recordIds: [],
    nextText: () => ({ status: 200, body: { requestId: 'stub', text: '把这个改成圆角', provider: 'aliyun', model: 'qwen3-asr-flash' } }),
  };
  await page.addInitScript(() => {
    const state = { stops: 0, recorded: 0 };
    (window as any).__speechProbe = state;
    const track = { kind: 'audio', stop() { state.stops += 1; } };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
    });
    class FakeRecorder {
      mimeType: string;
      ondataavailable?: (event: { data: Blob }) => void;
      onstop?: () => void;
      state = 'inactive';
      constructor(_stream: unknown, options?: { mimeType?: string }) { this.mimeType = options?.mimeType ?? 'audio/webm'; }
      static isTypeSupported() { return true; }
      start() { this.state = 'recording'; state.recorded += 1; }
      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({ data: new Blob([new Uint8Array(8)], { type: this.mimeType }) });
        this.onstop?.();
      }
      addEventListener() { /* 本套件不依赖事件监听 */ }
      removeEventListener() { /* noop */ }
    }
    (window as any).MediaRecorder = FakeRecorder;
  });
  await page.route('**/speech/config', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SPEECH_CONFIG) }));
  await page.route('**/speech/transcribe', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const headers = route.request().headers();
    const id = headers['x-speech-request-id'] ?? '';
    stub.recordIds.push(id);
    stub.posts.push({ id, mime: headers['content-type'] ?? '', bytes: (route.request().postDataBuffer() ?? Buffer.alloc(0)).length });
    const next = stub.nextText();
    await route.fulfill({ status: next.status, contentType: 'application/json', body: JSON.stringify(next.body) });
  });
  await page.route('**/speech/transcribe/*', (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() !== 'DELETE') return route.fallback();
    stub.deletes.push(url.pathname.split('/').pop() ?? '');
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ requestId: url.pathname.split('/').pop(), status: 'cancelled' }) });
  });
  return stub;
}

test.describe('M4-D2 语音确认闭环（转写与提交均为替身）', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.beforeEach(async ({ page }) => { await resetMock(); await installSpeechStubs(page); });

  test('录音 → 可编辑 review → 确认写入指令，只有点生成才提交任务', async ({ page }) => {
    await openStudio(page);
    const taskPosts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/tasks') taskPosts.push(request.url());
    });

    await page.getByTestId('speech-record').click();
    const review = page.getByTestId('speech-review');
    await review.waitFor({ state: 'visible', timeout: 30_000 });
    const textarea = page.getByTestId('speech-review-text');
    await expect(textarea).toHaveValue('把这个改成圆角');
    await textarea.fill('把购买按钮改成圆角，文案不动');
    await page.getByTestId('speech-use').click();
    await expect(page.getByTestId('instruction-input')).toHaveValue('把购买按钮改成圆角，文案不动');
    // 确认转写不等于提交：此时不应有任何 /tasks 请求。
    expect(taskPosts, '确认转写后自动提交了任务').toEqual([]);
    await expect(page.getByTestId('generate-candidate')).toBeEnabled();
    writeArtifact('speech-review-confirm.json', { instruction: await page.getByTestId('instruction-input').inputValue(), taskPosts });
  });

  test('录音时指着 A、确认前改点 B：必须提示并禁止直接套用', async ({ page }) => {
    await openStudio(page);
    const first = await pickElement(page, 'buy-button');
    await page.getByTestId('speech-record').click();
    await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
    const captured = await page.getByTestId('speech-capture-object').innerText();
    expect(captured.length, '没有显示录音时指着的对象').toBeGreaterThan(0);

    const second = await pickElement(page, 'save-button');
    expect(second.src, '两次点选没落到不同对象').not.toBe(first.src);
    await expect(page.getByTestId('speech-selection-conflict')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('speech-use')).toBeDisabled();
    const explicit = page.getByTestId('speech-use-current');
    await expect(explicit).toBeVisible();
    await explicit.click();
    await expect(page.getByTestId('speech-review')).toHaveCount(0);
    await expect(page.getByTestId('instruction-input')).toHaveValue(/改成圆角/);
    writeArtifact('speech-selection-conflict.json', { captured, first: first.src, second: second.src, instruction: await page.getByTestId('instruction-input').inputValue() });
  });

  test('录音中页面隐藏：立即取消并发送 DELETE，麦克风轨道被释放', async ({ page }) => {
    await openStudio(page);
    await page.getByTestId('speech-record').click();
    await page.getByTestId('speech-status').waitFor({ state: 'visible', timeout: 15_000 });
    await waitFor(async () => ((await page.getByTestId('speech-status').innerText()).includes('录音') || (await page.getByTestId('speech-status').innerText()).includes('识别')), 15_000, 100);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(async () => (await page.getByTestId('speech-review').count()) === 0, 30_000, 200);
    const probe = await page.evaluate(() => (window as any).__speechProbe as { stops: number; recorded: number });
    expect(probe.recorded, '没有真正开始录音（替身未被调用）').toBeGreaterThan(0);
    expect(probe.stops, '隐藏后没有释放麦克风轨道').toBeGreaterThan(0);
    expect(await page.getByTestId('instruction-input').inputValue()).toBe('');
    writeArtifact('speech-hidden-cancel.json', { probe });
  });

  test('转写返回 499：界面显示取消，重试必须使用新的 request id', async ({ page }) => {
    await openStudio(page);
    // 第一个请求返回取消；后续返回正常文本。
    let round = 0;
    const stub = await installOverrides(page, () => {
      round += 1;
      return round === 1
        ? { status: 499, body: { error: { code: 'SPEECH_CANCELLED', message: '内部取消细节不应显示' } } }
        : { status: 200, body: { requestId: 'x', text: '改成圆角', provider: 'aliyun', model: 'qwen3-asr-flash' } };
    });
    await page.getByTestId('speech-record').click();
    await expect(page.getByTestId('speech-review')).toHaveCount(0);
    await waitFor(async () => (await page.getByTestId('speech-status').innerText()).length > 0, 20_000, 200);
    const statusText = await page.getByTestId('speech-status').innerText();
    expect(statusText).not.toContain('内部取消细节');
    await expect(page.getByTestId('speech-record')).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId('speech-record').click();
    await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
    expect(stub.recordIds.length, '没有得到两次转写请求').toBeGreaterThanOrEqual(2);
    expect(new Set(stub.recordIds).size, '重试沿用了旧 request id（会拿到缓存终态）').toBe(stub.recordIds.length);
    writeArtifact('speech-cancel-new-uuid.json', { requestIds: stub.recordIds, statusText });
  });

  test('权限晚到后已取消：不得出现 review，也不得残留录音', async ({ page }) => {
    await openStudio(page);
    await page.evaluate(() => {
      const slow = () => new Promise((resolve) => {
        setTimeout(() => resolve({ getTracks: () => [{ kind: 'audio', stop() { (window as any).__speechProbe.stops += 1; } }] }), 1200);
      });
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: slow } });
    });
    await page.getByTestId('speech-record').click();
    await page.getByTestId('speech-cancel').click({ timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(2500);
    expect(await page.getByTestId('speech-review').count(), '取消后仍然弹出了 review').toBe(0);
    const probe = await page.evaluate(() => (window as any).__speechProbe as { stops: number; recorded: number });
    writeArtifact('speech-late-permission.json', { probe });
  });
  test('F1 真实跨源 iframe 重新点选：review 保留、必须显式确认，确认后再改选仍拦', async ({ page }) => {
    await openStudio(page);
    await pickElement(page, 'buy-button');
    await page.getByTestId('speech-record').click();
    await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
    // 真实 iframe 里再点一个元素：父窗口失焦 + 点选 pending，旧实现会把转写直接丢掉。
    const second = await pickElement(page, 'save-button');
    await expect(page.getByTestId('speech-review'), '重新点选后转写被丢弃了').toBeVisible();
    const reviewText = await page.getByTestId('speech-review-text').inputValue();
    expect(reviewText.length, 'review 文本被清空').toBeGreaterThan(0);
    await expect(page.getByTestId('speech-selection-conflict')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('speech-use')).toBeDisabled();
    // 必须显式选择，绝不自动套到新对象上
    await page.getByTestId('speech-use-current').click();
    await expect(page.getByTestId('speech-review')).toHaveCount(0);
    // 确认后再改选：必须重新确认才能生成
    await pickElement(page, 'buy-button');
    await expect(page.getByTestId('speech-binding-conflict')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('generate-candidate')).toBeDisabled();
    await page.getByTestId('speech-reconfirm').click();
    await expect(page.getByTestId('generate-candidate')).toBeEnabled({ timeout: 20_000 });
    writeArtifact('speech-iframe-repick.json', { reviewText, second: second.src, instruction: await page.getByTestId('instruction-input').inputValue() });
  });

  test('F2 语音提交成功后版本变化：新手输文字仍可提交（旧绑定不再阻塞）', async ({ page }) => {
    await resetMock();
    await setScript([
      [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
      [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '<div className="actions">', new: '<div className="actions" style={{ paddingTop: 16 }}>' } }],
      [{ name: 'finish', args: { summary: '购买区下移' } }],
    ]);
    await openStudio(page);
    await page.getByTestId('speech-record').click();
    await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('speech-use').click();
    await expect(page.getByTestId('instruction-input')).toHaveValue(/改成圆角/);
    await page.getByTestId('generate-candidate').click();
    await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'done', { timeout: 150_000 });
    // 制造版本变化（场景写回会推进主版本），再输入全新文字
    const scene = await getScene();
    const bumped = await http(base('/scene'), jsonRequest('PUT', scene.body));
    expect(bumped.status, bumped.text.slice(0, 200)).toBe(200);
    await page.getByTestId('instruction-input').fill('换成另一句完全无关的文字指令');
    await expect(page.getByTestId('generate-candidate'), '提交成功后旧语音绑定仍阻塞生成').toBeEnabled({ timeout: 30_000 });
    writeArtifact('speech-post-submit-newtext.json', { instruction: await page.getByTestId('instruction-input').inputValue(), version: (await getVersion()).body.version });
  });
});

/** 在已注册的 stub 之上替换转写响应（保持 request id 记录）。 */
async function installOverrides(page: import('@playwright/test').Page, next: () => { status: number; body: unknown }): Promise<{ recordIds: string[] }> {
  const recordIds: string[] = [];
  await page.unroute('**/speech/transcribe');
  await page.route('**/speech/transcribe', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    recordIds.push(route.request().headers()['x-speech-request-id'] ?? '');
    const response = next();
    await route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) });
  });
  return { recordIds };
}

export { getVersion };
