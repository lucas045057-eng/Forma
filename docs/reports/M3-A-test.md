# M3-A 后端请示独立验收 · Pi

- 日期：2026-11-14（Asia/Shanghai）
- 实现/测试冻结 HEAD：**`a947f9fd195171a7b42a14a38165c7bd0958174e`**
- 基线门禁：`git merge-base --is-ancestor 012d9a65… HEAD` 成功；`apps/packages/templates` 与 `pnpm-lock.yaml` 相对 `012d9a6` 无差异
- 运行：`job_b10ae204`，exit 1，约 86 秒；证据 `docs/reports/artifacts/M3-A/run-20261114-m3a-1/`

## 第二轮（HEAD `6c86101`，`run-20261114-m3a-2`）

- `job_e3cfdb4a` exit 1，约 103 秒；证据 `docs/reports/artifacts/M3-A/run-20261114-m3a-2/`。
- `typecheck`（4967ms）、`build`（7364ms）、标准 `pnpm test`（86211ms）均 exit 0；**280 单测全部通过**（shared 68、plugin 20、bridge 1、scene-renderer 5、server 179、Studio 7），无筛选/失败/跳过。四重点 4497/4922/4921/5842ms，均在 15s 预算内，普通 5s 预算未改。
- **M0-B 步骤在收集阶段失败，0 个测试执行**（`reports/e2e-m0b.json` total=0）：默认 `playwright.config.ts` 的 `testIgnore` 遗漏 `**/real-model/**`，误加载 `real-model.spec.ts:17`，报 `REAL_MODEL_RUN_DIR 未设置`；不是模型鉴权或产品失败，未读取 `.env`、未发真实请求。M0-A/M1-A/M1-B/M2-A/M2-B/M3-A 六套因此未开始。
- 修正：仅在 `playwright.config.ts` 的 `testIgnore` 增加 `**/real-model/**`（保留 m0a/m1a/m1b/m2a/m2b/m3a），并把专用十题限定到独立配置/runner。收集验证 `--list`：exit 0、**24 tests in 4 files**（`m0b-known-issues`、`m0b-message-guard`、`m0b-mutation-check`、`m0b-pick`），不再收集 real-model 或其他阶段；**这只是收集验证，不是 24 条已执行通过**。
- 本步骤前后 HEAD/锁/生产摘要一致，`refreshedArtifacts=0`；run1、stability、M2 历史证据均未覆盖。正式验收仍未完成，修正后由调度启动 `run-20261114-m3a-3`，结果待返回。

## 第三轮（HEAD `5c044dc`，`run-20261114-m3a-3`）

- `job_32342e02` exit 1，13m44s；证据 `docs/reports/artifacts/M3-A/run-20261114-m3a-3/`。
- typecheck/build/标准 280 单测全部通过；M0-B 24、M0-A 27、M1-A 7、M1-B 23、M2-A 35 全过（116 条）；**M2-B 10/12**，两项失败；**M3-A 未开始**。本轮已执行 E2E 共 126 passed / 2 failed，无 expected-failed/skip/retry；原始 JSON 逐份核对。
- 两项失败都在 `tests/e2e/m2b/01-ui.spec.ts`：越界提示（31.0s）与取消/重试（151.5s）。任务数据证实：越界用例旧任务 `8cb84293` done、新任务 `45ec215e` awaiting；重试用例旧任务 `3a5086e5` cancelled、新任务 `49d18030` awaiting，两张新卡 `72fb4e9b`/`678fccc2` 均 pending 未回答（`failure-race.json`）。
- **根因是测试 helper 竞争，不是产品丢候选**：旧 `resolveAwaiting()` 无 taskId，读取 `listTasks()` 的数组末项；任务 push 追加但未排序，点击后新 POST 尚未进入列表时，helper 会读到上一任务 done/cancelled 并提前返回，新任务随后进入 awaiting 却无人回答。
- 修正只在测试接线：换成 `submitAndResolve(page, action)`，先等待并校验本次精确 `POST /tasks` 202、取 `created.id`；`resolveAwaiting(page, taskId)` 只回答该任务自己的 pending 卡，校验 answer 200，等到该任务真实终态，并校验 Studio `task-select` 的当前 id；保留越界提示/未检查、取消/重试、候选/采用断言，未用 sleep/更高超时/自动批准全部卡。定向复跑两项通过。
- 62 份 refreshed tracked artifacts 已先归档再精确还原；run3 目录保留原失败证据。`M0-A/viewport.json`、`M1-B/undo-empty.json` 曾仅显示 CRLF 行尾状态，工作区/HEAD blob 相同、`--ignore-space-at-eol` 无 diff，已安全还原，不是未知内容变动。
- 修正后的 checkpoint（完整 M2-B 12 → M3-A 11）将另起后台入口，证据目录 `run-20261114-m3a-ui-checkpoint/`；它只作接线验证，不是最终完整 run4 通过。

## 修正后的 checkpoint（HEAD `a0e25ca`，`run-20261114-m3a-ui-checkpoint`）

- `job_d309cf00` exit 0：完整 M2-B **12/12**、M3-A **11/11**，共 23 通过；原始两份 JSON 每项 expectedStatus=passed、单一 result passed、无 retry/skip/errors。证据：`docs/reports/artifacts/M3-A/run-20261114-m3a-ui-checkpoint/`（含 job 输出/摘要、evidence/summary、两份 JSON、日志、9 份 refreshed artifacts）。
- 该 checkpoint 使用的是 `a0e25ca` 的 helper，当时仍带有三处附带等待：`waitFor` 预算 `60_000`（原 `30_000`）、新增 `page.waitForTimeout(300)`、以及用 `select.count()` 条件跳过的身份断言。调度核对 diff 后要求收回；这些属于测试接线的附带差异，不是产品修复，也不能因 23 通过忽略。
- 已收回为：`30_000` 预算；删除 `waitForTimeout(300)`；改为无条件 `expect(page.getByTestId('task-select')).toHaveValue(taskId)`（使用 Playwright 自动等待）。保留精确 `POST /tasks` 202→taskId、按 taskId `getTask` 轮询、只回答本任务 pending 卡、answer 200 校验、实际终态与原有 UI/候选/越界/未检查/取消/重试断言。
- **更正上轮交付说明**：上轮称“未用 sleep、加超时”与 diff 不符；实际有多出的 60s 与 300ms 等待，现以本段更正，原始 checkpoint 输出/证据保留不改写。
- 本 checkpoint 只证明该接线可通过，**不是最终完整 run4 结果**；收回附带等待后由新冻结 HEAD 直接启动 run4（typecheck/build/unit 与七套 E2E），不单独重复 checkpoint。

## 第四轮（HEAD `e6b177f`，`run-20261114-m3a-4`）与 E2E 端口接线修正

- `job_d7e19d77` exit 1，约 110 秒：typecheck/build 通过；`unit` 在 `apps/server/src/agent/client.test.ts:62` 失败（期望 `AGENT_PROTOCOL`，实际 `AGENT_UPSTREAM`，文件 238ms）；server **178/179**，其余已执行包 shared68/plugin20/renderer5/bridge1 通过，实际执行通过合计 **272**；**Studio 7 与七套 E2E 未调度**。不写 `280-1=279`。证据 `run-20261114-m3a-4/`。
- run4 没有记录该次初始化的端口/cause，不能据此断言失败一定由低位禁用端口导致，也不把历史资产偶发问题的唯一根因自动关闭。已合并的 a0f10a8 修改了实现侧测试夹具（高位/有界候选）；其 289 单测是参考，不是本轮独立结果。
- **E2E harness 仍有同类风险**：`tests/e2e/m0a/harness.ts::freePort()` 原来 `listen(0)`，其返回值被 `waitForHttp`、沙箱后端、预览源、fixture 与浏览器消费。已最小修正为：仅 loopback 尝试 **20000–65535** 随机候选，最多 32 次；只有 `EADDRINUSE` 与 win32 绑定 `EACCES` 进入下一候选，其它绑定/关闭错误直接停止并保留原因；每次完成自己的 server 错误监听与释放；接口仍是 `Promise<number>` 与“绑定后释放、子进程接手”的合同，不声称消除释放窗口。
- 接线审计：`tests/e2e` 中仅该处使用 `listen(0)`；其余外部服务/浏览器监听通过 `freePort()` 消费，或使用测试显式固定的 3001/4011/5173/5174 等既定端口。未改生产内部 preview worker 的端口逻辑，也未改 `waitForHttp` 超时、服务启停、测试预算、断言或 Playwright 收集排除。
- 本轮未单独用探针把 freePort 当作通过；端口修正由 run5 的实际服务启动/端口交接验证。

<!-- 历史：第一轮失败记录保留如下 -->

## 结论：验收未完成，完整回归被单测超时阻断

- `typecheck`、`build` 通过；`unit` 在 **apps/server** 失败（176/179 通过，3 项 5000ms 超时），`pnpm test` 首败即停，**Studio 单测未调度**。
- 官方顺序入口在 unit 步骤停止，**M0-B/M0-A/M1-A/M1-B/M2-A/M2-B/M3-A 七套 E2E 均未开始**。本轮正式结果为 **0 套 E2E**，不能沿用历史 E2E 通过记录。
- 三项失败都是测试超时，**不据此直接判定审批逻辑缺陷**；日志没有候选/审批断言失败，也没有证据证明是逻辑死锁。当前由 CodeBuddy 做只读受控并发诊断，诊断结论未返回前不归因、不改预算/重试。
- 之前实现方在 `012d9a6` 的 280 单测通过、以及本轮准备阶段本地 M3-A 接线 11/11，都不是本次 `a947f9f` 完整回归结果；不能拼接或顶替未跑部分。

## 实际步骤与计数

| 步骤 | 结果 | 说明 |
| --- | --- | --- |
| typecheck | **pass**，4.9s | 七包 typecheck（步骤日志） |
| build | **pass**，7.5s | 七包 build |
| unit | **fail**，72.2s | server 179 项：**176 passed / 3 failed（均 5000ms timeout）**；shared 68、source-tag 20、bridge 1（node:test）、scene-renderer 5 已通过；**Studio 7 未运行** |
| M0-B/M0-A/M1-A/M1-B/M2-A/M2-B/M3-A | **未运行** | 首败即停；无 JSON/截图/端口阶段证据 |

- 失败用例（原始日志 `logs/03-unit.log`）：
  1. `apps/server/src/work/approvals.test.ts > combines rules into one card and enforces the three-pending-card limit` — 5000ms timeout
  2. `apps/server/src/work/approvals.test.ts > persists stale main approvals, releases capacity and rejects repeated answers consistently` — 5000ms timeout
  3. `apps/server/src/work/service.test.ts > keeps at most three pending candidates and cleans up the oldest` — 5000ms timeout
- **不把 `280 - 3 = 277` 写成通过总数**：Studio 7 项根本没有运行，且 server 本身是 failed；只记录实际执行包的 270 项已通过和未运行清单。
- 步骤前后 HEAD/`pnpm-lock`/生产源码摘要一致，生产路径 git status 为空；`refreshedArtifacts=0`，没有 E2E 旧 tracked 证据被本轮刷新。

## 测试接线（已提交，不等于本轮验收通过）

- `a947f9f` 新增 M3-A API/真实 HTTP/真实候选 worktree/分源预览用例与 `playwright.m3a.config.ts`；默认 M0-B 显式排除 `m3a`。
- 准备阶段的**本地 M3-A 接线预跑为 11/11**（真 mock Agent、假 key、隔离端口/数据目录）：覆盖局部 App 直出、共享/全局/越范围/无 selection 请示、批准前不可见、批准不增模型调用、三卡上限、JSON 0/1/幂等/反答/并发、stale、重启/损坏数据、R1 预览失败、alias/default/barrel、Host/Origin。该结果只证明用例接线可跑，**不是本次官方回归，不能作为 M3-A 正式通过**。
- M2 迁移：旧套件已改为真实回答 pending 审批后继续原候选/采用/回退断言（无 selection/越界不再伪装直接成功）。官方回归未跑到 M2；准备阶段仅做了定向 M2-B 两个界面用例与 `zz-kill` 五项，均为调试性质，不替代本轮正式结果。
- **RR1（跨卡清理/保存失败的恢复意图）没有独立 E2E**：缺少可独立注入途径；由实现方 `approvals.test.ts` 与独立审查覆盖，本报告不宣称 E2E 通过。R1 的预览失败路径已有独立用例，但官方未跑到。

## 清零与清理核对

- 当前 3001/4011/5173/5174/5175 均空闲；没有发现本轮身份的启动后残留进程。
- 主模板/场景配置干净，生产源码/依赖/锁文件相对 `012d9a6` 无差异；`m2fix`/`m2d3` 未动，未清理 CodeBuddy 探针或其他会话。
- 本轮未读取真实 `.env`、未调用真实模型/Lux3D；未启动 M3-B 检查或 M3-C UI，候选四项 checks 仍 `not_run`，不存在“四检查 passed”结论。

## 归档与未覆盖

- 本次证据：`docs/reports/artifacts/M3-A/run-20261114-m3a-1/`（`evidence.json`、`summary.json`、`manifest.json`、`job-summary.json`、`job-output.log`、`unit-summary.json`、三段步骤日志）。
- 未运行：Studio 单测、七套 E2E、M3-B/M3-C、真实模型/Lux3D、RR1 独立 E2E。
- 下一步：等待 CodeBuddy 超时诊断与调度决定；需要新固定 HEAD 再执行完整顺序回归。本轮不重跑、不改断言/预算/并发配置，也不把历史 280/11 接线结果当作本次通过。
