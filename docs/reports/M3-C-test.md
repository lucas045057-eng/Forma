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
