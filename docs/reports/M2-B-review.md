# M2-B 指着说工作台界面 · Codex 审查

- 日期：2026-11-13；结论：**有条件通过**。
- 范围：合并快照 **c93286f**，包括 b4bf0ee、2251c58、0a066e7、d0196b3、b0b61f4 及分源接线；以下行号均对应此快照。
- 分级：**阻断 0，应修 1，建议 3**。M2 整体仍受 M2-A 复核未关闭问题约束；本报告的界面结论不代表整体可以过关。
- 仅新增本报告并追加 M2-A 报告；未改实现或测试，未读取真实 key，未调用真实模型。Pi 正在迁移测试，本报告不代替其结果。

## 应修

### R1 · 新点选等待版本号时，仍可能携带上一个选中对象提交

- 位置：`apps/studio/src/App.tsx:72`–`:81`；`apps/studio/src/PointSpeak.tsx:18`–`:22`、`:30`–`:34`、`:49`–`:50`。
- 问题：收到新 pick:result 后立即高亮新元素，但 Selection 只在异步 GET /version 成功后替换。期间没有清除旧 Selection，也没有 pending 状态来禁止提交；请求失败时仅显示错误，旧 Selection 继续有效。
- 具体时序：先选 A，再选 B；B 已高亮，版本请求仍在等待，此时按生成或 Ctrl/⌘+Enter，实际携带的仍是 A。若 A 文件未改变，后端 STALE_SELECTION 校验不会阻止任务。失败分支还可能让这个错配一直保留。
- 影响：“指着哪个改哪个”的核心语义不可靠；请求变慢时可能把真实编码模型额度花在错误对象上。requestId 能拒绝乱序的旧响应，但不能解决等待期间的旧值提交。
- 修法：新点选时立即使旧 Selection 失效，显式保存“正在读取版本/选取失败”的状态；等待或失败时禁止对象指令提交，包括快捷键。不能只置为 null 后让它无提示地变成“整体修改”。只允许最新点选成功绑定版本后恢复提交；失败要求重新点选。
- 验证要求：延迟/拒绝第二次 `/version`，确认高亮 B 期间既不能提交 A，也不能提交无 Selection 的全局任务；恢复后请求必须携带 B。此问题由代码执行顺序确认，本轮未用浏览器延迟注入重跑。

## 建议

### S1 · 画布尺寸请求立即返回缓存，首次数值不一定对应当前画布

- 位置：`apps/studio/src/App.tsx:89`、`:97`。
- 问题：previewSize 发 viewport:request 后同步返回 canvasWidth.current；postMessage 回复只能稍后到达。常驻尺寸上报通常能更新缓存，但首次点击或刚布局变化时仍可能使用默认/旧宽度，影响“匹配尺寸”及像素对比。
- 修法：带 requestId 请求并等待对应回复，或按钮仅在收到当前布局尺寸后可用；对不可信预览上报的宽度按编辑器范围限幅。补首次请求和布局变化后立即匹配的用例。

### S2 · 区分操作已成功与随后刷新状态失败

- 位置：`apps/studio/src/CandidatePanel.tsx:34`–`:45`；`PointSpeak.tsx:22`–`:28`。
- 问题：mutation 成功、reload 失败会进入同一个错误分支。用户可能只看到“操作失败”，再次点击；取消/重试也有类似反馈歧义。busy 防住普通重复点击，但不是服务端幂等标识。
- 修法：分别呈现“操作成功，状态刷新失败，可重载”，保存服务端操作结果，并在刷新前保持对应候选操作禁用。后端串行化及决策重检目前可阻止同一候选重复采用，不据此报告已经发生正式版本重复合并。

### S3 · 事件重连继续补真实中断、截断与重载交错验收

- 位置：`apps/studio/src/EventCenter.tsx:35`–`:42`、`:64`–`:94`；`apps/studio/src/m2-state.ts:33`–`:40`。
- 判断：单连接、seq 去重/排序、缺口补拉、历史截断后全量加载、重载期间事件回放均已有实现；不能仅凭 reducer 单测证明网络交错下的界面完整性。
- 建议：Pi 覆盖断线期间多事件、重复/乱序投递、截断后重载期间继续变化、后端数据重置使 seq 变小、请求失败后重连，以及卸载清理。reload 回放缓冲最多 2000 条，超慢重载期间超过窗口、缺少 epoch 等长期边界与 M2-A S2 一起管理。未发现可据现有代码直接判定的普通重连丢事件缺陷，不将待验证项虚列为应修。

## 重点核对结果

| 项目 | 判断与证据 |
| --- | --- |
| 统一事件中心 | `EventCenter.tsx:49`–`:119` 建立一条共享连接，1 秒后重连，清理 timer/socket/listeners；`:100`–`:104` 用队列串行处理消息。各面板使用同一 context，未各自建立 WebSocket。 |
| 补拉/去重/截断 | `m2-state.ts:37`–`:40` 按 seq 去重排序；`EventCenter.tsx:64`–`:94` 遇缺口补拉、truncated 重载；ready 序号低于本地时重新加载。`:35`–`:42` 用 reloadId 丢弃过期请求，并回放加载期间接受的事件；这些是接线检查，不冒充真实断网验收。 |
| 跨源消息 | `App.tsx:47`–`:61` 同时检查精确 preview origin、main/candidate contentWindow；候选不能改变 Selection。`packages/bridge/src/index.ts:4` 起解析规范的 HTTP(S) Studio origin，`:53` 要求 event.origin 与 parent source 均正确，发送采用精确 targetOrigin。studioOrigin 查询参数是消息路由约定，不是正式 API 授权凭据；未发现通配 targetOrigin 或靠候选消息授予写 API 权限。 |
| diff/模型文本进入 DOM | `CandidatePanel.tsx:13`–`:16` 通过 React 文本节点渲染文件名和 patch，不使用 innerHTML。对带 `<img ...>` 的 patch 做内存 React SSR 检查，结果为转义文本、没有 img 元素。instruction/步骤/错误也作为文本渲染。不能把预览主动执行页面代码与 diff 注入混为一谈，前者由 M2-A 的分源保护。 |
| 采用/撤回/回退 | `CandidatePanel.tsx:34`–`:45` 等待接口并捕获冲突、无回退记录等错误；`:51`、`:71`–`:72` 在 busy 时禁用按钮。M2-A 后端用作品互斥和持久意图重检状态，UI 不是唯一并发防线。未发现界面直接绕过 pending 决策的路径；刷新错误反馈见 S2。 |
| 未检查语义 | `CandidatePanel.tsx:68` 对四项始终渲染 `data-status="not_run"` 和“未检查”，不从候选完成、采用或模型摘要推导“通过”；`apps/server/src/work/service.ts:30` 也初始化为 not_run。当前阶段没有找到任何把这四项显示成通过的分支。M3 引入真实检查时再改为可信结果。 |
| 保留当前预览 | `App.tsx:105` 起保留 main iframe，候选单独用 id 作 key，切换视图不需要重建当前页；滚动和画布尺寸改走 bridge 消息，不再跨源读 DOM。当前/候选属于同一预览 origin，并不声称彼此隔离；其共同边界是 Studio/API。 |

## 收口条件与验证边界

关闭 R1 后，由 Pi 回归延迟/失败点选绑定版本、正常提交及快捷键，并完成新的分源消息、候选真实渲染、采用/撤回/回退、事件重连测试。M2-A 本轮仍有独立阻断及应修项，需一起关闭。未重跑 build/typecheck/完整单测或 E2E；未做真实模型“10 次至少 8 次改对”、多浏览器或触屏验收。

## 复核（第二轮整改）

- 日期：2026-11-13；范围：**fix/m2-review2，cc9ea12**，重点为 a4523e8。行号对应该分支快照，尚未合并 master。
- **结论：仍为有条件通过，不能转为“通过”。** R1 **部分修复**：普通生成按钮与快捷键已阻止 pending/failed 提交，但任务重试入口仍可绕过。阻断 0，应修 1。M2-A 的独立阻断/应修仍需同时关闭。

### R1 核对与剩余问题（应修）

- 已修证据：`apps/studio/src/App.tsx:79` 收到新 pick:result 立即进入 pending，旧 Selection 不再作为当前选中对象；`:81`–`:89` 只接受最新 requestId，失败进入 failed。`apps/studio/src/pick-state.ts:15`–`:16` 仅 none/ready 允许提交，pending/failed 不会降级为整体修改；`PointSpeak.tsx:36` 对 Ctrl/⌘+Enter 检查 submittable，`:53` 禁用普通生成按钮。
- **遗漏位置：`apps/studio/src/PointSpeak.tsx:21`–`:25`、`:64`。** 公共 submit 只检查非空文本和 busy，没有检查当前 pick 状态；task-retry 只按 busy 禁用，直接把旧任务 active.selection 传进去。因此选 B 正在等版本或已经失败时，点击“重试”仍可携带任务 A 的 Selection 发 POST /tasks。它也可能绕过失败状态发一个没有 Selection 的旧整体任务。
- 实证：从分支读取实际 PointSpeak TSX，内存转译执行，使用 hooks/JSX/API 替身且不启动浏览器。分别构造 pending(B)、failed(B) 和失败任务 A；两次均得到 **generateDisabled=true、retryDisabled=false**，调用真实 retry handler 后均捕获 **POST /tasks，selection=src/A.tsx:1:1**。未调用真实后端或模型。新增 pick-state 单测只验证 canSubmit 等纯函数，不能覆盖漏接的 retry 调用路径。
- 为什么需修：本轮约定明确要求 pending/failed 下所有提交都被阻止；“重试旧任务”不能成为绕过该状态门禁的另一个入口。后端 STALE_SELECTION 只检查旧对象是否过期，A 仍有效时不会替界面拦截。
- 修法：把当前点选状态门禁放到所有入口共用的 submit 中，并同步禁用 task-retry；如果产品要允许独立重试旧任务，须另行明确状态和所用对象，不能悄悄绕过“正在读取 B”的提示。本轮按既定不允许提交的语义修复即可。
- Pi 回归要求：pending、failed 分别覆盖普通按钮、快捷键、task-retry，断言零请求；ready 后正常提交最新选中对象，none 状态仍允许用户明确发整体修改。保留合法任务重试的反向对照，避免一律禁用重试。

### 其他判断与验证边界

原 S1–S3 未在本轮实现，继续作为建议，不新增阻断。此次只追加报告，未改 TSX 或 Pi 用例；内存 handler 探针不是浏览器端到端验收。整改分支尚未合并，最终仍需 Pi 对合并后的代码回归。

## 复核（补修）

- 日期：2026-11-13；快照：**d79c467**（fix/m2-review2，尚未合并 master）。
- **结论：M2-B 实现审查可以转为“通过”。** 原 R1 及其 task-retry 遗漏均已关闭，本次未发现新增阻断/应修；S1–S3 继续作为建议。此结论不代表 M2 整体过关，M2-A 的 N4、D3 及 Pi 的最终回归仍独立存在。

### R1（含重试）已修复

- `apps/studio/src/PointSpeak.tsx:22` 在所有入口共用的 submit 内检查 `!submittable`，即使 handler 被直接调用，也不能在 pending/failed 时提交。
- 普通生成按钮 `:53`、Ctrl/⌘+Enter `:36` 原有门禁保留；task-retry `:64` 新增 `!submittable` 禁用。重试仍携带原任务的 Selection，这是显式重试旧任务的既定语义；如今它不能绕过当前点选尚未完成/失败的状态。
- 从 d79c467 读取真实 TSX 与 pick-state，内存转译执行；hooks/JSX/API 使用无浏览器、无网络替身。构造旧失败任务 A，分别传入 pending(B)、failed(B)，两次均为 **retryDisabled=true**，并强行调用 retry handler，**POST /tasks 请求数=0**。ready 和 none 的合法重试反向对照均为 **retryDisabled=false、请求数=1**，没有把重试一律关掉。
- App 的新点选立即进入 pending、requestId 拒绝过期版本回复、失败不降级为整体修改等机制未被本次改动削弱。普通按钮、快捷键和重试现在最终共用同一 submit 门禁。

### 验证边界

只追加本节，未改实现与 Pi 用例；上述是实际 handler 的内存探针，不是浏览器回归。Pi 仍需在最终合并树上覆盖延迟/失败版本请求、快捷键和重试，以及其已列出的 STALE_SELECTION 提示、断线重连等界面验收。M2 真实模型“10 次至少 8 次改对”不在本次审查范围。
