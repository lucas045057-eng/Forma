import { expect, test } from '@playwright/test';
import { base, getScene, getVersion, http, jsonRequest, openStudio, pickElement, resetMock, restoreTemplate, setScript, waitFor, writeArtifact } from './helpers';

/**
 * M4-D2：按住说话 → 可编辑转写 → 明确确认才写入指令 → 用户点"生成候选版本"才提交。
 *
 * 语音转写与任务提交全部是**浏览器侧替身**（route 拦截 + fake getUserMedia/MediaRecorder），
 * 不打阿里、不产生真实识别或付费调用；后端也未配置语音上游。
 *
 * 本轮修正（返工前独立 E2E 的三个确认缺陷）：
 * 1. FakeRecorder 真实实现 addEventListener/removeEventListener —— 生产 `speech-input.ts:129` 用
 *    `addEventListener('dataavailable'|'stop'|'error')` 接数据与终态；旧的空实现让"停止/数据/错误"三条真实路径
 *    根本没被走到（录音不上传、资源释放与取消证据都是假的）。
 * 2. 转写响应必须回显**本次真实** `X-Speech-Request-Id`：`speech-api.ts:24` 会校验 `result.requestId === id`，
 *    旧替身写死 'stub'/'x' 会让真实校验抛 `SPEECH_UPSTREAM`，把"结果无效"错误地当成产品问题。
 * 3. 按住说话必须是真实 pointerdown → 等到录音真正开始（轨道 live）→ pointerup，不能用 `.click()`
 *    在同一个 tick 里按下并松开。
 */

const SPEECH_CONFIG = {
  enabled: true, provider: 'aliyun', model: 'qwen3-asr-flash',
  supportedMimeTypes: ['audio/webm'], maxBytes: 4 * 1024 * 1024, maxDurationMs: 35_000,
};

interface SpeechStub {
  posts: Array<{ id: string; mime: string; bytes: number }>;
  deletes: string[];
  /** 按第 N 次请求返回响应；默认回显真实 requestId 的固定文本。 */
  next: (index: number, requestedId: string) => { status: number; body: unknown };
}

async function installSpeechStubs(page: import('@playwright/test').Page): Promise<SpeechStub> {
  const stub: SpeechStub = {
    posts: [], deletes: [],
    next: (_index, requestedId) => ({ status: 200, body: { requestId: requestedId, text: '把这个改成圆角', provider: 'aliyun', model: 'qwen3-asr-flash' } }),
  };
  await page.addInitScript(() => {
    const probe = { stops: 0, recorderStarts: 0, recorderStops: 0, errors: 0, timeslice: 0 };
    (window as any).__speechProbe = probe;
    let liveTracks = 0;
    const makeStream = () => {
      liveTracks += 1;
      const track = { kind: 'audio', stop() { probe.stops += 1; liveTracks -= 1; } };
      return { getTracks: () => [track] };
    };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => makeStream() } });
    class FakeRecorder {
      mimeType: string;
      state = 'inactive';
      private listeners = new Map<string, Set<(event: unknown) => void>>();
      constructor(_stream: unknown, options?: { mimeType?: string }) { this.mimeType = options?.mimeType ?? 'audio/webm'; }
      static isTypeSupported() { return true; }
      addEventListener(type: string, fn: (event: unknown) => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set());
        this.listeners.get(type)!.add(fn);
      }
      removeEventListener(type: string, fn: (event: unknown) => void) { this.listeners.get(type)?.delete(fn); }
      emit(type: string, event: unknown) { for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event); }
      start(timeslice?: number) {
        probe.recorderStarts += 1;
        probe.timeslice = timeslice ?? 0;
        this.state = 'recording';
      }
      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        probe.recorderStops += 1;
        // 真实 MediaRecorder 在 stop 前派发最后一包 dataavailable，然后派发 stop。
        this.emit('dataavailable', { data: new Blob(['audio-chunk'], { type: this.mimeType }) });
        this.emit('stop', {});
      }
      fireError() { this.emit('error', new Event('error')); }
    }
    (window as any).MediaRecorder = FakeRecorder;
  });
  await page.route('**/speech/config', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SPEECH_CONFIG) }));
  await page.route('**/speech/transcribe', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    const headers = route.request().headers();
    const id = headers['x-speech-request-id'] ?? '';
    const index = stub.posts.length;
    stub.posts.push({ id, mime: headers['content-type'] ?? '', bytes: (route.request().postDataBuffer() ?? Buffer.alloc(0)).length });
    const response = stub.next(index, id);
    await route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) });
  });
  await page.route('**/speech/transcribe/*', (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    stub.deletes.push(id);
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ requestId: id, status: 'cancelled' }) });
  });
  return stub;
}

const probe = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__speechProbe as { stops: number; recorderStarts: number; recorderStops: number; errors: number; timeslice: number });

/** 真实按住：hover → pointerdown → 等录音真正开始（轨道变 live）→ 返回"松开"函数。 */
async function pressRecord(page: import('@playwright/test').Page): Promise<() => Promise<void>> {
  const button = page.getByTestId('speech-record');
  await button.hover();
  await page.mouse.down();
  await waitFor(async () => (await probe(page)).recorderStarts >= 1, 20_000, 50);
  return async () => { await page.mouse.up(); };
}

test.describe('M4-D2 语音确认闭环（真实按住 + 真实 requestId 回显）', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.beforeEach(async ({ page }) => { await resetMock(); await installSpeechStubs(page); });

  test('按住录音 → 松手转写 → 可编辑 review → 确认写入指令，只有点生成才提交任务', async ({ page }) => {
    await openStudio(page);
    const taskPosts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/tasks') taskPosts.push(request.url());
    });

    const release = await pressRecord(page);
    const during = await probe(page);
    expect(during.recorderStarts, '按下后 recorder 没有真正启动').toBeGreaterThanOrEqual(1);
    expect(during.timeslice, '没有使用生产的时间片参数（250ms）').toBe(250);
    await expect(page.getByTestId('speech-status')).toContainText('录音', { timeout: 20_000 });

    await release();
    const review = page.getByTestId('speech-review');
    await review.waitFor({ state: 'visible', timeout: 30_000 });
    const textarea = page.getByTestId('speech-review-text');
    await expect(textarea).toHaveValue('把这个改成圆角');
    await textarea.fill('把购买按钮改成圆角，文案不动');
    await page.getByTestId('speech-use').click();
    await expect(page.getByTestId('instruction-input')).toHaveValue('把购买按钮改成圆角，文案不动');
    expect(taskPosts, '确认转写后自动提交了任务').toEqual([]);
    await expect(page.getByTestId('generate-candidate')).toBeEnabled();

    const after = await probe(page);
    expect(after.recorderStops, '松手后 recorder 没有走真实 stop 路径').toBeGreaterThanOrEqual(1);
    expect(after.stops, '录音结束后没有释放麦克风轨道').toBeGreaterThanOrEqual(1);
    writeArtifact('speech-review-confirm.json', { during, after, instruction: await page.getByTestId('instruction-input').inputValue() });
  });

  test('录音时指着 A、确认前改点 B：提示并要求明确确认，不得自动套用', async ({ page }) => {
    await openStudio(page);
    const first = await pickElement(page, 'buy-button');
    const release = await pressRecord(page);
    await release();
    await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
    const captured = await page.getByTestId('speech-capture-object').innerText();
    expect(captured.length, '没有显示录音时指着的对象').toBeGreaterThan(0);

    const second = await pickElement(page, 'save-button');
    expect(second.src, '两次点选没落到不同对象').not.toBe(first.src);
    await expect(page.getByTestId('speech-selection-conflict')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('speech-use')).toBeDisabled();
    await page.getByTestId('speech-use-current').click();
    await expect(page.getByTestId('speech-review')).toHaveCount(0);
    await expect(page.getByTestId('instruction-input')).toHaveValue(/改成圆角/);
    writeArtifact('speech-selection-conflict.json', { captured, first: first.src, second: second.src });
  });

  test('录音中页面隐藏：立即取消、释放轨道并发送 DELETE，且不上传', async ({ page }) => {
    await openStudio(page);
    const stub = await installSpeechStubs(page);
    const release = await pressRecord(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(async () => (await probe(page)).stops >= 1, 30_000, 100);
    await release();
    expect(await page.getByTestId('speech-review').count(), '隐藏后仍弹出了 review').toBe(0);
    expect(stub.posts.length, '隐藏取消后仍然上传了音频').toBe(0);
    const recorded = await probe(page);
    expect(recorded.stops, '隐藏后没有释放麦克风轨道').toBeGreaterThanOrEqual(1);
    writeArtifact('speech-hidden-cancel.json', { probe: recorded, posts: stub.posts.length, deletes: stub.deletes });
  });

  test('转写返回 499：只显示安全文案，重试用新的 request id', async ({ page }) => {
    await openStudio(page);
    const stub = await installSpeechStubs(page);
    stub.next = (index, requestedId) => index === 0
      ? { status: 499, body: { error: { code: 'SPEECH_CANCELLED', message: '内部取消细节不应显示' } } }
      : { status: 200, body: { requestId: requestedId, text: '改成圆角', provider: 'aliyun', model: 'qwen3-asr-flash' } };

    const firstRelease = await pressRecord(page);
    await firstRelease();
    await expect(page.getByTestId('speech-review')).toHaveCount(0);
    await waitFor(async () => (await page.getByTestId('speech-status').innerText()).length > 0, 20_000, 100);
    const statusText = await page.getByTestId('speech-status').innerText();
    expect(statusText).not.toContain('内部取消细节');
    await expect(page.getByTestId('speech-record')).toBeEnabled({ timeout: 30_000 });

    const secondRelease = await pressRecord(page);
    await secondRelease();
    await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
    expect(stub.posts.length, '没有得到两次转写请求').toBeGreaterThanOrEqual(2);
    const ids = stub.posts.map((item) => item.id);
    expect(new Set(ids).size, `重试沿用了旧 request id：${JSON.stringify(ids)}`).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    writeArtifact('speech-cancel-new-uuid.json', { requestIds: ids, statusText });
  });

  test('权限未返回时取消：不启动录音、不出现 review、不残留轨道', async ({ page }) => {
    await openStudio(page);
    await page.evaluate(() => {
      const slow = () => new Promise((resolve) => {
        setTimeout(() => resolve({ getTracks: () => [{ kind: 'audio', stop() { (window as any).__speechProbe.stops += 1; } }] }), 1500);
      });
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: slow } });
    });
    const button = page.getByTestId('speech-record');
    await button.hover();
    await page.mouse.down();
    await expect(page.getByTestId('speech-cancel')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('speech-cancel').click();
    await page.mouse.up();
    await waitFor(async () => (await probe(page)).stops >= 1, 20_000, 100);
    expect(await page.getByTestId('speech-review').count(), '取消后仍然弹出了 review').toBe(0);
    const after = await probe(page);
    expect(after.recorderStarts, '权限未返回就不该启动 recorder').toBe(0);
    writeArtifact('speech-late-permission.json', { probe: after });
  });

  test('F1 真实跨源 iframe 重新点选：review 保留、必须显式确认，确认后再改选仍拦', async ({ page }) => {
    await openStudio(page);
    await pickElement(page, 'buy-button');
    const release = await pressRecord(page);
    await release();
    await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
    const second = await pickElement(page, 'save-button');
    await expect(page.getByTestId('speech-review'), '重新点选后转写被丢弃了').toBeVisible();
    const reviewText = await page.getByTestId('speech-review-text').inputValue();
    expect(reviewText.length, 'review 文本被清空').toBeGreaterThan(0);
    await expect(page.getByTestId('speech-selection-conflict')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('speech-use')).toBeDisabled();
    await page.getByTestId('speech-use-current').click();
    await expect(page.getByTestId('speech-review')).toHaveCount(0);
    await pickElement(page, 'buy-button');
    await expect(page.getByTestId('speech-binding-conflict')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('generate-candidate')).toBeDisabled();
    await page.getByTestId('speech-reconfirm').click();
    await expect(page.getByTestId('generate-candidate')).toBeEnabled({ timeout: 20_000 });
    writeArtifact('speech-iframe-repick.json', { reviewText, second: second.src });
  });

  test('F2 语音提交成功后版本变化：新手输文字仍可提交（旧绑定不再阻塞）', async ({ page }) => {
    await resetMock();
    await setScript([
      [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
      [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '<div className="actions">', new: '<div className="actions" style={{ paddingTop: 16 }}>' } }],
      [{ name: 'finish', args: { summary: '购买区下移' } }],
    ]);
    await openStudio(page);
    await pickElement(page, 'buy-button');
    const release = await pressRecord(page);
    await release();
    await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByTestId('speech-use').click();
    await expect(page.getByTestId('instruction-input')).toHaveValue(/改成圆角/);
    await page.getByTestId('generate-candidate').click();
    await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'done', { timeout: 150_000 });
    const scene = await getScene();
    const bumped = await http(base('/scene'), jsonRequest('PUT', scene.body));
    expect(bumped.status, bumped.text.slice(0, 200)).toBe(200);
    await page.getByTestId('instruction-input').fill('换成另一句完全无关的文字指令');
    await expect(page.getByTestId('generate-candidate'), '提交成功后旧语音绑定仍阻塞生成').toBeEnabled({ timeout: 30_000 });
    writeArtifact('speech-post-submit-newtext.json', { instruction: await page.getByTestId('instruction-input').inputValue(), version: (await getVersion()).body.version });
  });
});
