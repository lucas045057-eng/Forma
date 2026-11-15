# M4 统一返工六：Studio 浏览器夹具开发模块启动（未验证）

日期：2026-11-15。仅实现树 `.worktrees/m4` / `feat/m4-demo`，从 `17228617b46acb66f1e1d4999328f755fc084aaf` 开始。全文读取根6bfd58b的 `orbital/coordination/m4/unified-rework-6.md`，未为读文档合主线。

**本批未运行typecheck、build、单测、collect、浏览器、服务、demo、探针或审查，没有创建job、没有安装/升级依赖。只读源码/旧原件与Git静态核对；修改完成不代表24例通过或M4验收。**

## 运行事实与分开的归因

固定交接：`job_49d083b5` 已结束exit1，受测2463dd1，run `2026-11-15T14-34-18-166Z-full`。类型/构建成功，server378/378通过；Studio首次实际执行为118过/24败（142），后续demo脚本与全部193 E2E未执行。

- **组件文件23例**：已只读核对旧 `unit.log` 和逐页component JSON，pageErrors明确为实际pnpm React `jsx-dev-runtime.js`不提供`jsxDEV`命名导出。beforeEach等挂载超时，afterEach再次断言同一pageerror。47段错误不等于47条独立失败，更不能当成23条产品交互合同逐一跑坏。
- **真实App单例单独核对**：旧原文是 `expect(locator).toHaveAttribute(expected) failed`，`getByTestId('events-status')`期待connected，5000ms后element(s) not found，位置原37:101。旧 `real-app-cleanup.json`只记录两个listener已关、Chromium退出0、errors为空；这证明资源收尾记录干净，**没有记录页面启动pageerror，不能证明与组件同一个jsxDEV错误**。共享Vite配置存在相同缺口，因此一并修正，但该单例运行根因仍须新诊断确认。

旧原件只读，仍在Pi树 `docs/reports/artifacts/M4/regression/2026-11-15T14-34-18-166Z-full/`，未改写或挪动。

## 开发依赖图的静态核对与修正

两夹具均自行createServer，禁用configFile/envFile和自动依赖发现；旧include仅react、react-dom/client、react/jsx-runtime。实际开发JSX会请求react/jsx-dev-runtime，而pnpm实际React19.3.1的exports把该subpath指向CommonJS的`jsx-dev-runtime.js`，再分发至cjs开发/生产实现。已只读核对开发实现确实包含`exports.jsxDEV`，不是库没有这个能力；它需要真实的CJS→浏览器ESM预构建。

另核对react-dom19.3.1的exports/client及开发client源码：其内部require scheduler、react和react-dom。预构建以这些真实入口为root遍历内部CJS依赖；不把未直接声明的scheduler硬写成新的顶层包依赖，也不升级锁。

新增仅测试使用的 `src/test-support/speech-browser-fixture.ts`，两夹具共用同一Vite配置：

- `mode:'development'`、`esbuild:{jsx:'automatic',jsxDev:true}`，保持真正的开发JSX路径；不切production绕过、不伪造jsxDEV、不替换React。
- 保留 `configFile:false/envFile:false`、`optimizeDeps.noDiscovery:true`，include完整真实入口：`react`、`react-dom`、`react-dom/client`、`react/jsx-runtime`、`react/jsx-dev-runtime`。内部scheduler等由正常esbuild依赖遍历处理。
- 各夹具原root、独立cacheDir、临时loopback listen(0)、hmr:false、watch:null、cors:false和网络白名单保持。没有改生产Vite配置、组件、依赖版本、package脚本或锁。

这只是源码支持的修正方案，尚无新的预构建产物、模块导入或浏览器成功证据。

## 启动错误与真实ready握手

共用观察器在导航前安装pageerror、crash、script/document requestfailed和HTTP4xx/5xx监听，记录原始message/stack、URL、当前phase、elapsed ms。普通fetch的预期错误/取消不当作模块错误，既有网络白名单断言仍保留。

`run(phase, work)`将原来的导航/就绪Promise与真实页面故障事件竞速：模块启动错误一出现就报告，而不是继续空等整个hook。原始Error保留为cause，诊断序列化也保留cause，locator超时的原始错误不会被新的阶段包装丢掉。未运行或未观察到就绪不会标绿。

- 组件夹具仍以真实DOM `speech-record`挂载，以及原来的按钮可用断言成功作为ready；没有用假全局变量或伪造事件绕过React渲染。
- 真实App仍以原 `events-status[data-status=connected]`断言成功才标ready；原5000ms matcher预算不变，没有新增自动重试/宽限。App与EventCenter仍真实，HTTP/WS/录音/预览页仍明确替身。
- helper的ready只是诊断元数据，不能使测试通过。setup失败依旧从beforeEach/测试主体抛出；afterEach不重复把已报告的同一启动pageerror断言成第二条钩子错误。进入交互的用例仍要求pageErrors为空、无模块资源错误、无越白名单网络请求。
- HTML入口的CSS读取异常交给Vite/Connect next(error)产生真实错误响应，不让异步middleware拒绝失去关联。没有改变HTML加载的测试模块或React组件拓扑。

没有提高beforeAll/afterAll、beforeEach默认或各测试现有预算，没有skip/retry、没有删除“必须真实挂载”要求。

## 两夹具收尾与证据

### speech-browser.test.ts

- 每例重新登记当前context/page/monitor/setupFailure，部分初始化失败不会误用上一例已关闭的page。
- beforeEach保留原始启动故障；afterEach仍采样录音替身指标、截图、存在组件时通过原unmount按钮卸载并断言liveTracks=0。初始化从未完成时不伪造指标0；若本应成功却没有替身状态，仍失败。
- case清理逐项尝试context关闭与pending响应销毁；失败聚合，不盖住setupFailure。逐页JSON保留Vitest已登记的主错误、bootstrap快照、原pageErrors、before/after指标、请求/任务数据和清理错误。
- suite收尾保留原Chromium PID/创建时间后代快照、exit/remaining断言、真实端口关闭验证、Vite与cache清理。没创建browser时不为了空集合发无关CIM查询；实际有browser时验证不删减。
- 证据写入自主创建目录，失败纳入清理错误和stderr；beforeAll失败也有独立setupFailure，不能被afterAll写文件错误覆盖。

### speech-app.browser.test.ts

- 明确记录preview-listen、vite-create/listen、chromium-create、app-bootstrap、interaction阶段；页面就绪前后都保留原始pageErrors和资源请求URL。
- 主体catch先保存primary，finally依次尝试context/browser/BrowserServer/Vite/preview关闭。即使page/browser/Vite尚未创建，也只处理已获得的对象。
- 失败时可截图并写bootstrap快照；cleanup JSON不再只有空errors列表，还保存primary/cause、页面错误、阶段、依赖入口、cache保留状态及退出情况。
- 保留listener和Chromium退出断言，并补主HTTP、预览HTTP、BrowserServer WS的实际端口关闭检查（每个沿原1秒有界socket逻辑）。所有清理与证据写失败聚合，不将close不干净记为通过。

旧beforeEach没有真正进入交互的页面不会被新逻辑记为通过。组件23条业务测试主体一行未改；真实App保留父窗口实际blur增长、跨源来源校验、pending/reconnect review、明确B确认、不自动/tasks、成功语音提交后的新文字等断言。原指针/空格、取消/晚权限、499与新UUID、旧文字revision和task retry断言也都保留。

## 文件与保护范围

修改两个fixture测试；新增一个共用开发配置/启动观察/证据/端口工具；新增本报告。共用helper只在Node测试侧使用，没有被生产App或浏览器harness导入。

未修改生产组件/renderer/后端、录音或识别替身实现、harness中的选择逻辑、生产Vite配置、依赖锁/模板GLB/sidecar、Pi独立E2E/runner/旧阈值、历史证据或旧报告。fallback仍未跟踪、不入库；未触Pi树代码、未merge/push。

本批没有读取真实.env/ASKS/代理或提供商凭据，没有真实阿里/厂商识别/编码/Lux3D调用。阿里云百炼主链不变。读取包文件是静态读取本地已安装依赖，没有执行包导入/构建/浏览器或探针；早期尝试的顶层React路径不存在，随后按原错误中的pnpm实际路径核对，未安装补包。

## 后续与全部未执行边界

交回固定HEAD后由Codex统一安排集中验证，Pi自行完成本轮旧失败归档。新配置是否真正预构建并提供jsxDEV、真实App是否有另一启动错误、23条行为与真实App链路是否通过、清理和证据聚合是否实际生效，全部待实际日志，不预填新通过数。旧47段错误结构不改写。

demo脚本、M4 19和旧174 E2E仍未执行；真实Windows Ctrl+C/生产资产worker全链、真实模板iframe/HMR、真实阿里质量、真人A/B、完整彩排仍按独立证据列未执行/未覆盖。Claude独立复审仍欠报告，server全绿或未来运行成功都不能代替独立审查，M4及项目尚未验收。
