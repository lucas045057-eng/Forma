# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 07-fixes.spec.ts >> 审查整改项 >> R2：识别失败但源模型自带 lid/spatialPart 的 GLB，处理后不再被开盖轨道移动
- Location: tests\e2e\m1b\07-fixes.spec.ts:41:3

# Error details

```
Error: 出厂模型没有正常开盖（位移 0px，期望约 45px）

expect(received).toBeGreaterThan(expected)

Expected: > 22.68
Received:   0
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
        - status [ref=e12]: "32"
      - button "开启选取" [ref=e13] [cursor=pointer]
  - button "刷新状态" [ref=e15] [cursor=pointer]
  - generic [ref=e16]:
    - region "作品预览" [ref=e17]:
      - generic [ref=e18]:
        - generic [ref=e19]: 作品 / 木间香薰
        - generic [ref=e20]: 浏览模式 · 60%
      - generic [ref=e21]:
        - generic [ref=e22]:
          - text: 作品版本
          - code [ref=e23]: 307cdf0f4d
        - button "回退上一次采用" [ref=e24] [cursor=pointer]
      - iframe [ref=e26]:
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
    - complementary [ref=e27]:
      - generic [ref=e28]:
        - generic [ref=e29]:
          - heading "3D 场景编辑" [level=2] [ref=e30]
          - button "关闭" [ref=e31] [cursor=pointer]
        - paragraph [ref=e32]:
          - text: 预览滚动位置
          - status [ref=e33]: "0.601"
        - group "调整场景" [ref=e38]:
          - generic [ref=e40]:
            - text: 工具
            - combobox "工具" [disabled] [ref=e41]:
              - option "相机轨道" [disabled] [selected]
              - option "旋转模型" [disabled]
              - option "主光方向手柄" [disabled]
          - paragraph [ref=e42]: 拖动视口调相机；选择旋转显示旋转环；主光工具可拖动黄色球面手柄。
          - generic [ref=e43]:
            - text: 模型 Y 旋转
            - slider "模型 Y 旋转" [disabled] [ref=e44]: "0.998407346410207"
          - generic [ref=e45]:
            - text: 主光强度 3.00
            - slider "主光强度 3.00" [disabled] [ref=e46]: "3"
          - generic [ref=e47]:
            - text: 色温 4000 K
            - 'slider "色温 4000 K #ffd9a8" [disabled] [ref=e48]': "4000"
            - text: "#ffd9a8"
          - generic [ref=e49]:
            - text: 环境光 1.20
            - slider "环境光 1.20" [disabled] [ref=e50]: "1.2"
          - generic [ref=e51]:
            - text: 开盖 0.120
            - slider "开盖 0.120" [disabled] [ref=e52]: "0.12"
          - button "设为首屏" [disabled] [ref=e53]
          - button "记为此处关键帧" [disabled] [ref=e54]
        - button "撤回上一次写入" [ref=e55] [cursor=pointer]
        - group "采用模型" [ref=e56]:
          - combobox [ref=e58]:
            - option "选择已处理模型" [selected]
            - option "lux3d-8400001"
          - generic [ref=e59]:
            - checkbox "允许采用超过网页门槛的模型" [ref=e60]
            - text: 允许采用超过网页门槛的模型
          - button "采用此模型到作品" [disabled] [ref=e61]
        - group "与作品画面对照" [ref=e62]:
          - button "读取作品配置" [ref=e64] [cursor=pointer]
          - generic [ref=e65]:
            - text: 画布边长
            - spinbutton "画布边长" [ref=e66]: "378.6875"
          - button "匹配作品画布尺寸" [ref=e67] [cursor=pointer]
          - generic [ref=e68]:
            - checkbox "对照模式（已保存配置、当前滚动位置、隐藏手柄）" [checked] [active] [ref=e69]
            - text: 对照模式（已保存配置、当前滚动位置、隐藏手柄）
        - heading "最近写入的参数变化" [level=3] [ref=e70]
        - generic [ref=e71]: 尚无写入
        - group [ref=e72]:
          - generic "当前视口配置" [ref=e73]
      - region "修改请示" [ref=e74]:
        - heading "修改请示 · 待处理 0" [level=2] [ref=e75]
        - group [ref=e76]:
          - generic "历史请示（0）" [ref=e77] [cursor=pointer]
```

# Test source

```ts
  12  | import { compareAligned, silhouette } from '../m1a/visual';
  13  | import { writeArtifactFrom } from './artifact';
  14  | 
  15  | const requireFromServer = createRequire(path.join(SERVER_DIR, 'package.json'));
  16  | const BASE_CONFIG = JSON.parse(readFileSync(SCENE_CONFIG, 'utf8'));
  17  | 
  18  | /** 冻结旋转、只保留开盖轨道的临时配置（模型可替换）。 */
  19  | function frozenConfig(model: string, lidAt06 = 0.12): string {
  20  |   const rotation = [0, 1.0, 0];
  21  |   return JSON.stringify({
  22  |     ...BASE_CONFIG,
  23  |     model,
  24  |     hero: { ...BASE_CONFIG.hero, model: { rotation, scale: 1 } },
  25  |     scroll: [
  26  |       { at: 0, model: { rotation }, parts: { lid: { offset: [0, 0, 0] } } },
  27  |       { at: 0.6, model: { rotation }, parts: { lid: { offset: [0, lidAt06, 0] } } },
  28  |     ],
  29  |   }, null, 2);
  30  | }
  31  | 
  32  | async function gltfIo() {
  33  |   const { NodeIO } = requireFromServer('@gltf-transform/core');
  34  |   const { ALL_EXTENSIONS } = requireFromServer('@gltf-transform/extensions');
  35  |   const { MeshoptDecoder } = requireFromServer('meshoptimizer');
  36  |   await MeshoptDecoder.ready;
  37  |   return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  38  | }
  39  | 
  40  | test.describe('审查整改项', () => {
  41  |   test('R2：识别失败但源模型自带 lid/spatialPart 的 GLB，处理后不再被开盖轨道移动', async ({ page }) => {
  42  |     snapshotSceneFile();
  43  |     const fakeSource = path.join(M1B_DATA, 'fake-lid.glb');
  44  |     const fakeHosted = path.join(TEMPLATE_ASSETS, 'test-fakelid.glb');
  45  |     let sandbox: ReturnType<typeof createSandbox> | null = null;
  46  |     try {
  47  |       // 1) 造一个“识别失败但带 lid 标记”的模型：单 mesh 改名 lid 并打上 spatialPart
  48  |       const io = await gltfIo();
  49  |       const document = await io.readBinary(new Uint8Array(readFileSync(SINGLE_GLB)));
  50  |       const node = document.getRoot().listNodes()[0];
  51  |       node.setName('lid');
  52  |       node.setExtras({ ...(node.getExtras() as Record<string, unknown>), spatialPart: 'lid' });
  53  |       await io.write(fakeSource, document);
  54  | 
  55  |       // 2) 过管线处理（识别应当失败，且源模型自带的标记要被清掉）
  56  |       sandbox = createSandbox('r2-lid', await freePort());
  57  |       const processed = await processLocal({ input: fakeSource, id: 'fake-lid', assetsDir: sandbox.assetsDir });
  58  |       expect(processed.ok, processed.output).toBe(true);
  59  |       const index = JSON.parse(readFileSync(path.join(sandbox.assetsDir, 'index.json'), 'utf8')) as any[];
  60  |       const entry = index.find((item) => item.id === 'fake-lid');
  61  |       expect(entry?.metrics?.parts?.recognized, '单 mesh 模型不该被识别出部件').toBe(false);
  62  | 
  63  |       const outputModel = path.join(sandbox.assetsDir, 'fake-lid', 'model.glb');
  64  |       const output = await io.readBinary(new Uint8Array(readFileSync(outputModel)));
  65  |       const marked = output.getRoot().listNodes()
  66  |         .filter((item) => (item.getExtras() as Record<string, unknown>).spatialPart !== undefined)
  67  |         .map((item) => item.getName());
  68  |       expect(marked, `识别失败时源模型自带的 spatialPart 没被清除：${JSON.stringify(marked)}`).toEqual([]);
  69  | 
  70  |       // 3) 放进作品目录（临时），冻结旋转，只留开盖轨道
  71  |       copyFileSync(outputModel, fakeHosted);
  72  |       writeFileSync(SCENE_CONFIG, frozenConfig('/assets/test-fakelid.glb'), 'utf8');
  73  | 
  74  |       const { frame } = await openEditor(page);
  75  |       await enableCompare(page);
  76  |       await scrollPreview(page, frame, 0);
  77  |       await page.waitForTimeout(600);
  78  |       const fakeAt0 = await captureStudioCanvas(page);
  79  |       await scrollPreview(page, frame, 0.6);
  80  |       await page.waitForTimeout(800);
  81  |       const fakeAt6 = await captureStudioCanvas(page);
  82  |       const fakeShape0 = await silhouette(fakeAt0.png);
  83  |       const fakeShape6 = await silhouette(fakeAt6.png);
  84  |       const shiftFake = fakeShape0.bbox.minY - fakeShape6.bbox.minY;
  85  |       const changedFake = await compareAligned(fakeAt0.png, fakeAt6.png, 3);
  86  | 
  87  |       // 4) 出厂模型 + 同一份临时配置：应当正常开盖
  88  |       writeFileSync(SCENE_CONFIG, frozenConfig('/assets/diffuser-4969889.glb'), 'utf8');
  89  |       await enableCompare(page);
  90  |       await page.waitForFunction(
  91  |         () => document.querySelector('[data-testid="scene-viewport"]')?.getAttribute('data-loaded') === 'true',
  92  |         undefined,
  93  |         { timeout: 60_000 },
  94  |       );
  95  |       await scrollPreview(page, frame, 0);
  96  |       await page.waitForTimeout(800);
  97  |       const goodAt0 = await captureStudioCanvas(page);
  98  |       await scrollPreview(page, frame, 0.6);
  99  |       await page.waitForTimeout(800);
  100 |       const goodAt6 = await captureStudioCanvas(page);
  101 |       const goodShape0 = await silhouette(goodAt0.png);
  102 |       const goodShape6 = await silhouette(goodAt6.png);
  103 |       const shiftGood = goodShape0.bbox.minY - goodShape6.bbox.minY;
  104 |       const expectedGood = 0.12 * goodShape0.heightPx;
  105 | 
  106 |       writeArtifactFrom('fix-r2-lid-gating.json', {
  107 |         fake: { recognized: entry?.metrics?.parts?.recognized, markedNodes: marked, shiftPx: shiftFake, changed: changedFake.changedRatio, heightPx: fakeShape0.heightPx },
  108 |         factory: { shiftPx: shiftGood, expectedPx: expectedGood, heightPx: goodShape0.heightPx, ratio: shiftGood / expectedGood },
  109 |       });
  110 | 
  111 |       expect(Math.abs(shiftFake), `识别失败时 lid 节点仍被移动了（位移 ${shiftFake}px）`).toBeLessThanOrEqual(2);
> 112 |       expect(shiftGood, `出厂模型没有正常开盖（位移 ${shiftGood}px，期望约 ${expectedGood.toFixed(0)}px）`).toBeGreaterThan(expectedGood * 0.5);
      |                                                                                           ^ Error: 出厂模型没有正常开盖（位移 0px，期望约 45px）
  113 |     } finally {
  114 |       restoreSceneFile();
  115 |       sandbox?.cleanup();
  116 |       rmSync(fakeHosted, { force: true });
  117 |       rmSync(fakeSource, { force: true });
  118 |       expect(existsSync(fakeHosted)).toBe(false);
  119 |     }
  120 |   });
  121 | 
  122 |   test('R3：第二个后端实例被资产目录锁拒绝，第一个不受影响；强杀后锁能接管', async () => {
  123 |     const sandbox = createSandbox('r3-lock', await freePort());
  124 |     const processed = await processLocal({ input: SINGLE_GLB, id: 'lock-model', assetsDir: sandbox.assetsDir });
  125 |     expect(processed.ok, processed.output).toBe(true);
  126 | 
  127 |     const first = await sandbox.start();
  128 |     let third: Awaited<ReturnType<typeof sandbox.start>> | null = null;
  129 |     try {
  130 |       const indexFile = path.join(sandbox.assetsDir, 'index.json');
  131 |       const indexHash = sceneFileHash(indexFile);
  132 |       const secondPort = await freePort();
  133 |       const second = await new Promise<{ code: number | null; output: string }>((resolve) => {
  134 |         const child = spawn(process.execPath, [BACKEND_LAUNCHER], {
  135 |           cwd: SERVER_DIR,
  136 |           env: {
  137 |             ...process.env,
  138 |             PORT: String(secondPort),
  139 |             WORK_ROOT: sandbox.workRoot,
  140 |             SCENE_HISTORY_DIR: sandbox.historyDir,
  141 |             ASSETS_DIR: sandbox.assetsDir,
  142 |           },
  143 |           stdio: ['ignore', 'pipe', 'pipe'],
  144 |           windowsHide: true,
  145 |         });
  146 |         let output = '';
  147 |         child.stdout.on('data', (chunk) => { output += String(chunk); });
  148 |         child.stderr.on('data', (chunk) => { output += String(chunk); });
  149 |         child.once('exit', (code) => resolve({ code, output }));
  150 |         setTimeout(() => { child.kill('SIGKILL'); }, 60_000);
  151 |       });
  152 | 
  153 |       expect(second.code, `第二个实例没有失败退出：${second.output}`).not.toBe(0);
  154 |       expect(second.output).toContain('INSTANCE_LOCKED');
  155 |       // 第一个实例的数据没被碰
  156 |       expect(sceneFileHash(indexFile), '第二个实例改动了索引').toBe(indexHash);
  157 |       expect(existsSync(path.join(sandbox.assetsDir, 'lock-model', 'model.glb'))).toBe(true);
  158 |       expect((await getScene(first.base)).status).toBe(200);
  159 | 
  160 |       // 强杀第一个：锁文件残留，下一个实例应能接管
  161 |       await first.stop();
  162 |       await new Promise((resolve) => setTimeout(resolve, 600));
  163 |       const lockLeft = existsSync(path.join(sandbox.assetsDir, '.instance.lock'));
  164 |       third = await sandbox.start();
  165 |       const takeover = (await getScene(third.base)).status;
  166 | 
  167 |       writeArtifactFrom('fix-r3-instance-lock.json', {
  168 |         secondExit: { code: second.code, hasLockedMessage: second.output.includes('INSTANCE_LOCKED') },
  169 |         indexUnchanged: true,
  170 |         artifactIntact: true,
  171 |         lockFileLeft: lockLeft,
  172 |         takeoverStatus: takeover,
  173 |       });
  174 |       expect(takeover).toBe(200);
  175 |     } finally {
  176 |       await third?.stop();
  177 |       await first.stop().catch(() => {});
  178 |       sandbox.cleanup();
  179 |     }
  180 |   });
  181 | 
  182 |   test('B1：非本机 Host/Origin 被 403 HOST_DENIED，经 Studio 代理的正常请求不受影响', async () => {
  183 |     const evil = await rawRequest({ host: 'evil.example:3001', pathname: '/assets', origin: 'http://evil.example:3001' });
  184 |     expect(evil.status, `evil Host 没被拒：${evil.text}`).toBe(403);
  185 |     expect(evil.text).toContain('HOST_DENIED');
  186 | 
  187 |     const evilOriginOnly = await rawRequest({ host: '127.0.0.1:3001', pathname: '/assets', origin: 'http://evil.example:3001' });
  188 |     expect(evilOriginOnly.status).toBe(403);
  189 | 
  190 |     const loopback = await rawRequest({ host: '127.0.0.1:3001', pathname: '/assets' });
  191 |     expect(loopback.status).toBe(200);
  192 | 
  193 |     // 经 Studio 的 Vite 代理（Host 为 127.0.0.1:5173，仍是 loopback）
  194 |     const viaProxy = await rawRequest({ host: '127.0.0.1:5173', pathname: '/assets', port: 5173 });
  195 |     expect(viaProxy.status).toBe(200);
  196 | 
  197 |     writeArtifactFrom('fix-b1-host.json', {
  198 |       evil: { status: evil.status, body: evil.text.slice(0, 120) },
  199 |       evilOriginOnly: evilOriginOnly.status,
  200 |       loopback: loopback.status,
  201 |       viaProxy: viaProxy.status,
  202 |     });
  203 |   });
  204 | 
  205 |   test('S1：从 +π 附近调到 −π 附近记关键帧，写入的是展开后的短弧角度', async ({ page }) => {
  206 |     snapshotSceneFile();
  207 |     try {
  208 |       const { frame } = await openEditor(page);
  209 |       const reference = readSceneFile().hero.model.rotation[1];
  210 |       const at = await scrollPreview(page, frame, 0.5);
  211 |       await setSlider(page, 'scene-rotation-y', -3.1);
  212 |       await page.getByTestId('scene-save-keyframe').click();
```