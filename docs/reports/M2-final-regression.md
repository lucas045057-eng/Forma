# M2 已审查成品合并后的最终 mock 回归 · Pi

- 日期：2026-11-14（Asia/Shanghai）
- 集成基线：master **`b167907`**（合并独立审查通过的 `e468c20`；含 d79c467 的 retry 门禁与 N4 成品）
- 冻结 HEAD：**`86416ce080e10f75bea146f6d6b852629555ab79`**（`b167907` 之后的测试/接线提交；`apps/packages/templates` 与锁文件相对 `b167907` 无差异）。结果归档提交见交回消息。
- 角色边界：只改测试、测试接线、测试报告与证据；未改 `apps/`、`packages/`、`templates/` 生产源码，未装依赖、未改锁文件、未合并分支；`.worktrees/m2fix`、`.worktrees/m2d3` 未动。
- 安全约束：假 key、loopback mock、出站网络守卫；未读真实 `.env`/ASKS，未调用真实模型或 Lux3D。

## 0. 上一轮启动的 preflight 阻断（job_e2215d6c）

- `job_e2215d6c`（冻结点 `cdfed40`）**exit 2、约 6 秒、执行了 0 个验证步骤**；不是产品失败，也不能判定任何套件通过或失败。
- 根因：`tests/e2e/final-verification/run.mjs` 的 preflight 用 `git grep` 扫描整个 `tests/e2e`，命中入口脚本自身包含的搜索字符串；日志中唯一命中就是 runner 自身。
- 证据保留：`docs/reports/artifacts/M2-final/final-20261114-0040/`（`evidence.json` 的 `status=blocked`、`steps=[]`、`blocked.reason=test-fail-still-present`；`job-output.log`；`preflight.json`）。
- 该目录不覆盖、不改写；本轮用新 run-id 重新冻结。

### 0.1 第二次启动的入口归档失败（job_1afbd95b）

- `job_1afbd95b`（冻结点 `e418a23`）**exit 1、约 12 秒、后台 stdout 为空**；`final-20261114-0045` 的 `logs/01-typecheck.log` 显示七包 typecheck 全部 Done、`currentStep.exitCode=0`，HEAD/lock/生产源码摘要均未变。
- 事实：typecheck **成功**，但入口归档失败；`evidence.steps=[]`、`currentStep` 停在 `artifacts=[]`，**build / 单测 / 六套 e2e 均未运行**。不是产品失败，也不是完整通过。
- 根因：`run.mjs` 在第一步没有 `artifactDirs` 时，向尚未创建的 `EVIDENCE/artifacts/typecheck-index.json` 写索引；`snapshotArtifacts` 只在有 artifactDirs 循环时才 mkdir，于是抛 ENOENT；外层 catch 未记录异常，直接 exit 1，evidence 停在 `status=running`。
- 证据保留：`docs/reports/artifacts/M2-final/final-20261114-0045/` 原 `evidence.json`/`logs` 不改，另存 `entry-failure.json` 与 0 字节 `job-output.log`。
- 修复：索引写入前总是 mkdir；捕获并记录 `message/code/stack`；失败时同步写 `status=failed`、清理 `currentStep`、`finishedAt` 与 `summary.json` 并非零退出；Playwright 报告缺失也判失败。

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
   - 收尾路径加固：`artifacts/` 与每步快照目录总是先 `mkdir`；子进程 `error` 事件、日志关闭、Playwright JSON 缺失、归档异常都进入同一 `runStep` 失败记录；失败时写 `summary.json` 与步骤 summary，并清理 `currentStep`；未捕获的入口异常输出原错误并至少尝试落盘 failed 状态。
   - `--smoke=<success|command-fail|artifact-error>` 快速自检直接复用实际 `runStep`/收尾代码，不启动真实测试。

### 1.1 preflight 扫描修复的快速探针（临时 Git fixture，不碰生产）

`tests/e2e/final-verification/spec-scan.probe.mjs` 结果（全部 ok）：

| 场景 | 结果 |
| --- | --- |
| 只有 runner/fixture（`.mjs`）含扫描词 | `clean=true`、扫描 3 个用例文件、runner 不参与 |
| 真实 `sample.spec.ts` 追加未清理标记 | `clean=false`、`reason=marker-found`、命中该 spec |
| `git grep` 返回 128 | `clean=false`、`reason=git-grep-failed` |
| `git ls-files` 返回 128 / spawn error | `clean=false`、`reason=git-ls-files-failed` / `git-ls-files-error` |

仓库内 preflight 复跑：扫描 39 个 tracked spec/test 文件、`clean=true`（`PREFLIGHT OK`）。

### 1.2 runner 收尾路径 smoke（实际 runStep，临时证据目录）

`run.mjs --smoke=<scenario>` 结果（汇总在 `docs/reports/artifacts/M2-final/preflight-smoke.json`，临时目录已删除）：

| 场景 | 结果 |
| --- | --- |
| `success`：无产物步骤 → 有产物步骤 | runner exit 0、`status=passed`；两个 index 都写入（无 artifactDirs 也能 mkdir），`sample-artifact.json` 快照归档；进入下一步；`currentStep` 已清 |
| `command-fail`：第二步 `node -e exit(3)` | runner exit 1、`status=failed`；步骤 `exit=3`、`failureReasons=["exit=3"]`、cleanup 已尝试、summary 已写、`currentStep` 已清 |
| `artifact-error`：artifactDirs 指向文件 | runner exit 1、`status=failed`；捕获真实 `ENOTDIR`，写入 `error.code/message/stack`、failed 与 summary，不再留 running |

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
- 本轮全部 e2e 都是 **mock 模型门槛**；真实模型“连续 10 次至少 8 次改对”未运行，需要额度确认后另行派单，不能由本轮结果替代。

## 6. 实际结果：通过（mock 集成回归）

- `job_ae81d353`：**exit 0、10m54s**；冻结 HEAD `86416ce…`；`evidence.status=passed`，10 个步骤全部 `exitCode=0`、`signal=null`、`failed=false`。
- 每步 before/after 的 HEAD、`pnpm-lock` 摘要（`50e02a0c…1725`）、生产源码树摘要（`6697b6f6…59cf`）一致，生产路径 `git status` 为空；`priorEvidenceUnchanged=true`，`final-20261114-0040`/`-0045` 保留。

| 步骤 | 结果 |
| --- | --- |
| typecheck | exit 0 |
| build | exit 0 |
| 完整单测 | exit 0；**235**（shared 68、plugin 20、bridge 1（node:test）、scene-renderer 5、server 134、studio 7），无 skip/fail |
| M0-B e2e | 24/24 passed |
| M0-A e2e | 27/27 passed |
| M1-A e2e | 7/7 passed |
| M1-B e2e | 23/23 passed |
| 完整 M2-A e2e | 35/35 passed（含 D3 五场景与 N4 正常断言） |
| 完整 M2-B e2e | 12/12 passed（含 retry 正常断言） |
| D3 单独复核 | 5/5 passed（同一五场景重跑，**不是五个新增用例**） |

- 六套 e2e 合计 **128**（24+27+7+23+35+12）；七份 Playwright JSON 里的每个 test 都是 `expectedStatus=passed`、`status=expected`、唯一 result `status=passed`，`expected-failed=0`、`skipped=0`、`unexpected=0`、`retries=0`。
- N4（`takeover-n4-shutdown-b167907.json`）：blocked 操作先被接受，关闭期间锁仍在、第二实例 `INSTANCE_LOCKED`，解锁时 `headHasMarker=true`、`hasVersionChanged=true`、`operationCompleted=true`，重启 seq 接续；已按普通断言通过，不再 expected-failed。
- retry（`takeover-r1-retry.json`）：pending/failed 期间 `retryDisabledWhilePending=true`、`retryDisabledWhileFailed=true`，正常断言通过。
- D3：`artifacts/e2e-m2a/` 与 `artifacts/d3-standalone/` 两轮各自 5 个 scenario 都是 `gone=true`、`stillAlive=[]`、`leftoverIdentities/leftoversAfter=[]`；decoy 在目标清理后仍活、最终 `decoyCleanup.gone=true`；两轮 hash 不同，说明是独立重跑。D3 仍是**测试口径误报的纠正**，不是生产 `preview` 被修复。
- 端口/进程：每个 e2e 步骤后的已知端口列表为空；当前 3001/4011/5173/5174/5175 均空闲，没有本轮身份的 preview/vite/node 残留；N4 临时目录已删除；模板/配置 `git status` 干净。`.data/pi-m2a` 下仍有早期回合的 fixture 目录（非本轮创建，未删除）。

### 6.1 根目录生成物与独立证据

- 本轮刷新过的 **63 个 tracked report artifacts**（M0-A/M0-B/M1-A/M1-B/M2-A/M2-B）都已先完整快照到 `final-20261114-0100/artifacts/<step>/`（逐文件 sha256 在 `evidence.json`），随后才从 HEAD 还原根目录旧文件；旧结论没有被静默替换，新证据以本轮快照为准。
- M0-A 的二进制 `viewport-rotated.png` 也被本轮刷新；runner 的 JSON 快照不含二进制，已手工归档到 `final-20261114-0100/artifacts/e2e-m0a/viewport-rotated.png`，hash 记在 `artifacts-index-supplement.json`。
- 新增根文件 `takeover-r1-retry.json`、`takeover-n4-shutdown-b167907.json` 随本次提交保留；D3 的五个 tracked attributed 文件在根目录保持旧版，本轮两轮新版只在 run 目录快照中。

**结论：mock 门槛下 M2 的已审查成品集成回归通过。** 这不等于整个 M2 完成：真实模型成功率验收、F1 根 junction 正式 E2E、历史孤儿启动清理、资产偶发单测唯一根因仍未覆盖，按要求保留为未覆盖项。
