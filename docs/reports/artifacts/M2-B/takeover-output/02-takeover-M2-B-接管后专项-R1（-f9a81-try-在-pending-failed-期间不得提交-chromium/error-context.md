# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 02-takeover.spec.ts >> M2-B 接管后专项 >> R1（已知失败，d79c467 未合并）：retry 在 pending/failed 期间不得提交
- Location: tests\e2e\m2b\02-takeover.spec.ts:337:3

# Error details

```
Error: pending 期间 retry 仍可点击

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

```
Error: failed 期间 retry 仍可点击

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Page snapshot

```yaml
- main [ref=e3]:
  - generic [ref=e4]:
    - generic [ref=e5]:
      - text: ORBIT / STUDIO
      - heading "空间化 AI 创作工作台" [level=1] [ref=e6]
    - generic [ref=e7]:
      - button "3D 场景编辑" [ref=e8] [cursor=pointer]
      - button "3D 资产" [ref=e9] [cursor=pointer]
      - generic [ref=e10]: 预览已连接
      - generic [ref=e11]:
        - text: 事件已连接 ·
        - status [ref=e12]: "72"
      - button "开启选取" [active] [ref=e13] [cursor=pointer]
  - generic [ref=e14]:
    - region "作品预览" [ref=e15]:
      - generic [ref=e16]:
        - generic [ref=e17]: 作品 / 木间香薰
        - generic [ref=e18]: 浏览模式 · 0%
      - generic [ref=e19]:
        - generic [ref=e20]:
          - text: 作品版本
          - code [ref=e21]: bd2e62ecee
        - button "回退上一次采用" [ref=e22] [cursor=pointer]
      - iframe [ref=e24]:
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
    - complementary [ref=e25]:
      - paragraph [ref=e26]: SOURCE INSPECTOR
      - heading "选中对象" [level=2] [ref=e27]
      - paragraph [ref=e28]: 开启选取后，点击左侧页面。青色边框标出共享同一处源码的所有实例。
      - alert [ref=e29]: 无法读取作品版本，请确认后端已启动后重新点选
      - generic [ref=e30]: 等待选取页面元素
      - region "指着说" [ref=e31]:
        - paragraph [ref=e32]: POINT & SPEAK
        - heading "指着说" [level=2] [ref=e33]
        - generic [ref=e34]:
          - text: 修改指令
          - textbox "修改指令" [ref=e35]:
            - /placeholder: 例如：把这个按钮改成“马上购买”
            - text: 一个会失败的任务
        - paragraph [ref=e36]: 读取 src/components/Button.tsx:5:5 的作品版本失败，请重新点选后再提交。 Ctrl/⌘ + Enter 提交。
        - button "生成候选版本" [disabled] [ref=e37]
        - generic [ref=e38]:
          - generic [ref=e39]:
            - strong [ref=e40]: 失败
            - code [ref=e41]: 8537ff4b
          - combobox "查看任务" [ref=e42]:
            - option "8537ff4b · 失败" [selected]
            - option "8224df05 · 候选已就绪"
            - option "83bff508 · 候选已就绪"
            - option "961f21dd · 已取消"
            - option "c9f672bc · 候选已就绪"
            - option "41dc7768 · 候选已就绪"
          - paragraph [ref=e43]: 一个会失败的任务
          - list [ref=e44]:
            - listitem [ref=e45]: 任务已排队
            - listitem [ref=e46]: 开始校验选中对象并创建候选版本
            - listitem [ref=e47]: 候选目录已创建，编码 Agent 开始工作
            - listitem [ref=e48]: 请求编码模型（第 1/16 轮）
            - listitem [ref=e49]: 任务失败：编码模型服务返回 HTTP 500
          - alert [ref=e50]: 编码模型服务返回 HTTP 500
          - button "重试" [ref=e51] [cursor=pointer]
```

# Test source

```ts
  262 |       await expect(page.getByTestId('generate-candidate')).toBeDisabled();
  263 | 
  264 |       await page.getByTestId('instruction-input').fill('快捷键不应该把旧对象提交出去');
  265 |       await page.getByTestId('instruction-input').press('Control+Enter');
  266 |       await wait(1200);
  267 |       expect(bodies.length, '等待版本期间快捷键提交了任务').toBe(0);
  268 |       expect((await listTasks()).body.length).toBe(tasksBefore);
  269 |       expect(gate.held.length).toBe(1);
  270 | 
  271 |       await gate.release(version);
  272 |       await expect(page.getByTestId('pick-state')).toHaveAttribute('data-kind', 'ready', { timeout: 20_000 });
  273 |       const second = JSON.parse(await page.getByTestId('selection-json').innerText()) as Record<string, unknown>;
  274 |       expect(second.baseVersion).toBe(version);
  275 |       await expect(page.getByTestId('generate-candidate')).toBeEnabled();
  276 | 
  277 |       writeArtifactFrom('takeover-r1-pending.json', {
  278 |         first: { src: first.src, cid: first.cid, baseVersion: first.baseVersion },
  279 |         second: { src: second.src, cid: second.cid, baseVersion: second.baseVersion },
  280 |         version, pendingTasksPosted: bodies.length, tasksBefore, tasksAfter: (await listTasks()).body.length,
  281 |         versionRequestsSeen: gate.seen.length,
  282 |       });
  283 |     } finally {
  284 |       if (gate.held.length) await gate.release(version).catch(() => {});
  285 |       await gate.dispose();
  286 |     }
  287 |     expect(restoreTemplate().clean).toBe(true);
  288 |   });
  289 | 
  290 |   test('R1：第二次点选的版本请求失败期间同样禁止提交，重新点选可恢复', async ({ page }) => {
  291 |     expect(restoreTemplate().clean).toBe(true);
  292 |     await resetMock();
  293 |     await setScript(SUCCESS);
  294 |     const { bodies } = trackTaskPosts(page);
  295 |     await gotoStudio(page);
  296 | 
  297 |     await pickElement(page, 'buy-button');
  298 |     const first = JSON.parse(await page.getByTestId('selection-json').innerText()) as Record<string, unknown>;
  299 |     const tasksBefore = (await listTasks()).body.length;
  300 | 
  301 |     const gate = await versionGate(page);
  302 |     gate.arm();
  303 |     try {
  304 |       await pickWhileHeld(page, 'buy-button');
  305 |       await gate.fail('failed');
  306 |       await expect(page.getByTestId('pick-state')).toHaveAttribute('data-kind', 'failed', { timeout: 20_000 });
  307 |       const failedPrompt = await page.getByTestId('pick-state').innerText();
  308 |       expect(failedPrompt, '失败提示没有要求重新点选').toContain('重新点选');
  309 |       expect(await page.getByTestId('selection-json').count()).toBe(0);
  310 |       await expect(page.getByTestId('generate-candidate')).toBeDisabled();
  311 | 
  312 |       await page.getByTestId('instruction-input').fill('读取版本失败时不该提交');
  313 |       await page.getByTestId('instruction-input').press('Control+Enter');
  314 |       await wait(1200);
  315 |       expect(bodies.length, '读取版本失败期间快捷键提交了任务').toBe(0);
  316 |       expect((await listTasks()).body.length).toBe(tasksBefore);
  317 | 
  318 |       await gate.dispose();
  319 |       await pickElement(page, 'buy-button');
  320 |       await expect(page.getByTestId('pick-state')).toHaveAttribute('data-kind', 'ready', { timeout: 20_000 });
  321 |       const repicked = JSON.parse(await page.getByTestId('selection-json').innerText()) as Record<string, unknown>;
  322 |       await expect(page.getByTestId('generate-candidate')).toBeEnabled();
  323 | 
  324 |       writeArtifactFrom('takeover-r1-failed.json', {
  325 |         first: { src: first.src, cid: first.cid },
  326 |         failedPrompt,
  327 |         prompt: await page.getByTestId('pick-state').innerText(),
  328 |         repicked: { src: repicked.src, cid: repicked.cid, baseVersion: repicked.baseVersion },
  329 |         failedTasksPosted: bodies.length, tasksBefore, tasksAfter: (await listTasks()).body.length,
  330 |       });
  331 |     } finally {
  332 |       await gate.dispose();
  333 |     }
  334 |     expect(restoreTemplate().clean).toBe(true);
  335 |   });
  336 | 
  337 |   test('R1（已知失败，d79c467 未合并）：retry 在 pending/failed 期间不得提交', async ({ page }) => {
  338 |     test.fail(true, 'retry 的 submittable 门禁只存在于 fix/m2-review2 d79c467；master f70f046 尚未合并');
  339 |     expect(restoreTemplate().clean).toBe(true);
  340 |     await resetMock();
  341 |     await setScript([[{ name: 'read_file', args: { path: 'src/App.tsx' } }]], 0, 'error');
  342 |     await gotoStudio(page);
  343 | 
  344 |     await page.getByTestId('instruction-input').fill('一个会失败的任务');
  345 |     await page.getByTestId('generate-candidate').click();
  346 |     await expect(page.getByTestId('task-status')).toHaveAttribute('data-status', 'failed', { timeout: 90_000 });
  347 |     await expect(page.getByTestId('task-retry')).toBeVisible();
  348 | 
  349 |     await pickElement(page, 'buy-button');
  350 |     const version = (await getVersion()).body.version;
  351 |     const gate = await versionGate(page);
  352 |     gate.arm();
  353 |     const facts: Record<string, unknown> = {};
  354 |     try {
  355 |       await pickWhileHeld(page, 'buy-button');
  356 |       facts.retryDisabledWhilePending = await page.getByTestId('task-retry').isDisabled();
  357 |       expect.soft(facts.retryDisabledWhilePending, 'pending 期间 retry 仍可点击').toBe(true);
  358 | 
  359 |       await gate.fail('failed');
  360 |       await expect(page.getByTestId('pick-state')).toHaveAttribute('data-kind', 'failed', { timeout: 20_000 });
  361 |       facts.retryDisabledWhileFailed = await page.getByTestId('task-retry').isDisabled();
> 362 |       expect.soft(facts.retryDisabledWhileFailed, 'failed 期间 retry 仍可点击').toBe(true);
      |                                                                           ^ Error: failed 期间 retry 仍可点击
  363 |     } finally {
  364 |       writeArtifactFrom('takeover-r1-retry-known-failure.json', facts);
  365 |       if (gate.held.length) await gate.release(version).catch(() => {});
  366 |       await gate.dispose();
  367 |     }
  368 |     expect(restoreTemplate().clean).toBe(true);
  369 |   });
  370 | 
  371 |   test('断线重连：断开期间采用候选，重连后补拉历史并更新界面', async ({ page }) => {
  372 |     expect(restoreTemplate().clean).toBe(true);
  373 |     await resetMock();
  374 |     await setScript(SUCCESS);
  375 |     const task = await waitForTask((await submitTask('先生成一个候选，供断线期间采用')).body.id);
  376 |     expect(task.status).toBe('done');
  377 |     const candidateId = task.candidateId!;
  378 |     const socketMock = await mockEventsSocket(page);
  379 |     try {
  380 |       await page.goto('/');
  381 |       await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 60_000 });
  382 |       const opened = (await history(0)).body;
  383 |       socketMock.sendReady(opened.current);
  384 |       await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
  385 |       await expect(page.getByTestId('events-seq')).toHaveText(String(opened.current), { timeout: 20_000 });
  386 | 
  387 |       const historyRequests: string[] = [];
  388 |       page.on('request', (request) => {
  389 |         const url = new URL(request.url());
  390 |         if (url.port === String(STUDIO_PORT) && url.pathname === '/events/history') historyRequests.push(request.url());
  391 |       });
  392 | 
  393 |       await socketMock.sockets.at(-1)!.close();
  394 |       await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'reconnecting', { timeout: 15_000 });
  395 | 
  396 |       const adopted = await adoptCandidate(candidateId);
  397 |       expect(adopted.status, adopted.text).toBe(200);
  398 |       const versionAfterAdopt = adopted.body.version as string;
  399 |       const caught = (await history(0)).body;
  400 |       expect(caught.current).toBeGreaterThan(opened.current);
  401 | 
  402 |       await waitFor(() => socketMock.sockets.length >= 2, 20_000, 200);
  403 |       socketMock.sendReady(caught.current);
  404 |       await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  405 |       await expect(page.getByTestId('events-seq')).toHaveText(String(caught.current), { timeout: 20_000 });
  406 |       await expect(page.getByTestId('work-version')).toContainText(versionAfterAdopt.slice(0, 10), { timeout: 20_000 });
  407 |       expect(historyRequests.some((url) => url.includes(`since=${opened.current}`)), '没有从断线前序号补拉').toBe(true);
  408 | 
  409 |       writeArtifactFrom('takeover-events-reconnect.json', {
  410 |         startSeq: opened.current,
  411 |         currentAfterAdopt: caught.current,
  412 |         versionAfterAdopt,
  413 |         historyRequests: historyRequests.slice(-4),
  414 |         eventsSeqText: await page.getByTestId('events-seq').innerText(),
  415 |         workVersionText: await page.getByTestId('work-version').innerText(),
  416 |         candidateStillPending: (await listCandidates()).body.some((item) => item.id === candidateId && item.decision === 'pending'),
  417 |       });
  418 |     } finally {
  419 |       await socketMock.dispose();
  420 |       await revertVersion().catch(() => {});
  421 |       for (const candidate of (await listCandidates()).body.filter((item) => item.decision === 'pending')) {
  422 |         await discardCandidate(candidate.id).catch(() => {});
  423 |       }
  424 |     }
  425 |     expect(restoreTemplate().clean).toBe(true);
  426 |   });
  427 | 
  428 |   test('历史截断：补拉返回 truncated 时整体重载任务/候选/版本', async ({ page }) => {
  429 |     expect(restoreTemplate().clean).toBe(true);
  430 |     await resetMock();
  431 |     await setScript(SUCCESS);
  432 |     const first = await waitForTask((await submitTask('候选 A')).body.id);
  433 |     expect(first.status).toBe('done');
  434 |     const socketMock = await mockEventsSocket(page);
  435 |     try {
  436 |       await page.goto('/');
  437 |       await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 60_000 });
  438 |       const opened = (await history(0)).body;
  439 |       socketMock.sendReady(opened.current);
  440 |       await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
  441 |       await expect(page.getByTestId('candidate-select').locator('option')).toHaveCount(1, { timeout: 30_000 });
  442 | 
  443 |       await socketMock.sockets.at(-1)!.close();
  444 |       await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'reconnecting', { timeout: 15_000 });
  445 | 
  446 |       const second = await waitForTask((await submitTask('候选 B')).body.id);
  447 |       expect(second.status).toBe('done');
  448 |       const caught = (await history(0)).body;
  449 |       expect(caught.current).toBeGreaterThan(opened.current);
  450 | 
  451 |       const reloadRequests: string[] = [];
  452 |       const track = (request: { url(): string }) => {
  453 |         const url = new URL(request.url());
  454 |         if (url.port === String(STUDIO_PORT) && ['/tasks', '/candidates', '/version'].includes(url.pathname)) reloadRequests.push(url.pathname);
  455 |       };
  456 |       page.on('request', track);
  457 |       const historySeen: string[] = [];
  458 |       const routePredicate = (url: URL) => url.port === String(STUDIO_PORT) && url.pathname === '/events/history';
  459 |       const routeHandler = async (route: Route) => {
  460 |         historySeen.push(route.request().url());
  461 |         await route.fulfill({
  462 |           status: 200, contentType: 'application/json',
```