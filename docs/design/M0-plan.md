# M0 技术验证 · 设计与任务拆分

依据：`docs/dev-doc-v0.1.md`（开发文档 v0.1）。M0 过关条件：**点选能定位到源码行**；**Lux3D 输出可加载**。M0 不过关不进入 M1。

## 分工流水线

设计/调度（Claude Code）→ 实现（CodeBuddy）→ 测试（Pi）→ 审查（Codex）→ 调度合并结论、更新项目记忆。
每张任务卡的验收以 Pi 的测试报告 + Codex 的审查意见为准；两者都通过才算过关。

## 仓库结构（pnpm workspace monorepo，仓库根 = 工作区根）

```
apps/
  studio/        工作台前端：React + TS + Vite（M0 只做 iframe + 选取模式 + Selection 面板）
  server/        后端：Node + Fastify + WebSocket（M0 只需能起；M2 起真正用）
packages/
  shared/        共享类型与协议：Selection / Task / Candidate / Check / ApprovalCard、postMessage 消息类型
  vite-plugin-source-tag/   开发模式下给原生 JSX 元素注入 data-src / data-cid 的 Vite 插件
  bridge/        作品页内的 bridge.ts：悬停高亮、点选拦截、上报 pick:result
templates/
  product-page/  作品模板：React + Vite 单页，使用上面的插件与 bridge（M1 再加 3D 组件）
docs/            文档；docs/design/ 放设计，docs/reports/ 放测试与审查报告
.data/           运行时数据（作品 git 仓库、worktree、SQLite），不入库
```

约定：TypeScript strict；Node 24；包管理 pnpm；测试 Playwright（Pi 负责）；所有 API key 只在 `apps/server` 环境变量。

## 任务卡

### M0-B 点选 → 源码定位（无外部依赖，先做）
- **CodeBuddy 实现**
  1. 建 monorepo 骨架、`.gitignore`（忽略 node_modules、.data、orbital/sessions、orbital/ledger、orbital/tool-results、orbital/sub_agents/*/*.jsonl）、`git init` 并首次提交。
  2. `packages/shared`：按开发文档 §“候选版本、任务与请示卡数据模型”定义类型；定义 bridge 消息联合类型（pick:start / pick:stop / highlight / pick:result / scroll:progress / ready / error）。
  3. `packages/vite-plugin-source-tag`：仅 `serve` 模式启用；对每个**原生** JSX 元素（小写标签）注入 `data-src="相对项目根的路径:行:列"`、`data-cid="最近的组件名"`；不改组件元素（大写）；行列取 JSX 开标签在源文件中的位置（1 基行、1 基列，需在文档中写明）。
  4. `packages/bridge`：选取模式下拦截点击（capture 阶段 preventDefault + stopPropagation），向上找最近带 data-src 的元素；上报 Selection（不含 baseVersion）：src、cid、text、bbox、关键计算样式、同 src 实例数、向上 3 层祖先 src；未命中标记时归到外层并带 `note: "outer-container"`；列表项带 `instances`。支持 highlight 高亮所有同 src 实例。
  5. `templates/product-page`：一个“温暖风格香薰商品页”静态初版（标题、商品图占位、卖点列表 map 生成、立即购买按钮、共享 Button 组件被至少 3 处使用）。
  6. `apps/studio`：同源 iframe 加载模板 dev server（经 Vite proxy 到同源路径 `/preview/main/`），一个“选取”开关，右侧显示收到的 Selection JSON，并高亮同源实例。
  7. 根 `package.json` 脚本：`pnpm dev`（同时起模板与 studio）、`pnpm build`、`pnpm typecheck`。写 `README.md` 的运行方法。
- **Pi 测试**：Playwright 用例——遍历模板页所有带 data-src 的元素，随机抽 20 个在 studio 中点选，断言上报的 `文件:行` 处确实是该元素的开标签；断言选取模式下点击不触发原行为；断言共享 Button 的 instances 数正确；断言列表项被标注为多实例。输出 `docs/reports/M0-B-test.md`。
- **Codex 审查**：重点看插件的行列计算正确性、bridge 的事件拦截是否完备、postMessage 的 origin 校验、类型是否与开发文档一致。输出 `docs/reports/M0-B-review.md`。

### M0-A Lux3D 调用跑通（接入已调研，见 docs/research/lux3d-api.md）
- **CodeBuddy 实现**
  1. `apps/server` 资产服务模块 `lux3d`：读取 `LUX3D_API_KEY`、`LUX3D_BASE`（默认 `https://api.aholo3d.cn`）；封装 createTextTo3d / createImgTo3d / getTask / listTasks；提交带幂等键（同一幂等键在本地 SQLite 或 JSON 已有任务则直接返回旧 taskId，不重复提交）；重试前先查状态。
  2. 轮询（15 s 间隔，15 min 上限）→ 成功后**立即**下载 `outputs[].content` 的 GLB 到 `.data/assets/<taskId>/raw.glb`（URL 2 小时过期）。
  3. 处理：gltf-transform 压缩纹理与网格、归一化尺寸（最大边 = 1）与原点（底面中心），输出 `.data/assets/<taskId>/model.glb`。
  4. REST：`POST /assets/lux3d`（{prompt|img, version, idempotencyKey}）、`GET /assets/:id`；WebSocket 推 `asset.progress` / `asset.ready`。
  5. 提供 `POST /assets/lux3d/import`（{taskId}）：导入账号里已完成的任务而不重新生成（**零额度验证用**）。
  6. `apps/studio`：最小 three.js（@react-three/fiber + drei）视口，OrbitControls，可加载任一已处理的 model.glb 并旋转查看。
- **验证顺序**：先用 import 已有任务 4868277 跑通全链路（不花额度）；真实新生成须等用户同意花费后再做。
- **Pi 测试**：import 4868277 → 文件落盘 → 处理后 glb 可被 three.js 加载（Playwright 检查画布非空、无控制台错误）；幂等：同一幂等键提交两次只产生一个任务（用 mock 的 Lux3D 服务验证，不打真实接口）。
- **Codex 审查**：key 不进前端/日志、幂等与重试逻辑、URL 过期处理、路径安全。
- 过关：Lux3D 的 GLB 经处理后能在浏览器里加载并旋转查看；记录体积与耗时。

### M0-B-fix 审查整改（依据 docs/reports/M0-B-review.md，结论“有条件通过”）
- **Pi（先做，只改 tests/）**：R3 —— 增加独立于 data-src 的确定性目标（同文件不同位置、不同文本的同名标签，用模板源码 AST 求出的期望位置断言一一对应）；增加“应标记节点完整性”校验（用 Babel 解析 templates/product-page/src 下全部 tsx，得到所有原生 JSX 开标签位置集合，与运行时 DOM 中出现的 data-src 集合对照：渲染出来的必须都有标记且位置在集合内）；增加两种变异验证（同名标签错标、某类元素漏标）。同时**先写好** R1、R2 的回归用例（预期在 CodeBuddy 修复前失败，用 test.fail 或单独标注），以及 S4 中 bridge 错误 source、畸形 payload 的拒绝测试。
- **CodeBuddy（M0-A 交付后）**：R1 选取模式在 capture 阶段拦截 pointerdown/pointerup/mousedown/mouseup/click/auxclick/dblclick/contextmenu/submit 及键盘激活（Enter/Space），保留 pointermove/scroll；退出后完全恢复。R2 插件删除保留属性时跳过该属性子树内的注入，加 vitest fixture。顺带 S1（observer 忽略覆盖层 mutation）、S3（cid 只认组件函数/类/memo/forwardRef 包装，不认保存 JSX 的变量）。S2 暂缓。
- **S4** 的后端版本/路径校验写进 M2 任务卡，M2 写操作前必须落实。
- **收口**：Pi 跑原 7 项 + 新增回归全部通过 → Codex 复核 R1–R3 → M0-B 最终过关。

### M0-A-fix 审查整改（依据 docs/reports/M0-A-review.md，结论“有条件通过”）
- **CodeBuddy（M0-B-fix 交付后）**：R1 启动/重试时清理遗留 `*.tmp`（或用唯一临时名），不再 EEXIST；R2 下载加总时限并接入服务停止信号（AbortSignal 贯穿下载与轮询）；R3 ready 记录的模型文件缺失时，重新导入要能重新查询/下载/处理并修复记录。S1：mock 校验假 Authorization、version、prompt/img、outputFormat，补“提交后响应丢失”“taskId 写盘失败”“截断 GLB”“重定向到私网”等回归，每个测试隔离数据目录、使用专用假 key。S3：上游 LUX3D_BASE 只有 loopback mock 允许 http，其余强制 https。
- **S2**（持久事件序号与补拉）写进 M2 任务卡；**S4**（部件稳定命名、体积门槛、转换隔离）写进 M1 任务卡。
- **收口**：Pi 跑 M0-A 测试 + 新增回归 → Codex 复核 R1–R3。
- 追加（Pi M0-A 测试观察项）：`POST /assets/lux3d/import {taskId:"1e5"}` 被 Fastify coerceTypes 转成 100000 并接受；M0-A-fix 回合或下一轮里在 handler 内校验原始字符串为纯数字。
- 追加（Codex 复核 M0-B）：**N1 应修**——S3 修法使 `export default memo(function Card(){})`、`(...) as React.FC`、`(...) satisfies React.FC` 的 cid 退化为 Anonymous。修法：判断组件值前剥离 TSAsExpression/TSSatisfiesExpression 等类型包装；无外部绑定时用具名函数表达式名兜底；公开绑定名优先。Pi 先预写回归（it.fails），CodeBuddy 在 M0-A-fix 之后修。修完 Pi 回归、Codex 复核 N1 → M0-B 最终过关。

## M0 收口（2026-11-09）
- **M0 过关**：M0-A（Lux3D 跑通）与 M0-B（点选 → 源码定位）均经 实现 → Pi 测试 → Codex 审查 → 整改 → 回归 → 复核 全流程通过。最终 master 9d50cc4（+ Pi 测试提交 ea6bd49）：单测 91、M0-B e2e 24、M0-A e2e 27 全过，0 预期失败。
- 遗留建议（不阻断，排入后续任务卡）：
  - N4：组件名推断对“对象属性里的组件（ui.Card）”和未知 HOC 的匿名参数只给 Anonymous 或外层名——在插件 README 写明支持范围；需要时再加 ObjectProperty 上下文与 fixture。
  - N5：Studio 资产面板 taskId 输入 pattern 仍是 `[0-9]{1,20}`，应与后端（1–19 位、无前导零）同步。
  - M0-A S2（持久事件序号与补拉）、M0-B S4（后端版本与路径校验）→ M2；M0-B S2（大页面高亮性能）→ 视需要。
