# M3-C：Studio 请示与真实检查界面

状态：2026-11-15 已正式收口。受审产品 `393fe9f`，Pi 正式受测 `9294ccc`，验收及归档补正 `132a661` 已快进合入主线；501 单测、174 E2E、12 步全部通过。下文为原始设计，实际合同修正及验收边界见末尾收口节。Codex 设计调度、CodeBuddy 实现、Pi 独立测试、Claude Code 独立审查。

## 1. 依据与范围

已核对 `M3-plan.md` 的 M3-C 与最终过关标准、`M3-B-plan.md`、`M2-plan.md` 的 Studio/事件/分源及收口约束、`../dev-doc-v0.1.md` 的请示/检查验收和 `../project-brief.md` 的三按钮演示。旧文档中的同源、依赖可请示安装和 M2 全部未检查描述，以 M3-A/B 已冻结实现为准。

基线证据：`../reports/M3-B-test.md` run6 `2026-11-14T17-58-50-889Z-full`，11/11 步、146 E2E、422 单测通过，0 retry/skip/flaky/errors；`../reports/M3-B-review.md` 修后复核 0 blocker / 0 应修。基线产品树对 `6f6ff49` 无差异。这些是前阶段结果，不能替代 M3-C 新验收。

本阶段只改 `apps/studio` 的界面、状态、REST 调用及既有 bridge 消息的使用。实现单测由 CodeBuddy 写；独立 UI E2E、测试配置和正式证据由 Pi 写。不开新 WS、不引入依赖、不改 `apps/server`、`packages`、`templates`、锁文件，不改 M1 场景写回、M2 选择与候选合同，不做 M4 语音/外观重构。沿用 loopback mock Agent，**不新增真实付费模型调用**，不改断言凑绿，不修改或删除既有失败证据。

源码依据（相对仓库根）：`apps/studio/src/{App,CandidatePanel,EventCenter,PointSpeak}.tsx`、`m2-state.ts`、`api.ts`；`apps/server/src/app.ts`、`work/service.ts`、`checks/routes.ts`、`approvals/policy.ts`、`events.ts`；`packages/shared/src/index.ts`、`packages/bridge/src/index.ts`。下述为设计目标，不能表述为现有 UI 已具备。

## 2. 界面结构与请示状态

保留左侧作品/候选/并排预览、diff、版本与回退；右侧选中对象和 PointSpeak 下增设常驻 ApprovalPanel，显示待处理数量和历史折叠区。打开 3D 编辑器仍能看到待处理提示并返回卡片；等待请示不封锁其它任务。

每卡以 id 为 key，显示 taskId、question、reason、规则中文名、affected 原文列表、evidence 文本、options 的 label/impact、状态和更新时间。规则映射：shared_component“共享组件”、global_style“全局样式或场景配置”、out_of_scope“超出选中范围”、analysis_uncertain“影响范围无法完整分析”。不将静态分析证据包装成精确 DOM 影响保证。

| 持久状态 | 文案与可用操作 |
| --- | --- |
| pending | “等待批准”；批准本次修改 / 拒绝并丢弃；可沿任务取消 |
| approving | “正在发布已批准草稿”；两个回答按钮禁用 |
| approved | “已批准；候选发布后请运行检查，采用后才更新作品”；回答禁用 |
| rejected | “已拒绝并丢弃草稿，主作品未改变”；回答禁用 |
| cancelled | “任务已取消，请示不可继续”；回答禁用 |
| stale | “草稿或作品已变化，请重新生成任务”；回答禁用 |
| failed | “请示处理失败，请查看任务原因”；回答禁用 |

前端另外记录 submitting / outcomeUnknown / refreshing，不写入 ApprovalStatus。点击前同步设置以 cardId 为键的 in-flight 锁，互斥批准/拒绝/任务取消；事件与响应到达顺序不决定重复操作。只发数字 `{option:0}` / `{option:1}`，不乐观标 approved，不因批准响应成功自行创建 Candidate，不再请求模型。响应中的 `{approval,task}` 按请求起点版本合并或触发权威重读；被较新事件覆盖的响应不得回滚终态。

请求失败且结果未知时显示“提交结果尚未确认，正在读取服务器状态”，先 GET 卡片/任务和候选；同步成功前禁用重复决策。不自动重放 POST。确认仍 pending 后才允许用户再次明确回答。操作已成功但补拉失败显示“操作已提交，状态刷新失败，请刷新状态”，不可提示成操作失败引导再点。

### 受影响位置高亮

只在**当前作品 iframe**、且 card.baseVersion 等于已同步作品版本时操作。定位按钮使预览切到 current，并进入独立的“查看影响位置”模式：发送既有 `pick:start` + `highlight {src}`；退出发送 `pick:stop`，如原先有有效选取再恢复其选取模式与高亮。App 分开管理影响模式与 PointSpeak 的 Selection，影响模式收到 pick:result 不创建/替换可提交 Selection；离开影响模式、卡片终态、版本变化、iframe 重载、进入场景编辑器时清理。跨源消息继续精确检查 origin 和 frame.contentWindow，禁止 contentDocument、通配 origin 或让候选 iframe 参与选取。

既有 bridge 只支持一个精确 src，并将所有同 src 实例画框；没有文件通配、多 src 或定位回执。定位优先使用关联 task.selection.src（去掉末尾行列后的文件必须出现在 affected 中，基线须一致），当前模板 Button 的根 DOM 使用同一组件定义 src，可同时框出三处共享按钮。其次对 affected 中严格匹配 `src/...:行:列` 的项提供逐项定位。只有文件名/CSS/无法确认命中的条目显示“文件级影响；暂无可确认的页面位置”，保留原始证据，不把文件名当 src，不解析中文 evidence 猜坐标，不循环发多个 highlight 冒充同时高亮。无回执时文案为“查看源码对应位置”，不声称已命中 N 处。Pi 在 iframe 内独立读取 overlay 验证真实三处高亮；基线/草稿坐标差异的定位限制须在报告保留。

## 3. 真实检查与证据

CandidatePanel 按 schema → build → smoke → occlusion 四行显示，从后端 Candidate.checks 和 latestCheckRunId 所指的 CheckRun 读取。去掉现有硬编码 not_run；缺项显示“未检查（结果缺失）”，重复/未知项或候选与 run 不一致显示“检查状态不完整”，禁止采用。不得从 task.done、批准成功、预览 ready、run.completed 推导通过。

| 层次 | 显示 |
| --- | --- |
| 无 run / 旧候选缺记录 | 未检查；旧候选缺 candidateCommit 时提示重新生成 |
| run queued / running | 排队中 / 检查中，叠加每项已持久结果；未完成项仍 not_run，不增造 Check.status=running |
| Check passed / failed / not_run | 通过 / 失败 / 未检查；message 原样文本展示，blocked_by 说明“前序失败，未运行” |
| run completed | 根据 outcome 显示“全部检查通过 / 检查失败 / 未完成检查”，completed 本身不作绿灯 |
| run cancelled | “检查已取消”；保留已完成项，未运行项不变绿 |

显示 run id、候选 id、完成时间、错误 code/message、四项耗时（如有），展开证据。状态用文字+data-status，不只用颜色；错误 role=alert，进度 role=status，所有操作可键盘到达。

实际 `Check.evidence` / `CheckResult.evidence` 是 hash，**不是 URL**；`CheckRun.artifacts` 是 `{name,mime,bytes,hash}`，没有现成 href。四项主证据分别为 schema.json / build.log / smoke.json / occlusion.json，另有 smoke.png / occlusion.png，附加诊断仅显示 run 实际声明的安全产物。href 从固定 API 前缀与编码后的 runId/name 构造 `/checks/:id/artifacts/:name`，不使用 evidence 值导航，不接受任意 URL/磁盘路径。

日志/JSON 在受控详情区按文本显示，PNG 用图片或安全新页（noopener）；不用 innerHTML、HTML/SVG iframe 或源码执行。展示 bytes/hash 和下载入口；读取失败显示“证据无法读取，请刷新检查状态”，保留历史结果但关采用。切换候选/关闭面板取消无用 fetch、释放 object URL，迟到响应不得串入新候选。必需六份证据可读性验证按 runId 缓存于本次同步代次，失败后不可仅靠旧缓存恢复绿灯；不用 HEAD（后端没有专门 HEAD 合同），用现有 GET。

## 4. REST、事件与持久补拉

| 使用点 | 已有合同 |
| --- | --- |
| 持久快照 | GET /tasks、/candidates、/version、/approvals（均直接返回列表，version 为对象）；详情 GET /approvals/:id、/candidates/:id |
| 决策 | POST /approvals/:id → `{approval,task}`；POST /tasks/:id/cancel 沿用任务取消 |
| 检查 | POST /candidates/:id/checks → 202 CheckRun；首次 `{}`，显式“重新检查”才 `{rerun:true}`；GET /checks/:id → CheckRun；POST /checks/:id/cancel → CheckRun |
| 生命周期 | POST /candidates/:id/adopt、/discard；POST /version/revert；沿用既有返回与互斥 |
| 补拉 | 唯一 EventCenterProvider 的 /events WS；GET /events/history?since=（events/current/oldest/truncated） |

事件实际负载：approval.requested / approval.resolved 携 `approval`；check.started / **check.updated** / check.finished 携 `run` 和可选 `candidate`；保留 task.updated、candidate.ready/closed、version.changed 及资产/场景订阅。check.updated 不能漏，否则进度停留。先校验最小结构和关联 id，按 id upsert、seq 去重、升序应用，不为每面板开连接。run 用 id 分桶，候选只认 latestCheckRunId；历史 run 的迟到响应不能覆盖最新轮。

同步算法（C1 提供通用机制，C2 接入 runs）：

1. 保留唯一有序事件处理队列。首连 ready 时取 server seq 为起始锚点；缓冲后续事件，读取四份持久快照，再 GET 各候选 latestCheckRunId 详情。缺 run 不能清空成“已通过”。多 GET 非原子，**不把本地多个响应拼成服务器原子快照**。
2. 快照开始时记录连接代次、请求代次、事件锚点；其间事件缓冲。快照完成后从锚点补拉历史，将缓冲与历史按 seq 合并去重后重放。只提交当前代次结果；旧请求、旧 socket 回调和卸载后的响应丢弃。HTTP mutation 结果同样服从代次/事件顺序约束。
3. 重连从最后已应用 seq 补拉；即使无事件缺口，也重读 approvals/candidates/version/tasks 和 latest runs，以持久状态恢复卡片与门禁。重连期间保留旧展示并标“状态待同步”，禁决策。缺号时补拉后仍处理触发缺号的 WS 事件，不能直接丢掉它或跳游标。
4. truncated、oldest > lastSeq+1、ready.seq 倒退或缓冲溢出（沿用 2000 上限）时：废弃旧快照代次，重新取锚点/快照/历史；不得靠 Math.max 游标跳过未知事件。持续高流量无法完成时保持不同步并提供手动刷新，不无限递归或宣称已同步。
5. 应用补拉前按实体/全局已应用 seq 防回滚；提交快照后只对比当前关联 latestRun。跨请求组合不一致时再读对应候选/run；稳定前禁采用。version.changed 立即使旧基线卡片/候选本地失效并排权威刷新，不改写持久 status。
6. 任一关键 GET 失败保留上次数据与错误，syncReady=false；“刷新状态”仅 GET，不触发模型/检查/批准。同步通过才 connected+syncReady。轮询不作为第二套状态源；无活动 WS 时由重连/手动刷新恢复，永不自动重跑检查。

排序：待处理请示在前，同组按 createdAt、id 稳定排序；历史卡片折叠不丢失。事件序号只在同一服务历史代次内比较，updatedAt 用于展示而非唯一排序冲突判据。公共事件订阅继续通知旧 AssetPanel/SceneEditor，不能因新增状态破坏原链路。

## 5. 按钮门禁与错误文案

通用：syncReady 且事件连接可用、目标存在、无本实体 in-flight/结果未知锁才可写。UI 只做保守的已知信息判断，后端仍在锁内检查字节、策略、证据与当前作品；无法在前端证明的外部篡改不能宣称已排除。

采用的全部可见前提：candidate.decision=pending；candidateCommit 存在；候选基线=当前 version；latestRun 存在且 id=latestCheckRunId、candidateId/commit/baseVersion/mainVersion 与当前候选和作品一致；run completed+outcome passed、无 error、有非空 digest/policy/toolIdentity；candidate 与 run 四项都恰好各一条 passed、runId 和 evidence hash 对应；六份必需 artifacts 不重复、hash 对应四项主证据且本次代次可读。**无证据不可点采用**。前端不硬编码 policyVersion 代替后端校验，不下载源码自行算 digest。若已知失效，历史通过结果保留并显著标“证明已失效”，不继续显示成当前可采用绿灯。

| 操作 | 额外门禁 |
| --- | --- |
| 批准/拒绝 | card pending、关联 task awaiting_approval；本地基线不一致先刷新确认，不继续提交旧卡 |
| 运行检查 check-run | pending 且 candidateCommit 存在、基线匹配、没有 queued/running；首次普通 POST，不自动 rerun |
| 重新检查 check-rerun | 上轮终态、仍是有效 pending 候选；明确点击才 rerun:true，按下立即关旧采用绿灯 |
| 取消检查 check-cancel | run queued/running；点击只取消该 run，待确认后再放开按钮 |
| 撤回候选 | pending 且没有该候选决策请求；检查运行中仍允许显式撤回，由后端负责取消与清理 |
| 回退上次采用 | 沿用后端 NO_ADOPTION；请求期间与其它作品决策互斥；不以本地没有历史直接推断有记录 |

| 情况 | 用户可见文案 / 处理 |
| --- | --- |
| schema failed | “场景配置检查失败，请查看字段原因”；后续未运行，禁采用 |
| build failed | “构建失败，请查看构建日志”；后续未运行，禁采用 |
| smoke failed | “页面冒烟检查失败，请查看运行错误与截图”；未运行项如实显示，禁采用 |
| occlusion failed | “交互入口被遮挡或命中检查失败，请查看报告与截图”；禁采用 |
| 取消/超时/缺浏览器/服务重启/清理或持久化错误 | “检查已取消”或“检查未通过：<安全原因>”；无自动重试，不把基础设施错误写成页面缺陷 |
| POST checks 409 STALE_CANDIDATE | “候选内容或主作品已变化，请重新生成候选”；关采用和重跑旧候选，刷新 |
| adopt 409 CHECKS_NOT_PASSED | “检查未通过或证明已失效，请刷新检查状态；候选过期时需重新生成”；立即关本轮采用，刷新候选/run/版本，禁止自动再采用 |
| STALE_APPROVAL | “请示已失效，请重新生成任务”；刷新卡片/任务，回答禁用 |
| APPROVAL_ALREADY_ANSWERED / APPROVAL_NOT_PENDING | “该请示已处理或不可继续，正在刷新状态”；不自动改答 |
| APPROVAL_LIMIT | “最多保留 3 张待处理请示，请先处理现有卡片”；链接到待处理列表 |
| LEGACY_CANDIDATE / NOT_FOUND / INVALID_STATE | “候选缺少记录，请重新生成” / “对象已不存在” / “对象已关闭或正在处理”；刷新并禁旧操作 |
| 网络/5xx | “无法确认服务器状态，请刷新后继续”；保留证据，不自动重放写请求 |
| NO_ADOPTION | “暂无可回退的采用记录” |

`STALE_CANDIDATE` 仅用于 startChecks 重新解析候选路径；adopt 的失效证明统一是 `CHECKS_NOT_PASSED`。移除现有 UI 将 MERGE_CONFLICT 作为常见采用失败的分支；该码不是公共 API 可达验收目标，未知码走安全通用错误。错误/模型文字/diff/证据一律文本，不输出凭据。

## 6. testid 与可测性

| testid | 作用 / 附加属性 |
| --- | --- |
| approval-panel、approval-card | 卡列表与卡；卡带 data-approval-id、data-task-id、data-status |
| approval-approve、approval-reject | 卡内唯一回答按钮；真实 disabled，不能只拦 onClick |
| approval-affected | 每条受影响位置；data-affected 原值；精确定位项内提供按钮 |
| approval-status、approval-error、approval-highlight-exit | 状态、错误、退出影响模式 |
| check-run、check-rerun、check-cancel | 首次运行、显式重跑、取消 |
| check-run-status、check-item | run 状态与四行；data-run-id、data-candidate-id；行带 data-check-name、data-status |
| check-evidence | 证据入口；data-run-id、data-artifact-name、data-hash |
| check-error、candidate-gate-reason、state-refresh | 错误、禁用原因、只读刷新 |

保留 candidate-adopt/discard/select、candidate-checks/action-error、version-revert、preview-frame/candidate-frame、events-status/seq、pick-toggle 等既有 testid。重复卡片/证据通过实体 id 容器限定查询，不能靠文案顺序或 nth 固定定位。

前端状态归并、门禁与证据 URL/坐标选择抽成纯函数，在 Studio 内加单测；不向 HTTP 增加测试后门。Pi 另建 `tests/e2e/m3c/` 与 `playwright.m3c.config.ts`（由 Pi 提交）；实现者不得代写独立验收断言。real 指真实 Studio+后端+持久文件+WS+Chromium（模型仍 mock），mock 指浏览器拦截/受控事件或单测边界，二者在报告分表。

real UI 必测：共享按钮三处高亮；批准前无公开候选、拒绝后无候选；批准不增加 mock 请求数、候选出现后先检查再采用；四检查成功及真实构建/运行/遮挡失败；断线跨批准/检查完成恢复，合法等待卡重启仍在；重复点击；三候选/多 run 切换；采用回退；M1 写回后旧基线失效。schema 失败由 mock UI 呈现加已有 server 实测支撑：非法配置被 Agent 工具拒绝，直接篡改候选 startChecks 会先命中 STALE_CANDIDATE，不能编造公共路径 schema failed。截断/乱序/迟到请求、缺证据/损坏 payload、写请求响应丢失等用受控 mock，明确不是后端真实故障证据。

完整 M3-C 回归需在冻结同一 HEAD 上跑 typecheck/build/全量单测、原八套146例与新 UI 套件（新增例数由 Pi --list 固定，不预编造）。0 retry/skip/flaky/expected-failed/顶层 errors，每例一次结果；各轮归档不混用，重算原始证据 hash，保留失败轮与清理信息。正式报告 `docs/reports/M3-C-test.md`、独立审查 `M3-C-review.md`。所有可能超过数分钟的命令从根目录用 `orbital\bin\bg.cmd "<command>"` **首次即沙箱外**启动，拿 job 即结束回合，不轮询/睡眠，不重复启动；期间冻结受测文件。新脚本不能直接以 M3-B runner 旧身份集合冒充覆盖新增 Studio 文件。

## 7. M1 / M2 衔接与调度

M1 的 SceneEditor 与作品共用渲染器、确定性写回和版本快照保持；作品版本变化并收到 version.changed 后使旧审批/检查门禁失效（场景写回的事件时机见下文），检查 UI 不篡改场景参数或复制候选产物进入作品。M2 选择的 pending/ready/error、STALE_SELECTION 重选、候选最多三份、分源预览和滚动对齐、diff、采用/回退保持。批准→发布候选→用户显式检查→用户采用，每一步都可观察；未批准的 staging 不出现在 iframe 中。

### 场景写回与检查证明失效语义确认

1. **正式实测修正**：早期设计将“PUT /scene 只发 scene.changed、分两例验证”作为前提；该判断已被正式接线实测否定。写回会经作品快照产生新版本，旧候选检查证明随之失效，候选仍为 pending。不在前端伪造版本事件，不修改既有后端写回合同。
2. **内容绑定**：候选 `src/scene.config.json` 属于完整输入摘要，主作品配置进入版本快照；采用仍在后端作品互斥内复核内容、基线与证据，失效统一拒绝 `CHECKS_NOT_PASSED`。
3. **实际验收**：合并为“场景写回产生版本变化、关闭旧基线门禁、2 秒内 20 次采样不出现可采用窗口、绕过界面直接采用仍 409”的一例。正式结果见 `M3-C-test.md`；过时后端快照不在本轮合同内，真实后端重启仅引用 M3-A 历史证据与本轮页面 reload，不冒称本轮新测。

任务卡在 `../../orbital/coordination/m3/`：C1 ApprovalPanel 与事件补拉 → C2 CandidatePanel 真实检查与证据 → C3 按钮门禁与失败态 UI。C1/C2 交付中的按钮先保守禁用，C3 完成共同门禁后才进入阶段验收，不交付任何无门禁的临时采用入口。CodeBuddy 在调度后创建/确认的独立 M3-C worktree 分支串行实现，每卡固定提交；Pi 独立测试、Claude Code 独立审查，通过后由 Codex 集成冻结与完整验收，不自行合并。本轮只写设计和卡片，不创建 worktree、不调用各角色。

## 8. 需批准的后端变更与开放问题

当前范围没有必须的后端变更，也没有阻塞开工的用户决策。现合同无法提供任意文件的精确 DOM 命中回执、多位置同时高亮或“此刻一定可采用”的字节证明；本计划采用明确降级与后端最终裁决，不扩接口。

若实现发现无法满足卡片判据，单列“需批准的后端变更”：列复现、当前响应、必要最小字段/事件/兼容影响与新增测试，交 Codex/用户审批后再排独立卡；不得直接塞入 C1–C3。尤其不得为构造 schema UI 故障开放非法配置写入或检查旁路，不以增加 canAdopt 字段掩盖后端 TOCTOU 验证。

## 9. 正式收口（2026-11-15）

- 独立审查：`M3-C-review.md` 及 `M3-C-viewport-review.md` 修后均无阻断/应修；视口修复仅单行场景模式 CSS，固定实现 `393fe9f98c64822593591301518e246df8aa45e2` 的 Studio 类型检查与构建实际通过。
- Pi 正式受测 `9294cccfa9ab1212619a28b23f368ea5af1f0da6`，job `job_01305fef` exit 0、21m22s。typecheck/build、501 单测及九套 E2E 174 全过（24+27+7+23+35+12+11+7+28）；M3-C 28 中 real 20/mock 8。每例单一 passed result/retry 0，无 skip、expected-failed、flaky 或报告 errors；所有步骤身份稳定。
- 正式报告 [M3-C-test.md](../reports/M3-C-test.md)；原件在 `artifacts/M3-C/regression/2026-11-15T03-24-30-188Z-full/`。归档 `9cd539e` 与清单补正 `132a6613981112679909bccd9de9a897215f5ea7` 已快进主线。Codex 复算 195 个载荷文件字节/哈希全部匹配；清单自身明确排除。原测试 JSON/日志/manifest 未改写。
- 合入后产品 `apps` 树仍为 `8df06a9b57fd8e00e98a0eb946ad9b6b5c8f64a8`，与受审实现一致；apps/packages/templates/锁及根 package.json 零 diff。锁 SHA256 `67af36b7a1b8a8ace1f03aa0ca9addf979f3842bdab3ff3dc4f56901b7d18960`。
- 收尾：五个默认端口无监听、验收树自有 node/chrome 无残留、模板与配置复原、临时 exclude 已撤销；fallback 保持未跟踪。M3-B 写死目录产生的本轮中间证据已归档并记录原路径，未混入历史证据。
- 失败链保留：最初 M1-B 18/23 因外层布局裁掉两列，修后正式轮重新跑过全部 23；后续 M2-B 永久 truncated mock 使恢复不可达，改为一次合法真实事件尾段后从头完整回归。早先不自洽 oldest 的定向结果不作有效恢复证明。
- 范围仅当前模板、Chromium、loopback mock 上游。没有新真实语音/模型/Lux3D 付费调用；不能宣称全项目完成。四项非阻断建议进入 M4 打磨评估，按持续授权进入 M4。
