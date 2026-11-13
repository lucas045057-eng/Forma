# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 15-n4-shutdown.spec.ts >> N4 停机排空（真实 HTTP） >> app.close 等已接受的作品操作完成才关日志/放锁；第二实例在关闭期间仍被锁拒；重启 seq 接续
- Location: tests\e2e\m2a\15-n4-shutdown.spec.ts:37:3

# Error details

```
Error: 关闭期间实例锁已被提前释放

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

```
Error: 锁释放那一刻，被挂住的作品操作还没有完成

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

```
Error: 关闭期间第二实例没有被 INSTANCE_LOCKED 拦下：第二个实例在关闭期间成功启动

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

```
Error: 锁释放那一刻，被阻塞操作的作品写入还没落盘

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

```
Error: 锁释放那一刻，被阻塞操作的事件还没落盘

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
  126 |       expect(execFileSync('git', ['--git-dir', gitDir, 'config', '--get', 'core.fsmonitor'], { encoding: 'utf8' })).toContain('block.sh');
  127 | 
  128 |       // 2) 让作品脏着，这样被挂住的 GET /version 必须写一次快照（作品最后写入）。
  129 |       //    先在没有 marker 的情况下启动（fsmonitor 钩子会立即 exit 1，不影响 init），
  130 |       //    再由测试放上 marker，确保只有这一次请求被挂住。
  131 |       appendFileSync(path.join(work, 'src', 'App.tsx'), '\n// n4: blocked snapshot write\n', 'utf8');
  132 | 
  133 |       const first = await start('n4-first');
  134 |       const before = (await http(`${first.base}/events/history?since=0`)).body as { current: number; oldest: number };
  135 |       facts.seqBefore = before;
  136 |       writeFileSync(marker, 'hold');
  137 | 
  138 |       // 3) 发一个真实的 GET /version：它进入 repo.exclusive 后会被 fsmonitor 卡住。
  139 |       let versionResult: { status: number; body: { version?: string } } | null = null;
  140 |       const versionPromise = fetch(`${first.base}/version`).then(async (response) => {
  141 |         versionResult = { status: response.status, body: await response.json().catch(() => ({})) };
  142 |         return versionResult;
  143 |       });
  144 |       await new Promise<void>((resolve, reject) => {
  145 |         const deadline = Date.now() + 20_000;
  146 |         const check = () => {
  147 |           if (existsSync(markerLog) && statSync(markerLog).size > 0) return resolve();
  148 |           if (Date.now() > deadline) return reject(new Error('fsmonitor 没有被调用，无法证明请求已进入作品操作队列'));
  149 |           setTimeout(check, 100);
  150 |         };
  151 |         check();
  152 |       });
  153 |       await sleep(500);
  154 |       facts.operationAcceptedAndBlocked = versionResult === null;
  155 |       expect(facts.operationAcceptedAndBlocked, '被挂住的作品操作不应提前完成').toBe(true);
  156 | 
  157 |       // 4) 观察锁释放的那一刻，并在关闭期间尝试第二实例。
  158 |       let closeDoneAt = 0;
  159 |       const unlockRef: { value: UnlockSnapshot | null } = { value: null };
  160 |       const captureUnlock = (reason: string) => {
  161 |         if (unlockRef.value) return;
  162 |         const at = Date.now();
  163 |         let head = '';
  164 |         try { head = gitMain('rev-parse', 'HEAD').trim(); } catch { /* ignore */ }
  165 |         unlockRef.value = {
  166 |           at, reason, lockExists: existsSync(lockFile), head, headHasMarker: headHasMarker(),
  167 |           eventBytes: read(eventsFile).length, hasVersionChanged: read(eventsFile).includes('version.changed'),
  168 |           operationCompleted: versionResult !== null,
  169 |         };
  170 |       };
  171 |       const lockWatcher = (async () => {
  172 |         const deadline = Date.now() + 120_000;
  173 |         while (Date.now() < deadline) {
  174 |           if (!existsSync(lockFile)) { captureUnlock('lock-file-gone'); return; }
  175 |           if (closeDoneAt !== 0) { captureUnlock('close-settled'); return; }
  176 |           await sleep(20);
  177 |         }
  178 |       })();
  179 | 
  180 |       const closePromise = first.gracefulClose(90_000).then((result) => {
  181 |         const at = Date.now(); closeDoneAt = at; return { at, ...result };
  182 |       });
  183 |       await sleep(800);
  184 |       const closeSettledWhileBlocked = closeDoneAt !== 0;
  185 |       const lockHeldWhileBlocked = existsSync(lockFile);
  186 |       const secondWhileBlocked = await attemptSecondInstance();
  187 |       facts.whileBlocked = { closeSettledWhileBlocked, lockHeldWhileBlocked, secondWhileBlocked, operationStillBlocked: versionResult === null };
  188 | 
  189 |       // 5) 释放被挂住的操作，等关闭完成。
  190 |       markerRemovedAt = Date.now();
  191 |       rmSync(marker, { force: true });
  192 |       const released = await versionPromise;
  193 |       facts.blockedOperationResult = released;
  194 |       const closeResult = await closePromise;
  195 |       await lockWatcher;
  196 |       const logAfterClose = read(eventsFile);
  197 | 
  198 |       // 6) 重启：seq 接续、日志不再被改，并确认被挂住操作的写入已持久化。
  199 |       const restarted = await start('n4-restarted');
  200 |       const restartedVersion = (await http(`${restarted.base}/version`)).body.version as string;
  201 |       const after = (await http(`${restarted.base}/events/history?since=0`)).body as { current: number; oldest: number; events: Array<{ type: string }> };
  202 |       const logAfterRestart = read(eventsFile);
  203 |       const headVersion = gitMain('rev-parse', 'HEAD').trim();
  204 |       const logMtime = statSync(eventsFile).mtimeMs;
  205 |       const headTime = Number(gitMain('log', '-1', '--format=%ct').trim()) * 1000;
  206 |       const unlock = unlockRef.value;
  207 | 
  208 |       facts.after = {
  209 |         closeResult, processExitedWhileBlocked: closeSettledWhileBlocked, closeExitedAfterRelease: closeResult.at >= markerRemovedAt,
  210 |         unlock, lockReleasedAt: unlock?.at ?? null,
  211 |         restartedVersion, headVersion, headHasMarker: headHasMarker(),
  212 |         seqAfterRestart: after, logAfterRestartEqualsClose: logAfterRestart === logAfterClose,
  213 |         logMtime, headTimeOfLastWrite: headTime,
  214 |         writesBeforeUnlock: Boolean(unlock && unlock.headHasMarker && unlock.hasVersionChanged && logMtime <= (unlock.at + 1000) && headTime <= (unlock.at + 1000)),
  215 |         secondInstanceTests: { secondWhileBlocked },
  216 |         eventsAfterUnlock: { hasVersionChanged: logAfterRestart.includes('version.changed') },
  217 |       };
  218 | 
  219 |       // 7) N4 的验收断言（当前 HEAD 预期失败；用 soft 让所有事实都先记录）。
  220 |       expect.soft(facts.operationAcceptedAndBlocked, '被挂住的作品操作提前完成了').toBe(true);
  221 |       expect.soft(lockHeldWhileBlocked, '关闭期间实例锁已被提前释放').toBe(true);
  222 |       expect.soft(unlock?.operationCompleted, '锁释放那一刻，被挂住的作品操作还没有完成').toBe(true);
  223 |       expect.soft(secondWhileBlocked.locked, `关闭期间第二实例没有被 INSTANCE_LOCKED 拦下：${secondWhileBlocked.detail}`).toBe(true);
  224 |       expect.soft(closeResult.at >= markerRemovedAt, 'app.close 早于被阻塞操作的释放完成').toBe(true);
  225 |       expect.soft(unlock?.headHasMarker, '锁释放那一刻，被阻塞操作的作品写入还没落盘').toBe(true);
> 226 |       expect.soft(unlock?.hasVersionChanged, '锁释放那一刻，被阻塞操作的事件还没落盘').toBe(true);
      |                                                                     ^ Error: 锁释放那一刻，被阻塞操作的事件还没落盘
  227 |       expect.soft(released?.status, '被阻塞的 GET /version 没有正常完成').toBe(200);
  228 |       expect.soft(restartedVersion, '重启后作品版本与被阻塞操作返回的版本不一致').toBe(released?.body?.version);
  229 |       expect.soft(after.current >= before.current + 1, '重启后事件序号没有接续').toBe(true);
  230 |       expect.soft(after.oldest, '重启后事件历史被归零').toBe(before.oldest);
  231 |       expect.soft(logAfterRestart, '重启改写了事件日志').toBe(logAfterClose);
  232 |       expect.soft(headHasMarker(), '被阻塞操作的作品写入没有持久化').toBe(true);
  233 |     } finally {
  234 |       rmSync(marker, { force: true });
  235 |       for (const child of [...children].reverse()) await child.stop().catch(() => {});
  236 |       for (const instance of instances) instance.stopped = true;
  237 |       facts.instances = instances;
  238 |       writeArtifactFrom('takeover-n4-shutdown.json', facts);
  239 |       rmSync(root, { recursive: true, force: true });
  240 |     }
  241 |   });
  242 | });
  243 | 
```