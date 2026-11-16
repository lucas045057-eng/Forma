# Lux3D 增量第一次返工（基于 9885b41）

- 起点：`feat/lux3d-workbench` 的 `9885b41c7c65bc54e2b9e10f5b1f9558ced85a01`。
- 依据：根设计 `439d0fd`、`root-integration-notes.md`、`claude-code-review-9885b41.md` 与返工卡 `rework-1-9885b41.md`。
- 本批只做静态修正和回归代码；**没有**运行 build、tsc、test、collect、语法检查、浏览器、服务、probe、job 或真实 Lux3D/Asset/OSS/阿里云请求，也没有读 env/ASKS/凭据或派人。原 `9885b41` 报告与提交保持不变。

## F1 — 受信运行时解析劫持

- `packages/shared/src/scene-module.ts`：受管路径现在覆盖 `src/spatial-module` 本身、`src/spatial-module.*` 任意扩展名、`src/spatial-module/` 目录后代，以及 `src/scene-modules/**`；大小写/分隔符先规范化。新增 `RENDERER_BASE`、`isCanonicalModuleRenderer` 和共享运行时标记。
- `asset-module.ts`：生成组件改为显式 `import { SpatialModule } from '../spatial-module.tsx'`；页面实例导入也显式 `.tsx`，避免 `.ts`/目录/index 抢占解析。
- `asset-ledger.ts`：受管树只允许 canonical `.tsx` 运行时与精确 `<id>.json` / `<id>.tsx` 实例文件；任何同名 `.ts/.js/.mjs`、目录、index 或额外文件均判为 `INVALID_MANAGED_BASELINE`。运行时内容用共享标记校验。
- 回归：`scene-module.test.ts` 覆盖 `.ts/.js/.mjs/.d.ts` 与同名目录；`asset-module.test.ts` 覆盖显式 `.tsx` 生成和运行时安装；`asset-ledger.test.ts` 覆盖基线与候选中的影子文件。

## F2 — 检查快照预算（不放宽旧阈值）

- `checks/snapshot.ts`：导出 `SNAPSHOT_MAX_FILES=500`、`SNAPSHOT_MAX_FILE_BYTES=32 MiB`、`SNAPSHOT_MAX_TOTAL_BYTES=50 MiB`，原 `walk` 使用同一组常量。
- 新增 `evaluateSnapshotBudget` / `assertSnapshotBudget`：按与快照相同的 `src/public` 路径、过滤、链接和大小规则，读取真实作品目录并合并“变更后虚拟文件”（同路径按最终大小计，不重复累加，删除可移除）；超过单文件、总量或文件数时抛 `SnapshotBudgetError`（`PLACEMENT_CHECK_BUDGET_EXCEEDED`，详情含 reason/path/limit/used/remaining）。
- 接入点：
  - 模块插入候选：`WorkService.createModuleTask` 在 package 后、写 ledger/提交前预检；
  - 主槽采用：`SceneService.adopt` 在任何写入前预检模型/parts/provenance/最终 `scene.config.json`；
  - 模块保存/替换：`ModuleSceneService.adjust/replaceModel` 在 pending 前预检最终 config；模块替换在 `placement` 安装资产前预检完整虚拟集合；
  - 模块移除只减少文件，不做预算阻断。
- `force` 只影响网页几何门槛，不进入预算判断；上传 100 MiB 仍用于云处理/导出，不承诺可放置。app 将预算错误统一映射为 409，前端显示服务端剩余容量说明。
- 回归：`checks/budget.test.ts` 覆盖等于/超 1 字节、总边界、500/501 文件与同路径只计一次。

## F3 — 受信引用 AST 审计

- `asset-ledger.ts` 新增 `auditTrustedImports`：对每个改动过的非受管 ts/tsx 文件解析 AST：
  - 只允许 `import SpatialModel<id> from './scene-modules/<id>.tsx'` 这种默认导入；命名、命名空间、别名、重命名、type-only、side-effect、无扩展名均拒绝；
  - 拒绝从 `spatial-module`（任意扩展/目录）、`scene-modules` 重导出、`import = require`、动态 `import()`、任何 `require()`；
  - 拒绝 `createElement`/`jsx` 动态构造；拒绝额外 props、非自闭合、多个引用、未使用导入、把实例标识符当值传递；
  - 改名涉及源文件时分别审计旧/新路径引用集合。
- `verifyCandidateLedger` 在枚举变更后调用该审计；所有候选（不只放置）都走此检查。既有正常组件（如 `ProductHero` 的 `ProductScene`）不误拒。
- 回归：`asset-ledger.test.ts` 覆盖别名、namespace、改名、createElement、重导出、动态/require、额外 props、无扩展名与影子文件。

## F4 — 旧候选/恢复基线

- `WorkRepo.commitCandidate(id,message,ledger?,base?)`：调用方显式传入可信 base；若 `.base`/ledger/调用方冲突则 `CANDIDATE_BASE_CONFLICT`；验证 base 是版本库提交且是候选分支祖先；缺少全部可信来源时才 `CANDIDATE_BASE_UNKNOWN`。
- 所有已知调用方传 base：普通执行、批准发布（`intent.before`）、模块候选。
- `WorkService.init` 的批准恢复对 `CANDIDATE_BASE_UNKNOWN/CONFLICT/NOT_FOUND` 局部隔离：任务/卡片标记失败、保留 `recoveryHold` 草稿，不因单条旧数据阻止 `createApp`；其它持久化错误仍上抛。
- 回归：`repo.test.ts` 删除 `.base` 后无 base 失败，显式 base 成功。

## F5 — 手工关联限制

- `link()` 先做阶段判定：已有同一 providerTaskId 直接幂等返回（不 query、不重启）；已有关联不同 ID 409；除 `submit_unknown` 且无 ID 的本地任务外，`failed`/`rejected`/`cancelled`/`reserved`/`uploading`/已提交任务一律 `TASK_LINK_NOT_ALLOWED`，发生在任何云查询和持久化之前。
- `manualLink` 与 `confirmed:true` 保留。
- 回归：`lux3d-task-service.test.ts` 明确拒绝任务不得关联且不调用 `getProviderTask`。

## F6 — 单产物失败隔离

- `materialize` 改为逐产物独立下载/验证，优先处理 GLB；单个产物失败只写 warning/note，继续其余；只有没有任何有效产物时失败。刷新时已有本地成功项（同 label/format/animation 且字节哈希匹配）跳过，不覆盖；失败产物不生成空壳 artifact。
- 无成功结果时先持久化 warning 再失败，避免丢失原因。
- 回归：`lux3d-results.test.ts` 保留部分失败；下载失败没有运行态测试（本批禁止运行），实现报告记录该边界。

## F7 — 403 语义

- `Lux3DClient.providerRequest`：400/401 与业务 `c≠0` 为 `rejected`；403 改为 `UPSTREAM_FORBIDDEN` 且 `unknown`；5xx 为 unknown；200 缺 `c`、null `c`、坏 JSON 均为 unknown。没有自动换域或重发。
- 回归：`lux3d.test.ts` 覆盖 400/401/403/500/200 坏包分类。

## F8 — 主槽静态姿态

- `scene-renderer` 只在显式传入 `animation` 时挂载 `ModelAnimation`；主槽未传时不构建 mixer、不 play、不 `mixer.update(0)`，保持旧 bind pose。模块实例和结果卡显式传 animation，仍支持播放/暂停/循环和卸载释放。
- 原 M1 视觉阈值未改。由于本批禁止运行浏览器，未执行带非默认首帧模型的运行态回归；静态路径已核对。

## 同批建议

- **N1**：literal 模型路径扫描保留为辅助启发式；报告明确它不是安全边界，真正边界是 F1 managed runtime/输入/ledger。
- **N2**：`AssetModuleControls` 增加 `offsetX`、相机位置 X/Z、相机目标 X/Z、FOV 输入；`AssetPlacement` 插入增加水平偏移。服务端按字段合并，保留未编辑字段。
- **N3/N8**：旧作品无 runtime 时，首次插入在候选内由 server 从内置模板安装精确 renderer，写 ledger `runtime` 条目并纳入 diff/检查/采用/回退；同名 `.tsx`/`.ts`/目录冲突拒绝，不覆盖自定义文件，缺其它依赖不安装。回归：`asset-module.test.ts` 的旧作品迁移与冲突。现有 39743 实物未触碰。
- **N4**：模块 journal 增加主场景内容 context；cursor 同时校验 head 与 `src/scene.config.json` 哈希。主场景写入但未快照时也会使旧 undo stale；回归：`modules.test.ts`。
- **N5**：模块替换先预算预检；`installAssetFiles` 自身失败只回滚本次新建文件；`replaceModel` 失败后仅删除本次创建、字节仍匹配且未被主场景/任何模块引用的文件。已有资产与已持久配置不删；如果配置已引用新资产则保留。回归未运行。
- **N6**：octet-stream 解析器移入上传路由的封装 scope，其他 JSON 路由不再接受原始流。
- **N7**：`LuxTaskStore` 重启把 `uploading` 记为 `cancelled`（从未切 submitting/发 create），`submitting` 才为 `submit_unknown`；不自动重启上传或创建。回归：`lux3d-task-service.test.ts`。
- **N9**：`inside` 命中自闭合元素时返回 `INSIDE_REQUIRES_CONTAINER`，不再静默改到后面；回归 `asset-module.test.ts`。

## 变更文件

修改：`apps/server/src/app.ts`、`assets/lux3d{,-routes,-task-service,-task-store,-results}.ts`、`assets/placement.ts`、`checks/snapshot.ts`、`scene/{service,modules}.ts`、`work/{repo,service,asset-ledger,asset-module}.ts`、`apps/studio/src/{AssetModuleControls,AssetPlacement}.tsx`、`packages/scene-renderer/src/index.tsx`、`packages/shared/src/scene-module{,.test}.ts` 及对应回归。
新增：`apps/server/src/checks/budget.test.ts`、本报告。

## 未运行与缺口

- **未运行任何 build/tsc/test/collect/语法检查/浏览器/服务/probe/job/真实云请求**；因此不宣称可编译、测试通过或验收通过。
- F8 的“非默认首帧模型”与 F6 的真实下载失败未运行验证；F2 的放置集成边界只有纯预算函数回归，主槽/模块/候选预检需要集中验证。
- 旧模板作品 runtime 迁移只在临时 fixture 中覆盖，未验证 39743 实物；现有实例保持不动。
- `assertModuleRuntime` 仍保留为只读校验出口，但生产插入路径已改为 `ensureModuleRuntime`。
- 共享模型 GC 仍按根指示保守不实现；N5 只回滚本次替换新建文件。
