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
    const probe = { stops: 0, recorderStarts: 0, recorderStops: 0, errors: 0, timeslice: 0, liveTracks: 0, streams: 0, events: [] as string[] };
    (window as any).__speechProbe = probe;
    const makeStream = () => {
      probe.streams += 1;
      probe.liveTracks += 1;
      probe.events.push('stream-live');
      let ended = false;
      const track = { kind: 'audio', stop() { if (ended) return; ended = true; probe.stops += 1; probe.liveTracks -= 1; probe.events.push('track-ended'); } };
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
        probe.events.push('recorder-start');
        this.state = 'recording';
      }
      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        probe.recorderStops += 1;
        probe.events.push('recorder-stop');
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

interface SpeechProbe {
  stops: number; recorderStarts: number; recorderStops: number; errors: number; timeslice: number;
  liveTracks: number; streams: number; events: string[];
}

const probe = (page: import('@playwright/test').Page) =>
  page.evaluate(() => (window as any).__speechProbe as SpeechProbe);

/**
 * 真实按住：先等按钮可用（上一轮录音必须已结算），记录**本次之前**的计数，
 * hover → pointerdown → 等到本次 `recorderStarts` **增量 ≥1**、`liveTracks ≥1`、状态含"录音"，
 * 再返回"松开"函数。用累计值判断第二次录音会假通过，所以这里全部是增量。
 */
let pressOutstanding = false;

async function pressRecord(page: import('@playwright/test').Page): Promise<{ release: () => Promise<void>; delta: () => Promise<{ starts: number; liveTracks: number }> }> {
  const button = page.getByTestId('speech-record');
  await expect(button).toBeEnabled({ timeout: 30_000 });
  const before = await probe(page);
  await button.hover();
  await page.mouse.down();
  pressOutstanding = true;
  await waitFor(async () => {
    const now = await probe(page);
    return now.recorderStarts > before.recorderStarts && now.liveTracks >= 1;
  }, 20_000, 50);
  await expect(page.getByTestId('speech-status')).toContainText('录音', { timeout: 20_000 });
  const delta = async () => {
    const now = await probe(page);
    return { starts: now.recorderStarts - before.recorderStarts, liveTracks: now.liveTracks };
  };
  return { release: async () => { await page.mouse.up(); pressOutstanding = false; }, delta };
}

test.describe('M4-D2 语音确认闭环（真实按住 + 真实 requestId 回显）', () => {
  test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  test.beforeEach(async ({ page }) => { await resetMock(); await installSpeechStubs(page); });
  // 失败安全：任何用例中途抛错都要把按住的指针松开，否则后续用例会继承"按住"状态。
  test.afterEach(async ({ page }) => {
    if (!pressOutstanding) return;
    try { await page.mouse.up(); } finally { pressOutstanding = false; }
  });

  test('按住录音 → 松手转写 → 可编辑 review → 确认写入指令，只有点生成才提交任务', async ({ page }) => {
    await openStudio(page);
    const taskPosts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/tasks') taskPosts.push(request.url());
    });

    const pressed = await pressRecord(page);
    const during = await probe(page);
    expect((await pressed.delta()).starts, '本次按下没有启动 recorder').toBe(1);
    expect(during.timeslice, '没有使用生产的时间片参数（250ms）').toBe(250);
    await expect(page.getByTestId('speech-status')).toContainText('录音', { timeout: 20_000 });

    await pressed.release();
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
    const first = (await pickElement(page, 'buy-button')).selection;
    const pressed = await pressRecord(page);
    await pressed.release();
    await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
    const captured = await page.getByTestId('speech-capture-object').innerText();
    expect(captured.length, '没有显示录音时指着的对象').toBeGreaterThan(0);

    // buy-button 与 save-button 都是共享 Button 组件 → data-src 相同（src/components/Button.tsx:5:5），
    // 用它证明"两个对象不同"是无效前提。改用真实不同来源的 DOM 目标（ul.benefits，src/App.tsx）。
    const pickedSecond = await pickElement(page, 'benefits');
    const second = pickedSecond.selection;
    expect(second.src, '两次点选没落到不同对象').not.toBe(first.src);
    await expect(page.getByTestId('speech-selection-conflict')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('speech-use')).toBeDisabled();
    await page.getByTestId('speech-use-current').click();
    await expect(page.getByTestId('speech-review')).toHaveCount(0);
    await expect(page.getByTestId('instruction-input')).toHaveValue(/改成圆角/);
    writeArtifact('speech-selection-conflict.json', { captured, first: first.src, second: second.src, hit: pickedSecond.hit, message: pickedSecond.message, before: pickedSecond.before });
  });

  test('录音中页面隐藏：立即取消并释放轨道；录音阶段无上传，因此不应发送 DELETE', async ({ page }) => {
    await openStudio(page);
    const stub = await installSpeechStubs(page);
    const pressed = await pressRecord(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(async () => (await probe(page)).stops >= 1, 30_000, 100);
    await pressed.release();
    expect(await page.getByTestId('speech-review').count(), '隐藏后仍弹出了 review').toBe(0);
    expect(stub.posts.length, '隐藏取消后仍然上传了音频').toBe(0);
    // 录音阶段取消 ⇒ 从未上传 ⇒ 不需要也不应发 DELETE（这里如实断言两者都不存在，不伪造 DELETE 通过）。
    expect(stub.deletes, '没有上传却发了 DELETE').toEqual([]);
    const recorded = await probe(page);
    expect(recorded.stops, '隐藏后没有释放麦克风轨道').toBeGreaterThanOrEqual(1);
    expect(recorded.liveTracks, '隐藏后仍有活跃轨道').toBe(0);
    expect(recorded.events).toContain('track-ended');
    writeArtifact('speech-hidden-cancel.json', { probe: recorded, posts: stub.posts.length, deletes: stub.deletes });
  });

  test('转写返回 499：只显示安全文案，重试用新的 request id', async ({ page }) => {
    await openStudio(page);
    const stub = await installSpeechStubs(page);
    stub.next = (index, requestedId) => index === 0
      ? { status: 499, body: { error: { code: 'SPEECH_CANCELLED', message: '内部取消细节不应显示' } } }
      : { status: 200, body: { requestId: requestedId, text: '改成圆角', provider: 'aliyun', model: 'qwen3-asr-flash' } };

    const firstPressed = await pressRecord(page);
    await firstPressed.release();
    // 先等**真实 POST 发生**（499 的响应必然对应一次真实上传），再等界面进入取消/错误终态。
    await waitFor(async () => stub.posts.length >= 1, 30_000, 100);
    expect(stub.posts[0].id, '第一次转写没有带 UUID').toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(async () => {
      const text = await page.getByTestId('speech-status').innerText();
      return text.includes('取消') || (await page.getByTestId('speech-error').count()) > 0;
    }, 30_000, 100);
    await expect(page.getByTestId('speech-review')).toHaveCount(0);
    const statusText = await page.getByTestId('speech-status').innerText();
    const errorText = (await page.getByTestId('speech-error').count()) > 0 ? await page.getByTestId('speech-error').innerText() : '';
    expect(statusText + errorText).not.toContain('内部取消细节');

    const secondPressed = await pressRecord(page);
    await secondPressed.release();
    await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
    expect(stub.posts.length, '没有得到两次转写请求').toBeGreaterThanOrEqual(2);
    const ids = stub.posts.map((item) => item.id);
    expect(new Set(ids).size, `重试沿用了旧 request id：${JSON.stringify(ids)}`).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    writeArtifact('speech-cancel-new-uuid.json', { requestIds: ids, statusText });
  });

  test('权限未返回时取消：Escape 确定性取消，迟到的权限不会启动录音也不残留轨道', async ({ page }) => {
    await openStudio(page);
    // 确定性 barrier：getUserMedia 一直 pending，直到测试显式放行；不用"等 1500ms 猜"。
    await page.evaluate(() => {
      const probeState = (window as any).__speechProbe;
      const gate = { established: false, pending: 0, resolve: null as null | (() => void) };
      (window as any).__permissionGate = gate;
      const makeTrack = () => {
        // 真正分配：streams +1、liveTracks +1；stop 幂等（重复 stop 不再减）。
        probeState.streams += 1;
        probeState.liveTracks += 1;
        probeState.events.push('stream-live');
        let ended = false;
        return {
          kind: 'audio',
          stop() {
            if (ended) return;
            ended = true;
            probeState.stops += 1;
            probeState.liveTracks -= 1;
            probeState.events.push('track-ended');
          },
        };
      };
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: () => {
            gate.pending += 1;
            gate.established = true;
            return new Promise((resolve) => { gate.resolve = () => { const track = makeTrack(); resolve({ getTracks: () => [track] }); }; });
          },
        },
      });
    });
    const button = page.getByTestId('speech-record');
    await expect(button).toBeEnabled();
    await button.hover();
    await page.mouse.down();
    pressOutstanding = true;
    await expect(page.getByTestId('speech-status')).toContainText('权限', { timeout: 15_000 });
    // 前提必须是"权限真的在等待"：gate 已建立且有一个 pending 调用。
    const gateState = await page.evaluate(() => {
      const gate = (window as any).__permissionGate as { established: boolean; pending: number };
      return { established: gate.established, pending: gate.pending };
    });
    expect(gateState, `权限 gates 前提不成立：${JSON.stringify(gateState)}`).toEqual({ established: true, pending: 1 });
    // 按住期间按钮持有 pointer capture，点取消按钮可能被拦；用真实键盘 Escape 路径取消。
    await page.keyboard.press('Escape');
    pressOutstanding = false;
    await page.mouse.up();
    // 必须是**真正的取消终态**，不是"状态非空"。
    await expect(page.getByTestId('speech-status')).toContainText('取消', { timeout: 20_000 });
    expect(await page.getByTestId('speech-review').count(), '取消后仍然弹出了 review').toBe(0);
    const before = await probe(page);
    // 放行迟到的权限：这条轨道必须被停掉（stops 增量 ≥1、liveTracks 回 0）。
    await page.evaluate(() => { const gate = (window as any).__permissionGate; gate.resolve(); gate.resolve = null; });
    await waitFor(async () => (await probe(page)).stops > before.stops, 20_000, 100);
    const after = await probe(page);
    expect(after.liveTracks, '迟到权限的轨道没有被释放').toBe(0);
    expect(after.recorderStarts, '权限未返回就不该启动 recorder').toBe(0);
    expect(after.streams - before.streams, '必须实际放行一条迟到权限轨道').toBe(1);
    expect(after.events.slice(before.events.length)).toEqual(['stream-live', 'track-ended']);
    writeArtifact('speech-late-permission.json', { gateState, before, after });
  });

  test('F1 真实跨源 iframe 重新点选：review 保留、必须显式确认，确认后再改选仍拦', async ({ page }) => {
    await openStudio(page);
    await pickElement(page, 'buy-button');
    const pressed = await pressRecord(page);
    await pressed.release();
    await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
    const pickedSecond = await pickElement(page, 'benefits');
    const second = pickedSecond.selection;
    await expect(page.getByTestId('speech-review'), '重新点选后转写被丢弃了').toBeVisible();
    const reviewText = await page.getByTestId('speech-review-text').inputValue();
    expect(reviewText.length, 'review 文本被清空').toBeGreaterThan(0);
    await expect(page.getByTestId('speech-selection-conflict')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('speech-use')).toBeDisabled();
    await page.getByTestId('speech-use-current').click();
    await expect(page.getByTestId('speech-review')).toHaveCount(0);
    // 换回另一个**不同来源**的目标，制造真实的绑定与当前选择不一致。
    await pickElement(page, 'buy-button');
    await expect(page.getByTestId('speech-binding-conflict')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('generate-candidate')).toBeDisabled();
    await page.getByTestId('speech-reconfirm').click();
    await expect(page.getByTestId('generate-candidate')).toBeEnabled({ timeout: 20_000 });
    writeArtifact('speech-iframe-repick.json', { reviewText, second: second.src, hit: pickedSecond.hit, message: pickedSecond.message, before: pickedSecond.before });
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
    const pressed = await pressRecord(page);
    await pressed.release();
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
