# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 04-demo.spec.ts >> M4-D5 演示入口（mock） >> SIGINT 正常关闭：stopped、forced 全 false、端口释放
- Location: tests\e2e\m4\04-demo.spec.ts:123:3

# Error details

```
Error: 父进程没有在 90s 内退出

expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false
```

# Test source

```ts
  33  |     .filter((dir) => statSync(dir).isDirectory())
  34  |     .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  35  |   return dirs[0] ?? null;
  36  | };
  37  | 
  38  | const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
  39  | 
  40  | const portOpen = (port: number): Promise<boolean> => new Promise((resolve) => {
  41  |   const socket = net.connect({ host: '127.0.0.1', port });
  42  |   const done = (open: boolean) => { socket.destroy(); resolve(open); };
  43  |   socket.setTimeout(800);
  44  |   socket.once('connect', () => done(true));
  45  |   socket.once('timeout', () => done(false));
  46  |   socket.once('error', () => done(false));
  47  | });
  48  | 
  49  | async function waitAsync(predicate: () => boolean, timeoutMs: number, intervalMs = 200): Promise<boolean> {
  50  |   const started = Date.now();
  51  |   while (Date.now() - started < timeoutMs) {
  52  |     if (predicate()) return true;
  53  |     await wait(intervalMs);
  54  |   }
  55  |   return false;
  56  | }
  57  | 
  58  | function processTable(): Array<{ pid: number; parent: number; created: string }> {
  59  |   const script = "Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o')} } | ConvertTo-Json -Compress";
  60  |   const raw = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000 }).stdout ?? '[]';
  61  |   const value = JSON.parse(raw.trim() || '[]');
  62  |   return (Array.isArray(value) ? value : [value]).filter(Boolean);
  63  | }
  64  | 
  65  | function descendantsOf(pid: number): Array<{ pid: number; created: string; depth: number }> {
  66  |   const table = processTable();
  67  |   const children = new Map<number, Array<{ pid: number; parent: number; created: string }>>();
  68  |   for (const item of table) {
  69  |     const list = children.get(item.parent) ?? [];
  70  |     list.push(item);
  71  |     children.set(item.parent, list);
  72  |   }
  73  |   const out: Array<{ pid: number; created: string; depth: number }> = [];
  74  |   const queue: Array<{ pid: number; created: string; depth: number }> = [{ pid, created: table.find((item) => item.pid === pid)?.created ?? new Date(0).toISOString(), depth: 0 }];
  75  |   const seen = new Set<number>([pid]);
  76  |   for (let index = 0; index < queue.length; index += 1) {
  77  |     const current = queue[index];
  78  |     for (const child of children.get(current.pid) ?? []) {
  79  |       if (seen.has(child.pid)) continue;
  80  |       seen.add(child.pid);
  81  |       const next = { pid: child.pid, created: child.created, depth: current.depth + 1 };
  82  |       out.push(next);
  83  |       queue.push(next);
  84  |     }
  85  |   }
  86  |   return out.sort((a, b) => b.depth - a.depth);
  87  | }
  88  | 
  89  | function alive(pid: number): boolean {
  90  |   const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' }`], { encoding: 'utf8', timeout: 10000 });
  91  |   return (result.stdout ?? '').includes('alive');
  92  | }
  93  | 
  94  | async function startMockDemo(): Promise<DemoHandle> {
  95  |   const before = recentRun();
  96  |   const env: Record<string, string> = { ...process.env } as Record<string, string>;
  97  |   delete env.NODE_OPTIONS;
  98  |   const child = spawn(process.execPath, ['scripts/demo/mock.mjs'], { cwd: REPO_ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  99  |   const handle: DemoHandle = { child, runDir: '', plan: null, manifest: null, stdout: '', stderr: '' };
  100 |   child.stdout!.on('data', (chunk) => { handle.stdout += String(chunk); });
  101 |   child.stderr!.on('data', (chunk) => { handle.stderr += String(chunk); });
  102 |   const started = await waitAsync(() => handle.stdout.includes('Demo mode=mock') || child.exitCode !== null, 180_000);
  103 |   expect(started && child.exitCode === null, `mock 演示启动失败：${handle.stderr.slice(-800)}`).toBe(true);
  104 |   const runDir = recentRun();
  105 |   expect(runDir, '没有生成新的 demo run 目录').not.toBeNull();
  106 |   expect(runDir, '复用了旧 demo run 目录').not.toBe(before);
  107 |   handle.runDir = runDir!;
  108 |   await waitFor(() => existsSync(path.join(runDir!, 'manifest.json')) && readJson(path.join(runDir!, 'manifest.json')).status === 'running', 60_000, 200);
  109 |   handle.plan = readJson(path.join(runDir!, 'plan.json'));
  110 |   handle.manifest = readJson(path.join(runDir!, 'manifest.json'));
  111 |   return handle;
  112 | }
  113 | 
  114 | async function stopHandle(handle: DemoHandle): Promise<void> {
  115 |   if (handle.child.exitCode !== null) return;
  116 |   handle.child.kill('SIGINT');
  117 |   await waitAsync(() => handle.child.exitCode !== null, 90_000);
  118 | }
  119 | 
  120 | test.describe('M4-D5 演示入口（mock）', () => {
  121 |   test.describe.configure({ mode: 'serial' });
  122 | 
  123 |   test('SIGINT 正常关闭：stopped、forced 全 false、端口释放', async () => {
  124 |     test.setTimeout(300_000);
  125 |     const handle = await startMockDemo();
  126 |     const studio = `http://127.0.0.1:${handle.plan.ports.studio}/`;
  127 |     expect((await fetch(studio)).status, 'mock Studio 不可访问').toBe(200);
  128 |     expect(handle.manifest.credentials, 'mock 不应声明任何真实凭据').toEqual({ speech: false, coding: false, lux3d: false });
  129 |     expect(handle.manifest.mockServices).toBe(true);
  130 | 
  131 |     handle.child.kill('SIGINT');
  132 |     const exited = await waitAsync(() => handle.child.exitCode !== null, 90_000);
> 133 |     expect(exited, '父进程没有在 90s 内退出').toBe(true);
      |                                      ^ Error: 父进程没有在 90s 内退出
  134 |     const finalManifest = readJson(path.join(handle.runDir, 'manifest.json'));
  135 |     expect(finalManifest.status, `退出状态：${finalManifest.status}`).toBe('stopped');
  136 |     expect(finalManifest.cleanup?.problems ?? [], '正常关闭不应该有清理问题').toEqual([]);
  137 |     const forced = (finalManifest.cleanup?.children ?? []).filter((item: any) => item.forced);
  138 |     expect(forced, `正常 SIGINT 出现 forced 回收：${JSON.stringify(forced)}`).toEqual([]);
  139 |     const stillOpen: number[] = [];
  140 |     for (const port of Object.values(handle.plan.ports) as number[]) if (await portOpen(port)) stillOpen.push(port);
  141 |     expect(stillOpen, `退出后端口仍可连接：${stillOpen.join(',')}`).toEqual([]);
  142 |     writeArtifact('demo-sigint.json', { runDir: path.relative(REPO_ROOT, handle.runDir), plan: handle.plan, finalManifest });
  143 |   });
  144 | 
  145 |   test('真实候选链路：候选 HMR 连 plan.preview，10s 内无循环导航', async () => {
  146 |     test.setTimeout(420_000);
  147 |     const handle = await startMockDemo();
  148 |     const { ports } = handle.plan;
  149 |     const api = `http://127.0.0.1:${ports.api}`;
  150 |     const version = (await (await fetch(`${api}/version`)).json()).version;
  151 |     // 用 mock 编码上游支持的固定示例（购买区下移），直接走真实任务/候选链路。
  152 |     const submitted = await fetch(`${api}/tasks`, {
  153 |       method: 'POST', headers: { 'Content-Type': 'application/json' },
  154 |       body: JSON.stringify({ instruction: '把购买区向下移动一点', selection: { src: 'src/App.tsx:30:11', baseVersion: version, cid: 'Node', text: '', bbox: [0, 0, 10, 10], styles: { display: 'inline-block', position: 'static', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', fontSize: '16px', fontFamily: 'Arial', fontWeight: '400', lineHeight: '16px', padding: '0px', margin: '0px', borderRadius: '0px', width: '10px', height: '10px' }, instances: 1, ancestors: [] } }),
  155 |     });
  156 |     expect(submitted.status, `提交任务失败：${submitted.status}`).toBe(202);
  157 |     const task = await (await submitted.json() as any);
  158 |     const done = await waitFor(async () => {
  159 |       const current = await (await fetch(`${api}/tasks/${task.id}`)).json() as any;
  160 |       return current.status === 'done' ? current : false;
  161 |     }, 180_000, 500);
  162 |     void done;
  163 |     const taskFinal = await (await fetch(`${api}/tasks/${task.id}`)).json() as any;
  164 |     expect(taskFinal.status).toBe('done');
  165 |     const candidateId = taskFinal.candidateId;
  166 |     expect(candidateId).toBeTruthy();
  167 | 
  168 |     const { chromium } = await import('@playwright/test');
  169 |     const browser = await chromium.launch();
  170 |     try {
  171 |       const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  172 |       const sockets: string[] = [];
  173 |       const navigations: string[] = [];
  174 |       page.on('websocket', (socket) => sockets.push(socket.url()));
  175 |       page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
  176 |       const candidateUrl = `http://127.0.0.1:${ports.preview}/preview/c/${candidateId}/`;
  177 |       await page.goto(candidateUrl);
  178 |       await page.locator('[data-testid="buy-button"]').waitFor({ state: 'visible', timeout: 90_000 });
  179 |       const baselineNavigations = navigations.length;
  180 |       await wait(10_000);
  181 |       const extraNavigations = navigations.length - baselineNavigations;
  182 |       const hmr = sockets.filter((url) => url.includes(`:${ports.preview}/`));
  183 |       expect(extraNavigations, `候选预览 10 秒内发生 ${extraNavigations} 次导航（疑似连错端口循环刷新）；sockets=${JSON.stringify(sockets)}`).toBeLessThanOrEqual(1);
  184 |       expect(hmr.length, `候选 HMR 没有连到 plan.preview(${ports.preview})：${JSON.stringify(sockets)}`).toBeGreaterThan(0);
  185 |       writeArtifact('demo-candidate-hmr.json', { ports, candidateId, sockets, navigations, extraNavigations, candidateUrl });
  186 |     } finally {
  187 |       await browser.close();
  188 |     }
  189 |     await stopHandle(handle);
  190 |   });
  191 | 
  192 |   test('固定 5175 被占用时不串实例（demo 用自己的随机预览端口）', async () => {
  193 |     test.setTimeout(300_000);
  194 |     const occupy = net.createServer((socket) => socket.destroy());
  195 |     await new Promise<void>((resolve, reject) => { occupy.once('error', reject); occupy.listen(5175, '127.0.0.1', resolve); });
  196 |     try {
  197 |       const handle = await startMockDemo();
  198 |       expect(handle.plan.ports.preview, 'demo 预览端口不能等于被占用的 5175').not.toBe(5175);
  199 |       expect((await fetch(`http://127.0.0.1:${handle.plan.ports.studio}/`)).status).toBe(200);
  200 |       const backend = await fetch(`http://127.0.0.1:${handle.plan.ports.api}/health`);
  201 |       expect(backend.status).toBe(200);
  202 |       writeArtifact('demo-port-5175-occupied.json', { plan: handle.plan, occupied: 5175 });
  203 |       await stopHandle(handle);
  204 |     } finally {
  205 |       await new Promise<void>((resolve) => occupy.close(() => resolve()));
  206 |     }
  207 |   });
  208 | 
  209 |   test('父启动器被硬杀：真实 backend/frontends 及孙进程按 PID+创建时间回收，并留失败证据', async () => {
  210 |     test.setTimeout(480_000);
  211 |     const handle = await startMockDemo();
  212 |     const { ports } = handle.plan;
  213 |     // 让真实后端产生候选，从而派生候选预览 Vite（孙进程）。
  214 |     const version = (await (await fetch(`http://127.0.0.1:${ports.api}/version`)).json()).version;
  215 |     await fetch(`http://127.0.0.1:${ports.api}/tasks`, {
  216 |       method: 'POST', headers: { 'Content-Type': 'application/json' },
  217 |       body: JSON.stringify({ instruction: '把购买区向下移动一点', selection: { src: 'src/App.tsx:30:11', baseVersion: version, cid: 'Node', text: '', bbox: [0, 0, 10, 10], styles: { display: 'inline-block', position: 'static', color: 'rgb(0, 0, 0)', backgroundColor: 'rgba(0, 0, 0, 0)', fontSize: '16px', fontFamily: 'Arial', fontWeight: '400', lineHeight: '16px', padding: '0px', margin: '0px', borderRadius: '0px', width: '10px', height: '10px' }, instances: 1, ancestors: [] } }),
  218 |     });
  219 |     await waitFor(async () => {
  220 |       const list = await (await fetch(`http://127.0.0.1:${ports.api}/candidates`)).json() as any[];
  221 |       return Array.isArray(list) && list.length > 0;
  222 |     }, 180_000, 500);
  223 | 
  224 |     const owned = descendantsOf(handle.child.pid!);
  225 |     const tracked = [{ pid: handle.child.pid!, created: new Date(0).toISOString(), depth: 0 }, ...owned];
  226 |     expect(owned.length, '硬杀前没有找到任何孙进程').toBeGreaterThan(0);
  227 | 
  228 |     // 只杀启动器本身（不 /T），把回收责任交给子进程的 IPC 断开处理。
  229 |     spawnSync('taskkill', ['/F', '/PID', String(handle.child.pid)], { stdio: 'ignore' });
  230 |     await wait(2000);
  231 | 
  232 |     const deadline = Date.now() + 90_000;
  233 |     let remaining: typeof tracked = [];
```