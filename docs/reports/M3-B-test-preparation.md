# M3-B 验收准备（Pi 独立测试侧的接线与预检，**不是验收结论**）

> 状态：**验收准备**。本文件所在分支 `test/m3b-acceptance` 不合并、不改产品；
> M3-B **尚未通过**，正式门禁仍是「Claude 对 `6f6ff49` 的修后复核通过 → Codex 合并冻结 → Pi 正式完整回归」。
> 本文所有结论只覆盖「测试侧接线是否就绪」和「一次最小单场景预检」。

## 1. 分支与身份

| 项 | 值 |
| --- | --- |
| 工作树 | `E:\空间化AI工作台\.worktrees\m3b-acceptance` |
| 分支 | `test/m3b-acceptance`（从 `6f6ff494995eb2a77b0fdbac86367d15c259bce2` 派生） |
| 冻结实现工作树 | `.worktrees/m3b`（`feat/m3b-checks`，HEAD `6f6ff49`，本分支只读引用，未改动） |
| 主线 | `master`（`cbadee3…`），本分支不改主线、不 merge |
| 依赖 | `pnpm install --offline --frozen-lockfile`：**248 个包全部命中本地缓存、0 下载、0 升级**（1.3s） |

**产品与依赖无差异证明**（相对 `6f6ff49`）：

- `git diff 6f6ff49 -- apps packages templates` → **0 个差异块**；
- `git diff 6f6ff49 -- pnpm-lock.yaml` → **0 行**；
- `package.json` 只多一条脚本 `test:e2e:m3b`，`devDependencies` 未变。

**一个环境事实**：本仓库库里有一条历史 tracked 证据的路径长 232 字符，工作树根再叠加该路径会超过 Windows `MAX_PATH`。
所以本工作树用 `git -c core.longpaths=true worktree add …` 建出，缺失的那个文件已按 blob 逐字节还原。
后果：**在本工作树里必须带 `-c core.longpaths=true` 执行 `git status/diff`**，否则普通 `git status` 会因读不到那条超长路径而误报一条 `M`（不是真实改动）。

## 2. 环境与安全边界

- 编码上游：`tests/e2e/m2a/agent-mock.mjs`（loopback `127.0.0.1:4011`，fake key `mock-only`），**无任何真实模型调用**；
- Lux3D：`http://127.0.0.1:4019`（无人监听），不发真实生成请求；
- 后端：与产品同一 `createApp()`，由 `tests/e2e/m2a/start-backend.mjs` 启动，带 `tests/e2e/m0a/no-real-network.cjs` 出站守卫；
- 作品目录：每个用例 `createWorkRoot()` 复制模板 `src`/`public`（逐文件复制）到隔离目录，`node_modules` 走 junction；**不碰 `templates/product-page`**；
- 未读取 `apps/server/.env`、`orbital/ASKS.md` 或任何凭据；未新增付费调用。

## 3. 交付物

| 文件 | 作用 |
| --- | --- |
| `playwright.m3b.config.ts` | M3-B 专用配置：单 worker、0 retry、`forbidOnly`、无 `webServer`（用例自起隔离后端） |
| `tests/e2e/m3b/checks.ts` | 四个检查接口助手 + `waitCheckRun`（等本次 run 精确终态）+ `assertPassedRun`（四项 passed + 六份证据）+ `ensureChecksPassed`（旧套件迁移入口） |
| `tests/e2e/m3b/fixture.ts` | 隔离后端/作品副本/mock 上游夹具；支持优雅停机、强制杀进程树、同 dataDir 重启；候选创建绑定本次 POST 返回的精确 id |
| `tests/e2e/m3b/01-happy.spec.ts` | 成功路径：真实四项检查 → 证据 → 采用 → 回退 |
| `tests/e2e/m3b/02-faults.spec.ts` | 四类真实故障：schema / 编译 / 运行错误 / 遮挡 |
| `tests/e2e/m3b/03-gate.spec.ts` | 门禁与身份：幂等、显式 rerun、严格请求体、证据篡改、主版本过期 |
| `tests/e2e/m3b/04-lifecycle.spec.ts` | 取消 / 强杀重启恢复 / 跨候选串行 / 缺浏览器 |
| `tests/e2e/m3b/full-regression.mjs` | 未来完整回归的顺序入口（本轮**未启动**） |
| `package.json` | 新增 `test:e2e:m3b` 脚本 |
| `playwright.config.ts` | 默认 M0-B 收集新增 `**/m3b/**` 排除，既有排除不变 |

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
| 主版本变化 → 旧绿灯 `STALE_CANDIDATE` | 真实 HTTP + 直接改一行作品文件 | 已编写、未执行 |
| 运行中取消 → `cancelled`、无晚写 passed | 真实 HTTP | 已编写、未执行 |
| 后端强杀 → 重启后 `SERVICE_RESTARTED`、不自动重跑 | 真实 HTTP + 进程控制 | 已编写、未执行 |
| 两个候选串行（后一个 queued，不并行） | 真实 HTTP | 已编写、未执行 |
| 缺浏览器（`LOCALAPPDATA` 指向空目录的故障 launcher） | 故障 launcher | 已编写、未执行 |
| 业务预算/超时（180s / 120s / 30s） | — | **未覆盖**：HTTP 不能注入预算，故意用真实慢构建不可行；由实现侧单测覆盖 |
| executor / toolIdentity / root / env 注入 | — | **未覆盖**，且产品正确做法是**不**提供 HTTP 入口；由实现侧构造参数单测覆盖 |
| 任意 UDP / WebRTC / 子 worker 内部逐包拦截 | — | **未覆盖**：本机 e2e 只证明页面级策略；实现侧已用 Chromium 策略 + 真实 UDP 监听证明零出站（`review-fixes-20261114`），本分支不重复声明 |
| 跨操作系统进程/端口回收 | — | **未覆盖**：只在当前 Windows 环境观测 |

## 5. 本次实际执行：最小单场景预检

范围：**只跑 `01-happy.spec.ts`**（1 个用例），命令
`npx playwright test -c playwright.m3b.config.ts tests/e2e/m3b/01-happy.spec.ts --retries=0 --workers=1`。

- 结果：**1 passed（14.5s）**，用例本体 13.5s，无重试、无跳过；
- run `448432e5fa184c5296269d228b98a8f6`：`completed / passed`，总 6460ms；分项 schema 10ms、build 3672ms、smoke 884ms、occlusion 93ms；
- 六份证据全部落盘并被逐份校验字节数与 sha256：`schema.json` 99B、`build.log` 386B、`smoke.png` 105365B、`smoke.json` 324B、`occlusion.png` 105365B、`occlusion.json` 2717B；
- `smoke.json` 是真实检查：静态源 `http://127.0.0.1:59261/`、Chromium `158.0.8127.18`、1440×900、场景 `ready`、购买 `0 → 1`、反馈「已加入购物袋（演示）」、`pageErrors`/`blockedRequests` 皆空；
- `occlusion.json`：4 个可交互目标全部通过，`excluded` 有 `offscreen`（首屏外真被排除），购买入口中心命中自身；
- 采用后作品文件变化、版本号变化、`candidate.decision=adopted`；回退后文件与文案精确恢复；
- 事件：`check.started / check.updated / check.finished` 与采用事件同一条 EventLog，`check.finished`(20) 早于 `version.changed`(21)；
- 证据：`docs/reports/artifacts/M3-B/acceptance-precheck/happy-path.json`、`playwright-results.json`、`output/`。

**收尾核对**：跑完 `.worktrees/m3b-acceptance/.data` 已清空；3001/4011/5173/5174/5175 无监听；本工作树无残留 `node`/`chrome` 子进程；`templates/product-page` 未被改动。

## 6. 旧套件迁移（保留原断言，只补“先跑真实检查”）

| 套件 | 改动 |
| --- | --- |
| `m2a/01-flow` | 采用前 `ensureChecksPassed`，并断言四项 passed、`latestCheckRunId` 指向本次 run |
| `m2a/02-discard` | 第二个用例采用前同上 |
| `m2a/04-sandbox` | **先**拿到一次真实检查绿灯，再验证链接检查仍先拦住采用（`UNSAFE_WORK_TREE`），移除 junction 后原 200 断言保留 |
| `m2a/07-conflict` | 两个候选各跑一次真实检查，再继续原冲突/无半合并/可撤回断言 |
| `m2b/01-ui` | 点界面“采用”前，由测试 helper 走真实 checks API（M3-C 未做，不由产品 UI 假装检查完成）；界面“未检查”断言保持在其之前 |
| `m2b/02-takeover` | 采用前同上，断线补拉仍由真实事件驱动 |
| `m3a/01-approvals` | 采用前跑真实检查，原审批/候选/回退断言不变 |
| `real-model/real-model.spec.ts` | 点“采用”前跑真实四项检查；真实十题验收本身不在本轮执行 |

**一处必须写明的语义变化**：`07-conflict` 里第二个候选现在先被 **`STALE_CANDIDATE`** 拒绝。
原因：M3-B 采用门禁在合并前先比对主版本（`mainVersion !== baseVersion` 即拒绝），A 采用后 B 的绿灯已属旧基线。
`MERGE_CONFLICT` 因此不再是公共 API 可达的对外行为（实现内部仍保留兜底）。
这不是把断言改松：原「409 / 主线不变 / 无半合并 / 候选仍 pending / 可撤回 / 可回退」全部保留，只是拒绝码按新合同更新。

## 7. 完整回归入口（本轮未启动）

`tests/e2e/m3b/full-regression.mjs`：

- 顺序：`pnpm typecheck` → `pnpm build` → `pnpm test` → 旧七套 E2E（M0-B/M0-A/M1-A/M1-B/M2-A/M2-B/M3-A）→ M3-B；
- 首败即停、`--retries=0`、不做 `--only/--grep` 过滤；
- 每次运行独立目录 `docs/reports/artifacts/M3-B/full-regression/<runId>/`，逐步记录 HEAD/分支/工作区/产品 index 摘要/锁文件 hash/PID/起止时间/退出码与原始日志；
- **重要修正**：每个套件都必须把 reporter JSON 和 `outputDir` 重定向到本次 run 目录（脚本已用 `PLAYWRIGHT_JSON_OUTPUT_NAME` 与 `--output=` 做到），否则会覆写仓库里已归档的 tracked 证据。

支持 `--collect` 只做收集验证。**本轮没有启动它**：正式完整回归要等 Claude 修后复核通过、实现合并冻结之后再做。

## 8. 过程中发现的三件事

1. **测试侧错误（非产品缺陷）**：预检首轮 `POST /candidates/:id/checks` 得到 400 `INVALID_INPUT`「检查请求体必须是对象」。
   原因是我的助手在“无请求体”时发了空字符串 `body: ''`。产品的严格合同是正确的：空 body 应“不发 body”，不应发空串。已修正助手并加注释；不记产品缺陷。
2. **超长历史证据路径**：见 §1，需要 `core.longpaths`，否则工作树建不出来、`git status` 会误报。给后续在 Windows 上新开工作树的人一个提醒。
3. **默认套件会覆写 tracked 证据**：跑默认 M0-B 收集时，`docs/reports/artifacts/M0-B/playwright-results.json` 被上游配置写成了本次结果。已按 blob 原样还原（未覆盖旧证据，也未把它当作新证据）。这也是 §7 强制重定向的原因。

## 9. 结论（不含验收声明）

- 测试侧接线**已就绪**：M3-B 套件收集 7 例/4 文件，默认 M0-B 收集 24 例/4 文件且已排除 `m3b`/`real-model`；
- 一次最小单场景真实检查预检**通过**（1 passed，13.5s，真实 Chromium 与六份证据）；
- 其余 6 个 M3-B 用例与旧七套迁移后的用例**尚未执行**，本轮不声称它们通过；
- **M3-B 未通过、M3 未完成、项目未完成**，本分支不合并。下一步按原门禁：Claude 修后复核 `6f6ff49` → Codex 合并冻结 → Pi 正式完整回归（含本节全部未执行项）。
