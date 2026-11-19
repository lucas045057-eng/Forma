# 空间化 AI 创作工作台 · M0-A / M0-B

React + TypeScript strict + Vite 的同源预览与源码点选验证。环境：Node 24、pnpm 11（packageManager 固定 11.17.0）。

本机使用 Forma 工作台可运行 `pnpm forma`。启动、重开作品和第一轮试用步骤见[空间画布试用指南](docs/demo/studio-pilot.md)。

## 运行

在仓库根目录执行：

```sh
pnpm install
pnpm dev
```

| 服务 | 地址 / 端口 | 用途 |
| --- | --- | --- |
| Studio | http://127.0.0.1:5173 | 工作台入口 |
| 模板 Vite | http://127.0.0.1:5174/preview/main/ | 模板开发服务 |
| 同源预览 | http://127.0.0.1:5173/preview/main/ | Studio iframe 使用的代理地址 |
| Server | http://127.0.0.1:3001/health | Fastify 健康检查 |
| WebSocket | ws://127.0.0.1:3001/events | ready、asset.progress、asset.ready；Studio 同源代理 /events |

`pnpm dev` 同时启动三个服务；Ctrl+C 结束。端口固定且启用 strictPort，端口占用时请先结束占用服务。模板 HMR WebSocket 通过 `/preview/main/hmr` 代理到同源 5173。Studio 收到 ready 后同步选取状态。

打开 Studio，点击“开启选取”，再点预览里的“立即购买”。右侧应显示 `src/components/Button.tsx:5:5`、`cid: Button`、`instances: 3`；三个共享按钮均绘制青色框。退出选取后按钮恢复原行为。底部状态为演示反馈，不发起付款或外部请求。

## 验证命令

```sh
pnpm typecheck
pnpm build
pnpm test
```

`pnpm build` 构建各包及页面至各自 `dist/`；`pnpm test` 运行源码插件与资产后端的 Vitest 测试，以及 packages/bridge 的 Node test 浏览器探针（复用已有 Playwright，Windows 优先使用本机 Chrome，其余环境使用已安装的 Chromium）。bridge 探针使用独立临时端口，不启动项目 dev 服务。正式 Playwright 浏览器验收由 Pi 负责，已有 M0-B 用例可通过 `pnpm test:e2e` 执行。

pnpm 11 需要显式批准依赖构建脚本；workspace 仅允许 esbuild、sharp 的必要安装脚本。依赖锁定在 `pnpm-lock.yaml`。

## 仓库结构

- `apps/studio`：工作台、选取开关、Selection JSON、Vite 代理。
- `apps/server`：Fastify + WebSocket 资产服务，Lux3D 客户端、幂等任务、GLB 优化与 mock 服务。
- `packages/shared`：Selection、Task、Candidate、Check、ApprovalCard 与桥接联合类型、消息校验。
- `packages/vite-plugin-source-tag`：开发模式 JSX 源码注入及单元测试。
- `packages/bridge`：作品页选取、悬停、多实例高亮和消息桥接。
- `templates/product-page`：温暖风格香薰商品页，三处共享 Button、map 卖点列表。

## 源码与桥接约定

- 插件仅在 Vite `serve` 模式启用，位于 React 转换之前；生产构建不注入标记，也不安装 bridge。
- `data-src` 是相对 **模板 Vite root** 的路径，统一 `/` 分隔，加上 `:行:列`。模板 root 为 `templates/product-page`，不是 monorepo 根。
- 行、列均从 **1** 开始，指向原始源文件 JSX 开标签的 `<`。列使用 Babel/JavaScript 的 UTF-16 code unit 计数，制表符占一列；CRLF 不影响行号。不会按格式化后的代码定位。
- 仅小写原生 JSX 标签（含自定义小写标签）注入；大写组件、成员组件、Fragment 不注入。`data-src` / `data-cid` 为保留属性，最终标记排在展开属性之后。
- `data-cid` 取最近的大写命名函数、类组件或绑定组件函数/类的大写变量，支持 `memo` / `forwardRef` 及 `React.memo` / `React.forwardRef` 的嵌套包装。保存 JSX 值的变量（如 `const Heading=<h1/>`）不算组件；匿名 default export 等无法推断名字时为 `Anonymous`。
- 移除原生元素已有 `data-src` / `data-cid` 时，跳过已删除属性的整个 JSX 子树；保留其他属性、组件元素属性和正常子元素的源码标记。
- 消息格式是 `{ type, payload? }`。双方严格验证 `origin`、`source` 和消息形状；发送使用精确 origin，禁用 `*`。
- 选取模式在 window capture 阶段拦截 `pointerdown` / `pointerup` / `mousedown` / `mouseup` / `click` / `auxclick` / `dblclick` / `contextmenu` / `submit`，阻止默认行为与后续传播。
- **选取上报时机仍为 `click`（兼容既有 `auxclick`）**；按下、抬起及其他激活事件只阻止业务副作用，不上报，避免一次操作重复选取。Chromium 实测取消 pointerdown 后仍有 click，物理点击可正常选取。
- 可激活元素、表单及其后代中的 Enter/Space，在 keydown/keypress/keyup 阶段均拦截；普通页面文字上的空格滚动不受影响。pointermove/mousemove/wheel/scroll 保留，用于悬停与滚动。
- 退出选取立即恢复事件行为，下一帧清除高亮；安装期只有一套待命监听器和空覆盖层，不随开关重复添加。dispose/HMR 清理全部监听器、observer、待执行帧及覆盖层。
- Selection 的 `bbox` 为 iframe 视口内 `[x, y, width, height]`（CSS 像素）；`styles` 为关键计算样式；`ancestors` 检查直接向上的三个 DOM 层级，只收集有标记的 src。
- 同 src 全部实例计入 `instances`；列表与共享组件统一提示影响范围，不猜测循环语义。点击无标记的子元素会归属最近标记祖先，并带 `note: "outer-container"`；完全找不到标记时发 error。
- bridge 上报的 `PickSelection` 不含 `baseVersion`，Studio 加上启动配置时的 Git HEAD。M0 不实现候选版本管理或脏工作区版本校验，提交变化后需重启 Studio 刷新该版本号。
- 高亮使用独立、不可点击的覆盖层，不修改作品元素样式；停止选取时清除，滚动、尺寸变化和 DOM 更新时重绘。MutationObserver 忽略覆盖层及其后代的记录，无 `#root` 时观察 body 也不会自触发持续重绘。

## 测试访问点与边界

Studio：`pick-toggle`、`preview-frame`、`preview-status`、`selection-json`、`instances`。

模板：`buy-button`、`save-button`、`gift-button`、`benefits`、`benefit-item`、`action-status`（`data-purchases` 记录真实按钮点击次数）。高亮层使用 `data-bridge-overlay` / `data-highlight-src`。

M0 只支持本项目同源模板。生产静态部署、后端网页预览代理、候选版本持久化、候选任务执行均未实现。此阶段 build 验证编译产物，不提供生产环境下的源码选取服务。Shadow DOM、跨域内嵌页面和任意第三方脚本不在本任务范围；bridge 安装前已注册的 window capture 业务监听器不保证被阻止，应继续在模板业务挂载前安装 bridge。

实现说明见 `docs/reports/M0-B-impl.md`、`docs/reports/M0-A-impl.md`。

## M0-A：Lux3D 与模型预览

后端通过 Node 24 的 `--env-file-if-exists=.env` 读取 `apps/server/.env`。参考 `.env.example` 配置 `LUX3D_API_KEY` 和 `LUX3D_BASE`；外部环境变量优先于 .env。默认国内地址 `https://api.aholo3d.cn`，鉴权由后端直接写入 Authorization，不加 Bearer。不要把 key 放进 Vite 环境变量或请求 JSON。LUX3D_BASE 仅允许 HTTPS，HTTP 只对显式的 localhost / 127.0.0.1 / [::1] mock 配置放行；不安全配置会在启动时拒绝，不发送密钥。

启动 `pnpm dev` 后，点工作台顶部“3D 资产”，选择已处理模型即可拖动旋转、滚轮缩放、右键平移。也可输入已有任务编号导入；该操作不会重新创建付费任务。新生成由后端 API 提供，M0 不提供生成或 part-split 表单。

本机已处理并登记 Turbo/G1 两份备用模型。全新检出且没有 `.data` 时，先导入已有远端任务，或在**后端未启动时**运行离线导入（输入路径相对于仓库根）：

```sh
pnpm --filter @spatial/server process-model fallback/lux3d-4969293.glb offline-turbo
pnpm --filter @spatial/server process-model fallback/lux3d-4969298.glb offline-g1
```

原始备用 GLB 需在本地存在。离线命令会复制 raw.glb、优化并登记 index.json；已成功的同名资产不覆盖，需要新 id。失败的本地导入允许用原 id 重试。

| 方法 | 路径 | 参数 / 行为 |
| --- | --- | --- |
| POST | `/assets/lux3d` | `{prompt 或 img, version: "G1" 或 "G1-Turbo", idempotencyKey}`；prompt/img 二选一 |
| POST | `/assets/lux3d/import` | `{taskId}`；已有任务的首次导入或失败后重新查询 |
| GET | `/assets` | 资产列表，供视口选择 |
| GET | `/assets/:id` | 状态、错误、处理数据和 modelUrl |
| GET | `/assets/:id/model.glb` | 仅提供 ready 的处理结果；不开放任意文件路径 |
| WS | `/events` | `{type, ts, sequence, asset}`；type 为 asset.progress / asset.ready |

Studio 的 `/assets`、`/events` 均同源代理到 3001。任务接口返回本地资产 `id` 与远端 `taskId`，后续查询使用返回的 `id`。外部生成/查询失败会返回清晰的状态错误；403/404 下载返回 `OUTPUT_URL_EXPIRED`，可重新导入以再次查询最新 URL。原任务仍失败时，由用户决定新幂等键生成，不自动重复扣费。

持久化使用 `.data/assets/index.json`，下载文件在 `.data/assets/<taskId>/raw.glb`，优化结果为 `model.glb`。本地导入目录使用本地 id。M0 仅运行一个后端进程，JSON 串行写入、原子替换；不要让离线 CLI 与后端并发写同一目录。`ASSETS_DIR` 可隔离测试数据（相对路径相对于 apps/server）。模型、原始下载和索引均使用 UUID 唯一临时名与排他创建，失败清理本次临时文件；遗留旧 `.tmp` 不阻断重试，也不会自动删除其他操作的残留。

ready 资产若模型文件缺失，重新导入会以原 taskId 再次查询/下载/处理，不创建付费任务。启动时也会检测缺失文件并提示修复。每次成功发布更新 modelUrl 的 revision，前端按 URL 重置错误边界和加载状态，绕开失败缓存。

生成默认每 15 秒查状态，最多 15 分钟；0/1 等待、3 下载处理、4 失败、6 取消。重启恢复已有远端任务；提交确认丢失保留 submit_unknown，需先查远端任务列表后导入，不重发创建。`idempotencyKey` 重复返回旧记录，同键不同参数返回 409。

模型处理采用焊接、误差受限简化、1024 WebP 纹理、Meshopt 压缩，最后按世界包围盒归一化（最大边 1，底面中心原点）。Three.js 的 Meshopt 解码器随前端打包，不访问外部 CDN。下载不携带 API key；限制公网 HTTPS，允许配置的本地 mock，DNS 地址固定、防止内网重定向；下载上限 100 MiB。默认下载总时限为 120 秒，使用 `ASSET_DOWNLOAD_TIMEOUT_MS` 或 createApp 的 `downloadTimeoutMs` 配置，覆盖 DNS 等待、连接、全部重定向与响应体读取；重定向不重置预算。app.close / SIGTERM 通过停止信号中断查询、轮询等待和下载，把已知 taskId 保留为可恢复 polling 状态，重启后重新查询原任务。GLB 外部 buffer/image URI 被拒绝。

### Mock 服务（给 Pi）

以下是 Git Bash 命令。在第一个终端启动不使用任何真实 key 的 mock：

```sh
pnpm --filter @spatial/server mock
```

第二个终端从仓库根启动应用，覆盖真实配置并隔离索引：

```sh
LUX3D_BASE=http://127.0.0.1:4010 LUX3D_API_KEY=mock-only ASSETS_DIR=../../.data/mock-assets pnpm dev
```

在 Studio 导入任意数字任务编号；mock 依次返回 0、1、3（默认约两轮轮询），输出内置三角形 GLB。若需要香薰瓶，启动 mock 时设 `MOCK_GLB` 为本地原始 GLB 的绝对路径。默认端口 4010，可用 `MOCK_PORT` 改；`MOCK_SCENARIO` 支持 `success`、`failed`、`cancelled`、`expired403`、`expired404`、`timeout`、`unknown`、`response-lost`（接受创建后断开响应）、`truncated`（截断 GLB）、`drip`（持续滴流）。mock 严格验证 Authorization，默认仅接受 `mock-only`（不加 Bearer），工厂可用 `key` 指定专用假值；创建请求检查 version、prompt/img 路由互斥、outputFormat 为 `["glb"]`。`GET /__stats` 返回 creates/gets 计数，可验证同幂等键只创建一次。更换场景请使用新的 ASSETS_DIR，避免复用已完成记录。

自动化可导入 `createMockServer()` 与 `createApp()`，使用随机端口、临时 dataDirectory 和毫秒级 `pollMs` / `timeoutMs`；见 `apps/server/src/app.test.ts`、`assets/service.test.ts`。不需要启动真实 Lux3D，也不消耗额度。

3D 稳定测试入口：`asset-open`、`asset-close`、`asset-select`、`asset-task-id`、`asset-import`、`asset-status`、`model-viewport`；模型加载后 `model-viewport` 的 `data-loaded="true"`。WebSocket 不保存事件历史，界面会定期 GET 列表恢复状态。
