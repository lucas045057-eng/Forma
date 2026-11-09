# M0-B 审查整改实现说明

日期：2026-11-09。
工作树：`E:/空间化AI工作台/.worktrees/m0b-fix`。
分支：`fix/m0b-review`；基线：`e44bc88`。未合并到 master。

## R1：激活事件拦截

选取模式在 window capture 阶段阻止 pointerdown、pointerup、mousedown、mouseup、click、auxclick、dblclick、contextmenu、submit 的默认行为和后续传播。可激活元素、表单及其后代中的 Enter/Space 在 keydown、keypress、keyup 均拦截；普通页面文字上的空格不拦截。

**选取上报仍在 click（保留既有 auxclick 兼容）**。pointerdown/pointerup 等只阻止业务行为，不产生选取结果，避免一次操作重复上报。真实 Chromium 鼠标操作验证了取消 pointerdown 后仍触发 click，并正确上报一次选取。

pointermove、mousemove、wheel、scroll 不拦截，悬停及滚动继续工作。退出选取后拦截函数立即放行，高亮下一帧清除。安装期保留一套待命监听器与空覆盖层，不随选取开关增加；dispose/HMR 移除全部监听器、observer、动画帧及覆盖层。

## R2：删除属性与 JSX 子树

在原生开标签访问器中先删除保留属性，记录被删除的 JSXAttribute 节点，再插入外层标记。后续访问这些属性时调用 skip，禁止遍历其值子树。

删除必须发生在外层标记插入之前：MagicString 相邻边界的后续删除也可能抹掉已插入内容。最初尝试在父访问器中直接 skip 子路径未能阻止之后的 Babel 子路径访问，新增 fixture 已捕获该问题；最终使用 WeakSet 标记及 JSXAttribute 自身访问器跳过。

新增 fixture 覆盖 `<div data-src={<span/>}/>`、`<div data-cid={<b/>}>content</div>`，断言只有外层标记、源码位置指向原始 `<div`、已删除嵌套标签不存在。原有 spread、CRLF、Unicode、行列测试仍通过。组件标签自身的属性不会被删除。

## S1：覆盖层自触发

MutationObserver 检查 mutation.target：若一批记录全部来自覆盖层自身或后代，则不安排重绘。作品区与覆盖层混合变更仍正常触发一次绘制。

packages/bridge 的浏览器探针在没有 #root 的页面运行，选取并绘制后等待 12 个真实动画帧，断言 bridge 的 requestAnimationFrame 调度计数不增加。探针同时确认选取停止后无高亮框、dispose 后无覆盖层及遗留 bridge window 监听器。

## S3：组件归属

组件名查找只接受大写命名函数声明、类声明和绑定组件函数/类的大写变量；支持 memo、forwardRef、React.memo、React.forwardRef 的嵌套包装。不会将保存 JSX 值的大写变量当作组件。

`const Page=()=>{const Heading=<h1/>; return Heading;}` 的 cid 为 Page。另验证嵌套组件、命名函数表达式绑定及 memo/forwardRef 包装。匿名且没有可识别绑定的组件仍使用 Anonymous。

## 验证

在整改工作树执行：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
```

全部通过。测试数量：插件 Vitest 9 项，资产 Vitest 14 项，bridge Node test 浏览器探针 1 项，总计 24 项。

bridge 探针位于 `packages/bridge/src/index.test.mjs`，复用根目录已有 TypeScript 与 Playwright 包。Node test 负责运行，临时 HTTP 服务使用独立随机端口，不启动 dev 服务、不占用 Pi 的固定端口。Windows 优先使用现有 Chrome，其他环境使用 Playwright 已安装的 Chromium；未安装或新增浏览器/依赖。

验证包含真实鼠标点击、输入框 Enter 提交、按钮 Space、链接 Enter 导航，以及各拦截事件的取消状态、移动滚动放行、退出恢复、无 root 空闲帧及 dispose 清理。未运行或修改 Pi 的 tests/e2e；正式原 7 项和 R1–R3 验收由 Pi 在本分支回归。

原有 M0-A 的 Vite 3D chunk 体积提示和 Fastify 弃用提示仍存在，不影响检查通过。

## 变更边界与操作说明

- 无新增或升级依赖；pnpm-lock.yaml 与 pnpm-workspace.yaml 相对基线无变化。
- 根 test 脚本增加 bridge 包的测试入口，bridge 包增加 Node test 脚本；没有新增 devDependencies。
- 未修改 tests/e2e、主工作树实现或设计文档；未合并分支。
- 最初一条冻结安装命令遗漏工作树路径，误在主工作树执行；输出为 Already up to date，253 ms 结束。随后已改用显式 `pnpm -C` / `git -C`，所有源码编辑、提交和交付检查均位于整改工作树。该误操作已在会话中说明。
- S2 大页面索引/覆盖框复用按要求未做；S4 后端版本与路径校验仍留给 M2。
- 不保证阻断 bridge 安装前已注册的 window capture 业务监听器；继续在业务挂载前安装 bridge。Shadow DOM、任意第三方脚本隔离不在本轮范围。

## 提交

- `b199954` 修复保留属性子树标记与组件名称归属
- `c4f86d9` 拦截选取激活事件并阻断覆盖层自身重绘
- README 与本报告随后以中文文档提交收口，提交号见 git log。
