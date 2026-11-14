# M3-B 验收准备（Pi 独立测试侧的接线与预检，**不是验收结论**）

> 状态：**验收准备**。分支 `test/m3b-acceptance` 不合并、不改产品；
> M3-B **尚未通过**，正式门禁仍是「Claude 对 `6f6ff49` 的修后复核通过 → Codex 合并冻结 → Pi 正式完整回归」。
> 本文只覆盖「测试侧接线是否就绪」和「一次最小单场景真实预检」。

## 1. 分支与身份

| 项 | 值 |
| --- | --- |
| 工作树 | `E:\空间化AI工作台\.worktrees\m3b-acceptance` |
| 分支 | `test/m3b-acceptance`（从 `6f6ff494995eb2a77b0fdbac86367d15c259bce2` 派生） |
| 冻结实现工作树 | `.worktrees/m3b`（`feat/m3b-checks`，HEAD `6f6ff49`，本分支只读引用，未改动） |
| 主线 | `master`（`cbadee3…`），本分支不改主线、不 merge |
| 依赖 | `pnpm install --offline --frozen-lockfile`：**248 个包全部命中本地缓存、0 下载、0 升级**（1.3s） |

**产品与依赖无差异证明**（相对 `6f6ff49`）：`git diff 6f6ff49 -- apps packages templates` = 0 个差异块；`pnpm-lock.yaml` = 0 行；`package.json` 只多一条脚本 `test:e2e:m3b`，`devDependencies` 未变。

**一个环境事实**：库里有一条历史 tracked 证据的路径长 232 字符，工作树根叠加后超过 Windows `MAX_PATH`。
本工作树用 `git -c core.longpaths=true worktree add …` 建出，缺失文件已按 blob 逐字节还原。
后果：**本工作树里必须带 `-c core.longpaths=true` 执行 `git status/diff`**，否则普通 `git status` 会因读不到该超长路径而误报一条 `M`（不是真实改动）。

## 2. 环境与安全边界

- 编码上游：`tests/e2e/m2a/agent-mock.mjs`（loopback `127.0.0.1:4011`，fake key `mock-only`），**无任何真实模型调用**；
- Lux3D：`http://127.0.0.1:4019`（无人监听）；
- 后端：与产品同一 `createApp()`，由 `tests/e2e/m2a/start-backend.mjs` 启动，带 `tests/e2e/m0a/no-real-network.cjs` 出站守卫；
- 作品目录：每个用例用 `createWorkRoot()` 把模板 `src`/`public` 逐文件复制到隔离目录，`node_modules` 走 junction，**不碰 `templates/product-page`**；
- 未读取 `apps/server/.env`、`orbital/ASKS.md` 或任何凭据；未新增付费调用。

## 3. 交付物

| 文件 | 作用 |
| --- | --- |
| `playwright.m3b.config.ts` | M3-B 专用配置：单 worker、0 retry、`forbidOnly`、无 `webServer`（用例自起隔离后端） |
| `tests/e2e/m3b/checks.ts` | 四个检查接口助手 + `waitCheckRun`（等本次 run 精确终态）+ `assertPassedRun`（四项 passed + 六份证据）+ `ensureChecksPassed`（旧套件迁移入口） |
| `tests/e2e/m3b/fixture.ts` | 隔离后端/作品副本/mock 上游夹具；支持优雅停机、强制杀进程树、同 dataDir 重启；候选创建绑定本次 POST 返回的精确 id；`disposeAllFixtures()` 负责带证据收尾 |
| `tests/e2e/m3b/01-happy.spec.ts` | 成功路径：真实四项检查 → 证据 → 采用 → 回退 |
| `tests/e2e/m3b/02-faults.spec.ts` | 四类真实故障：schema / 编译 / 运行错误 / 遮挡 |
| `tests/e2e/m3b/03-gate.spec.ts` | 门禁与身份：幂等、显式 rerun、严格请求体、证据篡改、主版本过期 |
| `tests/e2e/m3b/04-lifecycle.spec.ts` | 取消 / 强杀重启恢复 / 跨候选串行 / 缺浏览器 |
| `tests/e2e/m3b/full-regression.mjs` | 未来完整回归的顺序入口（本轮**未启动**） |
| `package.json` / `playwright.config.ts` | 新增 `test:e2e:m3b`；默认 M0-B 收集排除 `**/m3b/**`（既有排除不变） |

## 4. 覆盖矩阵（执行状态如实分开）

“真实 HTTP”= 只用产品四个接口驱动；“故障 launcher”= 用环境变量/进程控制制造真实故障，不加产品 HTTP 旁路；“未覆盖”= 本分支没有 e2e 覆盖。

| 能力 | 验证方式 | 本次状态 |
| --- | --- | --- |
| 四项检查成功（真 Vite + 真 Chromium，1440×900） | 真实 HTTP | **已执行并通过**（见 §5） |
| 六份证据字节数/sha256/MIME/ETag/no-store/nosniff | 真实 HTTP | **已执行并通过** |
| 未知证据名、路径穿越、未知 run | 真实 HTTP | **已执行并通过**（404 / 403-404 / 404） |
| 未检查不可采用（409 `CHECKS_NOT_PASSED`） | 真实 HTTP | **已执行并通过** |
| 检查通过后采用 + 回退 | 真实 HTTP | **已执行并通过** |
| 检查事件先落盘再广播、序早于采用事件 | 真实 HTTP | **已执行并通过**（`check.finished` seq 20 < `version.changed` seq 21） |
| 收尾证据（PID/OS 创建时间/端口终态/目录清理/优雅 vs 强杀） | 夹具观测 | **已执行并通过**（见 §5 末段） |
| schema 故障 → 后续 not_run + 阻塞原因 | 真实 HTTP | 已编写、收集通过，**未执行** |
| 编译故障 → `build.log` 有真实错误 | 真实 HTTP | 已编写、未执行 |
| 运行错误（未捕获异常）→ `smoke` failed | 真实 HTTP | 已编写、未执行 |
| 遮挡 → `occlusion` failed 且记录命中元素 | 真实 HTTP | 已编写、未执行 |
| 四类故障后服务仍可继续（新候选跑通） | 真实 HTTP | 已编写、未执行 |
| 同身份幂等返回同一 run | 真实 HTTP | 已编写、未执行 |
| 显式 `{rerun:true}` 才新建 run | 真实 HTTP | 已编写、未执行 |
| 严格请求体（非布尔 rerun / 未知字段 / 数组） | 真实 HTTP | 已编写、未执行 |
| 已完成 run 取消不改写 passed | 真实 HTTP | 已编写、未执行 |
| 证据被改后读取 409、采用 409 | 真实 HTTP + 直接改证据文件 | 已编写、未执行 |
| 主版本变化 → B `startChecks` 409 `STALE_CANDIDATE`、`adopt` 409 `CHECKS_NOT_PASSED` | 真实 HTTP | 已编写、未执行（在旧套件 `07-conflict` 里） |
| 运行中取消 → `cancelled`、无晚写 passed | 真实 HTTP | 已编写、未执行 |
| 后端强杀 → 重启后 `SERVICE_RESTARTED`、不自动重跑 | 真实 HTTP + 进程控制 | 已编写、未执行（只证明重启恢复语义，**不**证明自主回收） |
| 两个候选串行（后一个 queued，不并行） | 真实 HTTP | 已编写、未执行 |
| 缺浏览器（隔离 `LOCALAPPDATA` 空目录） | 故障 launcher | 已编写、未执行 |
| 业务预算/超时（180s / 120s / 30s） | — | **未覆盖**：HTTP 不能注入预算，用真实慢构建不可行；由实现侧单测覆盖 |
| executor / toolIdentity / root / env 注入 | — | **未覆盖**，产品也不应提供 HTTP 入口；由实现侧构造参数单测覆盖 |
| 任意 UDP / WebRTC / 子 worker 内部逐包拦截 | — | **未覆盖**：本机 e2e 只证明页面级策略；实现侧已用 Chromium 策略 + 真实 UDP 监听证明零出站，本分支不重复声明 |
| 跨操作系统进程/端口回收 | — | **未覆盖**：只在当前 Windows 环境观测 |

## 5. 本次实际执行：最小单场景预检

范围：**只跑 `01-happy.spec.ts`**（1 个用例），命令
`node node_modules/@playwright/test/cli.js test -c playwright.m3b.config.ts tests/e2e/m3b/01-happy.spec.ts --retries=0 --workers=1`。
（按复核要求改用本仓库已安装的 Playwright CLI，不用 `npx`。）

- 结果：**1 passed（14.1s）**，用例本体 13.3s，无重试、无跳过；
- run `1c4492281c0a4962bd3b706472416bcd`：`completed / passed`，总 6338ms；分项 schema 10ms、build 3562ms、smoke 894ms、occlusion 90ms；
- 六份证据逐份核对字节数与 sha256：`schema.json` 99B、`build.log` 386B、`smoke.png` 105365B、`smoke.json` 324B、`occlusion.png` 105365B、`occlusion.json` 2717B；
- `smoke.json` 是真实检查：静态源 `http://127.0.0.1:24612/`、Chromium `158.0.8127.18`、1440×900、场景 `ready`、购买 `0 → 1`、反馈「已加入购物袋（演示）」、`pageErrors`/`blockedRequests` 皆空；
- `occlusion.json`：4 个可交互目标全部通过，`excluded` 含 `offscreen`（首屏外真被排除），购买入口中心命中自身（5 个采样点）；
- 采用后作品文件与版本号变化、`candidate.decision=adopted`；回退后精确恢复；
- 事件：`check.started / check.updated / check.finished` 与采用事件同一条 EventLog，`check.finished`(20) 早于 `version.changed`(21)；
- **收尾证据** `disposals-01-happy.json`：后端 PID 44108、OS 创建时间 `2026-11-14T15:36:58.1542918Z`、优雅关闭 `code=0 forced=false`、关闭后 30247/56735 端口不可连接、临时目录已删除、`failures: []`。
  （这是"优雅关闭"路径；强杀 fallback、端口残留、目录残留都会记入 `problems` 并让用例失败，不再 `stop().catch(()=>{})` 后删目录继续绿灯。）

## 6. 旧套件迁移（保留原断言，只补“先跑真实检查”）

| 套件 | 改动 |
| --- | --- |
| `m2a/01-flow` | 采用前 `ensureChecksPassed`，并断言四项 passed、`latestCheckRunId` 指向本次 run |
| `m2a/02-discard` | 第二个用例采用前同上 |
| `m2a/04-sandbox` | **先**在链接注入之前拿到真实检查绿灯（`startChecks` 会在锁内审计主作品，注入后会正确拒绝），再验证链接检查仍先拦住采用（`UNSAFE_WORK_TREE`）；移除 junction 后原 200 断言保留 |
| `m2a/07-conflict` | 两个候选各跑一次真实检查 → 采用 A → 对 B 分别验证两条路径（见下） |
| `m2b/01-ui` | 点界面“采用”前，由测试 helper 走真实 checks API（M3-C 未做，不由产品 UI 假装检查完成）；界面“未检查”断言保持在其之前 |
| `m2b/02-takeover` | 采用前同上，断线补拉仍由真实事件驱动 |
| `m3a/01-approvals` | 采用前跑真实检查，原审批/候选/回退断言不变 |
| `real-model/real-model.spec.ts` | 点“采用”前跑真实四项检查；真实十题本身不在本轮执行 |

**`07-conflict` 的语义变化（按实现改正过一次）**：A 采用后，B 的两条路径错误码**不同**：

- `startChecks(B)` → 409 **`STALE_CANDIDATE`**（候选解析阶段先比对主版本）；
- `adopt(B)` → 409 **`CHECKS_NOT_PASSED`**（`work/service.ts:650-657` 把 adopt 的“证明失效”统一归一）。

上一版把 adopt 写成 `STALE_CANDIDATE` 是错的，已按实现改正，并**不改产品来迎合测试**。
`MERGE_CONFLICT` 因此不再是公共 API 可达行为（实现内部仍保留兜底）。
原「主线不变 / 无半合并 / 候选仍 pending / 可撤回 / 可回退」断言全部保留。

## 7. 完整回归入口（本轮未启动）

`tests/e2e/m3b/full-regression.mjs`（按 Codex 复核要求重写）：

- 顺序：`pnpm typecheck` → `pnpm build` → `pnpm test` → 旧七套 E2E（M0-B/M0-A/M1-A/M1-B/M2-A/M2-B/M3-A）→ M3-B；首败即停、`--retries=0`、不做任何过滤。
- **身份门禁用真实字节**：已跟踪产品文件逐文件 SHA256 + `pnpm-lock.yaml` SHA256 + 工作区脏/未跟踪状态 + HEAD，逐步前后比较；任一项变化即判该步失败并停止（不再只看 index 摘要）。
- 所有 git 调用都带 `-c core.longpaths=true`；**非零退出直接抛错**，不把 stderr 当合法输出。
- `--collect` **只收集**（只跑各套件 `--list`），不再附带 typecheck/build/单测。
- Playwright 用仓库内 `node_modules/@playwright/test/cli.js`，不用可能触发下载的 `npx`。
- 每套原始 JSON 与 `outputDir` 定向到本次 run 目录（`PLAYWRIGHT_JSON_OUTPUT_NAME` + `--output=`），跑完解析报告核对
  `errors / stats.expected / stats.unexpected / stats.skipped / stats.flaky / 每个用例状态与重试`，不只看退出码。
- 运行环境按显式白名单构造（不继承、不打印整个 `process.env`）；继续 fake key / loopback / 现有出站守卫。
- 已归档 tracked 证据若被套件刷新，记录并 `git checkout --` 按 blob 还原，结果写进 manifest。

## 8. 过程中发现并修正的四件事

1. **测试侧错误（非产品缺陷）**：首轮预检 `POST /candidates/:id/checks` 得到 400 `INVALID_INPUT`「检查请求体必须是对象」。
   原因是助手在“无请求体”时发了空字符串 `body: ''`；产品严格拒绝非对象请求体是正确合同。已改成“真的不发 body”并加注释。
2. **超长历史证据路径**：见 §1，需要 `core.longpaths`，否则工作树建不出来、`git status` 会误报。
3. **默认套件会覆写 tracked 证据**：收集时 `docs/reports/artifacts/M0-B/playwright-results.json` 被写成本次 `--list` 的内容。
   本轮已把刷新后的字节（22220B，sha256 `970cef08…`）另存为 `acceptance-precheck/collection-refresh/m0b-playwright-results.bytes.json`，
   再按 blob 还原；`collection-verification.json` 记录 head blob（8556B，`2029ec30…`）与还原结果。
4. **比较还原结果不能用“字节 sha256”**：`core.autocrlf` 会让工作区（CRLF，8840B）与 blob（LF，8556B）字节不同。
   正确做法是比对 git 归一化对象 id（`git rev-parse HEAD:<path>` 与 `git hash-object --path=<path> <file>`），并要求 `git status` 该路径为空。
   第一版脚本在这里判了“还原失败”，是校验写法错，不是数据损坏——已改正并把两种数字都留档，避免后人误读。

## 9. 结论（不含验收声明）

- 测试侧接线**已就绪**：M3-B 收集 7 例/4 文件，默认 M0-B 收集 24 例/4 文件且已排除 `m3b`/`real-model`；两次收集 exit=0。
- 一次最小单场景真实检查预检**通过**（1 passed，13.3s，真实 Chromium 与六份证据、收尾证据齐全）。
- 其余 6 个 M3-B 用例、以及迁移后的旧七套用例**尚未执行**，本文不声称它们通过。
- **M3-B 未通过、M3 未完成、项目未完成**，本分支不合并。下一步按原门禁：Claude 修后复核 `6f6ff49` → Codex 合并冻结 → Pi 正式完整回归（含本文全部未执行项）。
