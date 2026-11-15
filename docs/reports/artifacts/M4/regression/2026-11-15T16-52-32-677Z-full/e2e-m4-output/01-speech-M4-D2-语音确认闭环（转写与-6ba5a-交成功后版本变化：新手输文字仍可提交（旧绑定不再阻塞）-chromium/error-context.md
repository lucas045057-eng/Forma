# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 01-speech.spec.ts >> M4-D2 语音确认闭环（转写与提交均为替身） >> F2 语音提交成功后版本变化：新手输文字仍可提交（旧绑定不再阻塞）
- Location: tests\e2e\m4\01-speech.spec.ts:202:3

# Error details

```
TimeoutError: locator.waitFor: Timeout 30000ms exceeded.
Call log:
  - waiting for getByTestId('speech-review') to be visible

```

# Test source

```ts
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
  207 |       [{ name: 'finish', args: { summary: '购买区下移' } }],
  208 |     ]);
  209 |     await openStudio(page);
  210 |     await page.getByTestId('speech-record').click();
> 211 |     await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 30_000 });
      |                                             ^ TimeoutError: locator.waitFor: Timeout 30000ms exceeded.
  212 |     await page.getByTestId('speech-use').click();
  213 |     await expect(page.getByTestId('instruction-input')).toHaveValue(/改成圆角/);
  214 |     await page.getByTestId('generate-candidate').click();
  215 |     await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'done', { timeout: 150_000 });
  216 |     // 制造版本变化（场景写回会推进主版本），再输入全新文字
  217 |     const scene = await getScene();
  218 |     const bumped = await http(base('/scene'), jsonRequest('PUT', scene.body));
  219 |     expect(bumped.status, bumped.text.slice(0, 200)).toBe(200);
  220 |     await page.getByTestId('instruction-input').fill('换成另一句完全无关的文字指令');
  221 |     await expect(page.getByTestId('generate-candidate'), '提交成功后旧语音绑定仍阻塞生成').toBeEnabled({ timeout: 30_000 });
  222 |     writeArtifact('speech-post-submit-newtext.json', { instruction: await page.getByTestId('instruction-input').inputValue(), version: (await getVersion()).body.version });
  223 |   });
  224 | });
  225 | 
  226 | /** 在已注册的 stub 之上替换转写响应（保持 request id 记录）。 */
  227 | async function installOverrides(page: import('@playwright/test').Page, next: () => { status: number; body: unknown }): Promise<{ recordIds: string[] }> {
  228 |   const recordIds: string[] = [];
  229 |   await page.unroute('**/speech/transcribe');
  230 |   await page.route('**/speech/transcribe', async (route) => {
  231 |     if (route.request().method() !== 'POST') return route.fallback();
  232 |     recordIds.push(route.request().headers()['x-speech-request-id'] ?? '');
  233 |     const response = next();
  234 |     await route.fulfill({ status: response.status, contentType: 'application/json', body: JSON.stringify(response.body) });
  235 |   });
  236 |   return { recordIds };
  237 | }
  238 | 
  239 | export { getVersion };
  240 | 
```