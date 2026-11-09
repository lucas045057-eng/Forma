# 空间化 AI 创作工作台 · M0-B

React + TypeScript strict + Vite 的同源预览与源码点选验证。环境：Node 24、pnpm 11（packageManager 固定 11.17.0）。

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
| WebSocket | ws://127.0.0.1:3001/events | 占位连接，发送 ready 后保持连接 |

`pnpm dev` 同时启动三个服务；Ctrl+C 结束。端口固定且启用 strictPort，端口占用时请先结束占用服务。模板 HMR WebSocket 通过 `/preview/main/hmr` 代理到同源 5173。Studio 收到 ready 后同步选取状态。

打开 Studio，点击“开启选取”，再点预览里的“立即购买”。右侧应显示 `src/components/Button.tsx:5:5`、`cid: Button`、`instances: 3`；三个共享按钮均绘制青色框。退出选取后按钮恢复原行为。底部状态为演示反馈，不发起付款或外部请求。

## 验证命令

```sh
pnpm typecheck
pnpm build
pnpm test
```

`pnpm build` 构建各包及页面至各自 `dist/`；`pnpm test` 仅运行源码插件的 Vitest 单元测试。未编写 Playwright 测试，正式浏览器验收由 Pi 负责。

pnpm 11 需要显式批准依赖构建脚本；workspace 仅允许 esbuild 的必要安装脚本。依赖锁定在 `pnpm-lock.yaml`。

## 仓库结构

- `apps/studio`：工作台、选取开关、Selection JSON、Vite 代理。
- `apps/server`：Fastify + WebSocket 占位服务。
- `packages/shared`：Selection、Task、Candidate、Check、ApprovalCard 与桥接联合类型、消息校验。
- `packages/vite-plugin-source-tag`：开发模式 JSX 源码注入及单元测试。
- `packages/bridge`：作品页选取、悬停、多实例高亮和消息桥接。
- `templates/product-page`：温暖风格香薰商品页，三处共享 Button、map 卖点列表。

## 源码与桥接约定

- 插件仅在 Vite `serve` 模式启用，位于 React 转换之前；生产构建不注入标记，也不安装 bridge。
- `data-src` 是相对 **模板 Vite root** 的路径，统一 `/` 分隔，加上 `:行:列`。模板 root 为 `templates/product-page`，不是 monorepo 根。
- 行、列均从 **1** 开始，指向原始源文件 JSX 开标签的 `<`。列使用 Babel/JavaScript 的 UTF-16 code unit 计数，制表符占一列；CRLF 不影响行号。不会按格式化后的代码定位。
- 仅小写原生 JSX 标签（含自定义小写标签）注入；大写组件、成员组件、Fragment 不注入。`data-src` / `data-cid` 为保留属性，最终标记排在展开属性之后。
- `data-cid` 取最近的大写命名函数、变量或类组件；匿名 default export 等无法推断名字时为 `Anonymous`。
- 消息格式是 `{ type, payload? }`。双方严格验证 `origin`、`source` 和消息形状；发送使用精确 origin，禁用 `*`。
- bridge 在 window capture 阶段拦截 `click` / `auxclick`，先阻止默认行为与后续传播，再查找最近标记。
- Selection 的 `bbox` 为 iframe 视口内 `[x, y, width, height]`（CSS 像素）；`styles` 为关键计算样式；`ancestors` 检查直接向上的三个 DOM 层级，只收集有标记的 src。
- 同 src 全部实例计入 `instances`；列表与共享组件统一提示影响范围，不猜测循环语义。点击无标记的子元素会归属最近标记祖先，并带 `note: "outer-container"`；完全找不到标记时发 error。
- bridge 上报的 `PickSelection` 不含 `baseVersion`，Studio 加上启动配置时的 Git HEAD。M0 不实现候选版本管理或脏工作区版本校验，提交变化后需重启 Studio 刷新该版本号。
- 高亮使用独立、不可点击的覆盖层，不修改作品元素样式；停止选取时清除，滚动、尺寸变化和 DOM 更新时重绘。

## 测试访问点与边界

Studio：`pick-toggle`、`preview-frame`、`preview-status`、`selection-json`、`instances`。

模板：`buy-button`、`save-button`、`gift-button`、`benefits`、`benefit-item`、`action-status`（`data-purchases` 记录真实按钮点击次数）。高亮层使用 `data-bridge-overlay` / `data-highlight-src`。

M0 只支持本项目同源模板。生产静态部署、后端预览代理、版本持久化、Lux3D、候选任务执行均未实现。此阶段 build 验证编译产物，不提供生产环境下的源码选取服务。Shadow DOM、跨域内嵌页面和任意第三方脚本不在本任务范围；点击拦截不覆盖业务自行监听 pointerdown 等先行事件的情形。

实现说明见 `docs/reports/M0-B-impl.md`。
