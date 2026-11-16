# Lux3D Workbench Implementation Plan

> **For agentic workers:** CodeBuddy is the designated implementer; use executing-plans as applicable. Do not spawn additional workers. User standing order overrides per-task RED/GREEN and repeated full suites: complete the development batch and regression code, then report a fixed commit for centralized verification.

**Goal:** 用户在本网站完成Lux3D全部公开能力，并将满意模型拖入网页后明确确认采用。

**Architecture:** 后端拥有上传、云端鉴权、持久任务与受信产物；前端提供简洁创作抽屉和按输入前置条件组织的高级工具。受版本/源窗口校验的放置意图连接iframe与Studio，已有槽位走scene history，普通区域走受检查的候选。

**Tech Stack:** 当前React/TypeScript、Fastify、three/fiber、sharp、Git候选/Playwright及官方Lux3D/Asset公开规范。

**Spec:** `docs/design/Lux3D-workbench-increment.md`

## Global Constraints

- 主线基线5af619e；只在CodeBuddy独立实现树新分支开发，现有主线服务/作品/密钥/证据不动。
- 拖入不产生付费创建；每次明确生成只创建一次，不自动重发未知提交。
- 密钥只在根目录Git-ignored后端.env，由根配置；工作者不读、不复制、不写入日志。
- 保留现有语音、采用/检查、撤回、来源与网页门槛；后台关闭与恢复有界。
- 本批写齐实现与回归代码，不运行服务/测试/构建/云调用，交根统一安排。

## Review Focus

1. 断网发生在上游接受之后：有providerTaskId只查原ID；无ID保持未知，历史匹配仅供用户明确认领，绝不自动认领或二次付费创建。
2. 浏览器拖放跨iframe和页面滚动：实际目标被正确识别，不受坐标偏差或陈旧版本影响。
3. 高级操作返回多个不同格式产物：不丢结果、不把图片/ZIP当GLB采用、不破坏动画。
4. 资产被放入多个网页模块：每个实例独立可调整，采用/撤回包含正确资产及来源。
5. 文件与上传凭证不可信：拒绝大小炸弹、假MIME、任意网络/路径和密钥泄漏。

## Task 1 — 上传、规范与能力映射

Files: modify `apps/server/src/assets/lux3d.ts`, `apps/server/src/app.ts`, `packages/shared/src/index.ts`; create focused `apps/server/src/assets/lux3d-upload.ts`, `lux3d-operations.ts` and corresponding `.test.ts` as needed. Avoid an app.ts mega-handler.

Interfaces: shared discriminated `LuxOperation`, `LuxTask`, `LuxArtifact`, opaque upload references; upload service `receive/resolve/uploadToProvider` separates safe local bytes from provider URLs. Pin 10 operation mappings and request/response validation to the downloaded official schemas. Keep old service callers compatible.

- [ ] Write regression cases for all operation request shapes, invalid combinations/enums, int64 ID, typed outputs, and all upload/path/network limits.
- [ ] Implement safe image/model upload, credential forwarding boundaries, capability configuration and latest-vs-legacy endpoint policy.
- [ ] Statically compare every mapping against official service schemas; record source URLs/digests and dependency choices.

## Task 2 — 持久任务与高级操作

Files: modify `apps/server/src/assets/service.ts`; create `lux3d-task-store.ts`, `lux3d-task-service.ts` and tests; extend existing asset event/public projection intentionally. Existing fallback/GLB pipeline remains usable.

Interfaces: create operation with `{operation,inputRefs,parameters,idempotencyKey}`; returns local typed task. Resume only queries prior remote ID; missing remote ID stays unknown until explicit user binding. Local artifacts distinguish original/optimized/version relationships and safe preview/download endpoints. Implement the spec revision's per-operation parser table and upload/public-resource disclosure, not a generic URL-only parser.

- [ ] Write regression cases for concurrent duplicate clicks, changed parameters409, accepted-then-disconnected unknown, restart, expiry, multi-output/animation preservation, malformed business response and close.
- [ ] Implement persistent reservation/state machine, bounded query retries, stage progress, task history and transformation dependencies.
- [ ] Check existing imports, provenance hashes, source models and download limits remain intact. No cloud calls.

## Task 3 — 简洁创作抽屉与完整高级工具

Files: refactor `apps/studio/src/AssetPanel.tsx`, `assets.css`, `App.tsx`; create `Lux3DWorkbench.tsx`, `lux3d-api.ts`, operation forms and focused tests as needed; retain local fallback/import UI.

Interfaces: canonical API accepts file/upload reference and typed operation; view state survives panel close via persisted task history. Image card does not submit until a visible enabled create button is clicked. Render outputs by kind and playable animations where supported.

- [ ] Write cases for drag/file-picker, invalid inputs, ordered multi-images, ten forms, no accidental submit, persistence, errors and keyboard access.
- [ ] Implement image-first main route, folded advanced tools, real result cards, task stage/recovery, preview/download/continue actions.
- [ ] Make asset panel nonblocking while placing a result in the webpage. All copy describes actual operation and billing trigger.

## Task 4 — 放置协议与网页集成

Files: extend `packages/shared/src/index.ts`, `packages/bridge/src/index.ts`, `apps/studio/src/App.tsx`; create focused `asset-placement` controller/protocol, server placement routes/service and tests; integrate `apps/server/src/scene/service.ts`, work task/candidate asset packaging, preview renderer/components as needed.

Interfaces: a parent-held drag session binds assetId/workVersion/nonce/mainFrame/expiry. Frame emits an untrusted replace/insert hint, revalidated by server at the bound version. Confirmation creates a placement intent; main-slot replace reuses scene history, module replace uses its instance configuration, insert creates a normal candidate with server-only attested attachments. Instance files live at src/scene-modules/<instanceId>.json; independent histories live outside model-writable work source, with version/content cursor checks. No untrusted arbitrary file/URL paths in instructions; modelWritable remains src-only, with server-managed exact attachment/config attestations rather than a public/** exception.

- [ ] Write protocol tests for wrong origin/source, replay/expiry/stale version, nested target/scroll, external drag and pending assets.
- [ ] Implement highlight/drop/confirmation and identical keyboard/button path; unchanged main work until confirmation.
- [ ] Implement existing-slot replacement, ordinary-region module candidate insertion, independent instance transform editing, checks/adoption/revert and provenance.
- [ ] Pin tests for cancelled candidate cleanup, multiple placements, shared-component selection, over-budget geometry and original M1-B contracts.

## Task 5 — 交付与集中验收准备

Files: report `docs/reports/Lux3D-workbench-implementation.md`; independent Pi tests under a new feature suite/config (Pi owns); old official regression files unchanged unless an explicit compatibility issue is demonstrated.

- [ ] Review full batch statically for type boundaries, actual network request sites, async/abort/cleanup, no hidden placeholder operations, old contracts and exact Git scope.
- [ ] Commit implementation/tests/docs by exact paths; preserve old branches and untracked reports. Report HEAD, changed paths, dependency/lock changes, old/new route map, completed vs missing capability matrix, and that no verification/cloud calls ran.
- [ ] Root merges design-review corrections into one implementation batch, then asks Pi for one bounded focused run on fixed bytes plus Claude finite code review. New defects first produce evidence-based fix list, not blind retries/full.
- [ ] After focused acceptance/review, arrange one relevant full integration regression; only then create a fresh manual-acceptance instance. Current39743 remains preserved.

Plan self-review: all10 operations, both placement kinds, transform/revert, upload/secret boundaries and five Review Focus inputs map to tasks and test cases above. SDK/new dependency/endpoint migration are explicit review decisions; no undocumented API or global SceneConfig multi-instance assumption is permitted.

## 设计修订后的必要回归（与上述任务同批写齐）

- [ ] Task2: accepted response loss without ID stays unknown even if list has exactly one item; explicit user recovery preserves manual confirmation provenance. Valid rejects keep failed key; no implicit new key, POST retry or cross-domain retry.
- [ ] Task1/2: drop does not request upload token; click reveals cloud-resource disclosure then uploads; credential globalDomain/single/block/dedup/lackBlocks/status bounds and separate auth tested.
- [ ] Task2/3: test every parser table row including NOT_REQUESTED slot preservation, unordered Turbo results, four-view order, rig error JSON, partial retarget success, 2h link refresh and original-not-optimized downstream input.
- [ ] Task2/3/4: animated/skinned/morph models bypass destructive transforms, channels/joints survive, webpage instance playback is explicit and controls release resources.
- [ ] Task4: instance-specific adjustment/model replace/undo; interleaved main-slot write, other-instance save, candidate adoption and version revert invalidate stale cursor safely; previous/current config hashes and journals are evidence.
- [ ] Task4: forged iframe source/type or model-written managed config cannot bypass server target proof; attachment missing/hash mismatch/symlink/cancel/adopt/revert checks retain src-only model authority.
- [ ] Independent design rereview is finite and static; root batches feedback to CodeBuddy. No tests or real services before the implementation batch is frozen.
