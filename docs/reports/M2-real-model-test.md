# M2 真实编码模型固定十题验收 · Pi

- 日期：2026-11-14（Asia/Shanghai）
- 实现基线：`b167907`（已独立审查）；mock 成品回归归档 `b40425c`（运行冻结 `86416ce`）
- 服务与模型：`https://xfastapi.ai/v1` + `gpt-6.1-sol`（用户新提供）；本轮**尚未发送任何付费对话请求**
- 方案：`docs/design/M2-real-model-acceptance.md` 固定十题，顺序/指令/断言不变；10 题串行、无自动重试/补跑，每题最多 16 轮 / 180 秒
- 真实运行冻结 HEAD：本轮测试/launcher/报告提交（`a950407` 之后仅测试与文档；完整 hash 见交回消息与 `run.json` 的 `head`）

## 当前状态：准备与 mock 接线完成，真实十题未开始

- 本轮只改测试/launcher/报告：新增专用 Playwright 配置、隔离 fixture、固定十题 spec、后台顺序入口与网络守卫白名单。
- **mock 接线结果：10/10 通过**（`docs/reports/artifacts/M2-real-model/mock-wiring-20261114/`，loopback mock、假 key，未用真实额度）。这只证明测试接线可用，**不是真实模型成绩，也不能用来预判通过**。
- 真实十题由调度在本轮提交后从后台启动；结果未回前不得写“通过”。

## 凭据与服务隔离

- 真实配置只读根 `apps/server/.env` 的三个字段（`CODING_AGENT_BASE_URL` / `CODING_AGENT_API_KEY` / `CODING_AGENT_MODEL`）；解析在测试 spec 内完成，**只传给后端子进程 env**。不打印值、不写报告/证据/源码/Git，不复制到 worktree `.env`，不读 `LUX3D_API_KEY`。
- mock 模式完全不读 `.env`：使用 `http://127.0.0.1:4011`、假 key、`mock-coder`。
- Studio、模板 Vite、候选预览、浏览器与 Playwright 日志均不带编码凭据；Vite 使用白名单环境变量。
- 出站守卫仍是 `tests/e2e/m0a/no-real-network.cjs`，新增 `PI_NET_GUARD_ALLOW=xfastapi.ai` 白名单：
  - 只允许该域名及其 DNS 解析出的地址；其他 DNS/直连 IP 继续阻断并记录。
  - 短探针：`xfastapi.ai` DNS 放行、`example.com` 返回 `ENETGUARD` 并写入 guard log；默认不设白名单时行为不变。
  - 生产客户端仍 `redirect:'error'`，不会把 Authorization 发往重定向域名；当前用真实实现验收，不因上游而改生产协议。
- Lux3D 固定指向无人监听的 `127.0.0.1:4019`，不产生真实 3D 任务。

## 每题隔离与环境

- 每题新建独立作品副本与数据目录（`docs/reports/artifacts/M2-real-model/<runId>/tasks/<n>/`）：
  - `src/`、`public/` 与根配置逐文件复制（`copyFileSync`，不用 `fs.cpSync` 复制二进制目录）；
  - `node_modules` 按包/按 `@scope` 子项逐个 junction 到真实依赖，**不整目录 junction**；
  - 后端 `WORK_ROOT` 指向副本，版本库/候选/预览缓存都在该题数据目录；主模板与已有历史不写。
- 每题启动独立后端（3001 + 预览源 5175）与模板 Vite（5174）；Studio（5173）由 Playwright webServer 固定启动。实际路径：Studio 点选 → 固定指令 → 任务 → 候选预览 → DOM/样式/配置断言 → 采用 → 主预览断言 → 回退 → 源码摘要恢复。
- 题目失败即记录并继续下一题（不补跑、不换题）；每题结束停止自己启动的后端/Vite，删除该题临时作品/数据，仅保留 JSON/截图证据。

## 固定十题与判据

| 序号 | 点选 | 固定指令（原样） | 判据摘要 |
| --- | --- | --- | --- |
| 1 | 首屏立即购买 | 把这个按钮的文字改成‘加入购物袋’，保留原来的购买行为，其他按钮文案不要改。 | 文案；点击后 purchases+1；save/gift 文案不变 |
| 2 | 首屏 h1 | 把主标题改成‘把森林，带回家。’，保留现有标题样式。 | 文本、仍为 h1、计算样式与基线一致 |
| 3 | 价格 | 把价格从 168 元改成 198 元，容量和香型说明保持原样。 | ¥198 且只出现一次；容量/香型不变 |
| 4 | 导航链接 | 把这个导航链接的文字改成‘探索香气’，仍然跳到下面的详情区。 | 文案、`#details`、点击跳转 |
| 5 | 购买按钮下小字 | 把这句小字改成‘给自己一份安静的礼物。’，其他文案保持原样。 | 文本；其他文案与基线一致 |
| 6 | intro | 把这段介绍文字的字号改为 16px，保持颜色和行高比例不变。 | 16px、line-height/font-size=2、颜色/文本不变 |
| 7 | 购买按钮（actions 祖先） | 把这一排购买和收藏按钮的间距改成 24px，不改变按钮本身的大小。 | gap=24px；按钮/礼盒尺寸与基线一致 |
| 8 | 任一共享 Button | 把这个共享按钮组件在页面上的三处实例都改成 12px 圆角，不改文字、颜色和点击行为。 | 三个按钮 12px；文案/背景/点击行为保留 |
| 9 | 第一条卖点 h3 | 把这组三条卖点的标题字号都改成 20px，卖点正文保持原样。 | 三个 h3=20px；标题/正文文本与正文字号不变 |
| 10 | 3D 展示外层 | 把这个 3D 场景的环境光强度改成 0.8，模型、相机、主光和滚动开盖配置都不要改。 | `scene.config.json` 仅 `hero.lights.ambient=0.8`；画布 ready，采用/回退一致 |

通用断言（由测试从 DOM/计算样式/JSON/文件实际读取，不把预期发给模型）：
- 除本题允许的字段外，全部快照键与基线一致（文本、按钮尺寸/颜色/字号、h1/intro/价格/nav/详情/页脚、卖点三条、场景状态等）。
- 候选和主预览的 3D `product-scene` 均 `data-state=ready`、存在 canvas。
- 候选四项内建检查仍为 `not_run`（Pi 观测独立记录，不冒充 M3 检查）。
- 采用后隔离作品生效；回退后源码/配置完整摘要与基线一致。
- 行为题（1/8 点击购买计数，4 点击导航 hash）在候选 iframe 内验证，不改作品。

## 证据字段

每题 JSON（`tasks/<n>.json`）记录：固定指令、selector、真实 selection（src/baseVersion/instances/ancestors）、taskId/会话（与 `x-opencode-session` 同一 task id）、任务状态/错误、轮数（从任务事件 `请求编码模型（第 n/16 轮）`）、任务时长、usage（客户端未暴露 → 记“未提供”）、diff/outOfScope/checks、基线/候选/采用/回退快照、版本变化、作品摘要（基线 vs 回退）、截图路径、行为断言。异常脱敏，不保存 Authorization/完整环境/上游响应体。

## mock 接线验证结果（不是真实成绩）

- 运行：loopback mock（4011，假 key），10 题顺序执行；`mock-wiring-20261114/results.json` → **10/10 passed**，每题 2 轮、约 9 秒。
- 逐题 selection 示例：1 → `src/components/Button.tsx:5:5`（instances=3）；10 → `src/components/ProductHero.tsx:33:10`；候选 diff 分别为 `src/App.tsx`、`src/scene.config.json` 等。
- 采用/回退版本变化均记录；每题 `workDigest.baseline === workDigest.afterRevert`；主模板 `git status` 干净；3001/4011/5173/5174/5175 全部释放。
- 任务 JSON 中未出现 Authorization/Bearer/key 形态字符串；mock 证据目录不包含截图（临时 probe 截图已清理，真实运行会保存每题 candidate/adopted/reverted 截图）。

## 真实执行命令（调度启动，不由本轮发付费请求）

在 `E:\空间化AI工作台` 根目录：

```powershell
orbital\coordination\m2-takeover\bg-root.cmd "node tests/e2e/real-model/run.mjs --mode real --run-id real-20261114-0100"
```

- 运行入口会检查 3001/5173/5174/5175 空闲，并只校验 `.env` 三个字段名存在（不打印值），然后启动 Studio 与固定十题；凭据只进后端 env。
- 证据目录：`docs/reports/artifacts/M2-real-model/real-20261114-0100/`（`run.json`、`results.json`、`playwright.json`、`run.log`、每题 JSON 与截图）。
- 判定：十题全部完成且至少 **8/10** 通过才可判 M2 过关；少于 8 题不得补跑/换题，按角色交修复/审查。超时、协议失败、上游故障均计真实失败；若启动/鉴权在首题请求前失败，记“验收未开始”。
- 本报告不预写通过；实跑结果由后台通知后归档。

## 未覆盖与边界

- 本轮没有真实模型请求，工具调用兼容性尚未验证；`x-opencode-session` 是现有实现，按真实实现验收。
- 服务用量/价格未提供，不估算费用；极限 160 轮请求，实际逐条记录。
- 十题只针对当前模板源码与固定指令；不做浏览器 Firefox/WebKit/触屏。
- F1 根 junction 正式 E2E、历史重启孤儿清理、资产偶发单测唯一根因仍按 `M2-final-regression.md` 保留为未覆盖。
