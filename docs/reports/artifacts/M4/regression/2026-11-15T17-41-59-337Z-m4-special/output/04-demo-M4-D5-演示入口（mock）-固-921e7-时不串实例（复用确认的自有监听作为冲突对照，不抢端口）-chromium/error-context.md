# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 04-demo.spec.ts >> M4-D5 演示入口（mock） >> 固定 5175 已被占用时不串实例（复用确认的自有监听作为冲突对照，不抢端口）
- Location: tests\e2e\m4\04-demo.spec.ts:361:3

# Error details

```
Error: 模拟 SIGINT 后必须正常退出

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 1

  Object {
-   "code": 0,
+   "code": 1,
    "signal": null,
  }
```

```
AggregateError: Owned demo cleanup failed
```

```
Error: demo 不能在收尾前异常退出

expect(received).toEqual(expected) // deep equality

- Expected  - 1
+ Received  + 1

  Object {
-   "code": 0,
+   "code": 1,
    "signal": null,
  }
```

# Test source

```ts
  82  |   const out: Array<{ pid: number; created: string; depth: number }> = [];
  83  |   const queue: Array<{ pid: number; created: string; depth: number }> = [{ pid, created: table.find((item) => item.pid === pid)?.created ?? new Date(0).toISOString(), depth: 0 }];
  84  |   const seen = new Set<number>([pid]);
  85  |   for (let index = 0; index < queue.length; index += 1) {
  86  |     const current = queue[index];
  87  |     for (const child of children.get(current.pid) ?? []) {
  88  |       if (seen.has(child.pid)) continue;
  89  |       seen.add(child.pid);
  90  |       const next = { pid: child.pid, created: child.created, depth: current.depth + 1 };
  91  |       out.push(next);
  92  |       queue.push(next);
  93  |     }
  94  |   }
  95  |   return out.sort((a, b) => b.depth - a.depth);
  96  | }
  97  | 
  98  | /**
  99  |  * 进程快照：一次 CIM 查询拿到全表，避免"每个 PID 同步起一次 PowerShell"把测试 worker 阻塞，
  100 |  * 也让"存在性"和"创建时间"来自同一次观测。查询失败/超时 = null（调用方必须当成 unknown，绝不能当 gone）。
  101 |  */
  102 | /** 谁在监听某个端口：返回自有可核的 PID + 创建时间；没有监听者返回 null；查询失败返回 null 并记录。 */
  103 | function listenerOf(port: number): { pid: number; created: string } | null {
  104 |   const script = [
  105 |     `$c = Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -First 1`,
  106 |     "if (-not $c) { exit 0 }",
  107 |     "$p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue",
  108 |     "$created = if ($p) { $p.StartTime.ToUniversalTime().ToString('o') } else { '' }",
  109 |     "Write-Output ('' + $c.OwningProcess + '|' + $created)",
  110 |   ].join("; ");
  111 |   const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20000 });
  112 |   if (result.error || result.status !== 0) return null;
  113 |   const text = (result.stdout ?? '').trim();
  114 |   if (!text) return null;
  115 |   const [pidText, created] = text.split('|');
  116 |   const pid = Number(pidText);
  117 |   if (!Number.isInteger(pid) || pid <= 0) return null;
  118 |   return { pid, created: created ?? '' };
  119 | }
  120 | 
  121 | function snapshotProcesses(): Map<number, string> | null {
  122 |   const script = "Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o')} } | ConvertTo-Json -Compress";
  123 |   const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20000 });
  124 |   if (result.error || result.status !== 0) return null;
  125 |   const text = (result.stdout ?? '').trim();
  126 |   if (!text) return null;
  127 |   try {
  128 |     const parsed = JSON.parse(text);
  129 |     const rows = Array.isArray(parsed) ? parsed : [parsed];
  130 |     const map = new Map<number, string>();
  131 |     for (const row of rows) {
  132 |       if (!row || !Number.isInteger(row.pid) || typeof row.created !== 'string') continue;
  133 |       map.set(row.pid, row.created);
  134 |     }
  135 |     return map.size ? map : null;
  136 |   } catch { return null; }
  137 | }
  138 | 
  139 | /**
  140 |  * 判定"是否仍是本次受测的进程"：
  141 |  * - 快照失败 → unknown（不算 gone）；
  142 |  * - 快照里没有 → gone；
  143 |  * - 记录或观测到的创建时间无效（NaN / ≤0 / epoch 0）→ unknown，不参与 alive/reused 判定；
  144 |  * - 创建时间一致 → alive，否则 reused（PID 被复用）。
  145 |  */
  146 | function stillOwn(pid: number, created: string, snapshot: Map<number, string> | null): 'gone' | 'alive' | 'reused' | 'unknown' {
  147 |   const recorded = Date.parse(created);
  148 |   if (!Number.isFinite(recorded) || recorded <= 0) return 'unknown';
  149 |   if (snapshot === null) return 'unknown';
  150 |   const observedRaw = snapshot.get(pid);
  151 |   if (observedRaw === undefined) return 'gone';
  152 |   const observed = Date.parse(observedRaw);
  153 |   if (!Number.isFinite(observed) || observed <= 0) return 'unknown';
  154 |   return observed === recorded ? 'alive' : 'reused';
  155 | }
  156 | 
  157 | async function startMockDemo(): Promise<DemoHandle> {
  158 |   const before = recentRun();
  159 |   const env: Record<string, string> = { ...process.env } as Record<string, string>;
  160 |   delete env.NODE_OPTIONS;
  161 |   const child = spawn(process.execPath, [DRIVER], { cwd: REPO_ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  162 |   const handle: DemoHandle = { child, runDir: '', plan: null, manifest: null, stdout: '', stderr: '' };
  163 |   activeDemos.add(handle);
  164 |   child.stdout!.on('data', (chunk) => { handle.stdout += String(chunk); });
  165 |   child.stderr!.on('data', (chunk) => { handle.stderr += String(chunk); });
  166 |   const started = await waitAsync(() => handle.stdout.includes('Demo mode=mock') || child.exitCode !== null || child.signalCode !== null, 180_000);
  167 |   expect(started && child.exitCode === null && child.signalCode === null, `mock 演示启动失败：${handle.stderr.slice(-800)}`).toBe(true);
  168 |   const runDir = recentRun();
  169 |   expect(runDir, '没有生成新的 demo run 目录').not.toBeNull();
  170 |   expect(runDir, '复用了旧 demo run 目录').not.toBe(before);
  171 |   handle.runDir = runDir!;
  172 |   await waitFor(() => existsSync(path.join(runDir!, 'manifest.json')) && readJson(path.join(runDir!, 'manifest.json')).status === 'running', 60_000, 200);
  173 |   handle.plan = readJson(path.join(runDir!, 'plan.json'));
  174 |   handle.manifest = readJson(path.join(runDir!, 'manifest.json'));
  175 |   return handle;
  176 | }
  177 | 
  178 | async function stopHandle(handle: DemoHandle): Promise<void> {
  179 |   const child = handle.child;
  180 |   if (child.exitCode !== null || child.signalCode !== null) {
  181 |     activeDemos.delete(handle);
> 182 |     expect({ code: child.exitCode, signal: child.signalCode }, 'demo 不能在收尾前异常退出').toEqual({ code: 0, signal: null });
      |                                                                                   ^ Error: demo 不能在收尾前异常退出
  183 |     return;
  184 |   }
  185 |   if (!child.connected) throw new Error('Owned demo is alive without its test IPC shutdown channel');
  186 |   const closed = new Promise<void>((resolve, reject) => {
  187 |     const timer = setTimeout(() => reject(new Error('Owned demo did not close within 90s')), 90_000);
  188 |     child.once('close', () => { clearTimeout(timer); resolve(); });
  189 |   });
  190 |   child.send({ type: 'sigint' });
  191 |   await closed;
  192 |   expect({ code: child.exitCode, signal: child.signalCode }, '模拟 SIGINT 后必须正常退出').toEqual({ code: 0, signal: null });
  193 |   if (handle.runDir) {
  194 |     const manifest = readJson(path.join(handle.runDir, 'manifest.json'));
  195 |     expect(manifest.status).toBe('stopped');
  196 |     expect(manifest.cleanup?.problems).toEqual([]);
  197 |     expect(manifest.cleanup.children.some((item: any) => item.forced)).toBe(false);
  198 |   }
  199 |   activeDemos.delete(handle);
  200 | }
  201 | 
  202 | test.describe('M4-D5 演示入口（mock）', () => {
  203 |   test.describe.configure({ mode: 'serial' });
  204 |   test.afterEach(async () => {
  205 |     const errors: unknown[] = [];
  206 |     for (const handle of activeDemos) {
  207 |       try { await stopHandle(handle); }
  208 |       catch (error) {
  209 |         errors.push(error);
  210 |         // 失败兜底只作用于自己持有的 ChildProcess；强制结束不算正常关闭。
  211 |         if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill('SIGKILL');
  212 |       } finally { activeDemos.delete(handle); }
  213 |     }
  214 |     if (errors.length) throw new AggregateError(errors, 'Owned demo cleanup failed');
  215 |   });
  216 | 
  217 |   test('进程内 SIGINT 处理模拟：launch 自身的 graceful 收尾（非真实控制台 Ctrl+C）', async () => {
  218 |     test.setTimeout(420_000);
  219 |     const record: Record<string, unknown> = { boundary: 'in-process SIGINT emit simulation, NOT real Windows console Ctrl+C' };
  220 |     let child: ReturnType<typeof spawn> | null = null;
  221 |     let primary: unknown = undefined;
  222 |     const cleanupErrors: string[] = [];
  223 |     try {
  224 |       const before = recentRun();
  225 |       const env: Record<string, string> = { ...process.env } as Record<string, string>;
  226 |       delete env.NODE_OPTIONS;
  227 |       // 普通文件入口 + IPC：不注入 NODE_OPTIONS/execArgv，launch 用的仍是产品实现（无替身 options）。
  228 |       child = spawn(process.execPath, [DRIVER], { cwd: REPO_ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  229 |       let stdout = '';
  230 |       let stderr = '';
  231 |       child.stdout!.on('data', (chunk) => { stdout += String(chunk); });
  232 |       child.stderr!.on('data', (chunk) => { stderr += String(chunk); });
  233 |       record.driverPid = child.pid;
  234 |       const ready = await waitAsync(() => stdout.includes('Demo mode=mock') || child!.exitCode !== null, 180_000);
  235 |       expect(ready && child.exitCode === null, `driver 未能就绪：${stderr.slice(-600)}`).toBe(true);
  236 | 
  237 |       const runDir = recentRun();
  238 |       expect(runDir, '没有生成新的 demo run 目录').not.toBe(before);
  239 |       expect(runDir).not.toBeNull();
  240 |       await waitFor(() => existsSync(path.join(runDir!, 'manifest.json')) && readJson(path.join(runDir!, 'manifest.json')).status === 'running', 60_000, 200);
  241 |       const plan = readJson(path.join(runDir!, 'plan.json'));
  242 |       const manifestBefore = readJson(path.join(runDir!, 'manifest.json'));
  243 |       expect(manifestBefore.credentials, 'mock 不应声明任何真实凭据').toEqual({ speech: false, coding: false, lux3d: false });
  244 |       const tracked = descendantsOf(child.pid!);
  245 |       expect(manifestBefore.children.map((item: any) => item.role).sort()).toEqual(['backend', 'frontends']);
  246 |       for (const direct of manifestBefore.children) {
  247 |         const identity = tracked.find((item) => item.pid === direct.pid);
  248 |         expect(identity, `真实角色 ${direct.role} 必须有创建时间证据`).toBeDefined();
  249 |         expect(Number.isFinite(Date.parse(identity!.created)) && Date.parse(identity!.created) > 0).toBe(true);
  250 |       }
  251 |       const ports = Object.values(plan.ports) as number[];
  252 |       const portsOpenBefore: number[] = [];
  253 |       for (const port of ports) if (await portOpen(port)) portsOpenBefore.push(port);
  254 |       progress(record, { runDir: path.relative(REPO_ROOT, runDir!), plan, manifestBefore, tracked: tracked.length, portsOpenBefore });
  255 | 
  256 |       // 只发出进程内 SIGINT 事件；launch 自己的 once('SIGINT') 处理器负责 graceful shutdown。
  257 |       const sentAt = Date.now();
  258 |       const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; ms: number }>((resolve) => {
  259 |         child!.once('exit', (code, signal) => resolve({ code, signal, ms: Date.now() - sentAt }));
  260 |       });
  261 |       const closed = new Promise<number>((resolve) => {
  262 |         child!.once('close', () => resolve(Date.now() - sentAt));
  263 |       });
  264 |       child.send({ type: 'sigint' });
  265 | 
  266 |       const exitInfo = await Promise.race([exited, wait(120_000).then(() => 'timeout' as const)]);
  267 |       const closeMs = await Promise.race([closed, wait(30_000).then(() => 'timeout' as const)]);
  268 |       record.exit = exitInfo;
  269 |       record.closeMs = closeMs;
  270 |       record.stdout = stdout;
  271 |       record.stderr = stderr;
  272 |       expect(exitInfo, '驱动必须自然以 0 退出，不能超时或信号结束').toMatchObject({ code: 0, signal: null });
  273 |       expect(typeof closeMs, '必须收到原生 close，不能用 manifest 代替').toBe('number');
  274 | 
  275 |       // 关键判据：不是"进程没了"，而是 manifest 真的由 launch 写成 stopped 且没有 forced。
  276 |       await waitFor(() => existsSync(path.join(runDir!, 'manifest.json')) && readJson(path.join(runDir!, 'manifest.json')).status !== 'running', 120_000, 300);
  277 |       const finalManifest = readJson(path.join(runDir!, 'manifest.json'));
  278 |       expect(finalManifest.status, `退出后状态不是 stopped：${finalManifest.status}`).toBe('stopped');
  279 |       expect(finalManifest.cleanup?.problems, '正常 SIGINT 必须写出无错误的清理记录').toEqual([]);
  280 |       const forced = (finalManifest.cleanup?.children ?? []).filter((item: any) => item.forced);
  281 |       expect(forced, `正常 SIGINT 出现 forced 回收：${JSON.stringify(forced)}`).toEqual([]);
  282 | 
```