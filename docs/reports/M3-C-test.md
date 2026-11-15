# M3-C 正式验收报告（Pi 独立测试与验收）

状态：**正式轮执行中/待填**（本轮只用 `tests/e2e/m3c/full-regression.mjs` 一次跑完 12 步；未跑完不写结论）。

> 准备与自证过程另见 `M3-C-test-preparation.md`（含阻断点发现与 7 处用例侧缺陷的修正记录）。本文件只记正式轮的受测身份、判据与结果。

## 1. 受测身份

| 项 | 值 |
| --- | --- |
| 工作树 | `.worktrees/m3c-acceptance`（分支 `test/m3c-acceptance`） |
| 受测提交（实现冻结） | `0860fbb5dd44f23ab9f99e9827d949e50b86b141`（merge 进验收树为 `70ad8d4`） |
| 受测 HEAD（验收树） | `70ad8d482990d682d74171516c11ad8d2c68d801`（merge `0860fbb`） |
| 身份摘要 digest | `126be4809497`（`manifest.json` 里的 `baseline.identity.digest`） |
| 锁文件 sha256 | `67af36b7a1b8a8ace1f03aa0ca9addf979f3842bdab3ff3dc4f56901b7d18960` |
| `HEAD:apps` 树对象 | `66e7ec7776b4d67a3d494cbd03652e127d1fd4f8`（= `0860fbb:apps`） |
| 产品/锁差异 | `git diff 0860fbb -- apps packages templates pnpm-lock.yaml` = **0 行** |
| 实现侧自证（提供方） | `job_dd3d2512` exit 0：`pnpm test` / `pnpm typecheck` / `pnpm build` 三段全 0，Studio 13 files，跑后五端口无监听 |
| 独立审查 | `docs/reports/M3-C-review.md`（master `fe17f83` 前一轮 0 blocker / 0 应修；三条 C3 应修与反代修复已复核） |

## 2. 入口与判据（不放宽）

入口：`node tests/e2e/m3c/full-regression.mjs`（与 M3-B 的 runner 同形状）。

顺序：`pnpm typecheck` → `pnpm build` → `pnpm test`（全量单测）→ 旧八套 E2E → **m3c（第 12 步，新增）**。

- 每套独立 `--output` 与 `PLAYWRIGHT_JSON_OUTPUT_NAME`，不覆写历史 JSON；
- 判据（`tests/e2e/m3b/runner-support.mjs#verifyPlaywrightReport`）：三层状态分别检查；每例**恰好 1 条 result**、`retry=0`；拒绝 `skipped`/`expected-failed`/`flaky`/顶层 `errors`；递归统计 suites 与 `stats.expected` 对数；
- 身份：产品 + `tests/e2e` + `playwright*.ts` + 锁的真实字节 SHA256，run 起点建 baseline，每步 before/after 对照；
- 证据：被刷新的已跟踪证据先归档新字节再按 blob 还原（`rev-parse HEAD:<path>` vs `hash-object --path`）；
- 入口快速失败：基线脏即 `exit 3`、一步不跑；
- m3c 的结构化中间证据通过 `M3C_ARTIFACT_DIR` 落在本轮 run 目录，不污染下一轮。

**收集口径**：`--collect` 实测 m0b 24 / m0a 27 / m1a 7 / m1b 23 / m2a 35 / m2b 12 / m3a 11 / m3b 7 / m3c 28 = **174**（证据 `regression/2026-11-14T21-12-52-141Z-collect`，9/9 步 ok）。

## 3. 本轮新增套件（28 例，real 20 / mock 8）

| 文件 | 类别 | 例数 | 覆盖 |
| --- | --- | --- | --- |
| `tests/e2e/m3c/01-approval.spec.ts` | real | 8 | 请示卡持久/刷新同 id 单卡、影响模式三处高亮（含 C1-1 回归）、批准/拒绝请求体与副作用、连点只发一次、取消任务、断线跨批准恢复 |
| `tests/e2e/m3c/02-checks-adopt.spec.ts` | real | 9 | 真实四检查与六证据、采用门禁与采用、显式 rerun、取消检查、三候选多 run 隔离、断线跨检查完成、version.changed 失效、M1 场景写回失效、**写回后不刷新也不可采用（含绕过面 409）** |
| `tests/e2e/m3c/03-failures.spec.ts` | real | 3 | 真实构建失败、真实运行错误（`UNCAUGHT_PAGE_ERROR`）、真实遮挡（`INTERACTIVE_TARGET_OCCLUDED`） |
| `tests/e2e/m3c/04-mock-boundaries.spec.ts` | mock | 8 | 历史截断重锚、旧代次迟到快照被丢弃、写请求响应丢失、证据 404、证据字节篡改、adopt 409 `CHECKS_NOT_PASSED`、startChecks 409 `STALE_CANDIDATE`、恶意文本按文本渲染 |

模型侧：编码上游是 loopback mock（`127.0.0.1:4011`），Lux3D 指向无人监听的 loopback（`4019`），后端带出站网络守卫；**无真实付费调用**。

## 4. 正式轮结果

**结论：未通过（停在第 8 步 `e2e-m1b`，5 例 unexpected）**。按调度要求停手留原件、不改判据、不重跑到绿。

| 步骤 | 结果 | 用例 | 备注 |
| --- | --- | --- | --- |
| typecheck | ok=true | — | — |
| build | ok=true | — | — |
| unit | ok=true | — | — |
| e2e-m0b | ok=true | 24/24 | 归档 21 份后按 blob 还原 |
| e2e-m0a | ok=true | 27/27 | 归档 28 |
| e2e-m1a | ok=true | 7/7 | 归档 7 |
| **e2e-m1b** | **ok=false code=1** | 收集 23：**18 passed / 5 failed / 0 skip / 0 flaky** | 归档 22 份后还原 |
| e2e-m2b / m3a / m3b / m3c | 未执行 | — | 首败即停 |

### 4.1 5 例失败（逐例指标）

| 用例 | 指标 | 阈值 | 证据 |
| --- | --- | --- | --- |
| `01-consistency` ① 出厂配置 | aligned changed **0.005291**（shift 0/0，backing 378=378） | < 0.005 | `consistency-default.json` |
| `01-consistency` ② 改动后一致 | 同上 0.005291（shift 0/0） | < 0.005 | `consistency-after-edit.json` |
| `01-consistency` ③ at≈0.6 | 同上 0.005291（shift 0/0） | < 0.005 | `consistency-scroll-06.json` |
| `04-keyframe` 记为此处关键帧 | **measuredShiftPx 0**（期望 15.74，模型高 378） | > 50% 期望 | `keyframe-write.json` |
| `07-fixes` R2 出厂模型开盖 | **factoryShiftPx 0**（期望 45.36） | > 50% 期望 | `fix-r2-lid-gating.json` |

前三条失败的共同点：**画布 backing 尺寸完全相等（378/378，dpr 1）、最佳对齐位移就是 (0,0)**，差的只是 0.5291% vs 0.5% 的像素比。后两条測的都是 **Studio 场景视口**（`captureStudioCanvas`）：配置已真实写进 `scene.config.json`（`at=0.549、lid=[0,0.12,0]`，6ms 落盘），但视口画面的顶边位移是 **0px**。而 at≈0.6 的页面 vs 视口差异只有 0.53%，说明**页面那边也没动**（若只有视口不动，差异会远大于阈值）。

### 4.2 归类：**产品侧可疑回归（Studio 场景视口）**，不是测试断言、不是入口/环境

- 受测字节与 `0860fbb` 完全一致（`HEAD:apps` = `0860fbb:apps` = `66e7ec77…`、`apps/packages/templates/lock` 差异 0 行），排除合入失误；
- 这 5 条都是 **M1 验收遗留的既有断言**（本轮未改一行）；同一台机器、同一素材下，M3-B run6 的 m1b 是 **23/23 全过**；
- 相对 M3-B run6 的唯一代码增量是 **M3-C 的 `apps/studio`**（`packages/` 与 `templates/` 零差异），失败又集中在 Studio 视口与场景配置的联动上；
- Claude 复核已把这条列为 M1 风险并要求 Pi 在完整回归里盯：`m1b/01-consistency` 像素比较、`m1b/04-keyframe` 覆写、`m1b/03-undo`。本轮实测正是前两项（`03-undo` 通过）。

**尚未证明的部分**（需实现侧读代码定位，不代替它下结论）：① 是 C3-1 的 dirty 保护让对照模式的 `load()` 被跳过，还是 Claude 建议 #5 提到的“每次同步窗口控件卸载重挂”重建了 3D 场景并丢配，还是 `state.reload` 不再驱动视口；② 为何页面侧也不动——是配置应用层还是渲染层。

本轮的完整定性与原件索引：`artifacts/M3-C/regression/2026-11-14T21-19-15-445Z-full/m1b-failure-analysis.json`。


## 5. 证据与复算

- 本轮 run 目录：`docs/reports/artifacts/M3-C/regression/2026-11-14T21-19-15-445Z-full/`（`manifest.json` / `manifest.log` / 逐步日志 / `e2e-m1b-results.json` / `e2e-m1b-output/**` 失败截图与 error-context / `evidence-refresh/e2e-m1b/**` 22 份被刷新证据的新字节），另有 `m1b-failure-analysis.json`。
- 被刷新的已跟踪证据均先归档新字节、再按 blob 还原（逐份校验 `rev-parse HEAD:<path>` vs `hash-object --path` 与 `git status` 为空）；m3c 的结构化中间证据由 `M3C_ARTIFACT_DIR` 定向到本轮目录的想法本轮未用到（m3c 步未执行）。
- **六份证据 sha256 与全目录清单本轮未生成**：本轮未通过，按“不把失败轮当成通过证据”的口径，不刷新 `sha256-manifest.json`；失败原件保持原样。


## 6. 资源回收

- 首败即停后未再启动任何套件；失败步的 Playwright 已自行关闭它启动的 4 个 webServer。
- 跑后核对：5173 / 3001 / 5174 / 5175 / 4011 均无监听；`.data/pi-m3c` 下无残留临时目录；`%TEMP%` 无 `m3c-e2e-*`。
- 工作区：除 `?? fallback/`（未跟踪输入素材，不入库、不在身份摘要内）外无其它未跟踪文件。


## 7. 未覆盖项（如实列出）

1. **真实后端进程重启**未在本套件内新执行：后端由 Playwright `webServer` 拥有，测试内无法合法重启；本套件覆盖的是"页面重载 + 只读刷新"的持久恢复。真实进程重启**引用 M3-A 已通过的 `15-n4-shutdown` 证据**（调度 2026-11-15 决定），不计入本套件新覆盖。
2. **`/events` WebSocket 升级**的代理未被实现侧新增的接线单测覆盖（`dev-proxy.test.ts` 只覆盖 REST 与证据字节）；本套件通过真实断线/重连用例间接覆盖 WS 行为。
3. **`blocked_by` 文案**：后端实测是"前序检查 build 未完成：CHECK_FAILED"，UI 只把"未开始执行："前缀映射为"前序失败，未运行："。语义满足（点名阻塞项 + 失败码），措辞不统一记为观察项。
4. **前端不能证明字节**：采用前的前端门禁只是可见性门禁，最终的字节/证据裁决在后端锁内（`validatePassedRun`）。本套件用"绕过界面直打接口 → 409"证明后端确实是最终防线，但不宣称前端能排除 TOCTOU。
5. 仅 Windows + Chromium，未覆盖跨 OS 与其他浏览器。
6. `02-faults` 里 schema 检查失败在 HTTP 公共面上不可达（M3-B 已记录），本套件同样没有伪造该路径。

## 8. 建议（不阻断收口）

1. **统一 `blocked_by` 文案**：让 UI 同时映射"前序检查 X 未完成"与"未开始执行："两种前缀，或直接原样展示并加统一说明。
2. **影响模式的"使用点"条目降级**：`affected` 里的 `src/App.tsx:27:14` 这类使用点会给出定位按钮，但页面元素的 `data-src` 指向组件定义，点击得到 0 框且无提示。建议按设计 §2"无法确认命中"的语义降级为文件级提示（本轮已作为观察项记录，未设成通过条件）。
3. **实现侧端口约定**：新增的 `dev-proxy.test.ts` 已改用 `listen(0)` 临时端口（好），但 `verify-proxy-isolation.mjs` 仍按参数占用 5173；建议后续统一为临时端口，避免与 UI 套件或开发者 `pnpm dev` 互斥。
4. **M1 场景编辑器布局**：C1–C3 把编辑器移入 `aside.inspector` 后宽度少约 44px、写入/撤回按钮等同步窗口；本轮 `m1b` 三套通过，但建议后续做一次专门的窄屏/拖拽中同步回归。

## 9. 一句话总结

受测字节与冻结提交 `0860fbb` 完全一致（`HEAD:apps` = `66e7ec77…`，产品/锁/模板差异 0 行），前七步（typecheck / build / unit / m0b 24 / m0a 27 / m1a 7）全过；**第 8 步 `e2e-m1b` 有 5 例失败，全部指向 Studio 3D 视口不再随场景配置更新（lid 位移 0px）与像素一致性 0.5291% 略超 0.5% 阈值**，归类为**产品侧可疑回归**（M3-B run6 时这 5 条全过，本轮唯一增量是 M3-C 的 `apps/studio`）。本轮停手、未重跑、未改任何判据；待实现侧定位修复后重跑同口径全量。


## 10. 第二正式轮：合入冻结主线后的受测身份（2026-11-15）

前 9 节是第一正式轮（`2026-11-14T21-19-15-445Z-full`）的原件与定性，**不改写、不重跑**。
本节记录第二正式轮在**已合入冻结主线**的测试分支上实际受测的身份与入口。

- 测试分支：`test/m3c-acceptance`；把冻结主线 `2db6d5968265dbb0cc42d7d96b7c37b31b8984fe`（其内含 merge `caa0ef0` → 受审实现 `393fe9f`）合入；
- 合并提交（受测 HEAD）：`248ba7ed6e3ec63dcd2d4f0921cd3fd84d46937e`；
- 祖先核验：`393fe9f` 与 `2db6d59` **都是** 受测 HEAD 的祖先（`git merge-base --is-ancestor` 均为真）；
- 产品/锁零差异：`git diff --name-only 393fe9f HEAD -- apps packages templates pnpm-lock.yaml` = 空；
  `HEAD:apps` = `393fe9f:apps` = `8df06a9b57fd8e00e98a0eb946ad9b6b5c8f64a8`；
  `pnpm-lock.yaml` 真实字节 SHA256 = `67af36b7a1b8a8ace1f03aa0ca9addf979f3842bdab3ff3dc4f56901b7d18960`；
- 起跑前环境：3001/4011/5173/5174/5175 均无监听，本工作树无自有 node/chrome 残留；
  `fallback/` 未入库（按 LESSONS 从本地根复制，m0a 需要的 `lux3d-4969293.glb` 在位）；
- 正式入口：`tests/e2e/m3c/full-regression.mjs`（12 步：typecheck → build → 全量 `pnpm test` → 原八套 E2E → M3-C 28 例）；
  每套 JSON 与 `--output`、以及 `M3C_ARTIFACT_DIR` 的结构化中间证据全部定向到本轮新 run 目录；
- 本轮**必须从头真正重跑**：原 M1-B 23 例要在该冻结身份上重新全部通过，不复用 `job_8b19c345` 的 GREEN，
  不从中间续跑、不 grep、不 skip、不 retry、首败后不自动补跑。


## 11. 第二正式轮结果：停在 `e2e-m2b` 的 1 例（归档与定性）

- 作业 `job_e0aa2e21`，run 目录 `docs/reports/artifacts/M3-C/regression/2026-11-15T02-53-39-669Z-full/`，
  用时 13m55s，`exit 1`；受测 HEAD `e284906`，身份摘要 `b71066cc4477…`，锁 `67af36b7…18960`。
- **已执行 9 步**：typecheck ✓、build ✓、全量单测 **501** 通过（68+20+1+5+321+86）、
  E2E：M0-B 24/24、M0-A 27/27、M1-A 7/7、**M1-B 23/23（在本轮冻结身份真实重跑，未复用实现侧 GREEN）**、
  M2-A 35/35、M2-B **11/12**。
- **实际 E2E**：127 passed / 1 failed；**M3-A 11 + M3-B 7 + M3-C 28 = 46 例未执行**。
  因此本轮**不是** 173 通过，而是 "127 过 + 1 失败 + 46 未执行"。
- 失败用例：`02-takeover.spec.ts › 历史截断：补拉返回 truncated 时整体重载任务/候选/版本`，
  报错为 `events-status` 20s 内一直 `reconnecting`（期望 `connected`）；原始 JSON、`error-context.md`、
  `test-failed-1.png` 都在本轮 `e2e-m2b-output/` 下，未改写。

### 11.1 `identityStable=false` 不是源码漂移

本轮 runner 把"退出码/报告核对失败"和"身份偏离基线"写进了同一个 `identityProblems` 数组（测试工具表述问题）。
实际核验该步：`identity.before.digest = identity.after.digest = b71066cc4477…`、`HEAD` 均为 `e284906`、
锁均为 `67af36b7…`、`dirty` 均为 `[]`、`drift` 为空。**没有任何源码/配置/锁漂移**。

### 11.2 定性：这是测试前提错误，不是产品回归

- M3-C 把同步逻辑收进了 `sync-state.ts`：`reconcileSnapshot` 在 `history.truncated` 时返回 `null`，
  客户端最多 3 次"取新 head → 重载快照 → 按新 anchor 补拉"，仍截断就如实报"事件历史无法连续补齐"。
- 旧实现（`6f6ff49`）遇 `truncated` 只做一次全量重载并把 seq 抬到 `history.current`，不校验回放连续性——
  所以旧代码在"永远截断"的 mock 下也能显示 connected，但那是**假连接**。
- 失败用例的 route 对**所有** `/events/history`（含 `since=0` 的 head 与新 anchor 的补拉）永久返回
  `{events:[], current: caught.current, oldest: caught.current+50, truncated: true}`。真实后端对
  `since >= current` 的请求不可能返回 truncated，因此任何遵守真实 History 合同的客户端都只能报错。
- 结论：**测试前提错误**（mock 让恢复不可达），产品行为符合合同；不改产品、不放宽断言。

### 11.3 最小测试侧修正（待定向验证）

`tests/e2e/m2b/02-takeover.spec.ts` 的 route 改为：只对**确实过旧的 cursor**（`0 < since < caught.current`）
返回一次合法截断；`since=0`（取新 head）与 `since>=caught.current`（新 anchor 补拉）**放行到真实后端**。
新增断言：`truncatedSeen.length > 0`（真的走过截断路径）、`since=0` 的 head 请求确实发生、截断之后确实有请求走真实后端。
原有 connected / `events-seq` / 两个候选 / 版本 / 全量重载请求断言全部保留，未删截断场景、未伪造 connected。
用 `tests/e2e/m2b/targeted-truncation.mjs` 只跑这一例（新目录、0 retry、记录身份与真实计数）。

### 11.4 第一次定向轮（`b655aec`）：通过，但只证明"不再永久截断"

- run：`docs/reports/artifacts/M3-C/regression/2026-11-15T03-14-28-406Z-m2b-targeted/`，1 passed（13.6s），
  `--grep 历史截断`、0 retry、单 worker。
- 这次 fixture 只做到"过旧 cursor 截断一次、其余放行"，但注入的响应是 `oldest = current + 50`——
  一个伪造的未来 oldest，不是真实保留尾段的元数据。所以它只能证明"不再永远截断"，不能代表
  "合法的 truncated 元数据能被恢复"。按 Codex 反馈如实降级，不当作修正已生效的证据。
- 该轮 `tests/e2e/m2b/artifact.ts` 写死 `docs/reports/artifacts/M2-B`，把 tracked 历史证据
  `M2-B/takeover-events-truncated.json` 刷新了。已先归档本轮新字节（563B，sha256 `71bd995b…`）到
  该 run 的 `evidence-refresh/`，再按 blob 还原（`headBlobId = restoredObjectId = 82cb7d17…`，
  `git status` 该路径为空），记录在 `evidence-restore.json`；新字节归属本 run，不冒充历史证据。

### 11.5 第二次定向轮前的两处补正（测试侧，未改产品）

1. 自洽截断元数据：`02-takeover.spec.ts` 改为用真实后端 `history(0)` 的保留尾段构造一次注入——
   `events` 全为真实事件、`current` 为真实 current、`oldest` 取尾段首 seq，并要求
   `oldest <= current`、`0 < since < oldest - 1`；注入用 `injection.used` 保证恰好一次；
   `since=0` 与新 anchor 补拉一律 `route.continue()` 走真实后端。真实事件不足（`current < since + 2`）时
   先产生一条真实任务补足，不伪造未来 oldest。新增断言：恰好注入一次、元数据关系合法、尾段非空且
   末事件等于真实 current、轨迹里截断之后确实出现 `since=0` 与 `since=caught.current`。
   原 connected / `events-seq` / 两候选 / 版本 / 全量重载请求断言与超时全部保留。
2. 定向入口的历史证据保护：`tests/e2e/m2b/targeted-truncation.mjs` 不再只定向 JSON/output。
   起跑前若 `docs/reports/artifacts` 已脏（归属不明）直接停止不跑（exit 3）；跑完先为本步刷新/新增的
   tracked 证据归档新字节与哈希，再按 blob 还原并用对象 id + `git status` 校验；同时记录受测 HEAD、
   锁 SHA256、spec SHA256、前后身份摘要与工作区状态。不声称 M2-B 的 artifact helper 支持
   `M3C_ARTIFACT_DIR`（它并不支持）。
### 11.6 第二次定向轮（新版本，`fb906ea`）：通过

- run：`docs/reports/artifacts/M3-C/regression/2026-11-15T03-20-18-991Z-m2b-targeted/`，
  受测 HEAD `fb906eab0eb9621badf25baa297b11ea5876783b`，spec SHA256 `1bb5bae2…`，
  锁 SHA256 `67af36b7…18960`，`identityStable=true`，`problems=[]`。
- 报告：1 spec / 1 test / 1 result，`expected=1`、`skipped=0`、`unexpected=0`、`flaky=0`；单例 8.9s、总 13.8s。
- 真实截断元数据（来自归档的 `takeover-events-truncated.json` 原件）：
  `injectionUsed=1`（恰好一次）；`since=15`、`oldest=17`、`current=30`，满足 `0 < 15 < 17-1` 与 `17 <= 30`；
  尾段 14 个真实事件（首 17、末 30）；请求轨迹 `15 → 0 → 30`，`since=0` 与 `since=30` 均走真实后端。
- 恢复后：`/tasks`、`/candidates`、`/version` 全量重载齐全；界面 `events-seq=30`；候选下拉两项（`e8426f62`、`1f929f68`）。
- 证据保护：本步刷新的 `M2-B/takeover-events-truncated.json` 新字节 769B（sha256 `c07ffea5…`）先归档到
  本 run 的 `evidence-refresh/run/`，再按 blob 还原（`headBlobId = restoredObjectId = 82cb7d17…`，`statusClean=true`）；
  新字节归属本 run，历史原件未被改写。
- 收尾核验：`templates`、`apps/studio`、`apps/server` 工作区干净；3001/4011/5173/5174/5175 无监听；本工作树无自有 node/chrome 残留。

> 说明：这两次定向轮只证明"该用例的截断恢复前提已修正且能通过"，**不构成** M3-C 的验收结论；
> 正式判定仍取决于随后从头执行的 12 步 174 例全量回归。
## 12. 正式结论：M3-C 第二正式轮全量通过（12 步 / 174 例 + 501 单测）

- 作业 `job_01305fef`，run `docs/reports/artifacts/M3-C/regression/2026-11-15T03-24-30-188Z-full/`，
  总时长 21m22s，`exit 0`。
- 受测 HEAD `9294cccfa9ab1212619a28b23f368ea5af1f0da6`：测试侧修正为 `fb906ea`，`9294ccc` 只是其上的 docs/证据归档，
  **不含任何代码改动**；后续归档提交同样只新增 docs/证据，不改受测代码。
- 身份基线：`identity = cf5b92b3cd7f…`、锁 SHA256 `67af36b7…18960`；12 步 `code=0`、`identityStable=true`、`report.ok=true`。

### 12.1 计数（逐份原始 JSON 复核）

| 步骤 | 结果 | 计数 |
| --- | --- | --- |
| typecheck | exit 0 | — |
| build | exit 0 | — |
| 全量单测 | exit 0 | **501** = shared 68 + vite-plugin-source-tag 20 + scene-renderer 5 + bridge 1 + server 321 + studio 86 |
| M0-B | exit 0 | 24 |
| M0-A | exit 0 | 27 |
| M1-A | exit 0 | 7 |
| M1-B | exit 0 | **23（本轮冻结身份真实重跑，非历史 GREEN 抵扣）** |
| M2-A | exit 0 | 35 |
| M2-B | exit 0 | 12（含上一轮失败的"历史截断"用例） |
| M3-A | exit 0 | 11 |
| M3-B | exit 0 | 7 |
| M3-C | exit 0 | 28 = **real 20 / mock 8**（按 spec 文件分类） |
| **E2E 合计** | | **174** |

独立复核脚本逐 test 递归检查九套原始 JSON：`errors[]` 为空、`expectedStatus='passed'`、`test.status='expected'`、
**恰好一条** `results` 且 `status='passed'`、`retry=0`、`result.errors` 为空、`stats.skipped|unexpected|flaky=0`、
`stats.expected` 与逐条计数一致 → **problems 为空**。结果落在同目录 `verification.json`。

### 12.2 身份、产品基准与清理

- 产品/锁相对受审实现 `393fe9f`：`git diff --name-only 393fe9f HEAD -- apps packages templates pnpm-lock.yaml` = **0**；
  `HEAD:apps = 8df06a9b57fd8e00e98a0eb946ad9b6b5c8f64a8`；根主线 `2db6d59` 仍是祖先。
- 收尾观测（`cleanup.json`）：3001/4011/5173/5174/5175 **无监听**；本工作树**无自有 node/chrome 残留**；
  `templates`、`apps/studio`、`apps/server` 工作区干净；`scene.config.json` 复原（哈希已记录）；
  临时 `.git/info/exclude` **无本轮路径残留**；`fallback/` 仍未入库（`?? fallback/`）。
- 本轮未广杀任何进程：没有需要清理的自有残留，故未执行额外 kill。

### 12.3 归档

- 本轮原件齐备：`manifest.json`/`manifest.log`、九套 `e2e-*-results.json` + `e2e-*-log` + `e2e-*-output/`、
  `unit.log`/`typecheck.log`/`build.log`、`evidence-refresh/`（各套刷新的历史证据新字节）、
  `launcher/`（job 的 `cmd`/`exit`/`job.json`/`output.log`）、`verification.json`、`cleanup.json`、
  `sha256-manifest.json`（**189 个文件**逐字节 SHA256）。
- 历史不改写：第一正式轮失败原件（`…21-19-15-445Z-full`）、collect 原件、两次定向轮原件均保持原样。

### 12.4 边界（写实）

- 浏览器覆盖**仅 Chromium**（1440×900、deviceScaleFactor 1），不声明跨浏览器。
- 本轮**没有新增真实后端重启**覆盖；重启/断线恢复仍引用历史 M3-A 证据与页面 reload 路径；
  "过时后端快照"不在本轮合同内。
- 模型上游全部是本机 loopback mock + fake key；Lux3D 指向无人监听的 loopback 端口；
  **无任何真实模型/语音/Lux3D 付费调用**；未读真实 `apps/server/.env`、`orbital/ASKS.md` 或凭据。
- Claude 的 4 条非阻断建议保留给后续（M4）打磨，本轮不新增用例、不改产品。

### 12.5 判定

在"mock 上游 + 本机 loopback + 仅 Chromium"这一已声明范围内，**M3-C 第二正式轮 12 步全部通过**：
501 单测 + 174 例 E2E（M3-C real 20 / mock 8），身份稳定、产品与受审实现零差异。
本分支不自行合并；合并与设计收口由 Codex 执行。