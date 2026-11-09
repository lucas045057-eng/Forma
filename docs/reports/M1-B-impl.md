# M1-B 写回接口与 Studio 3D 编辑面板

## 交付范围

基于 master `7a80e73`，仅在 `.worktrees/m1b` / `feat/m1b-writeback` 修改、安装、验证、提交。未合并 master、未复制真实 .env、未调用真实 Lux3D；未开子 agent 或团队，未新增/修改 Playwright 用例。

## 接口

| 接口 | 请求 | 成功响应 |
|---|---|---|
| GET /scene | 无 | 完整 SceneConfig |
| PUT /scene | 完整 SceneConfig | SceneChanged（config、diff、sequence、ts） |
| POST /scene/undo | 空请求，无需 JSON Content-Type | 恢复后的 SceneChanged；栈空 409 NO_SCENE_HISTORY |
| POST /assets/:id/adopt | `{}` 或 `{ "force": true }` | 采用后的 SceneChanged |
| WS /events | 现有通道 | 推送 `scene.changed`，与上述写接口相同结构 |

`diff` 是 JSON Pointer 字段路径数组：`{path, oldValue, newValue}`；字段缺失用 null 表示，数字数组可细到 `/hero/camera/position/0`。序号为该作品的场景写入序号，与资产事件序号分别计数。

PUT 使用独立 Ajv 实例，不进行 Fastify 类型强制转换、字段删除或默认值填充；额外字段、非法模型路径、非法数值、非递增关键帧均拒绝。400 INVALID_SCENE 带 `error.fields[]`（path、keyword/message/params）。请求对象中的任意文件路径不会用来决定落盘位置。

配置：

- `WORK_ROOT` 或 createApp({workRoot})：作品根目录，建议绝对路径；默认当前工作树 templates/product-page。
- `SCENE_HISTORY_DIR` 或 createApp({historyDirectory})：历史目录，默认当前工作树 .data/scene-history。
- scene.config.json 始终写到 WORK_ROOT/src/scene.config.json。采用文件始终写到 WORK_ROOT/public/assets/<id>.glb 与 <id>.parts.json。
- 自定义 WORK_ROOT 后，作品预览开发服务也须启动对应作品目录；本接口不会自动重启 Vite。

## 持久性、路径与采用行为

所有读取、PUT、undo、adopt 共用单进程串行队列。历史按作品根目录哈希分文件，避免多个不同 WORK_ROOT 混用 undo 栈。记录包含递增序号、时间、上一份配置、新配置、动作类型和 undo 栈。

提交顺序：先原子写持久 intent（含旧配置和目标栈）→ 原子替换场景 JSON → 原子确认历史 → 发事件。中途断电/进程退出，下一次访问该作品时重放持久 intent；单测覆盖重启重放和正确撤回栈。成功 PUT 压栈，undo 弹栈，不会在两份配置间反复切换。序列化是单后端实例范围，不支持多进程同时写同一作品。

文件用既有 writeAtomic（唯一临时名 + rename）发布。路径检查拒绝词法越界、现有中间目录与最终文件的符号链接/junction；WORK_ROOT 是运维指定的可信根，先 realpath。此检查不宣称防御拥有本机文件写权限的对手在检查后替换目录的 TOCTOU 攻击。历史目录是明确允许的独立持久目录，不属于作品输出路径。

采用仅允许 ready 资产；webReady=false 返回 409 FORCE_REQUIRED，只有布尔 force:true 放行。复制模型和指标中的部件元数据，按模型名生成 sidecar。配置发布后才切换网页模型。稳定资产 URL 不覆盖不同内容：同名文件内容不同返回 409 ASSET_NAME_CONFLICT，保证 undo 引用旧资产时不会读到已被覆盖的几何；相同内容允许重复采用。撤回恢复配置，不删除已发布的模型（旧历史仍可能引用）。采用过程中失败可能留下未被配置引用的文件，不影响当前作品；不提供自动垃圾回收。

## Studio 操作

工具栏新增“3D 场景编辑”，侧栏编辑时保留左侧 iframe 可滚动。M0 的资产面板和源码选择面板继续保留。

- ProductScene 仍为唯一渲染实现；编辑器通过可选回调接收 OrbitControls 相机结果与 TransformControls 旋转结果，不额外实现第二套模型加载/灯光渲染。
- 工具切换：相机、仅旋转的 TransformControls、主光球面手柄。灯光手柄沿以模型中部为中心的球面拖动，将归一化方向写回 light direction；拖动时临时禁用 OrbitControls。
- 主光强度、色温（2700–6500 K → hex）、环境光、lid 0–0.15 滑杆；额外提供 Y 轴旋转滑杆便于精细调整和稳定验收。色温采用 Tanner Helland 近似，有端点、钳位和单调测试；加载配置保留原始 hex，只有操作色温滑杆才转换（滑杆初始显示 4000 K，不表示任意原始 hex 都等于该色温）。
- 开盖仅在 sidecar recognized=true 且 lid='lid' 时可用；无元数据则显示“未识别部件”。默认 4969889 兼容 M1-A 的 parts.json，采用资产读取 <id>.parts.json。
- “设为首屏”写 hero，同时更新零位置关键帧中的 rotation/lid，以免已有 at=0 帧覆盖新首屏角度。其余关键帧保留。
- “记为此处关键帧”从 App 已验证 origin/source 的 iframe scroll:progress 获取 at；±0.02（含边界）覆盖，按 at 排序。保留最近被覆盖帧的其他部件参数；只保存当前 rotation/lid，灯光和相机属于 hero，不生成未定义的动画字段。
- “撤回”恢复前一配置，“采用”使用 ready 列表，明确勾选才能 force；收到 asset.ready 自动刷新列表。
- 右侧显示最近 scene.changed 的 diff；成功 REST 响应也带相同事件，可在消息订阅前后显示本次结果。编辑中的草稿不被外部事件静默覆盖，可主动“读取作品配置”刷新。

## data-testid 清单

| testid | 用途 |
|---|---|
| scene-open / scene-close | 打开/关闭编辑面板 |
| scene-panel | 编辑面板 |
| scene-viewport | 1:1 视口容器，data-loaded=true 表示模型已加载 |
| scene-canvas | 实际 WebGL canvas（由 ProductScene onCreated 标记） |
| scene-scroll-at | 已收到的 iframe 滚动进度 |
| scene-tool | camera / rotate / light 工具选择 |
| scene-rotation-y | Y 轴旋转滑杆，弧度 |
| scene-key-intensity | 主光强度滑杆 |
| scene-temperature | 色温滑杆，K |
| scene-ambient | 环境光滑杆 |
| scene-lid | 开盖滑杆；未识别时 disabled |
| scene-parts-warning | 未识别部件提示 |
| scene-save-hero | 设为首屏 |
| scene-save-keyframe | 记为此处关键帧 |
| scene-undo | 撤回上一次写入 |
| scene-asset-select / scene-force-adopt / scene-adopt | 选择、强制确认、采用模型 |
| scene-load | 读取作品当前配置，舍弃未保存草稿 |
| scene-size | 对照模式画布边长，100–1600 CSS px |
| scene-match-size | 点击时即时读取 iframe 作品 canvas 的 CSS 宽度 |
| scene-compare | 对照模式开关，开启时重读作品配置、隐藏手柄/关闭 OrbitControls |
| scene-config | 视口当前实际使用的配置 JSON（details 内） |
| scene-diff | 最近写入 diff JSON |
| scene-error | 接口或加载错误 |

## Pi 一致性接点

1. 打开 scene-open；等待作品 product-scene ready 和 scene-viewport[data-loaded=true]。
2. 点击 scene-load，再点 scene-match-size、勾选 scene-compare。对照模式使用 GET /scene 原始配置、相同 modelUrl `/preview/main/assets/...`、相同 iframe at，关闭所有编辑手柄。
3. 等待 scene-canvas 与 iframe canvas 的 CSS 尺寸及实际 width/height 都相同，再截图；ResizeObserver 调整是异步的，不能点击同一帧立即断言尺寸。
4. 读取 scene-config 可核对实际配置；scene-scroll-at 可核对滚动位置。可直接设置 scene-size 做固定尺寸比较。
5. 两处 DPR 上限、相机 fov、灯光、背景、色彩、曝光、阴影设置都仍来自 scene-renderer。同尺寸不等于容器 CSS 相同：作品外层有圆角遮罩，Studio 没有；比较原始画布输出，或由 Pi 明确记录共同可见区域/遮罩处理，勿把工具栏、容器圆角和旁边文字混入 3D 像素指标。本轮未作逐像素阈值验收。

## 验证结果

最终 worktree 内 `pnpm typecheck`、`pnpm build`、`pnpm test` 全部通过。共 176 项：shared 67、插件 20、后端 84、scene-renderer 4、bridge 浏览器探针 1。新增 10 项测试，含 Schema/字段错误/无 coercion、原子历史与并发顺序、重启重放、undo 空栈、配置路径与采用目录 junction 拒绝、采用 force/元数据/同名冲突、diff、色温和关键帧覆盖/首屏零帧。

Chrome 原生 CDP 冒烟（没有新增 Playwright）：

- 实际鼠标拖动 OrbitControls，相机从 [1.6,1.1,1.6] 变为 [0.7181003,1.3021631,2.0786694]。
- Y 角度滑杆实际值 1.1484073 rad（原生 range 以 -π 为步长起点，会对 1.15 取步长），环境光设为 2.7；点设为首屏后 REST 配置同时包含新相机、角度和光照，零帧角度一致。
- 读取 iframe 真实 Three 场景，ambient=2.7；页面标记 __smokeIdentity=123 保留，证明没有整页刷新。开始观察时已完成更新，探针读取 1 ms，不作为端到端延迟 SLA。
- 对照模式两边画布实际尺寸同为 397×397。
- 撤回后配置结构与原始配置相等，作品 ambient 恢复 1.2，iframe 身份标记仍为 123。
- 预览滚动到 at=0.6，lid 滑杆设 0.12，写回帧为 lid.offset=[0,0.12,0]；撤回恢复 [0,0.08,0]。最终配置值完全恢复；测试引入的 JSON 格式变化也已复原，不纳入提交。
- 浏览器脚本异常 0。截图在忽略目录 `.data/m1b-editor.png`；一次性 CDP 探针 `.data/m1b-smoke.mjs`，不纳入正式测试套件。

开发环境说明：初次 pnpm dev 暴露 Node strip-only 不支持 TS 参数属性，已改为普通字段；随后默认端口被并行 Pi 测试占用。最终浏览器使用同一 createApp 和两份 Vite 配置，通过本地启动器仅覆盖 3101/5273/5274 端口与相应代理/HMR 端口，未停止其他工作树服务。环境只传 mock-only 和 loopback 上游，不读 .env；没有发起生成请求。Vite 原生 API 在 stdin 结束时会退出，验证启动器使用 CI=true 保持非交互进程。验证服务已关闭。

## 已知限制与未运行

- 正式 Pi E2E、两边逐像素阈值、主光球面手柄与 TransformControls 的完整鼠标交互回归、Firefox/WebKit、触屏未运行；本轮实际拖动验证的是 OrbitControls，模型旋转使用滑杆验证。
- 单进程串行，不是多进程锁；历史为 JSON 文件，未设容量回收策略。事件历史补拉/重连同步仍属 M2。
- 一旦持久 intent 成功，后续 I/O 失败可能在下一次请求/重启时继续完成该写入；这是可恢复的提交语义，不是失败即永久放弃。
- 外部手工把 scene.config.json 写坏时，GET/undo 会先报配置错误；网页的上一份合法配置回退仍由 M1-A 处理。此轮未扩展损坏配置的自动修复策略。
- 写回格式统一为两空格 JSON，撤回恢复配置值，不保证恢复原文件空白排版。
- 采用不清理未引用资产，不覆盖同名不同内容的模型；要重新采用改变后的同编号模型，需由后续资产版本策略处理。
- 前端构建保留 Three chunk 大于 500 kB 的体积警告；未新增第三方库，仅给 server 声明工作区已有 Ajv ^8.17.1（锁定 8.20.0）作为运行依赖。
