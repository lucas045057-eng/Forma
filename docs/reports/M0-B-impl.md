# M0-B 实现说明

日期：2026-11-09。实现范围：`docs/design/M0-plan.md` 中 CodeBuddy 第 1–7 步。未修改已有 docs/ 或 orbital/ 文件；未调用外部付费服务。

## 已实现

1. pnpm workspace 六个子包、TypeScript strict、忽略规则和根脚本；初始化 Git 并按逻辑步骤分别提交。
2. shared 中包含 Selection / Task / Candidate / Check / ApprovalCard。协议采用 `{ type, payload? }`，覆盖任务卡七类消息；提供消息运行时校验。开发文档未展开的 TaskEvent / FileDiff 使用最小结构，后续任务可扩展。
3. 源码插件仅 `serve` 启用；通过 Babel 读取原始 JSX AST、MagicString 插入属性并生成 source map。仅原生小写标签注入，组件标签不注入。覆盖保留属性并在 spread 后追加；路径相对模板 Vite root，开标签 `<` 的行列均为 1 基，列为 UTF-16 code unit。
4. bridge 在 window capture 阶段拦截 click / auxclick，阻止默认行为及传播；上报文字、bbox、关键计算样式、实例数、三层 DOM 祖先源码。无标记子元素归属最近标记祖先并标注 outer-container。支持悬停、多实例覆盖层、滚动进度、ready/error；双方校验 origin 和 source，使用精确 targetOrigin。
5. 香薰模板包含温暖配色、CSS 商品占位图、三项 map 卖点、三处共享 Button（含立即购买）及可验证的原始点击反馈。
6. Studio 经 `/preview/main/` 代理模板与 HMR，提供选取开关、连接状态、Selection JSON、实例提示和自动高亮。
7. 根 dev/build/typecheck/test 可用；README 记录运行方式、端口、行列和桥接协议、测试访问点、边界。

## 启动

```sh
pnpm install
pnpm dev
```

- Studio：`http://127.0.0.1:5173/`
- 同源 iframe：`http://127.0.0.1:5173/preview/main/`
- 模板服务：5174，base 为 `/preview/main/`
- Fastify：3001，`GET /health`、WebSocket `/events` 为占位

根 dev 同时启动三个服务，Ctrl+C 结束。验证过程中启动的浏览器和开发服务在交付前关闭。

## 已执行验证

- `pnpm install && pnpm typecheck && pnpm build`：全部成功（最终完整执行已通过）。
- `pnpm test`：6 项 Vitest 单元测试全部通过，覆盖 CRLF、Unicode、原始行列、多行标签、map 回调、最近组件、class/memo、spread、保留属性、serve 限制与 root 外排除。
- `git diff --check`：通过。
- HTTP 检查：Studio、同源 iframe、经代理的 Button.tsx、后端 /health 均返回 200；转换后的 Button 包含正确源码标记。
- 本地无界面 Chrome，通过 DevTools 协议执行浏览器内 DOM 点击冒烟（未增加测试依赖或 Playwright 文件）：
  - 开启选取后点击“立即购买”：`src = src/components/Button.tsx:5:5`，`cid = Button`，`instances = 3`。
  - 三个共享按钮均有高亮覆盖框；选取时 `data-purchases` 保持 0，退出选取后点击变为 1。
  - map 列表项：`src = src/App.tsx:42:13`，`instances = 3`。
  - 临时无标记子元素点击归到 Button，返回 `note: outer-container`。
  - bridge 忽略错误 origin 的停止消息；Studio 忽略错误 source 的错误消息。
- 首轮浏览器驱动等待超时；检查页面与控制台后确认页面连接正常，在已加载页面重新执行上述步骤全部通过。该冒烟未替代 Pi 的随机点选及物理鼠标事件测试。

## 给 Pi / Codex 的交接

- 稳定 testid：Studio 的 `pick-toggle`、`preview-frame`、`preview-status`、`selection-json`、`instances`；模板的 `buy-button`、`save-button`、`gift-button`、`benefits`、`benefit-item`、`action-status`。
- 原始点击计数：模板 `action-status` 的 `data-purchases`；可用于判断捕获拦截是否生效。
- 覆盖层：`[data-bridge-overlay]`，内部 `[data-highlight-src]`。
- JSON 包含由 Studio 补充的 baseVersion；核验 src 时相对于 `templates/product-page` 读取源文件。
- 正式 Playwright 随机 20 元素验证、Pi 测试报告及 Codex 审查尚未执行，本报告不宣告里程碑正式验收通过。

## 已知限制

- baseVersion 取 Studio 启动配置时 Git HEAD，尚无脏工作区检测、版本刷新或候选管理；提交后重启 Studio 可更新。
- 标记和 bridge 仅开发模式可用；生产 build 只验证编译，不提供源码选取或生产代理部署。
- 匿名组件名称兜底 Anonymous；instances 反映共享源码实例，不能自动区分列表语义与共享组件。
- ancestors 查看直接上溯三个 DOM 层级，未标记层跳过记录但仍占层级。
- 未覆盖 Shadow DOM、跨域内嵌页面、业务 pointerdown 先行行为、持续动画下逐帧高亮同步。
- Server 仅占位；无 REST 业务任务、持久化、Lux3D、3D 或付费服务接入。
- 原有 AGENTS.md、docs/、orbital/ 及期间出现的其他非任务目录保持原状，不把这些已有内容纳入实现提交。

## 提交

- `81d360e` 初始化工作区骨架与后端占位服务
- `7e822af` 定义共享数据模型与桥接消息协议
- `58cd126` 实现开发模式源码标记插件并验证原始行列
- `a90d245` 实现选取桥接与同源码实例高亮
- `9413fb9` 实现温暖风格香薰模板与共享按钮
- `3d4cfda` 实现工作台同源预览与源码选取面板
- 本报告及 README 随“补充运行说明与实现验证报告”提交（提交号见 git log）。
