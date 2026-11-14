# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 05-security.spec.ts >> M0-A 路径穿越与密钥泄露 >> 2. 响应、模型下载与 WebSocket 事件里都不含上游 key
- Location: tests\e2e\m0a\05-security.spec.ts:47:3

# Error details

```
Error: 资产 lux3d-7000009 在超时前没有进入终态，观察到的状态：polling → failed
```

# Test source

```ts
  237 |     readyUrl: `http://127.0.0.1:${port}/health`,
  238 |     label: 'backend',
  239 |   });
  240 |   return { ...child, port, base: `http://127.0.0.1:${port}`, guardLog };
  241 | }
  242 | 
  243 | /* ------------------------------------------------------------------ HTTP */
  244 | 
  245 | export interface HttpResponse<T> {
  246 |   status: number;
  247 |   body: T;
  248 |   text: string;
  249 |   headers: Record<string, string>;
  250 | }
  251 | 
  252 | async function request<T>(url: string, init?: RequestInit): Promise<HttpResponse<T>> {
  253 |   const response = await fetch(url, init);
  254 |   const text = await response.text();
  255 |   let body: unknown = text;
  256 |   try { body = text ? JSON.parse(text) : null; } catch { /* 保持文本 */ }
  257 |   return { status: response.status, body: body as T, text, headers: Object.fromEntries(response.headers.entries()) };
  258 | }
  259 | 
  260 | export function getJson<T = any>(url: string) {
  261 |   return request<T>(url);
  262 | }
  263 | 
  264 | export function postJson<T = any>(url: string, payload: unknown) {
  265 |   // 不带 Origin 头：应用只在收到跨源 Origin 时才拒绝，测试用同源语义更贴近真实调用
  266 |   return request<T>(url, {
  267 |     method: 'POST',
  268 |     headers: { 'Content-Type': 'application/json' },
  269 |     body: JSON.stringify(payload),
  270 |   });
  271 | }
  272 | 
  273 | export async function getBytes(url: string) {
  274 |   const response = await fetch(url);
  275 |   return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()), headers: Object.fromEntries(response.headers.entries()) };
  276 | }
  277 | 
  278 | /* ------------------------------------------------------------------ WebSocket */
  279 | 
  280 | export interface AssetEventShape {
  281 |   type: string;
  282 |   ts?: string;
  283 |   sequence?: number;
  284 |   asset?: { id?: string; status?: string; error?: { code?: string; message?: string } };
  285 |   [key: string]: unknown;
  286 | }
  287 | 
  288 | export async function collectEvents(url: string) {
  289 |   const events: AssetEventShape[] = [];
  290 |   const raw: string[] = [];
  291 |   const WebSocketImpl = (globalThis as unknown as { WebSocket: new (url: string) => any }).WebSocket;
  292 |   const socket = new WebSocketImpl(url);
  293 |   socket.addEventListener('message', (event: { data: unknown }) => {
  294 |     const text = String(event.data);
  295 |     raw.push(text);
  296 |     try { events.push(JSON.parse(text) as AssetEventShape); } catch { /* 忽略非 JSON */ }
  297 |   });
  298 |   await new Promise<void>((resolve, reject) => {
  299 |     socket.addEventListener('open', () => resolve());
  300 |     socket.addEventListener('error', () => reject(new Error(`WebSocket 连接失败：${url}`)));
  301 |   });
  302 |   return {
  303 |     events,
  304 |     raw,
  305 |     close: () => { try { socket.close(); } catch { /* ignore */ } },
  306 |     waitFor: async (predicate: (events: AssetEventShape[]) => boolean, timeoutMs = 30_000) => {
  307 |       const deadline = Date.now() + timeoutMs;
  308 |       while (Date.now() < deadline) {
  309 |         if (predicate(events)) return;
  310 |         await new Promise((resolve) => setTimeout(resolve, 50));
  311 |       }
  312 |       throw new Error(`等待 WebSocket 事件超时，已收到：${JSON.stringify(events.map((event) => `${event.type}:${event.asset?.status}`))}`);
  313 |     },
  314 |   };
  315 | }
  316 | 
  317 | /* ------------------------------------------------------------------ 资产轮询 */
  318 | 
  319 | export async function waitForAsset(
  320 |   base: string,
  321 |   id: string,
  322 |   isDone: (asset: any) => boolean,
  323 |   options: { timeoutMs?: number; onPoll?: (asset: any) => void } = {},
  324 | ) {
  325 |   const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  326 |   const seen: string[] = [];
  327 |   while (Date.now() < deadline) {
  328 |     const response = await getJson(`${base}/assets/${id}`);
  329 |     const asset = response.body as any;
  330 |     if (asset?.status) {
  331 |       if (seen[seen.length - 1] !== asset.status) seen.push(asset.status);
  332 |       options.onPoll?.(asset);
  333 |       if (isDone(asset)) return { asset, seen, elapsedMs: options.timeoutMs ?? 30_000 };
  334 |     }
  335 |     await new Promise((resolve) => setTimeout(resolve, 50));
  336 |   }
> 337 |   throw new Error(`资产 ${id} 在超时前没有进入终态，观察到的状态：${seen.join(' → ')}`);
      |         ^ Error: 资产 lux3d-7000009 在超时前没有进入终态，观察到的状态：polling → failed
  338 | }
  339 | 
  340 | export const TERMINAL = new Set(['ready', 'failed', 'cancelled', 'submit_unknown']);
  341 | 
  342 | /* ------------------------------------------------------------------ GLB */
  343 | 
  344 | export function glbHeader(buffer: Buffer) {
  345 |   if (buffer.length < 12) return { valid: false, reason: '不足 12 字节' };
  346 |   return {
  347 |     magic: buffer.toString('ascii', 0, 4),
  348 |     version: buffer.readUInt32LE(4),
  349 |     declaredLength: buffer.readUInt32LE(8),
  350 |     actualLength: buffer.length,
  351 |     valid: buffer.toString('ascii', 0, 4) === 'glTF' && buffer.readUInt32LE(4) === 2 && buffer.readUInt32LE(8) === buffer.length,
  352 |   };
  353 | }
  354 | 
  355 | /** 用 @gltf-transform/core 真正解析一遍，顺带算顶点数和世界包围盒。 */
  356 | export async function inspectGlb(buffer: Buffer) {
  357 |   const { NodeIO, getBounds } = requireFromServer('@gltf-transform/core');
  358 |   const { ALL_EXTENSIONS } = requireFromServer('@gltf-transform/extensions');
  359 |   const { MeshoptDecoder } = requireFromServer('meshoptimizer');
  360 |   await MeshoptDecoder.ready;
  361 |   // 处理后的模型用 Meshopt 压缩，读的时候必须挂解码器，否则只能验证文件头
  362 |   const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  363 |     'meshopt.decoder': MeshoptDecoder,
  364 |   });
  365 |   const document = await io.readBinary(new Uint8Array(buffer));
  366 |   const root = document.getRoot();
  367 |   const scene = root.getDefaultScene() ?? root.listScenes()[0];
  368 |   const bounds = getBounds(scene);
  369 |   let vertices = 0;
  370 |   for (const mesh of root.listMeshes()) {
  371 |     for (const primitive of mesh.listPrimitives()) {
  372 |       const position = primitive.getAttribute('POSITION');
  373 |       if (position) vertices += position.getCount();
  374 |     }
  375 |   }
  376 |   const size = [bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]];
  377 |   return {
  378 |     meshes: root.listMeshes().length,
  379 |     materials: root.listMaterials().length,
  380 |     textures: root.listTextures().length,
  381 |     vertices,
  382 |     bounds: { min: [...bounds.min], max: [...bounds.max] },
  383 |     size,
  384 |     maxEdge: Math.max(...size),
  385 |   };
  386 | }
  387 | 
  388 | /* ------------------------------------------------------------------ 图片对比 */
  389 | 
  390 | export async function imageStats(png: Buffer) {
  391 |   const sharp = requireFromServer('sharp');
  392 |   const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  393 |   const colors = new Set<number>();
  394 |   let sum = 0;
  395 |   let sumSquares = 0;
  396 |   const pixels = info.width * info.height;
  397 |   for (let index = 0; index < data.length; index += 4) {
  398 |     const value = (data[index] << 16) | (data[index + 1] << 8) | data[index + 2];
  399 |     colors.add(value);
  400 |     sum += data[index] + data[index + 1] + data[index + 2];
  401 |     sumSquares += data[index] ** 2 + data[index + 1] ** 2 + data[index + 2] ** 2;
  402 |   }
  403 |   const mean = sum / (pixels * 3);
  404 |   const variance = sumSquares / (pixels * 3) - mean ** 2;
  405 |   return { width: info.width, height: info.height, uniqueColors: colors.size, mean, stdDev: Math.sqrt(Math.max(0, variance)) };
  406 | }
  407 | 
  408 | export async function pixelDiff(pngA: Buffer, pngB: Buffer) {
  409 |   const sharp = requireFromServer('sharp');
  410 |   const a = await sharp(pngA).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  411 |   const b = await sharp(pngB).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  412 |   const length = Math.min(a.data.length, b.data.length);
  413 |   let changed = 0;
  414 |   let total = 0;
  415 |   for (let index = 0; index < length; index += 4) {
  416 |     total += 1;
  417 |     const delta = Math.abs(a.data[index] - b.data[index]) + Math.abs(a.data[index + 1] - b.data[index + 1]) + Math.abs(a.data[index + 2] - b.data[index + 2]);
  418 |     if (delta > 12) changed += 1;
  419 |   }
  420 |   return { ratio: total ? changed / total : 0, changed, total };
  421 | }
  422 | 
  423 | /* ------------------------------------------------------------------ 证据 */
  424 | 
  425 | export function writeArtifact(name: string, data: unknown): string {
  426 |   mkdirSync(ARTIFACT_DIR, { recursive: true });
  427 |   const file = path.join(ARTIFACT_DIR, name);
  428 |   writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  429 |   return file;
  430 | }
  431 | 
  432 | export function readGuardLog(file: string): Array<{ kind: string; detail: string; pid: number }> {
  433 |   if (!existsSync(file)) return [];
  434 |   return readFileSync(file, 'utf8')
  435 |     .split('\n')
  436 |     .filter(Boolean)
  437 |     .map((line) => { try { return JSON.parse(line); } catch { return { kind: 'unparsable', detail: line, pid: 0 }; } });
```