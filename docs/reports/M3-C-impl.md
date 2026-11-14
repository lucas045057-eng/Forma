# M3-C 实现报告

## C1 — ApprovalPanel 与事件持久补拉

状态：实现已提交，自测通过（由调度核对后台原始日志）；尚未经 Pi 独立测试与 Claude Code 独立审查，不代表 C1 或 M3-C 正式验收通过。

基线：master `bc615bf`。实现分支 `feat/m3c-approval`，独立树 `.worktrees/m3c`。没有合并、push 或修改主工作树产品文件。

### 分步提交与文件

- `24af7e6`：`approval-state.ts`、`approval-state.test.ts`、`m2-state.ts`、`EventCenter.tsx`。新增持久请示、稳定排序、保守决策/坐标策略；唯一 WS 的四份 REST 快照与历史重放、连接和请求代次隔离、2000 条事件缓冲、连续序号检查。截断/溢出最多三次重新锚定，失败保留旧展示并关闭同步门禁。每次重连重读任务、候选、作品版本和请示；旧请求/旧 socket 不得提交结果。保留公共事件订阅与 state.reload 通知。
- `61303b0`：`ApprovalPanel.tsx`、`App.tsx`、`PointSpeak.tsx`、`CandidatePanel.tsx`、`style.css`。持久 pending/历史卡、中文状态、数字 option 回答、同步请求锁、任务取消、结果未知/刷新失败提示；采用按钮固定 disabled。独立影响模式只向当前作品 frame 发送精确 origin 的既有 bridge 消息，不替换 Selection、不触发指着说提交；终态/失步/版本变化/iframe 重载/场景编辑退出。场景编辑期间仍显示请示卡。
- 后续提交：静态渲染单测、候选终态防回滚、坐标路径校验与本报告；最终固定提交号随交付回报给调度。

### 行为与边界

1. 决策仅 POST `/approvals/:id`，body 为 `{option:0}` 或 `{option:1}`。先同步占用 cardId 锁，回答与取消互斥；不自动重发 POST、不乐观写 approved、不根据响应制造 Candidate。写操作完成后只经 GET + 历史重放恢复权威状态。
2. POST 成功而刷新失败提示“操作已提交，状态刷新失败，请刷新状态”；结果未知时保留锁，服务器同步成功后再允许用户明确回答。全局“刷新状态”仅 GET。
3. 定位优先关联任务同基线 Selection 且其文件在 affected 中；其次精确 `src/...:行:列` 的 JS/TS 源码项。文件级/CSS/无法确认的坐标保留证据并降级，不猜测 evidence。没有 DOM 定位回执，不宣称命中数量。旧基线无定位/回答权限。
4. 原 PointSpeak 的选取结果保留；影响模式忽略 pick:result，退出仅恢复仍同版本的合法选取模式。候选 frame 保持精确 origin/source 检查且始终 pick:stop。
5. C2 接点：`M2State.runs` 按 runId 存放，check.started/updated/finished 归并入口已预留；C1 快照不读取 latestCheckRun 详情，C2 须接入详情、关联校验和证据读取。C1 不展示检查成功，不开放采用。

### 自测与结果

已执行：`git diff --check` 通过；改动范围人工核对仅 Studio 前端/纯函数单测及本报告。未修改后端、shared/bridge、模板、依赖清单、锁、Pi E2E、历史报告证据；未读取真实 .env，未访问 staging 或调用模型。

已由根 `orbital/bin/bg.cmd` 单次后台执行，受测提交 `886bd99`：

```text
cd /d .worktrees\m3c && set CI=true&& call pnpm install --offline --frozen-lockfile && call pnpm --filter @spatial/studio test && call pnpm typecheck && call pnpm build
```

结果：`job_4a6d1a6a`（group `grp_d07a7c9a`）exit 0；Studio `Test Files 6 passed (6)`、`Tests 16 passed (16)`；全仓 `pnpm typecheck`、`pnpm build` 全部 Done。原件：根 `orbital/jobs/job_4a6d1a6a/output.log`。以上由调度读取日志并反馈，本轮不重复起跑。调度同时核对 `886bd99` 仅修改 Studio 与本报告，禁止区域零改动、工作树干净。

新增单测覆盖：请示排序、按 id 归并、终态防回滚、损坏 payload 拒绝、同基线/关联任务/同步门禁、定位降级、模式恢复策略、历史与缓冲乱序去重和缺号拒收；静态 React 渲染检查文本转义、实体 testid、终态/不同步真实 disabled、C1 采用固定 disabled。没有运行 Pi 正式验收套件。

### 未覆盖与 Pi 接点

- 待 Pi real UI：三按钮 overlay=3、真实 HTTP 数字回答与双击/键盘单次 POST、批准前无候选/批准不增加模型请求、拒绝与任务取消、合法服务重启、断线恢复、单 WS、3D 场景编辑与 M2 选择/分源衔接。
- 待 Pi 受控 mock：旧 GET/旧 socket 晚到、回答响应丢失、快照失败/截断/缓冲溢出、409 终态竞态、未知 payload。纯函数/静态渲染测试不冒充这些集成证据。
- 现有 bridge 无精确 DOM 回执，草稿与当前基线坐标可能不同，仍需 Pi 在当前 iframe 内独立核查 overlay。仅展示“查看源码对应位置”，不保证任意源码均能命中 DOM。
- 保留冻结 testid：approval-panel/card/approve/reject/affected/status/error/highlight-exit、state-refresh；卡容器含 data-approval-id/data-task-id/data-status；原 preview-frame/candidate-frame、events-status/seq、pick-toggle 保留。
- C1 交付时 C2/C3 尚未实现（C2 后续进展见下节）。独立测试与 Claude Code 独立审查尚未进行。

### 需调度批准

目前无后端/协议变更请求。所有实现仅使用现有 HTTP/事件/bridge 合同。

## C2 — CandidatePanel 真实检查与证据

状态：实现与单测已提交，自测通过（调度核对后台原始日志）；不代表 C2 或 M3-C 验收通过。继续使用 `.worktrees/m3c`、`feat/m3c-approval`，从 `886bd99` 接续；`928db02` 先补录调度确认的 C1 自测实况。

### 文件与分步提交

- `da1a194`：`check-state.ts` / `check-state.test.ts` 提供四项状态、候选/run 关联、终态归并和受限证据引用策略；`m2-state.ts` 按 runId 归并 check.started/updated/finished，历史 run 不回写 latest 指针；`EventCenter.tsx` 在四份快照后读取每个 latestCheckRunId 详情，仍只有一个 WS。快照/事件重放不一致时有界重读，关键 GET 失败保留旧展示且 syncReady=false；新增 syncEpoch 供证据缓存失效。
- `b4c0301`：`CandidatePanel.tsx` 接入运行/取消/显式重跑及每候选同步锁，POST 响应不直接写状态，写后权威重读；采用和回退都固定 disabled，移除其可执行入口。新增 `CheckPanel.tsx` 按 schema/build/smoke/occlusion 展示真实行、message、耗时、run 状态/错误/完成时间与证据。`api.ts` 新增受限 GET 证据读取与字节验证；`style.css` 增加检查与证据样式；`check-evidence.test.ts` 覆盖读取边界。
- 后续收尾提交：运行中不一致的 candidate/run 组合也触发重读；检查 payload 的可展示字段校验；`check-render.test.tsx` 验证运行门禁、四行顺序、文本转义、缺记录不冒充通过；补本节。最终固定提交号随本回合交付。

### 行为与安全边界

1. 无 run 显示未检查；缺项明确“结果缺失”，重复/未知项或身份不符标“检查状态不完整”。completed 不等于 passed，取消保留已持久结果。旧基线标“证明已失效”。
2. 首次运行 POST `/candidates/:id/checks` body `{}`；只有点击“重新检查”才 `{rerun:true}`；取消固定为点击时关联 run 的 `/checks/:id/cancel`。每候选先同步锁定，运行中禁运行/重跑；结果未知不自动重发，直到新同步成功才释放。STALE_CANDIDATE 关闭该候选运行入口并提示重新生成。
3. 新 run 开始/完成触发持久重读，check.updated 推进当前 run 的真实进度；缺 candidate 或组合不一致时再同步。详情 GET 服从 C1 连接/请求代次，历史 run 事件不改变当前 latest 指针。未通过 C3 共同门禁前，无采用或回退入口。
4. 证据名只允许现有后端白名单（六必需产物及 runner.log/summary.json），runId 也受限；路径仅由编码后的 runId/name 构造 `/checks/.../artifacts/...`。主证据同时匹配 candidate/run 的 hash 和 runId，拒绝重复引用和未知 MIME，不把 hash 当 URL。
5. 使用 GET（非 HEAD），验证 Content-Type、字节数、SHA-256，PNG 另核文件头。文本/JSON 仅 `<pre>`，PNG 仅 blob `<img>`；下载链接在读取成功后才开放。404、MIME/大小/hash 错误显示“证据无法读取，请刷新检查状态”，不复用旧成功结果。
6. 证据组件按 candidateId/runId、已校验引用、syncEpoch 与同步可用性隔离。切换候选、重跑、失步、刷新或卸载时 AbortController 取消旧请求、释放 object URL；即使传输忽略取消，迟到结果也不得写回。每组引用在该组件生命周期内缓存，未声明或不匹配的必需产物没有可点击入口。六项全可读状态保留给后续门禁接入，不代表当前可采用。

### 自测命令与当前结果

静态检查：`git diff --check` 已通过。C2 新单测为状态/归并/安全映射、证据 GET/校验/取消边界、React 静态渲染；不是 Pi real UI 证据。未运行既有 E2E 或 Pi 验收套件，未改其断言。

已通过根 `orbital/bin/bg.cmd` 单次后台执行，受测固定提交 `974ffa2`：

```text
cd /d .worktrees\m3c && set CI=true&& call pnpm --filter @spatial/studio test && call pnpm typecheck && call pnpm build
```

调度已核对 `job_77a38b3d` exit 0：`Test Files 9 passed (9)`、`Tests 29 passed (29)`，全仓 `pnpm typecheck` 与 `pnpm build` 全部 Done。日志原件为根 `orbital/jobs/job_77a38b3d/output.log`。本轮按调度提供的实况补录，不重复启动 C2 验证，不宣称独立验收通过。

### 未覆盖与 Pi 接点

- 待 Pi real UI：loopback mock Agent 生成候选后真实运行四检查、观察 check.updated、读取六证据；真实构建/页面运行/遮挡失败；取消、重启、断线完成恢复；三候选/同候选多轮切换及浏览器 fetch/object URL 释放行为。
- 待 Pi mock UI：schema failed、缺浏览器/预算/持久化错误、缺 run/跨候选/重复 Check、产物缺失/404/hash 不符、迟到详情与响应丢失。已有单测仅对纯函数、mock fetch 与静态 React 输出作证。
- 保留冻结 testid：check-run/rerun/cancel、check-run-status、check-item、check-evidence、check-error、candidate-gate-reason；关联 run/candidate/name/status/hash 属性按合同提供；原 candidate/preview testid 保留。
- C2 交付时 C3 共同门禁尚未实现，采用与回退始终 disabled；C3 后续接入见下节。尚未完成 Pi 独立测试、Claude Code 独立审查和 M3-C 全量验收。

### 需批准

无后端/协议变更请求；未修改 apps/server、packages、templates、依赖清单、锁、Pi E2E 或历史证据，未读取真实 .env、访问 staging 或调用付费模型。

## C3 — 门禁与失败态 UI

状态：C1–C3 实现已接通；C3 冻结后的全量单测/typecheck/build 待后台结果，尚未独立测试、审查或正式验收。基线 `974ffa2`，同一 `.worktrees/m3c` / `feat/m3c-approval`。`9124f7e` 补录调度已确认的 C2 自测结果。

### 分步提交、文件与原因

- `16ce0c4`：`adoption-gate.ts` / `adoption-gate.test.ts` 实现采用门禁参数表和操作相关错误文案；`mutation-locks.ts` 提供同步占锁、写请求结束后等待新权威同步才解锁的策略。该步未开放采用。
- `1baa587`：`CandidatePanel.tsx`、`CheckPanel.tsx` 将证据读取完成凭据与完整门禁联通，完成后才开放采用/回退；`EventCenter.tsx` 统一管理跨面板实体锁与作品锁；`ApprovalPanel.tsx` / `PointSpeak.tsx` 接入共享任务锁、未知结果恢复及终态拒绝；`App.tsx` 在版本变化后清除旧选取与迟到版本请求；`SceneEditor.tsx` 的写入/撤回/模型采用接入同一作品锁并在写后权威重读，场景渲染/参数/后端合同不变；`api.ts` 加有限的前端等待；更新 Studio 静态渲染测试以反映 C3 回退语义。
- 收尾：采用按钮层测试真实 disabled 和阻断回调；候选/任务快照与事件最小可展示结构校验，损坏关键事件触发权威刷新；`m2-state.test.ts` 的候选 fixture 补齐真实合同字段（原断言不变），增加损坏 payload 用例。最终固定 HEAD 随回合小结交调度。

### 采用门禁与证据生命周期

采用需同时满足：连接且同步就绪、无实体/作品操作锁；候选 pending、有 commit、基线等于当前作品；latest run 的 id/candidateId/commit/baseVersion/mainVersion 全匹配；run completed + outcome passed、无 error、digest/policy/toolIdentity 非空；candidate/run 各恰好四项 passed，runId 与 evidence hash 相符；六份必需产物唯一、名称/MIME/大小/hash 合法、四主证据 hash 对应；六份 GET 已在当前候选/run/作品版本/同步代次下核验可读。按钮与点击处理器均检查同一门禁，事件处理器还同步占锁，不能仅靠 disabled 防双击。

证据凭据绑定候选与 run 全部当前内容、作品版本及 syncEpoch，任一变化即不匹配。切候选、操作起点、重跑、失步及组件卸载使旧凭据失效；迟到旧凭据即便回调也无法满足新 key。任一读取失败关闭门禁。界面只说明前端已就绪，不声称排除了外部字节篡改；采用时后端仍在锁内做最终检查，无新 canAdopt 字段/旁路/强制采用。

`CHECKS_NOT_PASSED` 只作为 adopt 的失效证明路径：立即封住该 run，显示“检查未通过或证明已失效”，只 GET 刷新、不自动 POST；普通刷新不恢复被拒证明，需新 run（或基线失效时重新生成）。`STALE_CANDIDATE` 只在运行/重跑检查的解析路径提示重新生成并关闭旧入口。采用不依赖 STALE_CANDIDATE/MERGE_CONFLICT。回退不推断本地历史，由服务器 NO_ADOPTION 明示“暂无可回退的采用记录”。

### 互斥与失败恢复

- 运行/重跑/取消/采用/撤回同步占用 candidate 锁；请示回答与任务取消共享 task 锁，另有 approval 锁；采用/回退/场景写回共用 work 锁。其它任务不因持久 pending 请示而被封锁。检查正在运行本身不是请求锁，用户仍可显式撤回该候选。
- 锁存在 EventCenter 生命周期内，组件关闭也不丢失。POST 未结束时，任何早到 GET 都不能解锁；POST 结束后只有更新同步代次成功才能解锁。断线/刷新失败继续关闭操作，提示刷新，不自动重发写请求。
- POST 成功与后续 GET 失败分别处理：显示“操作已提交，状态刷新失败，请刷新状态”，不诱导再点。STALE_APPROVAL/已回答/非 pending 封住旧回答；APPROVAL_LIMIT 提供待处理卡片链接；未知错误按安全文本呈现。
- 为避免无限等待，Studio 普通 API/场景请求最多等待 60 秒、关键快照 GET 20 秒、证据组读取 30 秒；这些只结束客户端等待并进入结果未知/刷新路径，不调整后端运行器预算，不取消/重放后端操作，不把超时定性为产品失败。
- version.changed 首先关闭同步写门禁，再恢复权威版本；旧基线采用不可用，旧 Selection 清除，迟到选取版本 GET 不能复活旧选择。保持精确 origin/source 消息校验、当前/候选分源、候选不可选取、对比/滚动/diff 与单 WS。

### 自测与待核对结果

已完成静态 `git diff --check` 与改动范围核对。新增门禁参数表覆盖不同步/断线/锁、关闭候选、commit/基线/关联缺失或错配、非完成/非 passed、错误、身份缺失、失败/未运行/缺失/重复检查、runId/hash 不匹配、缺失/重复产物、不可读/旧代次凭据及后端拒绝证明。每个负向组检验采用按钮 disabled，直接调用按钮回调两次仍为零提交回调；正向组只在全部前提满足时启用。共享锁测试覆盖双取锁、作品互斥、早到 GET 不解锁和正确代次释放；这些不是浏览器真实 POST 次数证据。

C3 验证按任务卡使用全量单测，拟由根 `orbital/bin/bg.cmd` 单次启动：

```text
cd /d .worktrees\m3c && set CI=true&& call pnpm test && call pnpm typecheck && call pnpm build
```

调度已核对受测 `d09ce49` 的 `job_bb7581ad` exit 0：server 321、shared 68、vite-plugin 20、scene-renderer 5、bridge 1，Studio 10 个测试文件全部 passed；typecheck 与 build Done。原件为根 `orbital/jobs/job_bb7581ad/output.log`。这里只补录自测实况，不代表独立验收通过，不重复启动这轮验证。

### C1–C3 整体未覆盖与独立交接

Pi real UI（真实 Studio/后端/持久文件/WS/Chromium，模型仅 loopback mock）：完整三按钮选取→共享修改→请示三处 overlay→批准→候选→四检查→六证据→采用→回退；批准不重调模型、拒绝无候选；检查真实构建/运行/遮挡失败；未检查门禁；取消与运行中撤回；刷新/合法服务重启/断线恢复；双击及键盘仅一次真实 POST；M1 写回旧候选失效；三候选/多 run 切换；场景写回与作品决策互斥；分源/滚动/diff/单 WS 回归。

Pi mock UI：schema failed（不篡改后端造公共不可达路径）；缺浏览器/预算/持久化错误；缺项/重复项/关联错配/损坏 payload；404、缺失/篡改证据及未知 MIME；旧 GET/socket/证据请求迟到、历史截断/序号倒退/缓冲溢出；POST 响应丢失、成功后刷新失败；CHECKS_NOT_PASSED 与 STALE_CANDIDATE 各自路径；NO_ADOPTION、STALE_APPROVAL/已回答竞态。纯函数/mock fetch/静态 React 测试不替代真实 UI 或运行器失败证据。

Claude Code 重点：门禁真值表与证据 key 生命周期、跨面板/卸载后的锁、非原子快照重读、迟到响应与终态回滚、后端拒绝证明不能复用、M1 接线与 M2 选取回归、错误安全文本与 TOCTOU 边界。现有 bridge 无命中回执，任意草稿坐标无法保证精确 DOM 定位的限制仍保留。

尚未执行冻结同一产品身份的原八套 146 例与新 M3-C UI 套件；新增例数由 Pi --list 固定。未创建/修改 Pi 的 tests、配置或正式证据。调度须在独立审查整改与独立验收之后决定集成收口，不能把三张实现卡完成表述为 M3-C 验收通过。

### 需调度批准

无必须的后端/协议变更或待拍板事项。没有修改 apps/server、packages、templates、锁/依赖、Pi E2E 或历史证据，没有读取真实 .env、调用付费模型、合并、push 或删除 worktree。
