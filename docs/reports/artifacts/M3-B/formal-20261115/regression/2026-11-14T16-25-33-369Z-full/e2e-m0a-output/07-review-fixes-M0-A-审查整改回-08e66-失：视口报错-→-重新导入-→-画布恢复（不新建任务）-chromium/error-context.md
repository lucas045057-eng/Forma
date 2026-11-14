# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 07-review-fixes.spec.ts >> M0-A 审查整改回归 >> R3 ready 资产模型丢失：视口报错 → 重新导入 → 画布恢复（不新建任务）
- Location: tests\e2e\m0a\07-review-fixes.spec.ts:163:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: "ready"
Received: "failed"

Call Log:
- Timeout 120000ms exceeded while waiting on the predicate
```

# Page snapshot

```yaml
- main [ref=e3]:
  - dialog "3D 资产视口" [ref=e4]:
    - generic [ref=e5]:
      - generic [ref=e6]:
        - text: 3D ASSETS
        - heading "木间 · 模型预览" [level=2] [ref=e7]
      - button "返回网页" [ref=e8] [cursor=pointer]
    - generic [ref=e9]:
      - generic [ref=e10]:
        - paragraph: 失败
        - generic: 拖动旋转 · 滚轮缩放 · 右键平移
      - complementary [ref=e11]:
        - heading "已处理模型" [level=3] [ref=e12]
        - combobox "选择模型" [ref=e13]:
          - option "选择模型" [disabled] [selected]
        - heading "导入已有 Lux3D 任务" [level=3] [ref=e14]
        - paragraph [ref=e15]: 读取已有结果，不创建新的付费任务。
        - generic [ref=e16]:
          - textbox "任务编号" [ref=e17]: "7000003"
          - button "导入任务" [ref=e18] [cursor=pointer]
        - generic [ref=e19]:
          - heading "失败" [level=3] [ref=e20]
          - code [ref=e21]: lux3d-7000003
          - alert [ref=e22]: 模型下载返回 HTTP 500
  - generic [ref=e23]:
    - generic [ref=e24]:
      - text: ORBIT / STUDIO
      - heading "空间化 AI 创作工作台" [level=1] [ref=e25]
    - generic [ref=e26]:
      - button "3D 场景编辑" [ref=e27] [cursor=pointer]
      - button "3D 资产" [ref=e28] [cursor=pointer]
      - generic [ref=e29]: 预览已连接
      - generic [ref=e30]:
        - text: 事件已连接 ·
        - status [ref=e31]: "50"
      - button "开启选取" [ref=e32] [cursor=pointer]
  - generic [ref=e33]:
    - region "作品预览" [ref=e34]:
      - generic [ref=e35]:
        - generic [ref=e36]: 作品 / 木间香薰
        - generic [ref=e37]: 浏览模式 · 0%
      - generic [ref=e38]:
        - generic [ref=e39]:
          - text: 作品版本
          - code [ref=e40]: d468657c89
        - button "回退上一次采用" [ref=e41] [cursor=pointer]
      - iframe [ref=e43]:
        - main [ref=f1e3]:
          - generic [ref=f1e4]:
            - link "木间 MUJIAN / SCENT & LIVING" [ref=f1e5] [cursor=pointer]:
              - /url: "#home"
              - text: 木间
              - generic [ref=f1e6]: MUJIAN / SCENT & LIVING
            - link "关于这缕香气" [ref=f1e7] [cursor=pointer]:
              - /url: "#details"
          - generic [ref=f1e8]:
            - generic [ref=f1e9]:
              - paragraph [ref=f1e10]: A LITTLE SPACE TO BREATHE
              - heading "给生活， 留一点香气。" [level=1] [ref=f1e11]: 给生活，留一点香气。
              - paragraph [ref=f1e12]: 把森林的温柔带回家。木间 · 雪松无火香薰，让每一次回家都值得期待。
              - generic [ref=f1e13]: ¥ 168 / 100 mL · 雪松与佛手柑
              - generic [ref=f1e14]:
                - button "立即购买" [ref=f1e15] [cursor=pointer]
                - button "收藏香气" [ref=f1e16] [cursor=pointer]
              - paragraph [ref=f1e17]: 一份给自己，也给生活的温柔礼物。
            - generic "香薰三维展示" [ref=f1e18]
          - generic [ref=f1e22]:
            - paragraph [ref=f1e23]: SMALL RITUALS, EVERY DAY
            - heading "不必远行，也能亲近自然。" [level=2] [ref=f1e24]
            - list [ref=f1e25]:
              - listitem [ref=f1e26]:
                - text: "01"
                - heading "让呼吸慢下来" [level=3] [ref=f1e27]
                - paragraph [ref=f1e28]: 雪松与佛手柑，像雨后走进一片安静的森林。
              - listitem [ref=f1e29]:
                - text: "02"
                - heading "让角落有温度" [level=3] [ref=f1e30]
                - paragraph [ref=f1e31]: 琥珀色瓶身与木质瓶盖，把自然留在你喜欢的角落。
              - listitem [ref=f1e32]:
                - text: "03"
                - heading "让日常有仪式" [level=3] [ref=f1e33]
                - paragraph [ref=f1e34]: 读书、休息、等一杯茶，让淡淡香气陪你片刻。
            - button "为重要的人选一份" [ref=f1e35] [cursor=pointer]
          - generic [ref=f1e36]: 木间 MUJIAN · 留一隅安静，给自己。
          - status
    - complementary [ref=e44]:
      - paragraph [ref=e45]: SOURCE INSPECTOR
      - heading "选中对象" [level=2] [ref=e46]
      - paragraph [ref=e47]: 开启选取后，点击左侧页面。青色边框标出共享同一处源码的所有实例。
      - generic [ref=e48]: 等待选取页面元素
      - region "指着说" [ref=e49]:
        - paragraph [ref=e50]: POINT & SPEAK
        - heading "指着说" [level=2] [ref=e51]
        - generic [ref=e52]:
          - text: 修改指令
          - textbox "修改指令" [ref=e53]:
            - /placeholder: 例如：把这个按钮改成“马上购买”
        - paragraph [ref=e54]: 当前没有选中对象，也可以提交整体修改。 Ctrl/⌘ + Enter 提交。
        - button "生成候选版本" [disabled] [ref=e55]
```

# Test source

```ts
  79  |     const startedAt = Date.now();
  80  |     try {
  81  |       const submitted = await postJson(`${backend.base}/assets/lux3d`, {
  82  |         prompt: 'drip download',
  83  |         version: 'G1-Turbo',
  84  |         idempotencyKey: `r2-drip-${RUN_ID}`,
  85  |       });
  86  |       expect(submitted.status).toBe(202);
  87  |       const created = submitted.body as any;
  88  | 
  89  |       const { asset } = await waitForAsset(backend.base, created.id, (item) => TERMINAL.has(item.status), { timeoutMs: 40_000 });
  90  |       const elapsedMs = Date.now() - startedAt;
  91  | 
  92  |       expect(asset.status).toBe('failed');
  93  |       expect(asset.error?.code).toBe('DOWNLOAD_TIMEOUT');
  94  |       expect(asset.error?.message).toContain('总时限');
  95  |       expect(elapsedMs, '滴流下载没有被总时限中止').toBeLessThan(25_000);
  96  | 
  97  |       // 中止后不留自己的临时文件
  98  |       const taskDir = path.join(directory, String(created.taskId));
  99  |       const temps = readdirSync(taskDir).filter((name) => name.endsWith('.tmp'));
  100 |       writeArtifact('review-r2-drip-timeout.json', { asset, elapsedMs, temps });
  101 |       expect(temps).toEqual([]);
  102 |     } finally {
  103 |       await backend.stop();
  104 |       await mock.stop();
  105 |     }
  106 |   });
  107 | 
  108 |   test('R2b 下载中优雅停机 → 记录可恢复 → 重启后继续原 taskId 且不新建任务', async () => {
  109 |     const directory = scenarioDir('r2-stop');
  110 |     rmSync(directory, { recursive: true, force: true });
  111 |     const drip = await startMock({ scenario: 'drip' });
  112 |     const healthyPort = drip.port;
  113 |     const backend = await startBackend({ base: drip.base, assetsDir: directory, pollMs: 50, downloadTimeoutMs: 60_000 });
  114 |     let healthy: Awaited<ReturnType<typeof startMock>> | null = null;
  115 |     let restarted: Awaited<ReturnType<typeof startBackend>> | null = null;
  116 |     try {
  117 |       const submitted = await postJson(`${backend.base}/assets/lux3d`, {
  118 |         prompt: 'stop during download',
  119 |         version: 'G1-Turbo',
  120 |         idempotencyKey: `r2-stop-${RUN_ID}`,
  121 |       });
  122 |       const created = submitted.body as any;
  123 |       const taskId = String(created.taskId);
  124 | 
  125 |       // 等到真的进入下载阶段（滴流很慢，一定来得及）
  126 |       await waitForAsset(backend.base, created.id, (item) => item.status === 'downloading', { timeoutMs: 30_000 });
  127 | 
  128 |       const closed = await backend.gracefulClose(30_000);
  129 |       expect(closed.code, `优雅停机没有正常退出：${closed.output}`).toBe(0);
  130 | 
  131 |       // 停机后索引里应是可恢复状态：polling + SERVICE_STOPPED，taskId 保留
  132 |       const index = JSON.parse(readFileSync(path.join(directory, 'index.json'), 'utf8')) as any[];
  133 |       const record = index.find((item) => item.id === created.id);
  134 |       expect(record.status).toBe('polling');
  135 |       expect(record.error?.code).toBe('SERVICE_STOPPED');
  136 |       expect(record.taskId).toBe(taskId);
  137 | 
  138 |       // 换一个健康的 mock（同端口）后重启，后端应继续查询原任务并完成
  139 |       await drip.stop();
  140 |       expect(await waitPortFree(healthyPort), `mock 端口 ${healthyPort} 没释放`).toBe(true);
  141 |       healthy = await startMock({ port: healthyPort, scenario: 'success' });
  142 |       restarted = await startBackend({ base: healthy.base, assetsDir: directory, pollMs: 50 });
  143 |       const resumed = await waitForAsset(restarted.base, created.id, (item) => TERMINAL.has(item.status), { timeoutMs: 60_000 });
  144 | 
  145 |       expect(resumed.asset.status, JSON.stringify(resumed.asset.error)).toBe('ready');
  146 |       expect(resumed.asset.taskId).toBe(taskId);
  147 |       const stats = (await getJson(`${healthy.base}/__stats`)).body as { creates: number; gets: number };
  148 |       expect(stats.creates, '重启后新建了付费任务').toBe(0);
  149 |       expect(stats.gets, '重启后没有继续查询原任务').toBeGreaterThan(0);
  150 | 
  151 |       const model = await getBytes(`${restarted.base}${resumed.asset.modelUrl}`);
  152 |       expect(glbHeader(model.buffer).valid).toBe(true);
  153 | 
  154 |       writeArtifact('review-r2-resume.json', { record, resumed: resumed.asset, stats, modelBytes: model.buffer.length });
  155 |     } finally {
  156 |       await restarted?.stop();
  157 |       await healthy?.stop();
  158 |       await backend.stop();
  159 |       await drip.stop();
  160 |     }
  161 |   });
  162 | 
  163 |   test('R3 ready 资产模型丢失：视口报错 → 重新导入 → 画布恢复（不新建任务）', async ({ page }) => {
  164 |     const pageErrors: string[] = [];
  165 |     const consoleErrors: string[] = [];
  166 |     page.on('pageerror', (error) => pageErrors.push(error.message));
  167 |     page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  168 | 
  169 |     const mockBefore = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };
  170 |     const taskId = '7000003';
  171 | 
  172 |     await page.goto('/');
  173 |     await page.getByTestId('asset-open').click();
  174 |     await page.getByTestId('asset-task-id').fill(taskId);
  175 |     await page.getByTestId('asset-import').click();
  176 |     const viewport = page.locator('[data-testid="model-viewport"]');
  177 |     // 面板会自动选中已有的 ready 资产，所以 data-loaded 可能提前就是 true；
  178 |     // 先等这次导入的资产在后端真正 ready，再等面板切到它并加载完。
> 179 |     await expect.poll(async () => (await getJson(`${BACKEND_BASE}/assets/lux3d-${taskId}`)).body.status, { timeout: 120_000 }).toBe('ready');
      |                                                                                                                                ^ Error: expect(received).toBe(expected) // Object.is equality
  180 |     await expect(page.getByTestId('asset-select')).toHaveValue(`lux3d-${taskId}`, { timeout: 60_000 });
  181 |     await expect(viewport).toHaveAttribute('data-loaded', 'true', { timeout: 90_000 });
  182 |     const asset = (await getJson(`${BACKEND_BASE}/assets/lux3d-${taskId}`)).body as any;
  183 |     expect(asset.status).toBe('ready');
  184 |     const oldUrl = asset.modelUrl as string;
  185 | 
  186 |     // 删掉已发布模型，模拟磁盘丢失
  187 |     const modelFile = path.join(PRIMARY_ASSETS, taskId, 'model.glb');
  188 |     rmSync(modelFile, { force: true });
  189 | 
  190 |     // 重新进面板并选中同一个资产 → 加载失败 → 错误边界提示
  191 |     await page.reload();
  192 |     await page.getByTestId('asset-open').click();
  193 |     await page.getByTestId('asset-select').selectOption(asset.id);
  194 |     const alert = page.getByRole('alert').filter({ hasText: '3D 模型加载失败' });
  195 |     await expect(alert, '模型文件丢失时视口没有报错').toBeVisible({ timeout: 60_000 });
  196 |     await expect(viewport).toHaveAttribute('data-loaded', 'false');
  197 | 
  198 |     // 用原 taskId 重新导入修复
  199 |     await page.getByTestId('asset-task-id').fill(taskId);
  200 |     await page.getByTestId('asset-import').click();
  201 |     await expect(page.getByTestId('asset-status')).toContainText('可查看', { timeout: 90_000 });
  202 |     await expect(viewport).toHaveAttribute('data-loaded', 'true', { timeout: 90_000 });
  203 |     await expect(alert).toHaveCount(0);
  204 |     await page.waitForTimeout(800);
  205 | 
  206 |     const canvas = viewport.locator('canvas');
  207 |     const shot = await canvas.screenshot();
  208 |     const stats = await imageStats(shot);
  209 |     const repaired = (await getJson(`${BACKEND_BASE}/assets/${asset.id}`)).body as any;
  210 |     const mockAfter = (await getJson(`${MOCK_BASE}/__stats`)).body as { creates: number; gets: number };
  211 | 
  212 |     writeArtifact('review-r3-model-missing.json', {
  213 |       oldUrl,
  214 |       newUrl: repaired.modelUrl,
  215 |       creates: mockAfter.creates - mockBefore.creates,
  216 |       canvas: stats,
  217 |       pageErrors,
  218 |       consoleErrors,
  219 |     });
  220 | 
  221 |     expect(repaired.modelUrl, '修复后模型 URL 的 revision 没有更新').not.toBe(oldUrl);
  222 |     expect(mockAfter.creates - mockBefore.creates, '重新导入时创建了新任务').toBe(0);
  223 |     expect(stats.uniqueColors, `画布没有恢复：${JSON.stringify(stats)}`).toBeGreaterThan(20);
  224 |     // M1-A 起共享渲染器自己 fetch 并捕获错误，失败只体现为回退提示（不再抛未捕获异常）。
  225 |     // 所以这里改成更严的要求：不许有任何未捕获异常，也不许出现与“模型缺失”无关的控制台错误。
  226 |     expect(pageErrors, `模型缺失时出现了未捕获异常：${JSON.stringify(pageErrors)}`).toEqual([]);
  227 |     expect(
  228 |       consoleErrors.filter((line) => !/404|Failed to load resource|net::ERR/i.test(line)),
  229 |       `模型缺失时出现了无关的控制台错误：${JSON.stringify(consoleErrors)}`,
  230 |     ).toEqual([]);
  231 |   });
  232 | 
  233 |   test('S3 非 loopback 的 http 上游在启动时被拒绝，且没有发出任何请求', async () => {
  234 |     const directory = scenarioDir('s3-http-base');
  235 |     rmSync(directory, { recursive: true, force: true });
  236 |     const result = await startBackendExpectingRejection({ base: 'http://192.0.2.10:4010', assetsDir: directory });
  237 |     const guards = readGuardLog(result.guardLog);
  238 |     writeArtifact('review-s3-http-base.json', {
  239 |       exitCode: result.code,
  240 |       guardLog: guards,
  241 |       guardMarker: result.guardMarker,
  242 |       output: result.output.slice(-600),
  243 |     });
  244 | 
  245 |     expect(result.code, `应当拒绝启动，实际退出码 ${result.code}：${result.output}`).toBe(12);
  246 |     expect(result.output).toContain('LUX3D_BASE');
  247 |     expect(result.guardMarker?.active, '守卫必须已加载，日志为空才有意义').toBe(true);
  248 |     expect(guards, `拒绝启动前发出了出站请求：${JSON.stringify(guards)}`).toEqual([]);
  249 |     await sleep(50);
  250 |   });
  251 | });
  252 | 
```