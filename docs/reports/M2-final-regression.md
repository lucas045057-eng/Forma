# M2 已审查成品合并后的最终 mock 回归 · Pi

- 日期：2026-11-14（Asia/Shanghai）
- 集成基线：master **`b167907`**（合并独立审查通过的 `e468c20`；含 d79c467 的 retry 门禁与 N4 成品）
- 冻结 HEAD：本轮**测试/接线提交**（`b167907` 之后只有测试、验证入口与本报告；上一轮为 `cdfed40`；本轮重新提交后的完整 hash 由验证入口在 `evidence.json` 的 `frozenHead` 记录，并在交回消息中给出）
- 角色边界：只改测试、测试接线、测试报告与证据；未改 `apps/`、`packages/`、`templates/` 生产源码，未装依赖、未改锁文件、未合并分支；`.worktrees/m2fix`、`.worktrees/m2d3` 未动。
- 安全约束：假 key、loopback mock、出站网络守卫；未读真实 `.env`/ASKS，未调用真实模型或 Lux3D。

## 0. 上一轮启动的 preflight 阻断（job_e2215d6c）

- `job_e2215d6c`（冻结点 `cdfed40`）**exit 2、约 6 秒、执行了 0 个验证步骤**；不是产品失败，也不能判定任何套件通过或失败。
- 根因：`tests/e2e/final-verification/run.mjs` 的 preflight 用 `git grep` 扫描整个 `tests/e2e`，命中入口脚本自身包含的搜索字符串；日志中唯一命中就是 runner 自身。
- 证据保留：`docs/reports/artifacts/M2-final/final-20261114-0040/`（`evidence.json` 的 `status=blocked`、`steps=[]`、`blocked.reason=test-fail-still-present`；`job-output.log`；`preflight.json`）。
- 该目录不覆盖、不改写；本轮用新 run-id 重新冻结。

## 1. 本轮测试侧改动

1. `tests/e2e/m2b/02-takeover.spec.ts`
   - 删除 retry 用例的 `test.fail`，标题改为“R1：retry 在 pending/failed 期间也不得提交”，注释改为 b167907 已合入门禁。
   - 保留全部断言（pending/failed 期间 retry 禁用、按钮/快捷键不提交、gate 释放/失败流程）。
   - 证据更名 `takeover-r1-retry.json`；旧的 expected-failure 证据 `takeover-r1-retry-known-failure.json` 保留不覆盖。
2. `tests/e2e/m2a/15-n4-shutdown.spec.ts`
   - 删除 `test.fail`，按普通断言验收 N4（同文件内全部 `expect.soft` 保留，失败仍会让用例失败）。
   - 被挂住的真实 HTTP `GET /version` 改用 `node:http` 并显式 `Connection: close`：只避开最终审查建议 S1 中“keep-alive 直连客户端会让 close 额外安全等待约 72 秒”的排空等待；**锁必须等操作结束才释放、写入必须先于解锁等断言全部不变**，证据中记录 `blockedRequest.connection='close'` 与该说明。
   - 证据改名 `takeover-n4-shutdown-b167907.json`，pre-fix 的 `takeover-n4-shutdown.json` 保留不覆盖。
3. 新增顺序验证入口 `tests/e2e/final-verification/run.mjs`（一次后台执行）：
   - 每步记录命令、起止时间、退出码/信号、HEAD、`pnpm-lock.yaml` 摘要、生产源码树摘要、生产路径 `git status`、Playwright JSON 统计、端口/监听者（PID/名称/创建时间）、证据快照 hash。
   - 第一失败即停，按本步骤进程 PID 做 `taskkill /T` 清理；仍占用已知端口的进程只记录归属，不按端口强杀并行会话。
   - 运行前后记录 `d3-run-11ed6da0`、`d3-run-c0b6a407`、`isolation-r6.json` 的目录/文件摘要，证明历史证据未被覆盖。
   - preflight 的 `test.fail` 扫描改到独立模块 `tests/e2e/final-verification/spec-scan.mjs`：只扫描被 git 跟踪的 `*.spec.ts|*.spec.tsx|*.test.ts|*.test.tsx`，用 `git grep -F -e <固定字符串>`；退出码 1 表示无匹配，ls-files/grep 的执行错误（status≠0/1 或 spawn error）一律阻断，不再用 catch 把错误当成成功。

### 1.1 preflight 扫描修复的快速探针（临时 Git fixture，不碰生产）

`tests/e2e/final-verification/spec-scan.probe.mjs` 结果（全部 ok）：

| 场景 | 结果 |
| --- | --- |
| 只有 runner/fixture（`.mjs`）含扫描词 | `clean=true`、扫描 3 个用例文件、runner 不参与 |
| 真实 `sample.spec.ts` 追加未清理标记 | `clean=false`、`reason=marker-found`、命中该 spec |
| `git grep` 返回 128 | `clean=false`、`reason=git-grep-failed` |
| `git ls-files` 返回 128 / spawn error | `clean=false`、`reason=git-ls-files-failed` / `git-ls-files-error` |

仓库内 preflight 复跑：扫描 39 个 tracked spec/test 文件、`clean=true`（`PREFLIGHT OK`）。

## 2. 顺序验证范围（同一冻结 HEAD，不并行抢端口）

| # | 步骤 | 命令 | 超时 |
| --- | --- | --- | --- |
| 1 | typecheck | `pnpm typecheck` | 15 min |
| 2 | build | `pnpm build` | 20 min |
| 3 | 完整单测 | `pnpm test` | 20 min |
| 4 | M0-B e2e（默认 config） | `playwright test -c playwright.config.ts` | 45 min |
| 5 | M0-A e2e | `-c playwright.m0a.config.ts` | 45 min |
| 6 | M1-A e2e | `-c playwright.m1a.config.ts` | 45 min |
| 7 | M1-B e2e | `-c playwright.m1b.config.ts` | 45 min |
| 8 | 完整 M2-A e2e（含 D3 五场景与 N4） | `-c playwright.m2a.config.ts` | 60 min |
| 9 | 完整 M2-B e2e | `-c playwright.m2b.config.ts` | 60 min |
| 10 | D3 五场景单独复核（第二轮） | `-c playwright.m2a.config.ts tests/e2e/m2a/zz-kill.spec.ts` | 20 min |

- 固定浏览器路径 `PLAYWRIGHT_BROWSERS_PATH=%LOCALAPPDATA%\ms-playwright`。
- 每步用 `--reporter=list --reporter=json`，JSON 写到证据目录（`PLAYWRIGHT_JSON_OUTPUT_NAME`），`--output` 也放证据目录，避免覆盖仓库里旧 `playwright-results.json` 与 `output/`。
- 单测每包数量按实际输出记录；`235` 是已审成品的参考值，不写死计数，也不接受 skip/todo 冒充通过。
- 判定口径：以实际 `passed / unexpected-failed / expected-failed / skipped` 统计；两处已修的 retry/N4 **不允许 expected-failed**，也不接受“预期失败但通过”的意外结果；出现任一即该步失败。

## 3. 证据布局与停止策略

- 证据根：`docs/reports/artifacts/M2-final/<runId>/`
  - `evidence.json`：冻结 HEAD、每步完整记录（含 before/after HEAD、lock/source 摘要、端口归属、失败原因）。
  - `summary.json`、`logs/<NN>-<step>.log`、`reports/<step>.json`（Playwright JSON）、`output/<step>/`。
  - `artifacts/<step>/`：该步产出的 `*.json` 证据快照（M0-B/M0-A/M1-A/M1-B/M2-A/M2-B）。
  - 两轮 D3 分开归档：`artifacts/e2e-m2a/`（完整套件内第一轮）与 `artifacts/d3-standalone/`（单独第二轮），不覆盖 `d3-run-11ed6da0`、`d3-run-c0b6a407` 与旧误报 `isolation-r6.json`（入口在运行前后核对摘要）。
- 失败处理：立即停止后续步骤；记录失败步骤的退出码/信号、失败前后的摘要与端口；只清理本步骤 PID 树；不按端口号杀其他会话；保留全部日志与部分证据。

## 4. 已修复项与历史证据的保留

- retry 门禁与 N4 均由 b167907 合入；本轮不再使用 `test.fail`，历史 expected-failure 证据（`takeover-r1-retry-known-failure.json`、`takeover-n4-shutdown.json`、`isolation-r6.json`）全部保留。
- D3 的“旧 2→2”结论仍记录为**计数自匹配误报**；生产 `preview.ts`/`preview-worker.ts` 未被测试修正“修好”。第二轮 D3 仍按 PID+创建时间、监听端口与 decoy 判据复核，不做无意义无限重复。

## 5. 未覆盖 / 限制（不要当成全覆盖）

- F1（`src/`/`public/` 自身是 junction）仍无正式 E2E：本机复制含二进制模型的目录曾在 `fs.cpSync` 下崩溃，后续只在实现方单测覆盖；本轮不宣称 F1 已 E2E。
- 生产代码没有“重启时清理上次 IPC 自退失败留下的孤儿”，本轮 D3 也不覆盖该路径。
- 资产偶发测试（`service.test.ts` / `lux3d.test.ts`）尚未唯一归因到动态端口 bad-port；本轮只记录实际结果，不靠重试/加超时凑绿。
- N4 的 `Connection: close` 只避开约 72 秒 keep-alive 排空等待；该等待本身（S1 建议）仍是安全行为，不是缺陷验证。
- 启动窗口 D3 用例使用临时作品副本里的延迟 Vite 替身；生产 preview 代码未改，仍属于“覆盖限制”。

## 6. 当前状态：待后台结果（新 run）

- 上一轮 `final-20261114-0040` / `job_e2215d6c` 已归档为 **preflight 阻断**（exit 2、约 6 秒、0 步骤），证据目录保留，不覆盖。
- preflight 扫描修复后重新冻结；新 run id：**`final-20261114-0045`**。需要由调度从 workspace 根启动（不要人工等待/轮询）：

```powershell
orbital\coordination\m2-takeover\bg-root.cmd "node tests/e2e/final-verification/run.mjs --run-id final-20261114-0045 --base b167907"
```

- 启动后应看到 job id 与受跟踪通知；job 输出在 `orbital/jobs/<job id>/output.log`，证据在 `docs/reports/artifacts/M2-final/final-20261114-0045/`。
- **本报告不预先宣称通过。** 实跑结果（每套退出码/用例数、expected-failed/skipped、端口与进程清理、证据摘要）由后台通知回来后补入本节与 `evidence.json`/`summary.json`。
- 若权限阻止或包装不可用：不启动无通知作业，交回上述精确命令与冻结 HEAD，由调度启动。
