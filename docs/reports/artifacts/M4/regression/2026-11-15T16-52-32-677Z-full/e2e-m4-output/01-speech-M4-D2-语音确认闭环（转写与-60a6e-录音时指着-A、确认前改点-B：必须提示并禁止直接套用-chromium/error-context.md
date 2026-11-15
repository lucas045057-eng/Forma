# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 01-speech.spec.ts >> M4-D2 语音确认闭环（转写与提交均为替身） >> 录音时指着 A、确认前改点 B：必须提示并禁止直接套用
- Location: tests\e2e\m4\01-speech.spec.ts:102:3

# Error details

```
TimeoutError: locator.waitFor: Timeout 30000ms exceeded.
Call log:
  - waiting for getByTestId('speech-review') to be visible

```

# Test source

```ts
  6   |  *
  7   |  * 语音转写与任务提交全部是**浏览器侧替身**（route 拦截 + fake MediaRecorder/getUserMedia），
  8   |  * 不打阿里、不产生真实识别或付费调用；后端也未配置语音上游。
  9   |  * 覆盖：review 编辑与确认、录音时对象与当前对象不一致、录音中页面隐藏即取消、
  10  |  * 499 取消后重试必须用新的 request id、权限晚到时取消不得残留录音。
  11  |  */
  12  | 
  13  | const SPEECH_CONFIG = {
  14  |   enabled: true, provider: 'aliyun', model: 'qwen3-asr-flash',
  15  |   supportedMimeTypes: ['audio/webm'], maxBytes: 4 * 1024 * 1024, maxDurationMs: 35_000,
  16  | };
  17  | 
  18  | interface SpeechStub {
  19  |   posts: Array<{ id: string; mime: string; bytes: number }>;
  20  |   deletes: string[];
  21  |   // 每个用例可替换的转写行为；默认返回固定文本。
  22  |   nextText: () => { status: number; body: unknown };
  23  |   recordIds: string[];
  24  | }
  25  | 
  26  | async function installSpeechStubs(page: import('@playwright/test').Page): Promise<SpeechStub> {
  27  |   const stub: SpeechStub = {
  28  |     posts: [], deletes: [], recordIds: [],
  29  |     nextText: () => ({ status: 200, body: { requestId: 'stub', text: '把这个改成圆角', provider: 'aliyun', model: 'qwen3-asr-flash' } }),
  30  |   };
  31  |   await page.addInitScript(() => {
  32  |     const state = { stops: 0, recorded: 0 };
  33  |     (window as any).__speechProbe = state;
  34  |     const track = { kind: 'audio', stop() { state.stops += 1; } };
  35  |     Object.defineProperty(navigator, 'mediaDevices', {
  36  |       configurable: true,
  37  |       value: { getUserMedia: async () => ({ getTracks: () => [track] }) },
  38  |     });
  39  |     class FakeRecorder {
  40  |       mimeType: string;
  41  |       ondataavailable?: (event: { data: Blob }) => void;
  42  |       onstop?: () => void;
  43  |       state = 'inactive';
  44  |       constructor(_stream: unknown, options?: { mimeType?: string }) { this.mimeType = options?.mimeType ?? 'audio/webm'; }
  45  |       static isTypeSupported() { return true; }
  46  |       start() { this.state = 'recording'; state.recorded += 1; }
  47  |       stop() {
  48  |         this.state = 'inactive';
  49  |         this.ondataavailable?.({ data: new Blob([new Uint8Array(8)], { type: this.mimeType }) });
  50  |         this.onstop?.();
  51  |       }
  52  |       addEventListener() { /* 本套件不依赖事件监听 */ }
  53  |       removeEventListener() { /* noop */ }
  54  |     }
  55  |     (window as any).MediaRecorder = FakeRecorder;
  56  |   });
  57  |   await page.route('**/speech/config', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SPEECH_CONFIG) }));
  58  |   await page.route('**/speech/transcribe', async (route) => {
  59  |     if (route.request().method() !== 'POST') return route.fallback();
  60  |     const headers = route.request().headers();
  61  |     const id = headers['x-speech-request-id'] ?? '';
  62  |     stub.recordIds.push(id);
  63  |     stub.posts.push({ id, mime: headers['content-type'] ?? '', bytes: (route.request().postDataBuffer() ?? Buffer.alloc(0)).length });
  64  |     const next = stub.nextText();
  65  |     await route.fulfill({ status: next.status, contentType: 'application/json', body: JSON.stringify(next.body) });
  66  |   });
  67  |   await page.route('**/speech/transcribe/*', (route) => {
  68  |     const url = new URL(route.request().url());
  69  |     if (route.request().method() !== 'DELETE') return route.fallback();
  70  |     stub.deletes.push(url.pathname.split('/').pop() ?? '');
  71  |     return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ requestId: url.pathname.split('/').pop(), status: 'cancelled' }) });
  72  |   });
  73  |   return stub;
  74  | }
  75  | 
  76  | test.describe('M4-D2 语音确认闭环（转写与提交均为替身）', () => {
  77  |   test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  78  |   test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  79  |   test.beforeEach(async ({ page }) => { await resetMock(); await installSpeechStubs(page); });
  80  | 
  81  |   test('录音 → 可编辑 review → 确认写入指令，只有点生成才提交任务', async ({ page }) => {
  82  |     await openStudio(page);
  83  |     const taskPosts: string[] = [];
  84  |     page.on('request', (request) => {
  85  |       if (request.method() === 'POST' && new URL(request.url()).pathname === '/tasks') taskPosts.push(request.url());
  86  |     });
  87  | 
  88  |     await page.getByTestId('speech-record').click();
  89  |     const review = page.getByTestId('speech-review');
  90  |     await review.waitFor({ state: 'visible', timeout: 30_000 });
  91  |     const textarea = page.getByTestId('speech-review-text');
  92  |     await expect(textarea).toHaveValue('把这个改成圆角');
  93  |     await textarea.fill('把购买按钮改成圆角，文案不动');
  94  |     await page.getByTestId('speech-use').click();
  95  |     await expect(page.getByTestId('instruction-input')).toHaveValue('把购买按钮改成圆角，文案不动');
  96  |     // 确认转写不等于提交：此时不应有任何 /tasks 请求。
  97  |     expect(taskPosts, '确认转写后自动提交了任务').toEqual([]);
  98  |     await expect(page.getByTestId('generate-candidate')).toBeEnabled();
  99  |     writeArtifact('speech-review-confirm.json', { instruction: await page.getByTestId('instruction-input').inputValue(), taskPosts });
  100 |   });
  101 | 
  102 |   test('录音时指着 A、确认前改点 B：必须提示并禁止直接套用', async ({ page }) => {
  103 |     await openStudio(page);
  104 |     const first = await pickElement(page, 'buy-button');
  105 |     await page.getByTestId('speech-record').click();
> 106 |     await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
      |                                             ^ TimeoutError: locator.waitFor: Timeout 30000ms exceeded.
  107 |     const captured = await page.getByTestId('speech-capture-object').innerText();
  108 |     expect(captured.length, '没有显示录音时指着的对象').toBeGreaterThan(0);
  109 | 
  110 |     const second = await pickElement(page, 'save-button');
  111 |     expect(second.src, '两次点选没落到不同对象').not.toBe(first.src);
  112 |     await expect(page.getByTestId('speech-selection-conflict')).toBeVisible({ timeout: 20_000 });
  113 |     await expect(page.getByTestId('speech-use')).toBeDisabled();
  114 |     const explicit = page.getByTestId('speech-use-current');
  115 |     await expect(explicit).toBeVisible();
  116 |     await explicit.click();
  117 |     await expect(page.getByTestId('speech-review')).toHaveCount(0);
  118 |     await expect(page.getByTestId('instruction-input')).toHaveValue(/改成圆角/);
  119 |     writeArtifact('speech-selection-conflict.json', { captured, first: first.src, second: second.src, instruction: await page.getByTestId('instruction-input').inputValue() });
  120 |   });
  121 | 
  122 |   test('录音中页面隐藏：立即取消并发送 DELETE，麦克风轨道被释放', async ({ page }) => {
  123 |     await openStudio(page);
  124 |     await page.getByTestId('speech-record').click();
  125 |     await page.getByTestId('speech-status').waitFor({ state: 'visible', timeout: 15_000 });
  126 |     await waitFor(async () => ((await page.getByTestId('speech-status').innerText()).includes('录音') || (await page.getByTestId('speech-status').innerText()).includes('识别')), 15_000, 100);
  127 |     await page.evaluate(() => {
  128 |       Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  129 |       Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  130 |       document.dispatchEvent(new Event('visibilitychange'));
  131 |     });
  132 |     await waitFor(async () => (await page.getByTestId('speech-review').count()) === 0, 30_000, 200);
  133 |     const probe = await page.evaluate(() => (window as any).__speechProbe as { stops: number; recorded: number });
  134 |     expect(probe.recorded, '没有真正开始录音（替身未被调用）').toBeGreaterThan(0);
  135 |     expect(probe.stops, '隐藏后没有释放麦克风轨道').toBeGreaterThan(0);
  136 |     expect(await page.getByTestId('instruction-input').inputValue()).toBe('');
  137 |     writeArtifact('speech-hidden-cancel.json', { probe });
  138 |   });
  139 | 
  140 |   test('转写返回 499：界面显示取消，重试必须使用新的 request id', async ({ page }) => {
  141 |     await openStudio(page);
  142 |     // 第一个请求返回取消；后续返回正常文本。
  143 |     let round = 0;
  144 |     const stub = await installOverrides(page, () => {
  145 |       round += 1;
  146 |       return round === 1
  147 |         ? { status: 499, body: { error: { code: 'SPEECH_CANCELLED', message: '内部取消细节不应显示' } } }
  148 |         : { status: 200, body: { requestId: 'x', text: '改成圆角', provider: 'aliyun', model: 'qwen3-asr-flash' } };
  149 |     });
  150 |     await page.getByTestId('speech-record').click();
  151 |     await expect(page.getByTestId('speech-review')).toHaveCount(0);
  152 |     await waitFor(async () => (await page.getByTestId('speech-status').innerText()).length > 0, 20_000, 200);
  153 |     const statusText = await page.getByTestId('speech-status').innerText();
  154 |     expect(statusText).not.toContain('内部取消细节');
  155 |     await expect(page.getByTestId('speech-record')).toBeEnabled({ timeout: 20_000 });
  156 |     await page.getByTestId('speech-record').click();
  157 |     await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
  158 |     expect(stub.recordIds.length, '没有得到两次转写请求').toBeGreaterThanOrEqual(2);
  159 |     expect(new Set(stub.recordIds).size, '重试沿用了旧 request id（会拿到缓存终态）').toBe(stub.recordIds.length);
  160 |     writeArtifact('speech-cancel-new-uuid.json', { requestIds: stub.recordIds, statusText });
  161 |   });
  162 | 
  163 |   test('权限晚到后已取消：不得出现 review，也不得残留录音', async ({ page }) => {
  164 |     await openStudio(page);
  165 |     await page.evaluate(() => {
  166 |       const slow = () => new Promise((resolve) => {
  167 |         setTimeout(() => resolve({ getTracks: () => [{ kind: 'audio', stop() { (window as any).__speechProbe.stops += 1; } }] }), 1200);
  168 |       });
  169 |       Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: slow } });
  170 |     });
  171 |     await page.getByTestId('speech-record').click();
  172 |     await page.getByTestId('speech-cancel').click({ timeout: 15_000 }).catch(() => {});
  173 |     await page.waitForTimeout(2500);
  174 |     expect(await page.getByTestId('speech-review').count(), '取消后仍然弹出了 review').toBe(0);
  175 |     const probe = await page.evaluate(() => (window as any).__speechProbe as { stops: number; recorded: number });
  176 |     writeArtifact('speech-late-permission.json', { probe });
  177 |   });
  178 |   test('F1 真实跨源 iframe 重新点选：review 保留、必须显式确认，确认后再改选仍拦', async ({ page }) => {
  179 |     await openStudio(page);
  180 |     await pickElement(page, 'buy-button');
  181 |     await page.getByTestId('speech-record').click();
  182 |     await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
  183 |     // 真实 iframe 里再点一个元素：父窗口失焦 + 点选 pending，旧实现会把转写直接丢掉。
  184 |     const second = await pickElement(page, 'save-button');
  185 |     await expect(page.getByTestId('speech-review'), '重新点选后转写被丢弃了').toBeVisible();
  186 |     const reviewText = await page.getByTestId('speech-review-text').inputValue();
  187 |     expect(reviewText.length, 'review 文本被清空').toBeGreaterThan(0);
  188 |     await expect(page.getByTestId('speech-selection-conflict')).toBeVisible({ timeout: 20_000 });
  189 |     await expect(page.getByTestId('speech-use')).toBeDisabled();
  190 |     // 必须显式选择，绝不自动套到新对象上
  191 |     await page.getByTestId('speech-use-current').click();
  192 |     await expect(page.getByTestId('speech-review')).toHaveCount(0);
  193 |     // 确认后再改选：必须重新确认才能生成
  194 |     await pickElement(page, 'buy-button');
  195 |     await expect(page.getByTestId('speech-binding-conflict')).toBeVisible({ timeout: 20_000 });
  196 |     await expect(page.getByTestId('generate-candidate')).toBeDisabled();
  197 |     await page.getByTestId('speech-reconfirm').click();
  198 |     await expect(page.getByTestId('generate-candidate')).toBeEnabled({ timeout: 20_000 });
  199 |     writeArtifact('speech-iframe-repick.json', { reviewText, second: second.src, instruction: await page.getByTestId('instruction-input').inputValue() });
  200 |   });
  201 | 
  202 |   test('F2 语音提交成功后版本变化：新手输文字仍可提交（旧绑定不再阻塞）', async ({ page }) => {
  203 |     await resetMock();
  204 |     await setScript([
  205 |       [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
  206 |       [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '<div className="actions">', new: '<div className="actions" style={{ paddingTop: 16 }}>' } }],
```