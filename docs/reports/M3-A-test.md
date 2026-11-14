# M3-A 后端请示独立验收 · Pi

- 日期：2026-11-14（Asia/Shanghai）
- 实现/测试冻结 HEAD：**`a947f9fd195171a7b42a14a38165c7bd0958174e`**
- 基线门禁：`git merge-base --is-ancestor 012d9a65… HEAD` 成功；`apps/packages/templates` 与 `pnpm-lock.yaml` 相对 `012d9a6` 无差异
- 运行：`job_b10ae204`，exit 1，约 86 秒；证据 `docs/reports/artifacts/M3-A/run-20261114-m3a-1/`

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
