# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 02-takeover.spec.ts >> M2-B 接管后专项 >> 历史截断：补拉返回 truncated 时整体重载任务/候选/版本
- Location: tests\e2e\m2b\02-takeover.spec.ts:429:3

# Error details

```
Error: expect(locator).toHaveAttribute(expected) failed

Locator:  getByTestId('events-status')
Expected: "connected"
Received: "reconnecting"
Timeout:  20000ms

Call log:
  - Expect "toHaveAttribute" getByTestId('events-status') with timeout 20000ms
  - waiting for getByTestId('events-status')
    43 × locator resolved to <span class="connection" data-status="reconnecting" data-testid="events-status">…</span>
       - unexpected value "reconnecting"

```

```yaml
- text: 事件重连中 ·
- status: "123"
```

# Test source

```ts
  371 |     expect(restoreTemplate().clean).toBe(true);
  372 |     await resetMock();
  373 |     await setScript(SUCCESS);
  374 |     const task = await waitForTask((await submitTask('先生成一个候选，供断线期间采用')).body.id);
  375 |     expect(task.status).toBe('done');
  376 |     const candidateId = task.candidateId!;
  377 |     const socketMock = await mockEventsSocket(page);
  378 |     try {
  379 |       await page.goto('/');
  380 |       await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 60_000 });
  381 |       const opened = (await history(0)).body;
  382 |       socketMock.sendReady(opened.current);
  383 |       await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
  384 |       await expect(page.getByTestId('events-seq')).toHaveText(String(opened.current), { timeout: 20_000 });
  385 | 
  386 |       const historyRequests: string[] = [];
  387 |       page.on('request', (request) => {
  388 |         const url = new URL(request.url());
  389 |         if (url.port === String(STUDIO_PORT) && url.pathname === '/events/history') historyRequests.push(request.url());
  390 |       });
  391 | 
  392 |       await socketMock.sockets.at(-1)!.close();
  393 |       await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'reconnecting', { timeout: 15_000 });
  394 | 
  395 |       // M3-B：采用前先跑真实检查并等本次 run 终态（断线补拉仍由真实事件驱动）
  396 |       expect((await ensureChecksPassed(candidateId)).outcome).toBe('passed');
  397 |       const adopted = await adoptCandidate(candidateId);
  398 |       expect(adopted.status, adopted.text).toBe(200);
  399 |       const versionAfterAdopt = adopted.body.version as string;
  400 |       const caught = (await history(0)).body;
  401 |       expect(caught.current).toBeGreaterThan(opened.current);
  402 | 
  403 |       await waitFor(() => socketMock.sockets.length >= 2, 20_000, 200);
  404 |       socketMock.sendReady(caught.current);
  405 |       await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
  406 |       await expect(page.getByTestId('events-seq')).toHaveText(String(caught.current), { timeout: 20_000 });
  407 |       await expect(page.getByTestId('work-version')).toContainText(versionAfterAdopt.slice(0, 10), { timeout: 20_000 });
  408 |       expect(historyRequests.some((url) => url.includes(`since=${opened.current}`)), '没有从断线前序号补拉').toBe(true);
  409 | 
  410 |       writeArtifactFrom('takeover-events-reconnect.json', {
  411 |         startSeq: opened.current,
  412 |         currentAfterAdopt: caught.current,
  413 |         versionAfterAdopt,
  414 |         historyRequests: historyRequests.slice(-4),
  415 |         eventsSeqText: await page.getByTestId('events-seq').innerText(),
  416 |         workVersionText: await page.getByTestId('work-version').innerText(),
  417 |         candidateStillPending: (await listCandidates()).body.some((item) => item.id === candidateId && item.decision === 'pending'),
  418 |       });
  419 |     } finally {
  420 |       await socketMock.dispose();
  421 |       await revertVersion().catch(() => {});
  422 |       for (const candidate of (await listCandidates()).body.filter((item) => item.decision === 'pending')) {
  423 |         await discardCandidate(candidate.id).catch(() => {});
  424 |       }
  425 |     }
  426 |     expect(restoreTemplate().clean).toBe(true);
  427 |   });
  428 | 
  429 |   test('历史截断：补拉返回 truncated 时整体重载任务/候选/版本', async ({ page }) => {
  430 |     expect(restoreTemplate().clean).toBe(true);
  431 |     await resetMock();
  432 |     await setScript(SUCCESS);
  433 |     const first = await waitForTask((await submitTask('候选 A')).body.id);
  434 |     expect(first.status).toBe('done');
  435 |     const socketMock = await mockEventsSocket(page);
  436 |     try {
  437 |       await page.goto('/');
  438 |       await expect(page.getByTestId('preview-status')).toContainText('预览已连接', { timeout: 60_000 });
  439 |       const opened = (await history(0)).body;
  440 |       socketMock.sendReady(opened.current);
  441 |       await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 30_000 });
  442 |       await expect(page.getByTestId('candidate-select').locator('option')).toHaveCount(1, { timeout: 30_000 });
  443 | 
  444 |       await socketMock.sockets.at(-1)!.close();
  445 |       await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'reconnecting', { timeout: 15_000 });
  446 | 
  447 |       const second = await waitForTask((await submitTask('候选 B')).body.id);
  448 |       expect(second.status).toBe('done');
  449 |       const caught = (await history(0)).body;
  450 |       expect(caught.current).toBeGreaterThan(opened.current);
  451 | 
  452 |       const reloadRequests: string[] = [];
  453 |       const track = (request: { url(): string }) => {
  454 |         const url = new URL(request.url());
  455 |         if (url.port === String(STUDIO_PORT) && ['/tasks', '/candidates', '/version'].includes(url.pathname)) reloadRequests.push(url.pathname);
  456 |       };
  457 |       page.on('request', track);
  458 |       const historySeen: string[] = [];
  459 |       const routePredicate = (url: URL) => url.port === String(STUDIO_PORT) && url.pathname === '/events/history';
  460 |       const routeHandler = async (route: Route) => {
  461 |         historySeen.push(route.request().url());
  462 |         await route.fulfill({
  463 |           status: 200, contentType: 'application/json',
  464 |           body: JSON.stringify({ events: [], current: caught.current, oldest: caught.current + 50, truncated: true }),
  465 |         });
  466 |       };
  467 |       await page.route(routePredicate, routeHandler);
  468 |       try {
  469 |         await waitFor(() => socketMock.sockets.length >= 2, 20_000, 200);
  470 |         socketMock.sendReady(caught.current);
> 471 |         await expect(page.getByTestId('events-status')).toHaveAttribute('data-status', 'connected', { timeout: 20_000 });
      |                                                         ^ Error: expect(locator).toHaveAttribute(expected) failed
  472 |         await expect(page.getByTestId('events-seq')).toHaveText(String(caught.current), { timeout: 20_000 });
  473 |         await expect(page.getByTestId('candidate-select').locator('option')).toHaveCount(2, { timeout: 30_000 });
  474 |         const options = await page.getByTestId('candidate-select').locator('option').allInnerTexts();
  475 |         expect(options.join('\n')).toContain(second.candidateId!.slice(0, 8));
  476 |         expect(reloadRequests, 'truncated 后没有整体重载').toEqual(expect.arrayContaining(['/tasks', '/candidates', '/version']));
  477 | 
  478 |         writeArtifactFrom('takeover-events-truncated.json', {
  479 |           startSeq: opened.current,
  480 |           currentAfterSecond: caught.current,
  481 |           truncatedHistoryRequests: historySeen,
  482 |           reloadRequests,
  483 |           candidateOptions: options,
  484 |           eventsSeqText: await page.getByTestId('events-seq').innerText(),
  485 |         });
  486 |       } finally {
  487 |         await page.unroute(routePredicate, routeHandler);
  488 |       }
  489 |     } finally {
  490 |       await socketMock.dispose();
  491 |       for (const candidate of (await listCandidates()).body.filter((item) => item.decision === 'pending')) {
  492 |         await discardCandidate(candidate.id).catch(() => {});
  493 |       }
  494 |     }
  495 |     expect(restoreTemplate().clean).toBe(true);
  496 |   });
  497 | 
  498 |   test('三个待定候选在界面切换，标识与预览内容一一对应', async ({ page }) => {
  499 |     expect(restoreTemplate().clean).toBe(true);
  500 |     await resetMock();
  501 |     const specs = [
  502 |       { text: '马上购买甲', script: '甲' },
  503 |       { text: '马上购买乙', script: '乙' },
  504 |       { text: '马上购买丙', script: '丙' },
  505 |     ];
  506 |     const created: Array<{ id: string; text: string; previewUrl: string; baseVersion: string }> = [];
  507 |     for (const spec of specs) {
  508 |       await setScript([
  509 |         [{ name: 'read_file', args: { path: 'src/App.tsx' } }],
  510 |         [{ name: 'replace_in_file', args: { path: 'src/App.tsx', old: '立即购买', new: spec.text } }],
  511 |         [{ name: 'finish', args: { summary: `候选${spec.script}` } }],
  512 |       ]);
  513 |       const task = await waitForTask((await submitTask(`生成候选${spec.script}`)).body.id);
  514 |       expect(task.status, JSON.stringify(task.error)).toBe('done');
  515 |       const candidate = (await getCandidate(task.candidateId!)).body;
  516 |       created.push({ id: candidate.id, text: spec.text, previewUrl: candidate.previewUrl, baseVersion: candidate.baseVersion });
  517 |     }
  518 |     try {
  519 |       await gotoStudio(page);
  520 |       const select = page.getByTestId('candidate-select');
  521 |       await expect(select.locator('option')).toHaveCount(3, { timeout: 30_000 });
  522 |       const switched: Array<{ id: string; text: string; frameSrc: string | null }> = [];
  523 |       for (const candidate of created) {
  524 |         await select.selectOption(candidate.id);
  525 |         const frame = page.frameLocator('[data-testid="candidate-frame"]');
  526 |         await expect(frame.locator('[data-testid="buy-button"]')).toHaveText(candidate.text, { timeout: 90_000 });
  527 |         const frameSrc = await page.locator('[data-testid="candidate-frame"]').getAttribute('src');
  528 |         expect(frameSrc, '候选 iframe 地址与所选候选不一致').toContain(candidate.previewUrl);
  529 |         const title = await page.locator('[data-testid="candidate-frame"]').getAttribute('title');
  530 |         expect(title).toContain(candidate.id.slice(0, 8));
  531 |         switched.push({ id: candidate.id, text: await frame.locator('[data-testid="buy-button"]').innerText(), frameSrc });
  532 |       }
  533 |       await expect(page.getByTestId('candidate-details')).toContainText('待定候选 3/3');
  534 |       writeArtifactFrom('takeover-candidates-switch.json', { created, switched });
  535 |     } finally {
  536 |       for (const candidate of (await listCandidates()).body.filter((item) => item.decision === 'pending')) {
  537 |         await discardCandidate(candidate.id).catch(() => {});
  538 |       }
  539 |     }
  540 |     expect(restoreTemplate().clean).toBe(true);
  541 |   });
  542 | 
  543 |   test('多面板共用一条事件连接：3D 场景与 3D 资产同时打开仍只有一个 WS', async ({ page }) => {
  544 |     expect(restoreTemplate().clean).toBe(true);
  545 |     await resetMock();
  546 |     await setScript(SUCCESS);
  547 |     const sockets: string[] = [];
  548 |     page.on('websocket', (socket) => sockets.push(socket.url()));
  549 |     await gotoStudio(page);
  550 |     const eventSockets = () => sockets.filter((url) => new URL(url.replace(/^ws/, 'http')).pathname === '/events').length;
  551 |     expect(eventSockets(), '初始事件连接数不是 1').toBe(1);
  552 |     const beforeSeq = Number(await page.getByTestId('events-seq').innerText());
  553 | 
  554 |     await page.getByTestId('scene-open').click();
  555 |     await expect(page.getByTestId('scene-panel')).toBeVisible({ timeout: 60_000 });
  556 |     await page.getByTestId('asset-open').click();
  557 |     await expect(page.getByTestId('asset-close')).toBeVisible({ timeout: 60_000 });
  558 |     await wait(800);
  559 |     expect(eventSockets(), '打开面板后新建了事件连接').toBe(1);
  560 | 
  561 |     const scene = (await getScene()).body;
  562 |     const next = structuredClone(scene);
  563 |     next.hero.camera.fov = Math.min(60, Number(scene.hero.camera.fov) + 2);
  564 |     expect((await putScene(next)).status).toBe(200);
  565 |     await waitFor(async () => Number(await page.getByTestId('events-seq').innerText()) > beforeSeq, 20_000, 200);
  566 |     await expect(page.getByTestId('scene-config')).toContainText(String(next.hero.camera.fov), { timeout: 20_000 });
  567 |     const sceneConfigText = (await page.getByTestId('scene-config').textContent()) ?? '';
  568 |     const sceneConfigMirrored = sceneConfigText.includes(String(next.hero.camera.fov));
  569 |     const seqAfter = Number(await page.getByTestId('events-seq').innerText());
  570 | 
  571 |     await page.getByTestId('asset-close').click();
```