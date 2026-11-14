# M3-B 正式验收报告（Pi 独立测试与验收）

**结论：M3-B 验收不通过。**

失败集中在 M3-B 自己新写的 3 个用例（`02-faults` / `03-gate` / `04-lifecycle`），**三例的根因都在验收分支（`test/m3b-acceptance`）的测试侧，未发现产品代码缺陷**：
其中 1 例是导入写错（`sleep` 未从 `fixture.ts` 导出）、1 例断言与已定语义相反（`adopt` 的过期候选错误码）、1 例的故障前提在产品设计上不可达（沙箱拒绝写入非法 `scene.config.json`）。
受影响的产品行为本身没有一处被证伪：旧七套 E2E 139/139、typecheck、build、全量单测 422/422 全部实际通过。

> 本文是**正式验收报告**，不是 `M3-B-test-preparation.md` 的补丁；准备报告里的"验收准备"口径与本文的正式判定互不替代。

---

## 1. 受测冻结身份

| 项 | 值 |
| --- | --- |
| 工作树 | `E:\空间化AI工作台\.worktrees\m3b-acceptance` |
| 分支 | `test/m3b-acceptance`（本轮 `git -c core.longpaths=true merge master` 合入 `0f3a734`/`cf80bb3`） |
| 受测 HEAD | `65e2e0b37f47fed9b482815770080e742b642e85`（跑前提交，跑动过程中未改动） |
| 身份摘要 digest | `17c9997734ce`（产品 + `tests/e2e` + `playwright*.ts` + `package.json`/workspace/lock 的真实字节 SHA256 汇总） |
| 锁文件摘要 | `67af36b7a1b8` |
| 身份脏状态 | `identity.dirty = []`（轮内无脏文件） |
| 冻结实现 | `.worktrees/m3b`，`feat/m3b-checks`，`6f6ff49`（修后复核报告的受审对象） |

**产品树与锁的零差异核对（本轮亲自重跑，不引用旧结论）**

```
git rev-parse HEAD                                   → 65e2e0b37f47fed9b482815770080e742b642e85
git diff 6f6ff49 -- apps packages templates          → 0 行
git diff 0f3a734 -- apps packages templates          → 0 行
git diff 6f6ff49 -- pnpm-lock.yaml                   → 0 行
git rev-parse 6f6ff49:apps                           → adeb7396b6e5…
git rev-parse HEAD:apps                              → adeb7396b6e5…
```

即：受测产品字节 = 独立修后复核通过的 `6f6ff49` = master 合并后的 `0f3a734`，三者的 `apps/` 树对象 id 完全一致（`adeb7396b6e5`）。

**`fallback/` 的说明（不污染受测身份）**：M0-A 的 mock Lux3D 用 `tests/e2e/m0a/env.ts:22` 的 `MOCK_FIXTURE = <repo>/fallback/lux3d-4969293.glb`，而 `fallback/` 是**未跟踪素材**（项目约定不入库），`git worktree add` 出来的工作树天然没有它。
本轮把主树 `fallback/` 的 8 个文件复制进工作树（`lux3d-4969293.glb` 13,345,788B sha256 `7770579BB7DEB288…`、`lux3d-split-4969889.glb` 11,192,096B `239B77D757CD50B3…` 等）。
它**未提交、不在身份摘要路径内**（`apps`/`packages`/`templates`/`tests/e2e`/`playwright*.ts`/`package.json`/workspace/lock），机器证据是 `identity.dirty = []`；`git status` 里它只以 `?? fallback/` 出现。

## 2. 环境

| 项 | 值 |
| --- | --- |
| Node | v24.14.1 |
| pnpm | 11.17.0 |
| Chromium | 158.0.8127.18（Playwright 启动时打印） |
| 浏览器目录 | `PLAYWRIGHT_BROWSERS_PATH=C:\Users\Admin\AppData\Local\ms-playwright` |
| 系统 | Windows，仓库存放在含中文路径的根目录（所有 git 调用带 `-c core.longpaths=true`） |
| 依赖 | `pnpm install --offline --frozen-lockfile` → Already up to date，**0 下载** |
| 安全边界 | 编码上游为 loopback mock（`127.0.0.1:4011`，fake key）；Lux3D 指 `127.0.0.1:4019`（无人监听）；带 `tests/e2e/m0a/no-real-network.cjs` 出站守卫；未读 `.env`、无付费调用 |

## 3. 入口与判据（不放宽）

入口：`tests/e2e/m3b/full-regression.mjs`（正式入口，顺序执行、首败即停）。

```
node tests/e2e/m3b/full-regression.mjs
```

- 顺序：`pnpm typecheck` → `pnpm build` → `pnpm test`（全量单测）→ 旧七套 E2E → M3-B；
- 每套 E2E 以 `node node_modules/@playwright/test/cli.js test [-c <config>] --retries=0 --workers=1 --reporter=list,json --output=<新 run 目录>` 执行，JSON 报告定向到本次 run 目录（不写进各套件 config 里固定的历史路径）；
- 判据（`runner-support.mjs#verifyPlaywrightReport`，本轮又用独立的 `finalize-evidence.mjs` 复算了一遍）：三层状态分别检查 `expectedStatus=passed` / `test.status=expected` / `results[0].status=passed`；每例**恰好 1 条 result 且 `retry=0`**；拒绝 `skipped`/`expected-failed`/`flaky`/顶层 `errors` 非空/`stats.unexpected|skipped|flaky ≠ 0`；递归 `suite.suites` 统计真实 test 记录并与 `stats.expected` 对数；0/0 也算失败；
- 身份门禁：run 起点建立 baseline，每一步 before/after 都比对真实字节，偏离即该步失败并停止；
- 历史证据：本步被刷新的 tracked 证据先归档新字节与哈希，再按 **git 对象 id** 还原（`git rev-parse HEAD:<path>` vs `git hash-object --path`），并要求该路径 `git status --porcelain` 为空；
- 完成屏障：只以 `close` + 日志 stream flush 结束，spawn `ENOENT` 也照样有界结束并记录。

**收集口径**（`full-regression.mjs --collect`，exit 0，8 步全过）：m0b 24 / m0a 27 / m1a 7 / m1b 23 / m2a 35 / m2b 12 / m3a 11 / m3b 7 = **146**；旧七套合计 **139**，与 M3-A 收口基线一致。

## 4. 正式回归结果（run#3：`2026-11-14T16-43-45-146Z-full`）

| 步骤 | 结果 | 用例数 | 耗时 | 备注 |
| --- | --- | --- | --- | --- |
| typecheck | 通过 | — | 5.5s | exit 0 |
| build | 通过 | — | 7.8s | exit 0 |
| unit | 通过 | **422 passed / 0 failed** | 183.8s | server 321、shared 68、vite-plugin-source-tag 20、studio 7、scene-renderer 5、bridge 1 |
| e2e-m0b | 通过 | 24/24 | 58.5s | 21 份 tracked 证据刷新后按 blob 还原 |
| e2e-m0a | 通过 | 27/27 | 73.2s | 28 份证据归档还原 |
| e2e-m1a | 通过 | 7/7 | 44.9s | 7 份 |
| e2e-m1b | 通过 | 23/23 | 93.7s | 23 份 |
| e2e-m2a | 通过 | 35/35 | 205.4s | 35 份 |
| e2e-m2b | 通过 | 12/12 | 75.6s | 12 份 |
| e2e-m3a | 通过 | 11/11 | 64.2s | — |
| **e2e-m3b** | **不通过** | 7 收集：1 passed / **3 failed** / 3 skipped | 53.0s | 见 §6 |

旧七套合计 **139/139 全通过、0 retry、0 skip、0 flaky、errors 为空**。所有被刷新的 tracked 证据都先归档再按 blob 还原，还原后该路径 `git status` 为空（对象 id 逐个比对，不用工作区字节 sha256，避免 `core.autocrlf` 误判）。

## 5. 三轮 run 的时间线与作废判定（**不是产品失败**）

| 轮次 | 目录 | 结果 | 原因 | 判定 |
| --- | --- | --- | --- | --- |
| run#1 | `regression/2026-11-14T16-20-27-242Z-full` | 失败于 `e2e-m0b` | 我方启动命令 `set PLAYWRIGHT_BROWSERS_PATH=%LOCALAPPDATA%\ms-playwright && …` 让 cmd 把 `&&` 前的空格并入变量值，路径变成 `…\ms-playwright \chromium_headless_shell-1254\…` | **作废（入口环境错误）** |
| run#2 | `regression/2026-11-14T16-25-33-369Z-full` | 失败于 `e2e-m0a` | 工作树缺未跟踪素材 `fallback/lux3d-4969293.glb`，mock 下载端点回 500 | **作废（环境缺输入素材）** |
| run#3 | `regression/2026-11-14T16-43-45-146Z-full` | 失败于 `e2e-m3b` | 验收分支 3 个用例的测试侧缺陷（§6） | **本轮正式判定依据** |

run#1 证据：`e2e-m0b.log` 中 22 例失败信息全部是 `Executable doesn't exist at C:\Users\Admin\AppData\Local\ms-playwright \chromium_headless_shell-1254\…`（注意 `ms-playwright` 后的空格），通过的 2 例恰好是不启动浏览器的用例；同轮 typecheck/build/unit 均 exit 0。
run#2 证据：`.data/pi-m0a/assets/index.json` 里 10 条记录全是 `"error": { "code": "DOWNLOAD_HTTP", "message": "模型下载返回 HTTP 500" }`；用例表现是 `polling → failed` 且每例挂满 1 分钟。修法是复制 `fallback/`，直接验证 mock 的 `GET /output/model.glb` 从 500 变为 `200`、13,345,788 字节、`model/gltf-binary`。
两轮原件全部保留在各自 run 目录（日志、Playwright JSON、`error-context.md`），未删除、未改写；本报告不对它们做任何"通过"推断。

## 6. M3-B 三例失败的逐条分析（**全部为测试侧缺陷**）

### 6.1 `02-faults.spec.ts` — 任务没产出候选（schema 故障前提不可达）

- 现象：`Error: 任务没有产出候选：{… "status":"failed" …}`，2.6s 就失败（不是超时）。
- 原因：用例 `02-faults.spec.ts:17-19` 的 `SCHEMA_FAULT` 用 agent 的 `write_file` 往 `src/scene.config.json` 写 `{"hero": {"lights": `（非法 JSON）。但产品沙箱对这个文件有**显式校验**：`apps/server/src/agent/tools.ts:86-89` 要求 `scene.config.json` 必须是合法 JSON 且符合 `isSceneConfig` 约定，否则抛 `ToolError('scene.config.json 必须是合法 JSON')` → agent 工具调用失败 → 任务 `failed`，因此根本不会产生候选。
- 也堵死了"绕过 agent 直接改候选工作树"这条路：`apps/server/src/checks/runner.ts:246` 在发起检查时比对 `snapshot.digest` 与候选 `contentDigest`，不一致直接 409 `SNAPSHOT_MISMATCH`；`:417` 还会在结束时再比一次。
- 结论：**这不是产品缺陷**（沙箱拒绝写入非法场景配置、"候选字节变了就不检查"都是想要的行为）。是验收用例的故障构造前提在产品支持面上**不可达**。
- 整改建议（择一，由编排侧定）：① 把"schema 检查失败"的 E2E 用例改为**标注为不可达/删除**，并在报告中明确该项由实现侧注入故障的单测/集成测试覆盖（实现侧 `checks` 单测已有 `INVALID_JSON` 路径）；② 若坚持要 E2E 覆盖，需要产品提供一个受支持的测试注入点（这会动产品，不属于测试侧整改）。

### 6.2 `03-gate.spec.ts` — 过期候选 `adopt` 的错误码断言与已定语义相反

- 现象：`Expected: "STALE_CANDIDATE" / Received: "CHECKS_NOT_PASSED"`（`03-gate.spec.ts:129`）。
- 原因：产品的 `adopt` 在 `apps/server/src/work/service.ts:657` 把"证明失效"统一归一为 409 `CHECKS_NOT_PASSED`；而 `startChecks` 才在候选解析阶段返回 `STALE_CANDIDATE`。这条语义是本轮之前就定过的，并已写进迁移后的 `tests/e2e/m2a/07-conflict.spec.ts:12,56,63`（该套件在本轮 run#3 **实际 35/35 通过**，同一轮同一条产品行为被断言为 `CHECKS_NOT_PASSED`）。
- 结论：**不是产品缺陷**，是 `03-gate.spec.ts:129` 这条断言写错（与产品实现、与同轮通过的 `07-conflict` 都矛盾）。
- 整改建议：把该断言的期望改为 `CHECKS_NOT_PASSED`（409 不变），并在注释里写明与 `startChecks → STALE_CANDIDATE` 的区别。**本轮未改动它**——它是断言，按"不改已有断言来凑绿"的要求，交由编排侧批准后再改。

### 6.3 `04-lifecycle.spec.ts` — `sleep` 从 `fixture.ts` 导入但未被导出（导入写错）

- 现象：`TypeError: (0 , _fixture.sleep) is not a function`（`04-lifecycle.spec.ts:60`）。
- 原因：`04-lifecycle.spec.ts:10` 从 `./fixture` 导入 `sleep`，但 `fixture.ts:315` 的导出列表只有 `getCheckRun / waitCheckRun / startChecks / getCandidate`，`sleep` 只是 `fixture.ts` 内部从 `./checks` 导入、没有转出。Playwright 转译不做类型检查，`pnpm typecheck` 又只覆盖 `apps/`、`packages/`，所以直到实跑才暴露。
- 连带影响：该 spec 是 serial 模式，第一例失败后其余 3 例被跳过 → `stats.skipped=3`（不是用例主动 skip）。
- 结论：**不是产品缺陷**，是测试侧导入缺失（这也正是"此前 02/03/04 从未执行"的代价：这类错误只有实跑才现形）。
- 整改建议：`04-lifecycle.spec.ts` 改为从 `./checks` 导入 `sleep`（或让 `fixture.ts` 显式再导出）。

## 7. 证据与独立复算

证据根目录：`docs/reports/artifacts/M3-B/formal-20261115/`

| 子目录 | 内容 |
| --- | --- |
| `checks/` | 各 spec 的结构化证据：`happy-path.json`、`disposals-{01-happy,02-faults,03-gate,04-lifecycle}.json` |
| `checks/evidence-01-happy/` | 01-happy 运行中通过 HTTP 取回并**原样落盘**的六份检查证据：`schema.json` 99B、`build.log` 386B、`smoke.png` 105,365B、`smoke.json` 324B、`occlusion.png` 105,365B、`occlusion.json` 2,718B |
| `regression/<run>/` | 每轮 run 的 `manifest.json`/`manifest.log`、各步日志、Playwright JSON 与 `--output` 目录（含失败截图/`error-context.md`）、`evidence-refresh/`（被刷新的 tracked 证据新字节） |
| `sha256-manifest.json` | 全目录逐文件 sha256 与字节数（275 个文件，1,864,605 字节），外加下述三项复查结果 |

独立复算（`node tests/e2e/m3b/finalize-evidence.mjs`，exit 0，`problems: []`）：

1. **六份检查证据复算 sha256 全部与 `happy-path.json` 记录一致**（字节数也一致）；
2. **11 份 Playwright JSON 报告用同一判据重新验了一遍**（不信任 manifest 的旧结论）：run#3 的 8 份中 7 份 `ok=true`，`e2e-m3b` 为 `ok=false`（`exp=1 / unexp=3 / skip=3`，与 §6 一致）；run#1（m0b `unexp=22`）与 run#2（m0a `unexp=10`）确实为失败原件；
3. **4 份收尾证据干净**：每份 `failures: []`、`graceful.code = 0 且 forced = false`、`stillListening: []`、`dirRemoved: true`、`problems: []`，记录了后端 PID、OS 进程创建时间、base/preview 端口。

## 8. 资源回收

- 全部 worker / 浏览器 / 静态源 / 预览进程均已结束；本轮结束后核对端口 **3001 / 3050 / 4011 / 4019 / 5173 / 5174 / 5175 / 24612 / 24613 全部无监听**；
- `.data/` 下**没有** `m3b-*` 残留目录（四个 M3-B 夹具都 `dirRemoved: true`）；
- `git -c core.longpaths=true status --porcelain` 只剩本轮新增的未跟踪证据目录与 `?? fallback/`（输入素材，见 §1），tracked 文件干净。

## 9. 未覆盖项（如实列出，不因其它项通过而淡化）

1. `02-faults` 的 **schema 故障路径**在 HTTP 支持面上不可达（§6.1），本轮未获得任何 E2E 证据；
2. `03-gate` / `04-lifecycle` 里失败点**之后**的断言本轮没有执行证据（03-gate 在 29.1s 处失败于第 129 行；04-lifecycle 后 3 例被 serial 跳过）；
3. 真实"taskkill 被拒"的端到端清理失败路径仍未实测（复核方已注明，本轮也没构造出来）；
4. 业务预算/超时（180s/120s/30s）、executor/toolIdentity/root/env 注入仍只由实现侧单测覆盖，HTTP 无注入面；
5. 任意 UDP / WebRTC 的子 worker 逐包拦截：本机 E2E 只证明页面级策略，未重复实现侧的真实 UDP 监听证明；
6. 仅 Windows + Chromium 158，未覆盖跨操作系统进程/端口回收与其它浏览器。

## 10. 其它观察（不影响判定）

- `runner-support.mjs` 的 `stats.expected === 实际用例数` 这一条在**已经失败**的报告里必然不成立（`stats.expected` 只统计通过数），于是会多打一条级联 problem。判据本身没问题（`stats.unexpected ≠ 0` 已先拒），但读失败报告时容易被误导，建议后续把措辞改成"全绿时两者应相等"。本轮未改该模块（保持与自验 9/9 通过的那份字节一致）。
- `bg.cmd` 传命令时，cmd 批处理层会剥掉双引号并提前展开 `%VAR%`，因此长命令要用"无引号 + `&&` 紧贴 value"的写法（run#1 就是踩这里）。

## 11. 建议（整改清单，按优先级）

1. **必修**：`04-lifecycle.spec.ts` 的 `sleep` 导入改从 `./checks` 取（1 行）。
2. **必修（需批准）**：`03-gate.spec.ts:129` 的期望改为 `CHECKS_NOT_PASSED`，与产品实现和已通过的 `m2a/07-conflict` 对齐。
3. **需决策**：`02-faults` 的 schema 故障用例——标为不可达并改由实现侧故障注入覆盖，或删除该子场景；不要为了让它变绿而在产品里加测试后门。
4. **建议**：M0-A 的 harness 在启动 mock/fixture 前断言 `MOCK_FIXTURE` 存在（缺失立即以入口错误失败，而不是让每例挂 60–120s 超时后再报）；并评估把该素材换成入库的小体积 fixture，避免"工作树缺未跟踪素材"这类环境事故再次伪装成产品失败。
5. **建议**：`full-regression.mjs` 在 run 起点打印 `PLAYWRIGHT_BROWSERS_PATH` 的实际值并断言其头号目录存在（run#1 那类尾空格错误可以 1 行断言拦下）。

## 12. 一句话总结

受测产品字节（`6f6ff49` = `0f3a734` = HEAD `65e2e0b`，`apps` 树 id 一致）在 typecheck、build、422 项单测与旧七套 139 项 E2E 上全部通过；M3-B 自身 7 例中 1 例通过、3 例失败、3 例被跳过，三例失败的根因全部在验收分支的测试侧（导入错误 / 断言与已定语义相反 / 故障前提不可达），**未发现产品缺陷**。因此 **M3-B 验收不通过**，等整改后重跑同口径完整回归。
