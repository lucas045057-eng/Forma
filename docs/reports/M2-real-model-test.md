# M2 真实编码模型固定十题验收 · Pi

- 日期：2026-11-14（Asia/Shanghai）
- 实现基线：`b167907`（已独立审查）；mock 成品回归归档 `b40425c`（运行冻结 `86416ce`）
- 服务与模型：`https://xfastapi.ai/v1` + `gpt-6.1-sol`（用户新提供）；真实十题已由调度执行（见下文），归档阶段未再发送任何付费请求
- 方案：`docs/design/M2-real-model-acceptance.md` 固定十题，顺序/指令/断言不变；10 题串行、无自动重试/补跑，每题最多 16 轮 / 180 秒
- 真实运行冻结 HEAD：本轮测试/launcher/报告提交（`a950407` 之后仅测试与文档；完整 hash 见交回消息与 `run.json` 的 `head`）

## 当前状态：真实十题已完成（10/10）

- 调度已在冻结 HEAD **`865e3b2`** 上执行 `job_e27011e4`：**exit 0、3m36s**；`results.mode=real`、`complete=true`、`notStarted=false`、`securityStop=false`、**10/10 passed**，达到固定 8/10 门槛。此后未再调用付费模型，也不补跑。
- 本轮只做结果核对与归档；旧 mock 接线证据与故障探针保留，不覆盖。真实结果与 mock 成绩严格分开。
- 真实十题证据：`docs/reports/artifacts/M2-real-model/real-20261114-0100/`；每题的指令/顺序/判据与 `M2-real-model-acceptance.md` 一致。

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
- 页面/iframe 的 `error`/`unhandledrejection` 与 Playwright `pageerror` 分基线、候选、采用三阶段收集；候选/采用阶段出现**新增**未捕获异常即失败（基线已有异常不掩盖新增）。
- 点采用前，主 frame 快照必须仍等于基线，作品摘要与 `scene.config.json` 原字节未变（不是只在回退时验证）。
- 候选和主预览的 3D `product-scene` 均 `data-state=ready`、存在 canvas。
- 候选 `checks` 与 UI 四项必须全部 `not_run` 且不显示“通过”（Pi 观测独立记录，不冒充 M3 检查）。
- 采用后隔离作品生效；回退后源码/配置完整摘要与基线一致。
- 行为题（1/8 点击购买计数，4 点击导航 hash，8 另验 save/gift 原行为）在候选 iframe 内验证，行为状态单独记录，不混入“非目标内容变化”。

## 证据字段

每题 JSON（`tasks/<n>.json`）记录：固定指令、selector、真实 selection（src/baseVersion/instances/ancestors）、taskId/会话（与 `x-opencode-session` 同一 task id）、任务状态/错误、轮数（从任务事件 `请求编码模型（第 n/16 轮）`）、任务时长、usage（客户端未暴露 → 记“未提供”）、diff（完整 patch 另存 `diffs/<n>-*.patch`，JSON 只记 path/bytes/sha256）、outOfScope/checks、基线/候选/采用前/采用/回退快照、阶段错误、版本变化、作品摘要（基线 vs 采用前 vs 回退）、截图（baseline/candidate/adopted/reverted）、guard loaded 标记与日志、必要的后端错误摘要与端口清理结果。异常统一脱敏，不保存 Authorization/完整环境/上游响应体。

## mock 接线与故障探针（不是真实成绩）

- 补齐门禁后重跑：loopback mock（4011，假 key），10 题顺序执行；`mock-wiring-20261114/results.json` → **10/10 passed**，每题 2 轮、约 9 秒（总计约 106 秒）。
- 逐题 selection 示例：1 → `src/components/Button.tsx:5:5`（instances=3）；10 → `src/components/ProductHero.tsx:33:10`；候选 diff 分别归到 `src/App.tsx`、`src/scene.config.json` 等，完整 patch 在 `diffs/`。
- 每题基线截图先生成；采用前主 frame/作品摘要/场景配置不变断言通过；候选 4 项检查均为 `not_run`；采用/回退版本变化与 `workDigest.afterRevert === baseline` 均记录；guard marker active、guard 日志为空；主模板干净、端口释放。
- 故障探针（`fault-probes-20261114/`，均未发真实请求）：

| 注入 | 预期门禁 | 实测 |
| --- | --- | --- |
| 候选阶段未捕获异常 | 新增 pageerror 判失败 | `result=failed`，错误含“新增未捕获脚本异常…probe-uncaught-error” |
| 采用前手工改作品 `App.tsx` | 采用前 workDigest 判失败 | `result=failed`，错误“采用前作品内容不应被候选修改” |
| 证据中出现 `Bearer probe-secret-…` | 安全停止、不得通过 | `status=security-failed`、`securityStop=true`、runner exit 1 |

- 任务 JSON 中未出现 Authorization/Bearer/key 形态字符串；mock 证据目录不包含截图（临时 probe 截图已清理，真实运行会保存每题截图）。

## 真实运行结果（job_e27011e4，10/10）

- 冻结 HEAD `865e3b2f820e411bc54fd9be193ccdb1099d57e9`；job `job_e27011e4`，exit 0，job wall 216s（3m36s）；`run.json` 的 runner 计时 213 495ms，Playwright 一条封装十题的测试 `expected=1/unexpected=0/skipped=0`（**不是十条 Playwright 测试**）。
- 每题 task `done`，rounds=4；十题合计 **40 轮**（来自任务事件 `请求编码模型（第 n/16 轮）`，不是账单用量）。模型任务耗时（task createdAt→updatedAt）**11 293–13 937ms**，合计 128 043ms；题目 wall（含点选/预览/采用/回退）19 150–21 829ms，合计 206 997ms，与全 run 213 495ms 区分。

| # | 选中 src | rounds | 模型任务 ms | 题目 wall ms | base→adopt→revert（前 8 位） | 结果 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `src/components/Button.tsx:5:5`（3 实例） | 4 | 13 189 | 20 964 | 08a630a3→b400ba09→66786c2c | passed |
| 2 | `src/App.tsx:23:11` | 4 | 11 293 | 19 228 | 6ec9bf4c→bb7aa3df→d49cfb31 | passed |
| 3 | `src/App.tsx:25:11` | 4 | 13 314 | 21 344 | ae906a40→665f21df→a511524c | passed |
| 4 | `src/App.tsx:18:9` | 4 | 13 937 | 21 829 | 272873fd→b23ba824→159072b0 | passed |
| 5 | `src/App.tsx:30:11` | 4 | 11 367 | 19 150 | b279aa7e→a49d6547→17b33ba3 | passed |
| 6 | `src/App.tsx:24:11` | 4 | 13 654 | 21 783 | bb7a0567→f9eabe21→8160686d | passed |
| 7 | `src/components/Button.tsx:5:5`（3 实例，actions 祖先） | 4 | 12 663 | 20 464 | dff06b99→6a24a463→e8c955b8 | passed |
| 8 | `src/components/Button.tsx:5:5`（3 实例） | 4 | 13 433 | 21 406 | c96410a4→f3041c5d→e7869d6a | passed |
| 9 | `src/App.tsx:41:15`（3 条卖点） | 4 | 11 837 | 19 577 | 960a4a35→e39f2844→3936d7e4 | passed |
| 10 | `src/components/ProductHero.tsx:33:10` | 4 | 13 356 | 21 252 | 4ec10d2b→69b1af68→fbd384fd | passed |

逐题证据核对（全部成立）：
- 固定原指令与顺序一致；每题的 `selection.src/baseVersion`、taskId/会话、candidate id 均记录，diff 分别落在 `src/App.tsx`、`src/style.css`、`src/scene.config.json`（完整 patch 在 `diffs/`，10 个文件 sha256 与 JSON 记录一致）。
- 采用前主 frame 快照仍等于基线，`workDigest` 与 `scene.config.json` 原字节未变；采用/回退版本均变化；回退后 `workDigest` 与基线相同，scene 配置恢复。
- 候选四项 `checks` 全 `not_run`，UI 也全 `not_run` 且不显示“通过”；页面/iframe 未捕获异常在基线、候选、采用阶段均为空（`new*Errors=[]`）。
- 行为题：1 购买计数 0→1；4 点击导航后 hash=#details；8 购买计数 0→1，save/gift 仍显示“已收藏这缕香气（演示）”“已选择礼盒装（演示）”。
- 守卫：每题 markerActive=true，blocked/blockedAfter 为空；`unsafePaths/diffSecret/recordSecret` 为空；每题结束后 3001/5174/5175 端口空闲；无本轮身份的 preview/Vite/node 残留。
- 主模板与 tracked tree 干净，`mainTemplateClean=true`；生产相对 `b167907` 无差异。截图 40 张（每题 baseline/candidate/adopted/reverted），均在证据目录。
- 模型请求发往配置的 `xfastapi.ai`、model 字段 `gpt-6.1-sol`；第三方实际内部模型身份不可由本地测试验证，本报告不作此声称。usage 客户端未暴露，记“未提供”，**40 轮不是账单用量，不猜价**。
- 证据已扫描无 Authorization/Bearer/key 形态字符串；后端只读 `.env` 三个 Agent 字段传给自身进程，preview/Vite 不带编码凭据，Lux3D 固定不可用 loopback。

## 真实执行记录（已执行，结果已归档）

在 `E:\空间化AI工作台` 根目录：

```powershell
orbital\coordination\m2-takeover\bg-root.cmd "node tests/e2e/real-model/run.mjs --mode real --run-id real-20261114-0100"
```

- 命令已由调度执行；入口检查 3001/5173/5174/5175 空闲、只校验 `.env` 三个字段名存在（不打印值），然后启动 Studio 与固定十题；真实模式强制 10 题/8 门槛，忽略 `--limit`/`--only-results`。
- 证据目录：`docs/reports/artifacts/M2-real-model/real-20261114-0100/`（`run.json`、`results.json`、`playwright.json`、`run.log`、`job-summary.json`、`job-output.log`、每题 JSON/完整 diff/截图/logs、manifest）。
- 结果：10/10 passed，达到固定 8/10 门槛；十题全部完成、结果全部归档、无 expected-failed/skip/retry。未发生安全停止；上游 401/403 只会在已提交任务后计入失败，本轮无此情况。
- M2 的正式收口由调度在核对归档后决定；本轮不启动 M3，也不再进行任何付费测试。

## 未覆盖与边界

- 本轮真实十题只针对当前模板的固定案例；不能外推到其他页面、其他模型或未来版本。工具调用兼容性已按 xfastapi 真实实现跑通 10/10，但不能据此声称第三方内部模型身份或账单用量。
- 服务用量/价格未提供，不估算费用；极限 160 轮请求，实际逐条记录。
- 十题只针对当前模板源码与固定指令；不做浏览器 Firefox/WebKit/触屏。
- F1 根 junction 正式 E2E、历史重启孤儿清理、资产偶发单测唯一根因仍按 `M2-final-regression.md` 保留为未覆盖。
