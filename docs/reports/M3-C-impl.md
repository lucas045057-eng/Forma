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

状态：C1–C3 实现已接通；C3 `d09ce49` 全量自测/typecheck/build 已由调度确认通过，独立审查应修的后续整改见末节；尚未正式验收。基线 `974ffa2`，同一 `.worktrees/m3c` / `feat/m3c-approval`。`9124f7e` 补录调度已确认的 C2 自测结果。

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

## C1/C2 独立审查应修整改（基于 C3 d09ce49）

依据：主树 `ad5698c` 的 `docs/reports/M3-C-review.md`，C1/C2 各有一条应修。只读审查报告，未合并 master、未改独立报告；仍在原实现 worktree。`308a584` 已按调度反馈补录 C3 原轮自测通过实况，以下整改需新的冻结验证，不能借用旧成绩。

### C1-1：影响模式恢复卡片高亮

修复提交 `1644d10`。`App.tsx` 在已验证主 frame 的 origin/source 后，若影响模式收到 pick:result 或选取 error，发送 `impactHighlightMessages(卡片src)` 并返回，不采用点击目标，不替换 Selection、不显示误导性的选取错误。该纯函数依次发 pick:stop（清空当前 hover 与临时选中）→pick:start→highlight(卡片 src)，进入影响模式也使用同一序列。

单测：`approval-state.test.ts` 的 `restores the card source after a pick result and clears the hover before highlighting`，断言完整消息顺序，并从点击到其它源码/有 hover 的状态验证最终卡片 src 与 hover 清空。它是 Studio 消息策略单测，不冒充真实 bridge/DOM 验证。

既有 bridge 没有独立 hover 关闭消息；以后再次移动指针仍可出现临时 hover 框（卡片的 selectedSrc 不变）。本修复清理收到结果时的 hover，不宣称永久禁止 hover；不改 bridge 合同、不加轮询或跨源 DOM 操作。Pi 应按 `data-highlight-src === 卡片src` 统计目标框，真实三处高亮仍待独立浏览器验证。

### C2-1：检查故障限定到候选

修复提交 `a94add0`。新增 `sync-state.ts`，把 pending run 请求计划、Promise.allSettled 结果归并、快照/缓冲重放、代次有效性判断与候选检查故障分类抽成可测纯函数，由 EventCenter 实际调用。

- `pendingRunIds` 仅为 pending 候选取 latest run，已采用/已撤回候选不再发详情 GET。
- 单个 run GET 拒绝/结构不符、候选 checks 无 runId、旧记录/空 toolIdentity、关联不一致，写入该候选 `checkIssues`。不抛全局异常、不清其它候选或请示状态；该候选显示“检查状态不完整”，检查/采用禁用，撤回与其它全局操作保持各自门禁。
- 只有快照窗口内出现相关检查事件时才允许有界重读；第三次仍不一致则提交有效事件快照，全局 syncReady=true，保留局部问题。真正事件缺号/截断/溢出仍要求重锚；用尽时文案为“事件历史无法连续补齐”，不再把检查故障误报为历史变化过快。
- 实时 check.updated 走纯归并与局部分类，不因检查不一致触发全局同步。局部故障在成功的后续 REST 同步后重新评估；不会凭旧证据自行开放采用。
- 基础 tasks/candidates/version/approvals 或事件历史读取失败仍关闭全局同步，这是关键权威状态缺失，与单 run 故障分开。

新增 `sync-state.test.ts` 单测名：

- `a run GET failure isolates one candidate while global sync and the other candidate succeed`
- `unhealthy views without runId and legacy empty toolIdentity stay local`
- `does not plan run GETs for adopted or discarded candidates`
- `old candidate.ready cannot clear a newer latest pointer during snapshot replay`
- `a faulty live check.updated does not taint another candidate or request global resync`
- `snapshot-window events are replayed, while history gaps and overflow require reanchoring`
- `a new run in the snapshot window requests a bounded reread but keeps failure candidate-local`
- `drops late operations and old connections without publishing their snapshot`

`check-render.test.tsx` 另增 `isolates a candidate check issue without closing global work actions`，断言该候选检查/采用 disabled、回退仍可由服务器裁决。纯函数测试不替代 socket/fetch 异步全链路或浏览器真实操作测试。

### 审查其余建议逐项取舍

| 建议 | 处理与理由 |
| --- | --- |
| C1-S1 pending 选取悬挂 | 采纳：进入影响模式先作废请求，若旧 pick 为 pending 则明确置 none，退出不遗留永久 pending。 |
| C1-S2 iframe ready 恢复语义 | 保留现状：ready 与 onLoad 均清理影响模式并停止选取，等价于不恢复的退出策略；重载后旧 Selection 不再可信，不恢复旧高亮。 |
| C1-S3 taskId 共享锁 | C3 已采纳：ApprovalPanel 与 PointSpeak 共用 EventCenter task 锁；独立复核仍待 Claude。 |
| C1-S4 异步编排测试 | 部分采纳：本次抽出并实接同步决策纯模块，覆盖快照期间事件、旧请求/连接判断、缺号/溢出与局部失败；未重写整个 WebSocket/fetch 驱动为注入式运行器，以控制整改范围。完整异步竞态仍交 Pi mock UI。 |
| C1-S5 首连失败提示 | 已具备 state-refresh 与全局 syncError；保持手动 GET 恢复，不新增自动循环重试。Pi 验证首连失败路径。 |
| C2-S1 busy 导致证据重读 | 暂不采纳缓存重构：目前 busy/失步会销毁旧凭据与请求，能保守保证 C3 新门禁不复用旧绿灯；保留有限重复读取成本，避免本次整改扩大缓存生命周期改造。 |
| C2-S2 活动 run 自动读产物 | 采纳终态自动读取：queued/running 不再自动取部分 artifacts；完成/取消且同步后读取已有证据。没有额外增加运行中按需读取入口。 |
| C2-S3 blocked_by 前缀 | 采纳：使用后端实际“未开始执行：”前缀，保留原 message 文本；Studio 渲染测试 fixture 改为真实文案，原失败/未运行断言不放宽。 |
| C2-S4 未知错误码 | C3 已采纳 operationError 通用安全文案与按操作区分的错误码；不恢复旧 MERGE_CONFLICT 分支。 |
| C2-S5 撤回后预览模式 | 保留现状：有其它候选时继续显示下一候选，无候选时 App 回到 current；避免额外改变既有交互，已明确交 Pi 验证撤回多候选场景。 |

场景编辑器位于 inspector 内的布局风险仍保留；仅在最终整改冻结提交上跑 Pi 完整 M1/M2/M3-C UI 回归，不在 C1/C2 中间禁用入口的提交上冒充回归通过。

### 整改验证与边界

`git diff --check` 静态检查后冻结；后台串行命令仍为：

```text
cd /d .worktrees\m3c && set CI=true&& call pnpm test && call pnpm typecheck && call pnpm build
```

本整改轮结果待调度核对，job id/日志路径及最终固定 HEAD 在回合小结给出；取得 job 后结束且冻结文件。不调用子 Agent、不改 apps/server/packages/templates/锁/Pi tests 或历史证据，不读取真实 .env、不调用付费模型。没有必须的后端或协议变更、没有新增“需批准”项；不宣称应修已经独立复核或正式验收通过。

## C3 独立审查三项应修整改（基于 91134d7）

依据：主树 `fe2dc26` 的 `docs/reports/M3-C-review.md` C3 追加节，只读报告，未合并主树。Claude 已确认 C1-1/C2-1 修复；C3 有条件通过、0 blocker、3 应修。本节记录实现整改，尚待新轮自测结果与独立修后复核，不能作为正式验收结论。上轮 `job_1f28cd58` 的成绩本轮未收到调度确认，不补写未知结果。

### C3-1 场景草稿与在途配置读取

提交 `9444dc8`。新增 Studio 内 `SceneDraftGuard`，SceneEditor 自动 `load()` 在 dirty 时直接返回，资产列表刷新仍照常。每次编辑都会推进修订号，使已经起跑的 GET /scene 无法在之后覆盖新草稿；旧请求错误也不再覆盖新编辑的提示。保存成功使用本次确定写入返回的 config 更新 saved/draft 与 diff，并清掉 dirty、作废此前读请求；保存失败不清 dirty。显式“读取作品配置”允许覆盖，但只在请求成功且之后没有新编辑时应用，失败时保留草稿及 dirty。

场景写入期间禁用画布交互；滚动位置变化也不会重置未保存的旋转/开盖草稿。此处不改场景渲染算法、参数合同或后端预算。控件即使在自动 GET 在途时允许编辑，修订守卫也确保迟到响应不能覆盖它，关闭原首连/重载竞态。

`scene-draft.test.ts` 新增：

- `does not reload a scene draft with unsaved edits`
- `clears the unsaved flag after a successful save and permits reload`
- `rejects a scene GET that arrives after editing or saving`
- `allows explicit read without clearing dirty until it succeeds`

这些验证生产使用的草稿守卫，不冒充 M1 浏览器写回/撤销回归；Pi 仍需验证真实控件、画布及 inspector 布局。

### C3-2 旧 run 的恢复入口

提交 `f7ffaa8`。CandidatePanel 不再用 checkIssues 一刀切封锁恢复操作：有已取得且 id/candidate/commit/baseVersion 关联正确的终态 run，可显式重新检查；活动 run 可取消。不存在 run、关联错配、不同步、实体锁、基线失效或已收到 STALE_CANDIDATE 时保留相应限制。首次检查遇到异常 checkIssue 也保持禁用。

采用门禁不变：checkIssues 仍直接阻止按钮与处理器，不因恢复重跑入口而放宽身份、四项结果或六证据条件。重跑仍只在用户点击时发送 `{rerun:true}`，由后端最终裁决。

`check-render.test.tsx` 新增 `allows explicit rerun for a completed legacy run while adoption stays disabled`：旧 run/空 toolIdentity/无 runId 视图下重跑可用且采用 disabled；同 run 改为活动后只可取消；移除 run 后重跑和取消都 disabled。

### C3-3 重试保持原任务范围

提交 `f2c9136`。`pick-state.ts` 新增 `retrySelection`，PointSpeak 的按钮与提交路径使用同一结果：原任务有 Selection 且基线仍匹配时始终沿用原 Selection，不随当前选中元素变更；旧基线时只接受用户重新点选的同一 src、当前版本 Selection，否则禁重试并提示重新点选。原任务原本无 Selection 时才继续整页重试，即便当前选了元素也不会偷偷缩小范围。pending/failed 点选仍阻止提交。

`pick-state.test.ts` 新增：

- `retries with the original scope instead of the currently picked element`
- `requires a same-source repick after version change and never silently retries the whole page`

覆盖当前选中其它元素、清空选择、版本变化、同 src 新版重选和点选 pending；不会静默扩大或替换任务范围。

### 建议项采纳与理由

`1a485e6` 处理错误语义与轻量提示整改：

| 项 | 处理与理由 |
| --- | --- |
| C3-S1 明确拒绝与未知结果 | 采纳。已知业务码仍用对应文案；其它 ApiError 4xx 显示“操作被拒绝：服务器说明”，只用 React 文本，不执行 HTML；网络/超时/未知 5xx 才用“无法确认”。PointSpeak、候选与请示均接入；后续 GET 失败保留原拒绝原因并追加刷新失败，不把明确拒绝说成结果未知。 |
| C3-S2 尚未检查文案 | 采纳。无 latestCheckRunId 显示“尚未运行检查，请先运行检查”，与关联错配区分；采用仍禁用。 |
| C3-S3 影响模式吞真实错误 | 采纳。只有 bridge 明确的“未找到带源码标记的外层容器”选取错误被用于恢复高亮；其它页面 error/rejection 照常显示，不再静默吞掉。现合同没有错误分类字段，使用现有精确文案，不扩 bridge。 |
| C3-S4 无选取也提示重选 | 采纳。版本变化时仅原 pick 为 ready/pending 才提示重新点选；仍清理旧模式与请求。 |
| C3-S5 live 清除 checkIssues | 暂不采纳。现有标记混合了 GET 失败与视图不一致，单凭一次 live payload 清除可能提前恢复此前读取失败的候选；保留等待下一次成功 REST 同步重新评估，check.finished/手动刷新可恢复。本次先修显式重跑死路，不扩大故障来源与缓存状态重构。 |

新增测试 `distinguishes definite rejection from unknown network or server outcomes`、`labels an unchecked candidate as not yet checked rather than inconsistent`、`suppresses only pick errors in impact mode, not real page failures`。前者含 MODEL_MISSING/INVALID_TASK、网络、500、拒绝后刷新失败及提交成功后刷新失败的文案断言。

### 冻结验证与独立接点

完成静态 diff 检查后，以最终提交后台串行执行：

```text
cd /d .worktrees\m3c && set CI=true&& call pnpm test && call pnpm typecheck && call pnpm build
```

已读取受测 `5edaa22` 的 `job_2adead58` 原件：根 `orbital/jobs/job_2adead58/exit` 为 `0 0`（按 bg-run.cmd 格式，第一项为进程 exit code）；output.log 确认 server 321、shared 68、vite-plugin 20、scene-renderer 5、bridge 1、Studio 12 文件/85 项，共 500 项通过，所有 typecheck/build 均 Done。归类：这轮全量单测/类型/构建自测通过，无失败；并非 UI 接线或正式验收通过。原轮不重复运行。未运行或修改 Pi E2E，真实 M1 写回/撤销、旧检查恢复、失败任务重试范围及既有 C1–C3 浏览器场景仍交 Pi；EventCenter 异步驱动风险与 inspector 布局风险仍在独立测试清单内。

没有新增需批准事项：只改 Studio 与本实现报告；没有后端/协议/模板/锁/依赖/Pi tests 或历史证据变更，没有读取真实 .env、付费模型调用、子 Agent、合并或 push。

## Pi 接线冒烟整改：Studio 开发反代缺失（基于 5edaa22）

归类：真实产品侧接线缺陷，不是测试或环境问题。Pi 在隔离验收树记录 `/approvals` 返回 Vite SPA HTML，导致首份关键快照 JSON 解析失败、syncReady 持续 false；`/checks` 同样未代理。原件与独立说明位于 Pi 的 `docs/reports/artifacts/M3-C/prep/dev-proxy-missing-approvals-checks.json`、`smoke-open-studio-timeout-error-context.md` 及 `M3-C-test-preparation.md` §7，本轮未改这些原件。

修复提交 `052b64d`：仅在 `apps/studio/vite.config.ts` 按既有写法增加 `/approvals`、`/checks`、`/health` 三个 `target: backend` 代理键。`/health` 是对照后端路由时发现的另一遗漏。未更改 origin/CORS/WS 安全设置，未把预览内容接回 Studio 同源。

### 路由核对清单

逐项只读对照 `apps/server/src/app.ts`、其调用的 `checks/routes.ts`，并核对 `index.ts` 的独立预览监听器：

| 主后端前缀 | 已注册路径 / 方法 | 代理核对 |
| --- | --- | --- |
| /health | GET /health | 本次补齐 |
| /approvals | GET /approvals；GET、POST /approvals/:id | 本次补齐 |
| /checks | GET /checks/:id；POST /checks/:id/cancel；GET /checks/:id/artifacts/:name | 本次补齐，包含六份证据读取 |
| /events | WS /events；GET /events/history | 已有，保留 ws:true |
| /tasks | GET、POST /tasks；GET /tasks/:id；POST /tasks/:id/cancel | 已有 |
| /candidates | GET /candidates、/candidates/:id；POST /candidates/:id/adopt、/discard、/checks | 已有，检查发起走此键 |
| /version | GET /version；POST /version/revert | 已有 |
| /scene | GET、PUT /scene；POST /scene/undo | 已有 |
| /assets | GET /assets、/assets/:id、/assets/:id/model.glb；POST /assets/lux3d、/assets/lux3d/import、/assets/:id/adopt | 已有 |

主应用及注册模块未发现其它未代理 API 前缀。`/preview/main/`、`/preview/c/:id/` 与 HMR 由独立 preview-origin 监听器提供，按分源合同不增加到 Studio 代理。agent/assets 的 mock-server 是独立测试上游，不是主后端注册 API，也不代理其模型接口或 /__stats。

新增 `apps/studio/src/dev-proxy.test.ts`：`routes Studio API requests and check evidence through the real Vite proxy instead of SPA fallback`。使用实际 Vite 配置中的代理键，只有 target 替换成本轮动态端口的 loopback HTTP stub，启动真实 Vite server；从 Studio 地址验证列表/详情/历史 GET、批准/取消/发起检查 POST、证据 JSON 与 PNG 字节转发。关闭 envFile，不读真实 .env，不启动模型或 Pi 后端，不修改 Pi tests；这是接线集成自测，不冒充真实后端与 UI 独立验收。两服务器在 finally 关闭。

### m2b 采用路径兼容性（实现核对）

结论：实现仍允许 `tests/e2e/m2b/01-ui.spec.ts:124-128` 的路径通过，无须通过 Studio 的“运行检查”按钮重新开一轮。该用例先取 pending 候选，经 `ensureChecksPassed`（m2a/api.ts 转调 m3b/checks.ts）使用真实后端检查 API，等待 completed/passed 并核对 run 后再点 candidate-adopt；未伪造检查结果。

Studio 不要求检查由 UI 发起：check.finished 触发权威快照，或首连/重连恢复已有 latestCheckRunId；GET /checks/:id 获取已持久 run，终态自动 GET 六份证据，核 MIME/字节/hash 后生成当前同步代次回执。候选仍 pending、基线/身份/四结果/证据均一致且无锁时，adoptionReason 返回空字符串，按钮 enabled。`/checks` 代理补齐后，这些请求可以到达主后端。仅有后端 outcome passed 并不跳过六证据可读条件；点击仍需等待 UI 同步与证据读取完成。

本结论是实现及测试步骤的只读兼容性判断，不是 m2b 实跑通过；浏览器等待时序、超时预算和采用后的页面效果仍由 Pi 在新冻结提交正式回归确认。本轮没有修改、重跑 Pi 的 m2b 测试。

### 本次验证与边界

上轮 `job_2adead58` exit 0 已在 C3 三项整改节补录，不重跑旧轮。它的单测没有开发反代接线覆盖，所以与本次 Pi 的真实产品缺陷并不矛盾。

该轮 `job_b3756ceb` 已确认失败：exit 原件为 `1 0`，日志中 dev-proxy.test.ts 报 `Port 5173 is already in use`，Studio 为 1 failed / 85 passed。归类为新增测试的端口隔离缺陷，不是产品反代故障；bdb297a 不作为可验收冻结版。由于命令串首败即停，该轮后续 typecheck/build 不记为通过。失败原件保留于根 orbital/jobs/job_b3756ceb，产品三个反代键保持不变。后续修复与新验证见下节。

## 代理接线测试 hermetic 整改（基于 bdb297a）

### 根因与修复

修复提交 `fb13d35`。检查当前安装的 Vite `dist/node/chunks/config.js`：`startServer` 以 `!configPort` 判断端口是否存在；配置 `port:0` 或直接 `studio.listen(0)` 都会被当成未指定，回退到默认开发端口。这解释了为何原测试虽然写了 0，仍在 Pi 占用默认端口时失败。

新测试对 stub 使用 Node HTTP `listen(0)`，对 Vite 使用其已创建的 `studio.httpServer.listen(0)`，绕过 Vite 的默认端口选择封装；Vite 包装过的底层 listen 仍执行 initServer，再交给 Node/系统分配临时端口。监听成功后从各自 `address().port` 读取实际端口，stub 的实际地址写入测试代理 target，Vite 的实际地址用于请求；没有释放临时端口后再绑定的抢占窗口，也没有固定高位端口常量。

只覆盖测试配置，不改产品 vite.config.ts 的三个反代键或其它产品配置。测试仍使用真实代理键和 HTTP 请求断言；configFile:false、envFile:false，不读取真实 .env，不连接真实后端；禁用 HMR/文件监听，优化缓存使用 mkdtemp 的独立临时目录，避免与其它 dev server 共用缓存。嵌套 finally 确保即便 Vite close 失败也继续关闭 stub，最后删除本测试创建的缓存目录；不会关闭外部服务。

### 单文件与占用端口自证入口

提交 `2a879fa` 新增 `apps/studio/verify-proxy-isolation.mjs`，用于这次串行验证，不进入 Vitest 自动收集，也不修改 package scripts。验证端口由 CLI 参数传入，接线测试文件自身不含默认/固定高位端口值。

后台命令：

```text
cd /d .worktrees\m3c && set CI=true&& node apps/studio/verify-proxy-isolation.mjs 5173
```

脚本按顺序执行，首败即停，finally 清理：

1. `pnpm --filter @spatial/studio exec vitest run src/dev-proxy.test.ts`，单独验证修复后的文件。
2. 在传入的默认 Studio 端口起一个实际 Vite server，root 为 Studio，禁用 envFile、代理与 HMR，缓存独立；它只用于制造端口占用，不访问后端。如果端口已经占用，则通过 `/@vite/client` 的 createHotContext 内容确认已有 Vite 服务，复用这个占用条件，不停止或修改它；若不是 Vite 服务则明确失败，不伪造覆盖。
3. 记录 `[port-check]` 的 before-full-test 证据后执行 `pnpm test`；全量结束再验证该端口仍为 Vite 服务并记录 after-full-test，然后依次 `pnpm typecheck`、`pnpm build`。
4. 关闭本脚本创建的 Vite，记录 `[cleanup] owned Studio listening=false`，清理本脚本缓存。若使用的是外部 Vite，明确记录未拥有监听器，原服务保持运行。任何命令失败也走 finally。

本回合初次只读检查未发现 5173 监听；冻结后的起跑前复查已发现 5173 被 PID 40308 监听。脚本会在单文件通过后确认已有 Vite 占用，若期间释放则自行建立占用，并以作业内的前后探针作为真正“端口被占仍通过”的证据。本轮结果尚待后台作业完成后调度读取，不预写“单文件通过”或“占用端口仍全绿”。最终提交、job id 与日志路径在回合小结给出；取得 job 后立即结束、不轮询。

### 其它测试的固定端口盘点

只读检索本实现树 `*.test.ts/tsx/js/mjs` 的 listen/port 常量、无参 Vite listen 与默认端口引用：未发现第二处与本缺陷相同的真实固定端口单测入口。命中的 `apps/server/src/test-support/fetch-listener.test.ts` 数字是 vi.fn 模拟分配/冲突断言，其真实监听用动态分配 helper；`apps/server/src/scene/service.test.ts` 的默认端口字符串是 app.inject 的 Host 校验，不绑定监听。此结论限本次静态检索，不宣称穷尽所有间接环境依赖。

另确认独立 E2E 的 `tests/e2e/m0a/env.ts`、`m1a/env.ts`、`m1b/env.ts`、`m2a/env.ts` 有固定 Studio/模板/后端/上游端口（包括 5173/5174），多套同时启动可能冲突。这些是由 Pi runner 顺序运行的整套服务配置，不是 pnpm test 单测；本轮仅列出，不修改 Pi 测试/配置、不得关闭 Pi 进程。

### 状态与边界

本轮仅修改 Studio 测试/验证入口与实现报告，未改后端、协议、模板、锁、产品反代键或 Pi 的测试与失败证据；未读取真实 .env、未调用付费模型、未派子 Agent。新验证未完成前仍不可宣称正式冻结通过，无额外需批准事项。
