# M1 3D 写回 · 设计与任务拆分

依据：`docs/dev-doc-v0.1.md` §3D 操作写回网页。**过关条件：工作台 3D 视口与网页呈现一致**；在视口里调角度、灯光，网页即时同步。这条链路完全不经过大模型，是 Demo 最稳的一环。
前置：M0-A、M0-B 均最终过关（含整改）。输入模型：`fallback/lux3d-split-4969889.glb`（part-split 后 6 部件：瓶身、瓶盖、4 根藤条；部件无名字，见 docs/research/lux3d-api.md）。

## 核心设计决定

1. **同一个渲染组件，两处使用**——新建 `packages/scene-renderer`：`<ProductScene config modelUrl scrollAt? />`（@react-three/fiber + drei）。作品模板用它只读渲染；Studio 视口用同一个组件，外面再套编辑控件（OrbitControls、TransformControls、灯光手柄）。“所见即所得”靠同一份代码保证，而不是两份实现对齐。
   - 渲染参数固定在组件内并共享：sRGB 输出、ACES tone mapping、曝光 1、阴影设置、像素比上限 2。
   - **不从网络加载 HDR**（drei `Environment preset` 会走 CDN）；环境光用 three 自带的 `RoomEnvironment` 或纯灯光，保证离线可用。
   - Studio 视口的长宽比锁定为网页首屏 3D 区域的长宽比，相机 fov 一致。
2. **配置文件即接口**：作品的 `src/scene.config.json`，结构按开发文档示例（model / hero.camera / hero.model / hero.lights / scroll[]）。
   - 类型与 JSON Schema 放 `packages/shared`（`SceneConfig`、`sceneConfigSchema`）；后端写入前用 ajv 校验，网页读取时也做轻量校验，非法时回退到上一份合法配置而不是白屏。
   - 坐标系：模型局部空间 = 处理后的归一化空间（Y 向上、最大边 1、底面中心为原点）；`parts.<name>.offset` 以该空间为单位。
3. **部件稳定命名（承接 M0-A 审查 S4）**：资产处理管线在归一化后按包围盒自动命名节点：最低且体积最大 = `body`；紧贴 body 顶部、宽度最大的剩余部件 = `cap`；其余细长部件 = `reed_1..n`；并新建分组节点 **`lid`** 包含 `cap` 与全部 `reed_*`（开盖时瓶盖和藤条一起抬起）。命名结果写入资产元数据 `parts.json`，Studio 可人工改正。无法识别时不命名，UI 提示“未识别部件，开盖关键帧不可用”。
   - 体积门槛：输出 > 3 MB 或 > 10 万顶点时资产标记 `webReady: false` 并在 UI 提示，不再静默通过。
4. **写回路径**：`PUT /scene`（body 为完整 SceneConfig）→ 校验 → 原子写入作品目录的 `src/scene.config.json` → Vite HMR 让网页即时更新 → WebSocket 推 `scene.changed`（含 diff）。
   - 作品目录在 M1 用配置项 `WORK_ROOT`（默认 `templates/product-page`）；M2 引入候选 worktree 后切到候选目录，接口不变。
   - 每次写入前把旧配置存入 `.data/scene-history/`，提供 `POST /scene/undo`；Studio 显示“参数 diff”（改了哪些字段、旧值 → 新值）。
5. **资产采用**：`POST /assets/:id/adopt` → 把处理后的 model.glb 复制到作品 `public/assets/<id>.glb`，并更新 `scene.config.json` 的 `model`。
6. **滚动关键帧**：网页里 bridge 已有 `scroll:progress { at }` 消息。作品页 3D 组件按 `scroll[]` 关键帧对 `model.rotation` 与 `parts.*.offset` 做分段线性插值（smoothstep 缓动）。Studio 流程：用户在预览里滚到目标位置 → Studio 显示当前 `at` → 在视口摆好姿态/拖动“开盖”滑杆 → 点“记为此处关键帧”→ 写入 `scroll`（同 at ±0.02 视为覆盖）。

## 作品页改动
- 用 `ProductScene` 替换首屏的 CSS 瓶子占位（`.product-art`），首屏 3D 区域固定长宽比；无模型或加载失败时回退到现有占位图，不白屏。
- 作品依赖 three / @react-three/fiber / drei（版本与 Studio 一致，pnpm workspace 共享）。

## Studio 3D 面板
- 视口：OrbitControls 调相机；TransformControls（仅旋转）转模型；主光方向手柄（拖动球面上的点）；滑杆：主光强度、色温（2700K–6500K → hex）、环境光；“开盖”滑杆（lid.offset.y 0–0.15）。
- 按钮：**设为首屏**（写 hero）、**记为此处关键帧**（写 scroll）、**撤回上一次写入**、**采用此模型到作品**。
- 右侧显示本次写入的参数 diff。

## 任务卡

### M1-A 渲染组件、配置 Schema 与作品页接入（CodeBuddy）
- `packages/scene-renderer`、`packages/shared` 的 SceneConfig 类型与 JSON Schema、作品页替换占位、滚动插值、加载失败回退。
- 资产管线部件自动命名 + `lid` 分组 + `parts.json` + `webReady` 门槛。
- 用 `fallback/lux3d-split-4969889.glb` 处理后的资产作为默认模型。

### M1-B 写回接口与 Studio 3D 面板（CodeBuddy，M1-A 之后）
- `PUT /scene`、`POST /scene/undo`、`POST /assets/:id/adopt`、`scene.changed` 事件；Studio 面板全部控件与 diff 显示。

### Pi 测试（M1-A、M1-B 各一轮）
- **一致性（过关核心）**：同一配置下，Studio 视口画布与网页首屏画布截图（同尺寸）像素差异低于阈值（阈值在报告中给出并说明理由）；改角度/灯光后两边再次一致。
- 即时同步：写入后网页在 N 秒内更新（记录实测耗时），无整页刷新。
- Schema：非法配置被拒绝（4xx），网页不白屏；手工写坏 JSON 时网页回退到上一份合法配置。
- 撤回：撤回后文件内容与网页都恢复。
- 滚动关键帧：滚到 at=0.6 时 lid 上移量与配置一致（读取 three 场景图或像素证据）。
- 部件命名：对 4969889 拆分模型，`body`/`cap`/`reed_1..4`/`lid` 命名与人工核定一致。
- **承接 M0-B 复核 N3**：M1 给作品页加入条件渲染（3D 加载成功 vs 回退占位图）后，M0-B 的“AST 节点集合 = DOM 标记集合”完整性检查会误报。须按渲染状态分别定义“应渲染集合”（3D 成功态 / 回退态各跑一次），保留“渲染树无漏标”和独立锚点断言；不得写死数量或删除 missing 检查来掩盖。

### Codex 审查
- 两处渲染是否真正共用一套参数；Schema 与 TS 类型是否一致；写回原子性与并发写；路径安全（WORK_ROOT 之外不可写）；HMR 下的资源释放（WebGL context、纹理、geometry dispose）。

## 留给后续
- 写入候选 worktree 而非直接写作品目录：M2。
- 持久事件序号与补拉（M0-A 审查 S2）：M2。

### M1-A-fix 审查整改（依据 docs/reports/M1-A-review.md，结论“有条件通过”；按用户“做完收个尾”留到下次开工）
- R1：Studio 视口用默认配置，没读作品当前 scene.config.json 和滚动姿态——M1-B 的 `GET /scene` 与“视口 vs 网页一致性测试接点”应覆盖；M1-B 交回后核对是否已解决，未解决则并入本卡。
- R2：parts.recognized=false 时，原模型里恰好名为 `lid` 的节点仍会被开盖轨道移动——渲染器应只在 recognized=true 时应用 parts.* 偏移。
- R3：启动清理 *.tmp 无写入者所有权检查，可能误删另一个活跃实例正在写的临时文件——临时名带实例/进程标识，只清理本实例或确认过期（如超过时限且无锁）的文件。
- 建议：S1 Euler 逐轴插值跨 ±π 绕远路（改四元数 slerp 或规定最短路径语义）；S2 GLTFLoader 改动全局默认 LoadingManager；S3 draft-07 Schema 不表达关键帧严格递增，写回方必须同时用 guard；S4 Three 分包体积警告，记录加载预算。
