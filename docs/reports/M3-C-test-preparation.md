# M3-C 独立验收准备报告（Pi）

状态：**验收准备，未跑正式全量，未宣称任何通过。**
本轮只做可并行准备：建隔离验收树、按 real/mock 分表把设计点名的必测项落成用例、用 `--list` 固定真实收集到的例数。正式轮次等调度确认最终冻结提交号后另行派发。

## 1. 隔离验收树

| 项 | 值 |
| --- | --- |
| 工作树 | `E:\空间化AI工作台\.worktrees\m3c-acceptance` |
| 分支 | `test/m3c-acceptance`（从实现冻结候选 `5edaa22` 起） |
| 实现树（只读，不改） | `.worktrees/m3c`，分支 `feat/m3c-approval`，当前 `5edaa22` |
| 主工作树 | 未改动；产品代码、锁、`templates/`、既有测试与证据一律未改 |
| 依赖 | `pnpm install --offline --frozen-lockfile`（exit 0，248 包全部来自本地 store，0 下载） |

最终冻结提交号以调度下一条指令为准；若冻结号变化，本套件需在**新的受测 HEAD** 上重新 `--list` 并复核一遍断言是否仍成立（尤其是 C3 三条应修的修法）。

## 2. 新增文件清单（全部由 Pi 提交，实现者不得代写）

```
playwright.m3c.config.ts                        # 独立配置：4 个 webServer（mock 编码上游 + 被测后端 + Studio + 模板预览源）
tests/e2e/m3c/env.ts                            # 端口/路径沿用 M2-A 形状，工作数据另用 .data/pi-m3c
tests/e2e/m3c/artifact.ts                       # 结构化证据落到 docs/reports/artifacts/M3-C/
tests/e2e/m3c/support.ts                        # real UI 公共动作（点选/提交/请示卡/overlay 计数/检查/证据/收尾）
tests/e2e/m3c/01-approval.spec.ts               # real：请示与影响模式（8 例）
tests/e2e/m3c/02-checks-adopt.spec.ts           # real：真实检查、证据、采用门禁、采用/回退（8 例）
tests/e2e/m3c/03-failures.spec.ts               # real：真实构建/运行/遮挡失败（3 例）
tests/e2e/m3c/04-mock-boundaries.spec.ts        # mock：截断/迟到/响应丢失/缺证据/409/恶意文本（8 例）
tests/e2e/m3c/full-regression.mjs               # 正式轮入口（与 M3-B 同形状，12 步；见 §3.1）
```

另有一处**测试配置**改动：`playwright.config.ts` 的 `testIgnore` 增加 `**/m3c/**`，否则 M0-B 的默认 `testDir: './tests/e2e'` 递归收集会把本套件一起收进来（这是 M0-B 早年踩过的老问题）。

## 3.1 正式轮入口（第 12 步）与总例数

新增 `tests/e2e/m3c/full-regression.mjs`，与 M3-B 的 `tests/e2e/m3b/full-regression.mjs` **同形状**，只把证据根换成 M3-C、并多一个第 12 步：

```
typecheck → build → unit → e2e-m0b → e2e-m0a → e2e-m1a → e2e-m1b
          → e2e-m2a → e2e-m2b → e2e-m3a → e2e-m3b → e2e-m3c（新增）
```

为什么另起一份而不改 M3-B 那份：M3-B 的 runner 字节是**已验收冻结**的一部分（`docs/reports/M3-B-test.md` run6 的入口），改它会动已收口证据的身份。同形守卫全部保留，并对新步骤同样生效：

- 顺序执行、首败即停；
- 每套独立 `--output` 与 `PLAYWRIGHT_JSON_OUTPUT_NAME`（不覆写历史 JSON），三层状态判据 + 每例恰好 1 条 result + retry/skip/flaky/errors 全 0；
- 身份基线（产品 + `tests/e2e` + `playwright*.ts` + 锁的真实字节）逐步 before/after 对照；
- 被刷新的已跟踪证据先归档新字节、再按 blob 还原；起跑前就脏则拒绝覆盖；
- **基线脏就 exit 3、一步不跑**的入口快速失败；
- 完成屏障（只认 close + 日志写完）。

M3-C 套件自己的结构化中间证据（`writeArtifact`）通过 `M3C_ARTIFACT_DIR` 定向到**本轮 run 目录**（`<OUT>/m3c-artifacts/`），不写回 `docs/reports/artifacts/M3-C/` 根目录，避免把下一轮的干净基线弄脏。

第一次 `--collect` 实跑（`regression/2026-11-14T20-08-48-946Z-collect`，9/9 步 `ok=true`）固定了正式轮的总例数：

| 套件 | m0b | m0a | m1a | m1b | m2a | m2b | m3a | m3b | **m3c（新）** | 合计 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 例数 | 24 | 27 | 7 | 23 | 35 | 12 | 11 | 7 | **27** | **173** |

即正式轮 = typecheck + build + 全量单测 + **173** 个 E2E。与 M3-B 的 146 相比只多 m3c 的 27，其余八套一个没变。

## 3. `--list` 实测（不预编造数字）

```
node node_modules/@playwright/test/cli.js test -c playwright.m3c.config.ts --list --reporter=list
→ Total: 27 tests in 4 files
```

| 文件 | 类别 | 例数 |
| --- | --- | --- |
| `01-approval.spec.ts` | real | 8 |
| `02-checks-adopt.spec.ts` | real | 8 |
| `03-failures.spec.ts` | real | 3 |
| `04-mock-boundaries.spec.ts` | mock | 8 |
| **合计** | real 19 / mock 8 | **27** |

**既有八套不受影响**（同一 HEAD 上重新 `--list` 核对）：

| 配置 | 收集结果 | 与 M3-B 收口基线一致 |
| --- | --- | --- |
| `playwright.config.ts`（M0-B 默认） | 24 tests / 4 files | ✅（m3c 已被排除） |
| `playwright.m2a.config.ts` | 35 tests / 14 files | ✅ |
| `playwright.m2b.config.ts` | 12 tests / 2 files | ✅ |
| `playwright.m3b.config.ts` | 7 tests / 4 files | ✅ |

即：正式轮应跑 **typecheck + build + 全量单测 + 原八套 146 例 + 本套件 27 例**；新增例数由上面的 `--list` 固定，而不是估出来的。

## 4. real 用例 → 设计必测项对照

| 设计点名的 real 必测项 | 落点 |
| --- | --- |
| 共享按钮三处高亮 | `01` 影响模式用例：当前作品 iframe 内按 `data-highlight-src` + 青色边框统计 **恰好 3** 个同 src 框；点击页面另一处后仍回到 3 个（C1-1 回归守卫）；退出后 overlay 清空 |
| 候选 iframe 无选取 | `02` 真实四检查用例末尾：切到候选预览后 overlay=0，点击候选 iframe 不产生 Selection |
| 批准前无公开候选、拒绝后无候选 | `01` 持久显示用例 + 拒绝用例（`GET /candidates` 与界面双向核对） |
| 批准不增加 mock 请求数 | `01` 批准用例：`/__stats.calls` 前后相等，且检查 POST 计数为 0 |
| 候选出现后先检查再采用 | `01` 批准用例 + `02` 采用门禁用例（未检查时 `candidate-adopt` 真 `disabled`，门禁文案“尚未运行检查”） |
| 四检查成功 + 六份证据可读 | `02` 真实四检查用例：首次 POST body 深等 `{}`、四项 passed、六份证据链接为受限 API、展示 64 位 hash、`<pre>`/`<img>` 文本与图片渲染 |
| 真实构建/运行/遮挡失败 | `03` 三例：真语法错误、真未捕获异常、真覆盖层；逐项核对 failed/not_run 与后端产物（`UNCAUGHT_PAGE_ERROR`、`INTERACTIVE_TARGET_OCCLUDED`） |
| 断线跨批准 / 跨检查完成恢复 | `01` 断线用例（页面内真实关闭 WS → 外部回答 → 重连后自动恢复）；`02` 断线跨检查完成用例 |
| 合法等待卡重启仍在 | **部分覆盖**：`01` 用“反复页面重载 + 只读刷新”证明持久恢复；真实**后端进程**重启见 §6 缺口 |
| 重复点击 | `01` 重复点击用例：绕过可操作性等待连点两次，断言 `/approvals/:id` 的 POST 恰好 1 次 |
| 三候选与多 run 切换 | `02` 三候选用例：切换候选后 run/证据按候选隔离，迟到的旧 run 不覆盖当前候选 |
| 采用 / 回退 | `02` 采用门禁用例（采用后作品文案变化 + 版本变化 + 回退 200）与 version.changed 失效用例 |
| M1 写回后旧基线失效 | `02` 两例：采用另一个候选后旧候选门禁变“证明已失效”；`PUT /scene` 真实落盘后未检查候选仍不可采用（见 §6 关于 version.changed 的实测口径） |

## 5. mock 用例 → 设计 mock 边界对照（逐例标题带 `mock：`，不冒充运行器真实失败）

| 边界 | 落点 |
| --- | --- |
| 历史截断/乱序 | `04` 截断用例：把 `GET /events/history` 首次响应伪造成 `truncated: true` + 假锚点，断言重新取锚点后终态按权威状态恢复、事件序号不被假锚点污染 |
| 迟到响应 | `04` 迟到快照用例：把旧的 pending `/approvals` 快照当成新响应，断言已批准不被回滚 |
| 写请求响应丢失 | `04` 响应丢失用例：`POST /approvals/:id` abort，断言“无法确认服务器状态”、不自动重发；刷新后按服务器状态显示 |
| 缺证据 / 损坏 payload | `04` 两例：证据 404 与字节被篡改（hash 不符），断言“证据无法读取”且采用关闭、伪造内容不进界面 |
| `CHECKS_NOT_PASSED` | `04` adopt 409 用例：文案准确、绿灯关闭、不自动再采用 |
| `STALE_CANDIDATE` | `04` startChecks 409 用例：提示重新生成候选并关掉运行/重跑/采用 |
| 恶意文本 | `04` 恶意文本用例：`<img onerror>` / `<script>` / `<svg onload>` 全部按文本渲染，`window.__xss` 为 undefined，DOM 里没有注入的节点 |
| schema 故障（公共路径不可达） | **未做成 real**（设计明确要求不造后端旁路）；由 §4 的 mock 证据口径 + 既有 server 实测（`agent/tools.ts` 拒写 + `repo.ts:294` 的 `STALE_CANDIDATE`）支撑，在正式报告里单独标注 |

## 6. 现在还缺什么才能跑正式全量（如实列出）

1. **最终冻结提交号**：当前基线是 `5edaa22`（C3 三条应修的整改提交）。但 §7 发现了一个**前置实现缺陷**（Studio 开发服缺 `/approvals` 与 `/checks` 反代），必须由实现者先修；修完后冻结号会变，本套件要在新的 HEAD 上重新 `--list` 并复核断言（尤其 C3-1 场景草稿、C3-2 旧记录重跑、C3-3 重试范围三处修法）。
2. **真实后端进程重启 —— 已定（调度 2026-11-15）**：**不为套件新增 launcher 入口**。正式轮用“页面重载 + 只读刷新”覆盖持久恢复；真实进程重启**引用 M3-A 已通过的 `15-n4-shutdown` 证据**，报告里明确写“由既有证据支撑、本轮未新执行”，不计入本套件新覆盖。
3. **`version.changed` 的实测口径 —— 已定（调度 2026-11-15）**：接受两例拆分，**不扩合同**。读实现确认 `PUT /scene`（M1 场景写回）只发 `scene.changed`、不发 `version.changed`；`version.changed` 来自 adopt/revert/snapshot。因此：①采用造成的 `version.changed` 让旧候选门禁立即失效（真断言）；②M1 写回后门禁不被放宽（未检查的候选仍不可采用）。该局限如实写进正式报告，另由 Codex 在设计文档补一段“场景写回是否需要让旧检查证明失效”的语义确认（不改实现）。
4. **M2 回归兼容性**：`tests/e2e/m2b/01-ui.spec.ts` 的采用步骤先走真实 checks API 再点界面按钮；C3 下采用还要求六份证据回执就绪，Playwright 的可操作性等待预期能覆盖，但必须在正式轮里实测确认（这是 Claude 复核里点名要 Pi 确认的点）。
5. **既有八套 + 新套件的同一轮跑法 —— 已定并落地**：调度已批准把 m3c 作为第 12 步接进同形状 runner；Pi 写成 `tests/e2e/m3c/full-regression.mjs`（不改 M3-B 已冻结那份），总例数由 `--collect` 固定为 **173**（见 §3.1）。
6. **定向自证**：harness 接线冒烟已撞出 §7 的实现缺陷（不是断言写错）；反代修完、拿到新冻结提交后，正式轮之前建议至少把 01/02 各跑一遍，避免把“从未跑过的断言”当验收。

## 7. 本轮已做的接线冒烟（不是验收）——**冒烟直接撞出一个实现缺陷**

在干净基线上用单独输出目录跑了 1 个 real 用例（影响模式三处高亮），目的只是验证 4 个 webServer、Studio 启动、mock Agent、真实点选与 overlay 读取这条链路，**不作为通过证据**。结果：**链路在第一步就断了**，并按原件定位到根因。

### 7.1 现象

`openStudio()` 在 `events-status` 上等 90 秒失败（一直是 `connecting`），页面同时显示：

```
状态待同步
Unexpected token '<', "<!doctype "... is not valid JSON
```

作品预览（iframe）已连接，说明 Studio 本体是活的；卡在事件中心的**首次权威快照**。

### 7.2 根因（已在浏览器里逐层取到证据）

| 证据 | 结果 |
| --- | --- |
| 拦截四份快照的响应体 | `/tasks` → `[]`、`/candidates` → `[]`、`/version` → `{"version":"1799b929…"}`、**`/approvals` → `<!doctype html>…`（Vite 的 SPA fallback，即 Studio 的 index.html）** |
| 探针：页面里直接开 `ws://127.0.0.1:5173/events` | 能收到 `{"type":"ready","seq":0,"oldest":1}` → **WS 代理本身没问题** |
| 探针：页面里直接开 `ws://127.0.0.1:3001/events` | 403（后端同源校验，预期行为） |
| `apps/studio/vite.config.ts` 的 proxy 键 | `'/scene' '/assets' '/events' '/tasks' '/candidates' '/version'` —— **缺 `/approvals` 与 `/checks`** |

即：C1 新增了 `/approvals` 的读写、C2 新增了 `/checks/:id`、`/checks/:id/cancel`、`/checks/:id/artifacts/:name`，但开发服务器的反代表从 M1 时代到 `5edaa22` 没动过。开发服把这两个前缀当成前端路由，回了 index.html → `JSON.parse` 失败 → `syncReady` 永远为 false → **请示面板、检查面板、采用门禁全套不可用**。

为什么以前没暴露：M2 / M3-A / M3-B 的 E2E 一律**直连后端 3001** 驱动请示与检查，没有任何套件从 Studio 页面里访问过 `/approvals` 或 `/checks`，所以历史全绿也覆盖不到。这也说明本套件（从页面走真实界面）是必要的。

### 7.3 定位与归类

- **归类：实现缺陷（产品侧 `apps/studio/vite.config.ts`），不是测试问题、不是环境问题。**
- 修复者：实现者（CodeBuddy），不是 Pi。只需两行反代：`'/approvals': { target: backend },` 与 `'/checks': { target: backend },`；不改后端、不改协议、不改断言。
- 复原材料：`docs/reports/artifacts/M3-C/prep/dev-proxy-missing-approvals-checks.json`（四份响应体、探针结果、作业号与建议 diff）与同目录的 `smoke-open-studio-timeout-error-context.md`。
- 修后自验：`events-status` 应在数秒内变 `connected`；六份证据 GET 应返回真实 JSON/PNG（不是 HTML）。

因此本套件当前在 `5edaa22` 上**跑不出真实通过**（不是断言写错，是被测界面拿不到请示/检查数据）。正式全量必须等这个缺陷修完、拿到新的冻结提交之后再做。

## 8. 纪律确认

- 不改产品：`apps/`、`packages/`、`templates/`、`pnpm-lock.yaml` 零改动；
- 不改实现者报告与历史证据，不删任何失败原件；
- 模型只用 loopback mock（`127.0.0.1:4011`），Lux3D 指向无人监听的 loopback，后端带出站网络守卫，无付费调用；
- 长命令一律从仓库根用 `orbital\bin\bg.cmd` 起跑，拿 job 立即结束回合，不轮询不睡眠。
