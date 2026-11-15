# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 01-speech.spec.ts >> M4-D2 语音确认闭环（真实按住 + 真实 requestId 回显） >> 录音时指着 A、确认前改点 B：提示并要求明确确认，不得自动套用
- Location: tests\e2e\m4\01-speech.spec.ts:173:3

# Error details

```
Error: 两次点选没落到不同对象

expect(received).not.toBe(expected) // Object.is equality

Expected: not "src/components/Button.tsx:5:5"
```

# Test source

```ts
  85  |     const index = stub.posts.length;
  86  |     stub.posts.push({ id, mime: headers['content-type'] ?? '', bytes: (route.request().postDataBuffer() ?? Buffer.alloc(0)).length });
  87  |     const response = stub.next(index, id);
  88  |     await route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) });
  89  |   });
  90  |   await page.route('**/speech/transcribe/*', (route) => {
  91  |     if (route.request().method() !== 'DELETE') return route.fallback();
  92  |     const id = new URL(route.request().url()).pathname.split('/').pop() ?? '';
  93  |     stub.deletes.push(id);
  94  |     return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ requestId: id, status: 'cancelled' }) });
  95  |   });
  96  |   return stub;
  97  | }
  98  | 
  99  | interface SpeechProbe {
  100 |   stops: number; recorderStarts: number; recorderStops: number; errors: number; timeslice: number;
  101 |   liveTracks: number; streams: number; events: string[];
  102 | }
  103 | 
  104 | const probe = (page: import('@playwright/test').Page) =>
  105 |   page.evaluate(() => (window as any).__speechProbe as SpeechProbe);
  106 | 
  107 | /**
  108 |  * 真实按住：先等按钮可用（上一轮录音必须已结算），记录**本次之前**的计数，
  109 |  * hover → pointerdown → 等到本次 `recorderStarts` **增量 ≥1**、`liveTracks ≥1`、状态含"录音"，
  110 |  * 再返回"松开"函数。用累计值判断第二次录音会假通过，所以这里全部是增量。
  111 |  */
  112 | let pressOutstanding = false;
  113 | 
  114 | async function pressRecord(page: import('@playwright/test').Page): Promise<{ release: () => Promise<void>; delta: () => Promise<{ starts: number; liveTracks: number }> }> {
  115 |   const button = page.getByTestId('speech-record');
  116 |   await expect(button).toBeEnabled({ timeout: 30_000 });
  117 |   const before = await probe(page);
  118 |   await button.hover();
  119 |   await page.mouse.down();
  120 |   pressOutstanding = true;
  121 |   await waitFor(async () => {
  122 |     const now = await probe(page);
  123 |     return now.recorderStarts > before.recorderStarts && now.liveTracks >= 1;
  124 |   }, 20_000, 50);
  125 |   await expect(page.getByTestId('speech-status')).toContainText('录音', { timeout: 20_000 });
  126 |   const delta = async () => {
  127 |     const now = await probe(page);
  128 |     return { starts: now.recorderStarts - before.recorderStarts, liveTracks: now.liveTracks };
  129 |   };
  130 |   return { release: async () => { await page.mouse.up(); pressOutstanding = false; }, delta };
  131 | }
  132 | 
  133 | test.describe('M4-D2 语音确认闭环（真实按住 + 真实 requestId 回显）', () => {
  134 |   test.beforeAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  135 |   test.afterAll(() => { const restored = restoreTemplate(); expect(restored.clean, restored.status).toBe(true); });
  136 |   test.beforeEach(async ({ page }) => { await resetMock(); await installSpeechStubs(page); });
  137 |   // 失败安全：任何用例中途抛错都要把按住的指针松开，否则后续用例会继承"按住"状态。
  138 |   test.afterEach(async ({ page }) => {
  139 |     if (!pressOutstanding) return;
  140 |     try { await page.mouse.up(); } finally { pressOutstanding = false; }
  141 |   });
  142 | 
  143 |   test('按住录音 → 松手转写 → 可编辑 review → 确认写入指令，只有点生成才提交任务', async ({ page }) => {
  144 |     await openStudio(page);
  145 |     const taskPosts: string[] = [];
  146 |     page.on('request', (request) => {
  147 |       if (request.method() === 'POST' && new URL(request.url()).pathname === '/tasks') taskPosts.push(request.url());
  148 |     });
  149 | 
  150 |     const pressed = await pressRecord(page);
  151 |     const during = await probe(page);
  152 |     expect((await pressed.delta()).starts, '本次按下没有启动 recorder').toBe(1);
  153 |     expect(during.timeslice, '没有使用生产的时间片参数（250ms）').toBe(250);
  154 |     await expect(page.getByTestId('speech-status')).toContainText('录音', { timeout: 20_000 });
  155 | 
  156 |     await pressed.release();
  157 |     const review = page.getByTestId('speech-review');
  158 |     await review.waitFor({ state: 'visible', timeout: 30_000 });
  159 |     const textarea = page.getByTestId('speech-review-text');
  160 |     await expect(textarea).toHaveValue('把这个改成圆角');
  161 |     await textarea.fill('把购买按钮改成圆角，文案不动');
  162 |     await page.getByTestId('speech-use').click();
  163 |     await expect(page.getByTestId('instruction-input')).toHaveValue('把购买按钮改成圆角，文案不动');
  164 |     expect(taskPosts, '确认转写后自动提交了任务').toEqual([]);
  165 |     await expect(page.getByTestId('generate-candidate')).toBeEnabled();
  166 | 
  167 |     const after = await probe(page);
  168 |     expect(after.recorderStops, '松手后 recorder 没有走真实 stop 路径').toBeGreaterThanOrEqual(1);
  169 |     expect(after.stops, '录音结束后没有释放麦克风轨道').toBeGreaterThanOrEqual(1);
  170 |     writeArtifact('speech-review-confirm.json', { during, after, instruction: await page.getByTestId('instruction-input').inputValue() });
  171 |   });
  172 | 
  173 |   test('录音时指着 A、确认前改点 B：提示并要求明确确认，不得自动套用', async ({ page }) => {
  174 |     await openStudio(page);
  175 |     const first = await pickElement(page, 'buy-button');
  176 |     const pressed = await pressRecord(page);
  177 |     await pressed.release();
  178 |     await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
  179 |     const captured = await page.getByTestId('speech-capture-object').innerText();
  180 |     expect(captured.length, '没有显示录音时指着的对象').toBeGreaterThan(0);
  181 | 
  182 |     // buy-button 与 save-button 都是共享 Button 组件 → data-src 相同（src/components/Button.tsx:5:5），
  183 |     // 用它证明"两个对象不同"是无效前提。改用真实不同来源的 DOM 目标（ul.benefits，src/App.tsx）。
  184 |     const second = await pickElement(page, 'benefits');
> 185 |     expect(second.src, '两次点选没落到不同对象').not.toBe(first.src);
      |                                           ^ Error: 两次点选没落到不同对象
  186 |     await expect(page.getByTestId('speech-selection-conflict')).toBeVisible({ timeout: 20_000 });
  187 |     await expect(page.getByTestId('speech-use')).toBeDisabled();
  188 |     await page.getByTestId('speech-use-current').click();
  189 |     await expect(page.getByTestId('speech-review')).toHaveCount(0);
  190 |     await expect(page.getByTestId('instruction-input')).toHaveValue(/改成圆角/);
  191 |     writeArtifact('speech-selection-conflict.json', { captured, first: first.src, second: second.src });
  192 |   });
  193 | 
  194 |   test('录音中页面隐藏：立即取消并释放轨道；录音阶段无上传，因此不应发送 DELETE', async ({ page }) => {
  195 |     await openStudio(page);
  196 |     const stub = await installSpeechStubs(page);
  197 |     const pressed = await pressRecord(page);
  198 |     await page.evaluate(() => {
  199 |       Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  200 |       Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  201 |       document.dispatchEvent(new Event('visibilitychange'));
  202 |     });
  203 |     await waitFor(async () => (await probe(page)).stops >= 1, 30_000, 100);
  204 |     await pressed.release();
  205 |     expect(await page.getByTestId('speech-review').count(), '隐藏后仍弹出了 review').toBe(0);
  206 |     expect(stub.posts.length, '隐藏取消后仍然上传了音频').toBe(0);
  207 |     // 录音阶段取消 ⇒ 从未上传 ⇒ 不需要也不应发 DELETE（这里如实断言两者都不存在，不伪造 DELETE 通过）。
  208 |     expect(stub.deletes, '没有上传却发了 DELETE').toEqual([]);
  209 |     const recorded = await probe(page);
  210 |     expect(recorded.stops, '隐藏后没有释放麦克风轨道').toBeGreaterThanOrEqual(1);
  211 |     expect(recorded.liveTracks, '隐藏后仍有活跃轨道').toBe(0);
  212 |     expect(recorded.events).toContain('track-ended');
  213 |     writeArtifact('speech-hidden-cancel.json', { probe: recorded, posts: stub.posts.length, deletes: stub.deletes });
  214 |   });
  215 | 
  216 |   test('转写返回 499：只显示安全文案，重试用新的 request id', async ({ page }) => {
  217 |     await openStudio(page);
  218 |     const stub = await installSpeechStubs(page);
  219 |     stub.next = (index, requestedId) => index === 0
  220 |       ? { status: 499, body: { error: { code: 'SPEECH_CANCELLED', message: '内部取消细节不应显示' } } }
  221 |       : { status: 200, body: { requestId: requestedId, text: '改成圆角', provider: 'aliyun', model: 'qwen3-asr-flash' } };
  222 | 
  223 |     const firstPressed = await pressRecord(page);
  224 |     await firstPressed.release();
  225 |     // 先等**真实 POST 发生**（499 的响应必然对应一次真实上传），再等界面进入取消/错误终态。
  226 |     await waitFor(async () => stub.posts.length >= 1, 30_000, 100);
  227 |     expect(stub.posts[0].id, '第一次转写没有带 UUID').toMatch(/^[0-9a-f-]{36}$/);
  228 |     await waitFor(async () => {
  229 |       const text = await page.getByTestId('speech-status').innerText();
  230 |       return text.includes('取消') || (await page.getByTestId('speech-error').count()) > 0;
  231 |     }, 30_000, 100);
  232 |     await expect(page.getByTestId('speech-review')).toHaveCount(0);
  233 |     const statusText = await page.getByTestId('speech-status').innerText();
  234 |     const errorText = (await page.getByTestId('speech-error').count()) > 0 ? await page.getByTestId('speech-error').innerText() : '';
  235 |     expect(statusText + errorText).not.toContain('内部取消细节');
  236 | 
  237 |     const secondPressed = await pressRecord(page);
  238 |     await secondPressed.release();
  239 |     await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
  240 |     expect(stub.posts.length, '没有得到两次转写请求').toBeGreaterThanOrEqual(2);
  241 |     const ids = stub.posts.map((item) => item.id);
  242 |     expect(new Set(ids).size, `重试沿用了旧 request id：${JSON.stringify(ids)}`).toBe(ids.length);
  243 |     for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  244 |     writeArtifact('speech-cancel-new-uuid.json', { requestIds: ids, statusText });
  245 |   });
  246 | 
  247 |   test('权限未返回时取消：Escape 确定性取消，迟到的权限不会启动录音也不残留轨道', async ({ page }) => {
  248 |     await openStudio(page);
  249 |     // 确定性 barrier：getUserMedia 一直 pending，直到测试显式放行；不用"等 1500ms 猜"。
  250 |     await page.evaluate(() => {
  251 |       const probeState = (window as any).__speechProbe;
  252 |       const gate = { established: false, pending: 0, resolve: null as null | (() => void) };
  253 |       (window as any).__permissionGate = gate;
  254 |       const makeTrack = () => {
  255 |         // 真正分配：streams +1、liveTracks +1；stop 幂等（重复 stop 不再减）。
  256 |         probeState.streams += 1;
  257 |         probeState.liveTracks += 1;
  258 |         probeState.events.push('stream-live');
  259 |         let ended = false;
  260 |         return {
  261 |           kind: 'audio',
  262 |           stop() {
  263 |             if (ended) return;
  264 |             ended = true;
  265 |             probeState.stops += 1;
  266 |             probeState.liveTracks -= 1;
  267 |             probeState.events.push('track-ended');
  268 |           },
  269 |         };
  270 |       };
  271 |       Object.defineProperty(navigator, 'mediaDevices', {
  272 |         configurable: true,
  273 |         value: {
  274 |           getUserMedia: () => {
  275 |             gate.pending += 1;
  276 |             gate.established = true;
  277 |             return new Promise((resolve) => { gate.resolve = () => { const track = makeTrack(); resolve({ getTracks: () => [track] }); }; });
  278 |           },
  279 |         },
  280 |       });
  281 |     });
  282 |     const button = page.getByTestId('speech-record');
  283 |     await expect(button).toBeEnabled();
  284 |     await button.hover();
  285 |     await page.mouse.down();
```