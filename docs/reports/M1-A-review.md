# M1-A 共享渲染、配置与部件管线 · Codex 审查报告

- 日期：2026-11-09。
- 结论：**有条件通过**。默认拆分香薰模型的实现链路具备继续测试的基础；共享组件、配置失效回退及转换隔离均已落地，但配置来源、未识别部件降级和启动清理存在 3 项应修。尚不能据此宣告“两处呈现一致”验收通过。
- 分级：**阻断 0，应修 3，建议 4**。
- 范围：合并快照 **7a80e73**，包含 `3c67264`、`daaa4bf`、`d2f7953`、`43aba85`、`20ef519`、`de9fce2`；以下行号全部对应 7a80e73。实现、测试、配置和交付报告通过 `git show` 读取；没有审查 `.worktrees/m1b` 的未合并实现。
- 本次只新增本报告，未改实现、测试、Pi 证据或项目记忆；未读取 `.env`、真实资产索引或调用 Lux3D，没有创建提交。

## 阻断

无。以下问题不妨碍当前单进程、默认配置、已识别拆分模型的基础演示，但应在相关一致性和安全验收收口前处理。

## 应修

### R1 · 共用了渲染器，但 Studio 没有读取作品当前配置和滚动姿态

- **位置**：`apps/studio/src/AssetPanel.tsx:61`；`templates/product-page/src/components/ProductHero.tsx:14`、`:35`。
- **问题**：Studio 始终传 `defaultSceneConfig`，也未传 scrollAt；作品页从 `useSceneConfig()` 读取配置文件并传当前滚动进度。两处共享渲染代码，但实际输入不是同一个状态。当前初始 hero 恰好与默认值相同，不能据此证明配置变化后仍一致。
- **证据**：内存加载两个快照组件，以合法的 FOV=70 配置注入作品配置 store，再检查其实际创建的 ProductScene props：作品为 **70**，Studio 仍为 **35**，Studio 的 scrollAt 为 omitted。没有修改配置文件或运行像素对比，此探针验证的是实际参数来源。
- **为什么应修**：设计的核心是同一配置产生同一呈现。改了作品相机、灯光、旋转或滚动开盖后，Studio 仍显示默认参数；只复用组件不足以满足这一点。这不要求本轮实现全部 M1-B 编辑控件，但须明确接通当前配置的读取路径。
- **修法**：让两处从统一的配置来源获取当前 hero/scroll，Studio 的作品检查模式传入对应 at，并确保比较的是同一模型。可与正在实现的 M1-B 配置读取接口一起落实，但该接口当前不在本次快照中，不能算已完成。Pi 至少以一组明显不同的合法 FOV/灯光/姿态配置做双视口对比，不能只测默认值。

### R2 · recognized=false 仅提示，渲染器仍按原有节点名称应用开盖位移

- **位置**：`apps/server/src/assets/parts.ts:21`；`packages/scene-renderer/src/pose.ts:43`、`:46`；`apps/studio/src/AssetPanel.tsx:84`。
- **问题**：识别失败时保留原始节点名，这是合理的无损降级；但渲染器没有接收 recognized 或允许操作的部件清单，只用 getObjectByName 查找配置中的名称。原模型恰好已有 `lid` 时，即使识别失败、UI 声明“开盖关键帧不可用”，仍会移动它。
- **证据**：构造只有一个名为 lid 的网格的合法 GLB；快照 groupParts 返回 **recognized=false**。用 GLTFLoader 解析同一二进制后调用快照 applyPartOffsets，lid.position.y 从 **0 变为 0.08**。不是只用一个脱离 GLB 管线的字符串对象模拟。
- **为什么应修**：失败降级没有形成执行约束，可能对未知模型的同名节点产生错误动画。默认 4969889 的识别成功不覆盖这一分支。
- **修法**：把处理结果的 recognized/已确认部件清单传到渲染执行层，或写入并验证 GLB 元数据。未识别时禁用部件轨道，只保留整模展示/旋转；不要仅凭原始名字授权开盖。补“未识别且原始模型带 lid/cap 名称”的回归，并验证各节点保持原姿态。

### R3 · 启动清理没有写入者所有权检查，可删除另一个活跃实例的临时文件

- **位置**：`apps/server/src/assets/cleanup.ts:10`、`:14`；`apps/server/src/assets/service.ts:45`；`apps/server/src/index.ts:3`、`:7`。
- **问题**：清理只依据文件名和文件类型，不检查年龄、所属进程或数据目录锁。第二个后端启动时，createApp/init 会先清理，再调用 listen；因此即使稍后因端口占用退出，也已经可能删除第一个实例正在写入的 index/model/raw 临时文件。
- **证据**：对快照 cleanup 函数注入目录适配器，列出一个代表活跃写入的 `index.json.<UUID>.tmp`，rm 被直接调用。函数既没有活跃状态输入，也没有锁或时间判断。该探针没有删除真实文件；竞争后果依据 writeAtomic 的写入/rename 顺序判断，未做双真实进程破坏性测试。
- **为什么应修**：已有“只运行单后端”的约定没有在清理之前强制成立。这里不是要求增加并发资产写入能力，而是要让误启动第二实例不会破坏第一实例。相对 M0-A 的“只清理本次创建的唯一临时名”，本轮增加了跨写入者删除风险。
- **修法**：在任何清理、索引写入和任务恢复前，取得资产目录的排他实例锁，并让离线 CLI 遵循同一协议；无法取得时直接拒绝启动。若不实现可证明所有权的清理，则保留不确定文件，不要仅按 UUID 外形删除。补第二实例/CLI 在首实例持锁时启动的回归，断言首实例临时文件未被碰触。不能把“只删已知命名”当作“只删自己的文件”。

## 建议

### S1 · Euler 逐轴插值会跨 ±π 绕远路，需明确旋转语义

- 位置：`packages/scene-renderer/src/pose.ts:12`。
- 证据：合法配置从 yaw **+179° 到 -179°**，at=0.5 得到 **0°**；实际走约 358° 的路径，而不是约 2° 的短弧。
- 当前默认 0.52→1.8 没有跨界，且设计写的是分段线性数值插值，所以不以此阻断当前默认动画。建议明确编辑控件是否需要短弧；若需要，采用四元数 slerp 或角度展开。若保留整圈旋转能力，应以明确的展开角/模式表达，并分别测试。

### S2 · GLTFLoader 修改了全局默认 LoadingManager

- 位置：`packages/scene-renderer/src/index.tsx:91`、`:92`。
- 问题：`new GLTFLoader()` 未传 manager，Three 的 Loader 默认使用 DefaultLoadingManager；setURLModifier 因而改变全局默认加载行为，而非仅当前视口。拒绝外部资源的策略本身合理，但会影响同页面后续使用默认 manager 的其他 loader，卸载时也没有恢复。
- 修法：为每个加载流程创建独立 LoadingManager，再把它传给 GLTFLoader；补另一个默认 loader 在视口挂载/卸载前后不受影响的检查。当前两处纯灯光视口没有证明因此失效，不列应修。

### S3 · draft-07 Schema 不含严格帧序语义，写回方必须同时使用 guard

- 位置：`packages/shared/src/scene-config.ts:28`、`:129`–`:133`。
- 证据：重复 at 或乱序帧可通过 Ajv Schema，isSceneConfig 会拒绝。交付报告与 Schema comment 已准确披露，作品 store 也确实使用 guard，因此不认定为当前配置失效漏洞。
- 建议：M1-B 对外写入入口统一调用完整校验函数，而非各自记忆“先 Ajv 再额外检查”；在接口级测试重复/乱序不会写盘。scenePose 自身以配置已验证为前提，不负责修复非法排序。

### S4 · Three 分包警告不阻断正确性，但需记录加载预算和资源压力结果

- 位置：`packages/scene-renderer/package.json:4`–`:6`；`packages/scene-renderer/src/index.tsx:77`–`:106`。
- 锁文件中 Studio、模板和共享渲染器使用相同的 Three **0.180.0**、fiber **9.8.2**、drei **10.7.9**、React **19.3.1**，没有发现为同一功能引入另一套 Three 版本。Ajv **8.20.0** 在 shared 的 devDependencies，当前前端 guard 不引入 Ajv 运行时。
- 构建大于 500 kB 的警告来自实现方交付，本次没有重新构建或给出新的 bundle 实测值。建议用压缩后体积、首屏 ready 耗时和冷缓存/离线演示结果决定优化，不仅为消除 warning 而拆包。资源专项还应覆盖快速切换 URL、解析失败、HMR、非默认场景/材质及重复开关视口；当前测试不足以证明长期内存始终稳定。

## 各重点核对结果

### 渲染一致性与离线依赖

ProductHero 与 AssetPanel 都调用 `@spatial/scene-renderer` 的 ProductScene，当前源代码没有各自另设曝光、tone mapping、灯光实现。包内统一 sRGB、ACES、曝光 1、PCFSoft 阴影、1024 阴影图、DPR 上限 2、背景；两处容器使用 aspectRatio=1，相机 fov 来自传入 config。实际配置来源差异见 R1。

Studio 启用了 OrbitControls，额外的 minDistance=0.6/maxDistance=5 也会限制视口相机；M1-B 传入更远/更近的合法相机时，应验证无操作状态不会被 controls 自动钳位而改变一致性。当前默认相机在这个范围内，未另列当前演示缺陷。

没有发现此实现使用 Environment preset、远程 HDR、FontLoader 或远程字体 URL；MeshoptDecoder 从 Three examples 本地模块导入。GLB fetch 后只允许内部 blob/data 资源。这里是导入及调用路径审查，不等于已经运行断网的浏览器网络验收。

### SceneConfig 与非法配置回退

TS 结构与 Schema 的字段/可选项一致：model、hero、scroll 必填，camera/model/lights 的子字段必填；fov 1–120，scale 0.01–100，强度/环境光 0–20，at 0–1；Vec3 为恰好三个有限数，颜色为六位 hex。对象结构拒绝额外字段，parts 只允许安全名称映射；局部模型 URL 排除外部 URL、百分号和路径逃逸段。TS 普通 number/string 不能表达这些运行时范围，不应把类型检查当作校验。

快照 store 的内存探针：初次有效 FOV=70；随后坏 JSON 和 Schema 非法 FOV=999 均保持 **70**；首次即坏 JSON 时使用 defaultSceneConfig，model 为 **空串**，页面走占位。raw 导入让 JSON 语法错误进入自有处理而不是 JSON 模块解析；HMR data 保存上一份合法配置。此项只复现了 store 接受/拒绝逻辑，没有实际编辑文件测试 Vite HMR，刷新后只保留进程内历史的限制也没有被夸大为持久撤回能力。

### 部件启发式与坐标系

启发式为保守的直立香薰识别，不是任意物体语义识别。内存几何探针：标准 body/cap/reed 成功；cap 宽度为 body 的 1.3 倍时拒绝、无藤条的两部件模型拒绝；100 根符合几何条件的藤条可形成 102 个候选部件并成功。失败分支在重命名和重组之前返回，现有单测也验证没有半途改名。对其他物体仍可能在形状相似时误认，实际产品需保留人工校正，不能声称已识别所有瓶形。

groupParts 在归一化后获取 world bounds；移动 cap/reeds 前保存世界矩阵，把它们放到场景根的单位 lid 下，再设回该矩阵，并拒绝不能用 TRS 表达的 shear。body 仍保留原变换。applyPartOffsets 重置基准位置后把归一化模型空间的 offset 通过父矩阵的逆线性部分转换，不把上一次位移累加，也不把外层整模旋转/缩放误算为部件局部基准。默认已识别模型的分组与坐标变换符合设计；失败时的执行降级问题见 R2。

### 子进程、发布与错误

worker 路径固定，参数为解析后的输入路径及本次 mkdtemp staging 内输出；env 只保留必要系统/临时目录变量，execArgv 清空，不继承 key、NODE_OPTIONS 或代理配置。timeout/abort 发 SIGKILL，等待 close 后才移除 staging；本函数的 recursive rm 只针对该次创建的目录，没有全目录扫删。worker 自身不再启动其他子进程。原始错误在内部传回，AssetService 的 failure 对非 AssetError 转成固定文本，REST/WS 不直接回传路径或堆栈。

用 fork/文件系统适配器模拟超时、取消和崩溃：超时/取消各请求 kill 1 次，崩溃直接处理 close；三种均没有在活跃 writer 尚未 close 时清理、没有发布输出，也未向 worker env 传 provider key。**这是流程探针，不是本次真实 OS 进程树终止实测**；现有 process-isolated.test.ts 有真实 worker 的超时/取消/异常用例，需由 Pi 回归确认。

父进程在 worker 成功退出后读取、分别原子发布 parts.json 和 model.glb；两文件不是一个事务，但服务在整条处理成功前不会标 ready。停止信号在 worker 前后检查；父进程最终两次 writeAtomic 未传 signal，取消与发布的竞争应按“可能已写文件、服务仍保留可恢复状态”理解，不能宣称磁盘完全没有副作用。没有发现因该流程自动重新提交付费任务的路径。启动全目录清理是另一条路径，风险见 R3。

### 滚动与资源释放

rotation/各部件 offset 独立采样；隐式 0 帧取 hero.rotation/零 offset，at 越界钳制，非有限 at 归零，末帧保持。guard 拒绝乱序和重复，当前 UI/配置读取路径满足前置条件；跨 ±π 的数值路径见 S1。

每个视口独立解析模型，未继续使用 useGLTF 全局缓存，revision URL 改变会通过 SceneBoundary 的 key 重挂载。effect 清理取消 fetch、dispose 已拥有的默认 scene；解析晚于取消完成也会 dispose。disposeModel 使用 Set 去重 geometry/material/texture/ImageBitmap；共享同一资源的两个 Mesh 探针结果均为 **dispose 1 次，ImageBitmap.close 1 次**。R3F 的已安装版本有 renderer dispose/context loss 清理路径，Canvas 生命周期交给 R3F 处理，并非完全没有释放实现。

尚未实测解析途中失败时的部分资源、GLTF 非默认场景、skinning 资源、快速 HMR 和重复开关下的资源峰值；不得仅凭 dispose 调用存在就宣告无内存泄漏。相关正式压力验收见 S4。

## 本次验证边界与收口建议

执行的均为秒级内存取证：快照组件 props 对照、store 初次/HMR 回退逻辑、Schema/guard 语义边界、Euler 跨界、NodeIO→GLTFLoader 的未识别同名 lid、部件几何 fixture、cleanup 删除目标、fork close/清理顺序及资源去重释放。虚拟文件系统未触碰真实资产；fork 探针未创建真实子进程。

没有重跑 pnpm build/typecheck/test/e2e、实际编辑配置触发 HMR、启动项目开发服务或完成双视口像素对比。交付中的 **166 项通过**、默认模型浏览器 ready 与开盖截图属于实现方证据，本次没有冒充为重新执行。Pi 正在补正式 M1-A 测试，这些结果不在本次审查中预判。

建议回派 R1–R3：一致性读取可结合 M1-B 接口落地；未识别部件的执行限制应在渲染层落实；清理必须先证明单实例所有权。修复后由 Pi 分别覆盖非默认配置、未识别但带 lid 的模型、第二实例误启动，再复核。S1–S4 可按演示路径和后续集成安排，不将尚未实现的 M1-B 写回/撤回功能算作本次新增缺陷。
