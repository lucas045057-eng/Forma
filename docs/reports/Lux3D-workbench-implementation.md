# Lux3D 站内创作增量 — 实现交付报告

- 实现者：CodeBuddy（新窗口续接）
- 设计依据：根 `docs/design/Lux3D-workbench-increment.md` 与 `Lux3D-workbench-implementation.md`，固定提交 **`439d0fd2c577542f37e154f576b10166924632ab`**（父 `63fb82e`，最初 `242e1d0`）。
- 工作区：`E:/空间化AI工作台/.worktrees/m4`，分支 `feat/lux3d-workbench`，起始 HEAD `242e1d0e0f5d76968330fad88eb584b0a6e16366`；在原草稿上续做，未 reset/clean/stash/强切分支，未覆盖快照。
- 本批**没有运行** build、typecheck、test、collect、语法检查、浏览器、服务、probe、job 或真实 Lux3D/Asset/阿里云请求；不读取 `.env`/ASKS，不复制或回显任何凭据。文末“未运行事实”是结论边界。

## 1. 总体结论

十类官方创建能力、查询历史、拖图/选图后的单次生成、点击后才上传云端、幂等与未知不重发、受信附件权限、实例级配置与独立历史、服务端目标校验、主槽替换/实例替换/普通区域候选插入、外部文件拖入保护、动画保留与显式播放、任务持久化与恢复，均已在实现树写齐。

**尚不能宣称验收通过**：本批只交付静态实现与回归代码，没有执行。真实 Lux3D/Asset 云端、真实图片解码/模型处理、真实浏览器原生拖放、真实 Windows 控制台 Ctrl+C 均未验证。

## 2. 十类能力矩阵

| 能力 | 服务端映射（官方路由） | 前端入口 | 产物处理 | 状态 |
|---|---|---|---|---|
| 图生 3D | `/lux3d/v1/generate/img-to-3d/task/create` | 主抽屉拖图/选图，G1/G1-Turbo，面数/PBR/格式 | 固定/无序槽位；GLB 原件入资产，非动画模型可生成网页优化件 | 已写 |
| 文生 3D | `/lux3d/v1/generate/text-to-3d/task/create` | 高级工具；可保留一张参考图 | 同上 | 已写 |
| 多模态生图 | `/lux3d/v1/generate/multimodal-to-image/task/create` | 高级工具，图/文或组合 | 下载实际图片并通过 sharp 解码 | 已写 |
| 四视图 | `/lux3d/v1/generate/image-to-four-view/task/create` | 高级工具 | JSON 数组严格四项，按前斜/后斜/侧/背标签保留顺序 | 已写 |
| 材质迁移 | `/lux3d/v1/generate/material-transfer/task/create` | 高级工具，GLB＋材质图 | 固定 ZIP/GLB/USDZ/OBJ ZIP/FBX ZIP 槽位，`NOT_REQUESTED` 保留位置并解释 | 已写 |
| 部件拆分 | `/lux3d/v1/part-split/task/create` | 高级工具 | 单 GLB，不猜节点业务语义 | 已写 |
| 多格式导出 | `/lux3d/v1/multi-format-export/task/create` | 高级工具；GLB 输入必须至少一种目标格式 | 固定七槽位；不把 glb 当导出格式；不声称无 GLB 可网页采用 | 已写 |
| 关节化与动画 | `/lux3d/v1/articulation-animation/task/create` | 高级工具，GLB＋动作描述 | 结果按实际文件头分类（GLB/ZIP/FBX…），不假定 ZIP | 已写 |
| 数字人绑骨 | `/lux3d/v1/animations/rig/task/create` | 高级工具，仅 GLB | 先识别含 `error` 的 JSON 失败（即使 status=3），不标成功 | 已写 |
| 动画重定向 | `/lux3d/v1/animations/retarget/task/create` | 高级工具，1–10 个规范动作，separate/combined，glb/fbx，原地 | 逐 action 成功/失败；部分成功保留并提示，无成功项失败；combined 保留片段集合 | 已写 |

历史与恢复：`GET /assets/lux3d/tasks`、`GET /assets/lux3d/tasks/:id`、`GET /assets/lux3d/remote-history`；导入已有任务 `POST /assets/lux3d/import-operation`（只查询，不创建）。

## 3. 关键实现

### 3.1 上传与云端边界

- 新增 `apps/server/src/assets/lux3d-upload.ts`：本地暂存，图片仅 PNG/JPEG/WebP、10 MiB、4096 万像素、实际解码；GLB 100 MiB 并做结构/场景/资源校验；SVG/HTML/压缩炸弹/外部 glTF 资源拒绝。上传本身不申请云端 token，也不创建任务。
- 新增 `lux3d-provider-upload.ts`：先取 `/asset/v1/token`，目的域必须 HTTPS、无凭据/路径/端口/查询，命中显式 allow-list 且公网 DNS；本地 mock 例外仅限回环。
- OUS：只使用 `ous-token-v2`，不发送 API `Authorization`；MD5 小写 hex；按 `blockSize` 单文件或 init/part/status；尊重 `deduplicated` 与 `lackBlocks`（区间解析、只补缺失分片）；status 轮询不少于 200 ms、累计 **5 秒**预算；status 5 才取 `url`，6/8 失败；响应/下载有大小与超时边界。
- `X` 原始 JSON 解析（`provider-json.ts`）在 IEEE754 之前把超安全整数 token 保留为十进制字符串；create/get/list/OUS taskId 均按 int64 十进制字符串使用。

### 3.2 任务状态机

新增/重写 `lux3d-task-store.ts`、`lux3d-task-service.ts`：

- 创建前持久化原子占位、参数指纹与幂等键；同键同参返回原任务，同键异参 409。
- 本地同时最多处理 2 个任务；满额时创建请求**明确 429 拒绝**，不静默排队，也不形成未告知的付费提交。
- 已获得 providerTaskId 后只查询原编号；无 ID 的传输/超时/5xx/200 解析失败/缺 ID 一律 `submit_unknown`；**即使列表只有一条也不自动认领**。
- 用户可“只查询恢复”，列表仅展示时间上可能对应的任务；`POST /link` 还要求 `confirmed: true`，并持久化 `manualLink{at,providerTaskId,listedAt,candidateCount,parametersHash}`，明确“校验通过不等于证明是原提交”。
- 明确拒绝（HTTP 400/401/403 或 `c≠0`）为 `rejected`，原键再试不重复 POST；本地校验失败为 `blocked`；其余保守 `unknown`。未知没有伪装成“恢复”的重新创建。
- 停止本地等待：有 ID 保留阶段与编号；无 ID 且可能已提交则 `submit_unknown`，未提交则 `cancelled`；均不声称云端取消/退款。
- 重启恢复：`reserved` 直接取消（未上传/未提交）；`uploading/submitting` 由 store 转为 unknown；只有可信 ID 才按原编号恢复查询。
- 轮询超时/查询失败保留任务与 ID，不用“失败”伪装成需要重新创建。
- 远端链接 2 小时：本地保留原件；上传记录缓存 105 分钟后过期重传；`POST /tasks/:id/refresh` 可重新 getTask 刷新链接并补齐本地文件；下一步云操作只用原件，网页优化件不可作为云输入。

### 3.3 受信附件与模块权限（B2/R1/C1/C2）

新增 `apps/server/src/work/asset-ledger.ts`、`apps/server/src/work/asset-module.ts`：

- Ledger 持久化在工作数据区（`lux3d-ledgers/<candidateId>.json`），模型不能提供或修改；绑定 candidateId、baseVersion、实例、意图、逐路径 `operation/role/beforeHash/afterHash/bytes/assetId`，以及唯一引用动作与锚点。
- 权限顺序固定：路径规范化/安全检查 → `src/scene-modules/**` 与受信 `src/spatial-module.tsx` 拒绝优先 → 普通 `src` 规则。模型对受管命名空间的新增/修改/删除/改名全拒绝；基线已有受管文件也必须由服务端历史/采用证明，C1 不要求本候选 ledger 重新授权未变基线。
- 同一判定用于 `pendingDiff`、`commitCandidate`、检查输入 `resolveCheckCandidate`、采用 `adopt`、批准恢复 `finalizeApprovedTask`；`auditTree` 还对整棵树做受管配置 schema 与生成组件精确格式校验。
- 普通候选也审计静态实例引用集合（C2）：只接受 `<SpatialModule instanceId="…">` 或服务端生成的 `<SpatialModel<id>/>`；新增/删除/移动/重复、动态表达式、额外 props 均拒绝，除非 ledger 声明的 add/remove 动作、文件与锚点完全一致。
- 候选取消只回收自己的副本；模型/来源/部件等共享文件保守保留，不做本轮共享 GC。

### 3.4 实例配置、独立历史与移除

- 新模块固定 `src/scene-modules/<instanceId>.json`，严格 `SceneModuleConfig`：实例、受信 assetId、`/assets/<id>.glb`、相机、旋转、比例、容器内布局（宽百分比/对齐/偏移）与 `{clip,playing,loop}`；不写屏幕坐标，不共享旧 `SceneConfig.model`。
- 旧 `src/scene.config.json` 三根字段与旧 undo 不动；主槽替换继续走 `SceneService.adopt`，模块替换走 `ModuleSceneService.replaceModel`，二者历史独立。
- `ModuleSceneService`（`apps/server/src/scene/modules.ts`）按 workId/instanceId 隔离 journal，记录 before/after 完整配置、哈希、workVersion、mutationId、来源与 segment；保存/撤回在同一作品锁下核对版本与当前内容后原子写入并快照。
- 任何其他版本变化（主场景、其他实例、候选采用、版本回退）都会使旧 cursor 失效：`MODULE_HISTORY_STALE` 拒绝旧 undo，不清空/回放旧快照；重新载入后新调整开启新 segment。
- 崩溃恢复使用有界 pending intent：当前文件等于 before 才重放，等于 after 才收尾，其他情况标记冲突并停止回放；不会覆盖不同版本。
- 移除模块走服务端 remove intent 候选：恰好一处静态引用＋受管 import 被移除，配置/组件删除，ledger 记录原 hash 与 `afterAbsent`；共享模型/来源保留；仍走原请示/检查/采用/回退。
- 受信渲染器 `src/spatial-module.tsx` 只接收 `instanceId`，自行读取服务端配置；生成组件仅含 instanceId 与固定 import，不携带模型 URL/替代配置。

### 3.5 服务端权威放置

重写 `apps/server/src/assets/placement.ts`：

- 会话绑定 assetId、workVersion、有效期；确认时服务端重新取 head，版本变化即拒绝。
- 服务端自行 AST 校验目标：`ProductHero.tsx` 中含 `ProductScene` 的 `data-testid="product-scene"` 元素或 `<ProductHero/>` 才认定主槽；`data-spatial-module` 只接受服务端存在的实例；普通元素才允许插入。iframe 声明的 kind 与真实目标不符时 `PLACEMENT_TARGET_MISMATCH`，不采信 iframe。
- 主槽 → `scene.adopt`（保留 force 语义）；已有实例 → 安装不可变资产文件后 `ModuleSceneService.replaceModel`；普通区域 → 生成带 ledger 的模块候选，仍走原批准/检查/采用/回退。
- 同一会话指纹防重复确认；成功后缓存结果；失败清除指纹。会话过期拒绝。
- 超过网页门槛需要用户勾选“明确强制采用”；服务端不再无条件假称已优化。

### 3.6 前端与桥

- `Lux3DWorkbench.tsx`：简洁主流程＋折叠高级工具；拖入只本地暂存；生成按钮旁固定计费/公开链接/不提供云端删除说明；未知只提供查询/明确关联；同键同参重复点击不二次创建；明确“新一轮”才换键；任务历史、片段播放/暂停/循环、原件下载/原件作为下一步输入、刷新链接。
- `AssetModuleControls.tsx`：实例列表、独立布局/角度/比例/动画调整、保存即写作品版本、单实例撤回、创建移除候选；显示 cursor 失效。
- `AssetPlacement.tsx`：左置确认面板，结果抽屉保持可见；支持主槽/实例/新增三类目标；插入布局、强制采用勾选、键盘/按钮替代入口。
- `AssetPanel.tsx` 改为非模态右侧抽屉；`App.tsx` 放置期间保留抽屉，放置会话缓存失败会清理。
- `packages/bridge/src/asset-placement.ts`：识别 `data-spatial-module` 目标；外部文件拖入 preview 时阻止导航并提示回到上传区；内部放置仍校验 sessionId/assetId、origin/source；临时 tabindex 在停止后恢复。
- `scene-renderer`：显式播放/暂停/循环，暂停保留时间；无片段时保持静态；卸载停止 action 并 uncache；不再默认播放。

## 4. 路由与配置变更

新增：

- `POST /assets/placements/sessions`
- `POST /assets/placements/:id/confirm`
- `GET /assets/modules`
- `GET /assets/modules/:id`
- `POST /assets/modules/:id/adjust`
- `POST /assets/modules/:id/undo`
- `POST /assets/modules/:id/remove`
- `GET /assets/lux3d/capabilities`
- `POST /assets/lux3d/operations`
- `GET /assets/lux3d/tasks`
- `GET /assets/lux3d/tasks/:id`
- `POST /assets/lux3d/tasks/:id/stop`
- `POST /assets/lux3d/tasks/:id/resume`
- `POST /assets/lux3d/tasks/:id/refresh`
- `POST /assets/lux3d/tasks/:id/link`（要求 `confirmed: true`）
- `GET/POST /assets/uploads`、`GET /assets/uploads/:id/preview`
- `GET /assets/lux3d/remote-history`、`POST /assets/lux3d/import-operation`

保留：旧 `/assets/lux3d`、`/assets/lux3d/import`、`/scene*`、旧撤销/采用/检查路由。新能力使用官方新网关 `api.aholo.cn`；旧显式 `LUX3D_BASE` 不自动替换、不跨域重试。可配置 `LUX3D_UPLOAD_HOSTS`（逗号分隔）收紧 OUS 目的域。

依赖/锁：未新增第三方依赖，`pnpm-lock.yaml` 未改。`packages/shared/package.json` 仅新增 `./scene-module` 导出。模板新增 `templates/product-page/src/spatial-module.tsx`。

## 5. 回归代码清单（只写不跑）

新增：

- `packages/shared/src/scene-module.test.ts`：严格配置、身份不可调、受管路径大小写/分隔符。
- `apps/server/src/work/asset-ledger.test.ts`：受管拒绝、精确字节证明、public 附件、未发生引用变化、重复/动态引用。
- `apps/server/src/scene/modules.test.ts`：单实例保存/快照/撤回、stale cursor、错误版本不落盘。
- `apps/server/src/assets/placement.test.ts`：服务端主槽识别、iframe kind 不符、普通元素插入、陈旧目标。
- 更新 `apps/server/src/work/asset-module.test.ts`：新 `scene-modules` 包、移除恢复原元素、生成组件仅 instanceId。
- 更新 `apps/server/src/assets/mock-server.test.ts`：十路由、分页形状、int64 原始数字、OUS token/single/block/status、多格式与 NOT_REQUESTED。
- 更新 `apps/server/src/assets/lux3d-results.test.ts`：部分失败保留成功产物、不再把部分失败标为 error。
- 更新 `apps/server/src/assets/lux3d-provider-upload.test.ts`：deduplicated、lackBlocks 只补缺失分片。
- 更新 `apps/studio/src/placement-state.test.ts`：replace-module 只接受服务端形状实例编号。
- 既有操作/上传/任务/存储回归保留并随接口调整。

## 6. 未运行事实与风险

**未运行**：`tsc`、build、vitest、Playwright、collect、语法检查、浏览器、真实服务、probe、Orbital job、真实 Lux3D/Asset/OUS/阿里云请求。未验证真实云端任何能力，未验证真实图片/GLB 解码路径，未验证原生拖放/跨 iframe 滚动/缩放，未验证真实 Windows 控制台 Ctrl+C。

**必须由根集中验证时优先看**：

1. 新模板 renderer 的 Vite 解析与 `import.meta.glob` 类型；真实浏览器中模块配置热更新/刷新。
2. `securePublicFetch` 手写 multipart 在真实 OUS 的兼容性；真实 status 5 链接域；5 秒 status 预算是否足够。
3. 真实 Lux3D 返回的各操作槽位/`NOT_REQUESTED`/Turbo 乱序/rig error JSON/retarget combined 形态是否与规范样例一致。
4. 旧验收树/旧候选缺少 `candidates/.base-<id>` 元数据时 `commitCandidate` 会拒绝；需要根确认是否只影响旧数据。
5. `computeSnapshot` 总字节上限 50 MiB 与上传 GLB 100 MiB 的差异：大模型模块候选可能通过上传但在检查快照被拒；本轮未放宽旧上限。
6. 模块历史 UI 未提供相机 X/Z 与 offsetX 输入；服务端 schema 与历史已支持，UI 只暴露常用子集。
7. 共享模型 GC 按根指示保守未实现；移除实例保留模型/来源文件，避免破坏撤回。
8. mock 的 `/lux3d/v1/generate/task/list` 形状从旧的 `d: []` 改为分页对象（官方契约）；对应旧 mock 测试断言已同步，不是放宽安全断言。

## 7. 提交范围

本批只改实现树中 Lux3D 增量相关源码、模板 renderer、回归与本文档；保留未跟踪 `docs/reports/M4-full-M1B-sync-static-diagnosis.md` 与 `fallback/`，不 merge/push 主线，不触碰 20884/39743 验收实例或其作品/数据/端口。
