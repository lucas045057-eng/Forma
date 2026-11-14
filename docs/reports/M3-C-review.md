# M3-C 独立审查（Claude Code）

审查方式：只读冻结提交字节（`git show <sha>:<path>` / `git diff`），未读取或操作 `.worktrees/m3c` 工作区，未运行 e2e，未改产品代码。对照依据：`docs/design/M3-C-plan.md`、`orbital/coordination/m3/c1-approval-events.md`、`orbital/coordination/m3/c2-checks-evidence.md`，以及基线 `bc615bf` 的后端/bridge 实际实现（`apps/server/src/events.ts`、`work/service.ts`、`checks/{runner,artifacts,routes}.ts`、`packages/bridge/src/index.ts`）。

已冻结语义按正确行为处理：`adopt` 失效证明统一 409 `CHECKS_NOT_PASSED`；`STALE_CANDIDATE` 仅出现在 `startChecks`；`MERGE_CONFLICT` 不再是公共 API 可达目标（C2 已移除该分支，符合设计）。

自测实况（调度提供，未作审查结论）：C1 `job_4a6d1a6a` Studio 16/16 + typecheck + build；C2 `job_77a38b3d` Studio 29/29 + typecheck + build。

---

## C1 — ApprovalPanel 与事件持久补拉（`886bd99`，基线 `bc615bf`）

**结论：有条件通过**（0 blocker / 1 应修）。**建议在该基础上继续 C3 收口**，应修项在 C3 内一并修掉并由 Pi 的三处高亮用例覆盖。

> **修后复核（`1644d10`，随 `91134d7` 冻结）：C1-1 确认已修。** 影响模式下收到 `pick:result`/`error` 即发 `pick:stop → pick:start → highlight(卡片 src)`（`App.tsx:115`、`approval-state.ts` `impactHighlightMessages`），bridge 的临时 selectedSrc 与 hover 被清掉，Selection 不被替换；C1-S1 已采纳（进入影响模式时把 pending 选取置 none）。残留：指针再移动仍会出现临时 hover 框（Pi 按 `data-highlight-src` 过滤）；影响模式会吞掉主 iframe 的全部 `error` 消息（见 C3-S3）。

### 重点复核逐条结论

| 复核点 | 结论 | 依据 |
| --- | --- | --- |
| 快照非原子与游标跳跃 | 通过 | `EventCenter.tsx` `synchronize`：先取锚点 → 并行四份 GET → `history(anchor)` → `contiguousReplay(history+buffer)` 要求从锚点起逐号连续且覆盖到 `current`，否则重来；旧的 `Math.max` 跳游标已删除。重放在"较新快照"上回放"锚点后的完整事件"，因每次状态变更都伴随带完整实体的事件（`service.ts` 各 emit 点），最终每实体落在最后一条事件，不会停在旧值；终态另有守卫（见下）。 |
| 缺号/触发事件不丢 | 通过 | 实时 `event.seq !== seq+1` 或 `version.changed` 时先 `buffer.push(event)` 再重同步，触发事件参与重放。 |
| 截断 / seq 倒退 / 缓冲溢出 | 通过 | `truncated`、`oldest > anchor+1`、`current < anchor`、`overflow`（2000 上限）均 `continue`；后续尝试用 `history(0).current` 取新锚点并重读快照；最多 3 次后报错、`syncReady=false`，不宣称已同步、不无限递归。`ready.seq < seq`（服务重启）时以新 ready.seq 为锚点。 |
| 迟到响应 / 旧代次回调 | 通过 | `connection`/`request` 双代次 + `valid()` 在每个 await 后检查；`onclose` 与卸载都自增两者；旧 socket 的 `onmessage/onclose` 以 generation 丢弃。 |
| 终态回滚 | 通过 | `mergeApproval`：终态/approving 不被 pending 覆盖、终态不被 approving 覆盖；`task.updated` 终态不回到非终态；`candidate.*` 非 pending 不回到 pending。有单测。 |
| 回答与取消竞态 | 基本通过（见建议 C1-S3） | 以 cardId 为键的同步 `locks` 互斥批准/拒绝/卡内取消；POST 后不写本地实体，只走权威重读；`outcomeUnknown` 与"操作已提交，状态刷新失败"分开，均不自动重发；锁在下一次成功同步后才释放（`[state, syncReady]` effect 只放开非 submitting 锁）。 |
| 数字回答 body | 通过 | `mutation('POST', { option })`，option 仅 `0 \| 1`。 |
| 影响模式退出不破坏 Selection / 不触发 PointSpeak | 通过（但见应修 C1-1 关于页面内高亮） | `pick:result` 在 `impactRef.current` 时直接 return，不 `setPick`；`PointSpeak blocked={!!impact \|\| showScene}`；`exitImpact` 仅在 `wasPicking && selection.baseVersion===version` 时恢复选取模式并重发 selection 高亮。版本变化/卡片终态/`syncReady` 失效/进入场景编辑/iframe 重载都会退出。 |
| source/origin 校验 | 通过 | 未改动：`event.origin !== previewOrigin` 即丢弃，且 `event.source` 必须精确等于主或候选 iframe 的 `contentWindow`；无 `contentDocument`、无 `*` origin。 |
| 候选 iframe 选取能力 | 通过 | 候选源只处理 `ready`（并回 `pick:stop`）与 `scroll:progress`；影响模式只向主 iframe `send()`，并强制 `setMode('current')`。 |
| 文件名当 src / 坐标猜测 | 通过 | `affectedSource` 只接受 `task.selection.src`（文件须在 affected 中、基线一致）或严格 `src/...:行:列`；其余显示"文件级影响；暂无可确认的页面位置"。路径段 `.`/`..` 被拒。 |
| 文本 XSS | 通过 | reason/evidence/affected/option 全部走 React 文本节点或 `<pre>`，无 `innerHTML`。 |
| 单 WS | 通过 | 全 Studio 仅 `EventCenter.tsx` 一处 `new WebSocket`。 |
| C1 采用入口禁用 | 通过 | `candidate-adopt` 为字面 `disabled`（`CandidatePanel.tsx:71`@886bd99），C1 期间无任何可点采用窗口；有渲染单测。 |
| 资产/场景原订阅 | 通过 | `subscribe` 保留；同步完成后对重放事件逐条 `notify` 再发 `state.reload`。 |

### Blocker

无。

### 应修

**C1-1 影响模式下点击/悬停页面会改写 iframe 内高亮，Studio 侧显示与实际框选不一致**
- 位置：`apps/studio/src/App.tsx:117-118`（@886bd99，`case 'pick:result'`）；行为来源 `packages/bridge/src/index.ts`（基线）`click()` 内 `selectedSrc = src` 与 `move()` 的 hovered 框。
- 现象：影响模式为了显示框选会发 `pick:start`，bridge 因此处于 picking。用户在页面上点一下，bridge 自己把 `selectedSrc` 换成被点元素并重绘；Studio 只是忽略 `pick:result`，标题仍是"查看影响位置"、卡片仍认为在看共享 Button，但页面上已是另一个元素的框。悬停还会多出一个橙色 hovered 框（Pi 若直接数 overlay 子节点会得到 4 而不是 3）。Selection 本身确实没被替换（断言字面成立），但"查看影响位置"的可视结果被破坏。
- 最小修法（只改 Studio，不动 bridge）：在 `pick:result` 分支里，若 `impactRef.current` 存在，则 `send({ type: 'highlight', payload: { src: impactRef.current.src } })` 后 return（把 bridge 拉回卡片的 src）；`error` 消息（"未找到带源码标记的外层容器"）在影响模式下也忽略。
- 给 Pi 的提示（不是替它写断言）：overlay 计数应按 `data-highlight-src === <卡片 src>` 过滤，避免把 hovered 框算进去。

### 建议

- **C1-S1** `App.tsx:60` 进入影响模式时 `++pickRequest.current` 会使正在解析的选取请求作废，`pick` 停在 `{kind:'pending'}`，PointSpeak 无法提交，且退出时 `selection` 为空导致不恢复选取模式。建议进入影响模式时若 `pick.kind === 'pending'` 则显式 `setPick({kind:'none'})`，或不自增 `pickRequest`（影响模式已屏蔽 `pick:result`）。
- **C1-S2** `App.tsx:103-110` iframe `ready` 时清理影响模式但没有按 `wasPicking` 恢复先前选取模式；设计允许"重载即清理"，但与 `exitImpact` 的恢复语义不一致，可直接改为调用 `exitImpact(false)` 后保持现状，或至少保持两处行为一致。
- **C1-S3** 卡内锁不覆盖 PointSpeak 的 `task-cancel`（`PointSpeak.tsx:39-41`，仅 queued/running 时显示）。running→awaiting_approval 的切换窗口里理论上可出现"任务取消"与"批准"两个并发 POST（由后端串行裁决，不会产生错误状态，但 UI 会出现两个并发写）。设计要求批准/拒绝/任务取消互斥，建议以 taskId 建共享锁（调度称 C3 已加入"任务锁"，C3 审查时复核）。
- **C1-S4** `synchronize` 的异步编排（代次失效、缓冲合并、3 次重试、失败后锁保持）没有单测，只有 `contiguousReplay` 纯函数测试。建议把编排抽成可注入 `fetch`/socket 的纯模块，补"快照期间到达事件""旧 operation 晚到""overflow 后重锚"三例。
- **C1-S5** 同步失败后不自动重试，只靠"刷新状态"按钮恢复，符合设计 §4.6；但首连即失败时整页 `syncReady=false`，建议在 `state-refresh` 旁显示失败原因已做到，Pi 用例覆盖即可。

### 未覆盖与风险

- 浏览器级：共享 Button 三处实际 overlay、断线跨批准、合法服务重启后同 id 单卡、POST 响应丢失后的 `outcomeUnknown`、双击/键盘只发一次 POST——全部归 Pi。
- **M1 回归风险**：`SceneEditor` 现在渲染在 `aside.inspector` 内、原 inspector 内容改为 `hidden` 而非卸载（`App.tsx:190` 起）。M1 的场景编辑器 E2E 若依赖布局/可见性或"inspector 不存在"，可能受影响；PointSpeak 在场景编辑期间保持挂载（已用 `blocked` 禁提交）。需要在 C3 冻结后的完整回归里确认。
- C1/C2 中间提交上 `candidate-adopt`（C1 起）与 `version-revert`（C2 起）均禁用，M2 的采用/回退 E2E 在这两个提交上必然不可跑——属有意的中间态，**完整回归只应在 C3 冻结提交上做**。

---

## C2 — CandidatePanel 真实检查与证据（`974ffa2`，相对 `886bd99`；不含 `9124f7e` 与 C3 提交）

**结论：有条件通过**（0 blocker / 1 应修）。**建议在该基础上继续 C3 收口**，但应修 C2-1 必须在 C3 内修掉并补单测，否则 C3 的故障态 UI 与采用门禁会被整页"状态待同步"掩盖。

> **修后复核（`a94add0`，随 `91134d7` 冻结）：C2-1 确认已修。** `sync-state.ts` `pendingRunIds` 只取 pending 候选；run GET 用 `allSettled`，失败/结构不符/无 runId/空 toolIdentity/视图不一致只写入该候选 `checkIssues`；快照仅在"检查事件跨越本次快照"时最多重读 2 次，用尽后仍提交快照、`syncReady=true`；实时 `check.updated` 不再触发全局重同步（`reconcileLiveEvent`）。全局同步只受事件历史连续性与四份核心 GET 约束。8 个单测覆盖所述场景。残留：`checkIssue` 同时封住了"重新检查"，导致后端明确要求"显式重新检查"的旧记录走入死路（见 C3-2）。

### 重点复核逐条结论

| 复核点 | 结论 | 依据 |
| --- | --- | --- |
| completed 当 passed | 通过 | `checkView`：只有 `associated && consistentChecks && outcome==='passed' && 四行 passed && !run.error` 才显示"全部检查通过"；completed+not_run outcome 为"未完成检查"；无 run 为"未检查"；有 latestCheckRunId 但未关联为"检查状态不完整"。有单测。 |
| 未知状态静默绿灯 | 通过 | `isCheckRun` 校验 status/checks 结构；`validChecks` 要求四名各恰好一条且状态 ∈ {passed,failed,not_run}；缺项显示"（结果缺失）"。 |
| latest run 与候选匹配 | 通过 | `associatedRun` 要求 `run.id===latestCheckRunId`、candidateId/candidateCommit/baseVersion 一致；`consistentChecks` 再要求 candidate.checks 与 run.checks 状态、evidence 逐项相等且 `runId===run.id`。 |
| `candidate.ready` 与 latest run 先后覆盖 | 通过 | `m2-state.ts`：候选事件不能改写已有 `latestCheckRunId`（保留旧指针与 checks）；check 事件只有在"状态里当前 latest = 该 run 且事件携带的 candidate.latest = 该 run 且 mergeRun 采纳了该 run"时才更新候选。新 latest 指针只来自 REST：`check.started`/`check.finished` 实时到达即触发重同步；重放窗口中出现快照未含的 `check.started` 则重来。 |
| 迟到旧 run 覆盖当前 run | 通过 | run 按 id 分桶；`mergeRun` 禁止终态→活动、running→queued、同状态下完成项回退；历史 run 无法把自己选成 latest。 |
| 同候选多轮串证据 | 通过 | `evidenceRefs` 只取 latest 关联 run 的 artifacts，主证据 hash 必须同时等于 run.check.evidence 与 candidate.check.evidence 且 `candidate.check.runId===run.id`；`Evidence` 以 `[candidateId, latestCheckRunId, syncEpoch, syncReady, refs]` 为 key 重挂载。 |
| 首次/重跑/取消 body 与目标 | 通过 | 首次 `POST /candidates/:id/checks` body `{}`；仅 `latestCheckRunId` 存在且上轮非活动时出现 `check-rerun`，body `{rerun:true}`；取消只打 `/checks/<latest run id>/cancel`；按候选 id 加锁，锁在 POST 返回后的下一次成功同步（epoch ≥ 点击时 epoch+1）才释放；不应用 mutation 响应、不重发。 |
| `STALE_CANDIDATE` | 通过 | 仅在检查 POST 失败时本地标记候选失效、关运行/重跑并提示重新生成，符合冻结语义。 |
| 证据 URL / hash 不当 URL | 通过 | `evidenceUrl` 只接受与后端一致的 runId 正则 `^[a-z0-9]{6,32}$`（对应 `randomUUID().replaceAll('-','')`）和后端 `ARTIFACT_NAMES` 八个固定名，再 `encodeURIComponent`；hash 只作展示与 `data-hash`。 |
| MIME/大小/SHA-256 校验可否绕过 | 通过 | `readCheckEvidence`：`redirect:'error'`、`cache:'no-store'`；响应 Content-Type 主类型必须等于引用 mime（与 `artifactMime` 一致：json/text 带 charset、png 无）；`byteLength === ref.bytes`、SHA-256 === ref.hash、PNG 还核 8 字节魔数；`safeArtifact` 限制 mime 与名字后缀匹配且 ≤2 MiB；校验全部在渲染前完成。HTML/SVG 无法进入（名字与 mime 白名单都不含）。 |
| 文本/图片渲染与执行 | 通过 | 文本/JSON 进 `<pre>` 文本节点；PNG 走 `Blob` + object URL 的 `<img>`；下载链接 `rel="noopener noreferrer"`。 |
| object URL 泄漏 / 迟到读取 | 通过 | `.then` 在创建 object URL 前检查 `aborted`；cleanup `abort()` 并 revoke 已创建的全部 URL；`readCheckEvidence` 在读完与 hash 后各检查一次 abort；有"传输忽略 AbortSignal 时迟到结果不发布"单测。 |
| 单 WS | 通过 | 仍只有 `EventCenter.tsx:134` 一处。 |
| C2 采用入口禁用 | 通过 | `candidate-adopt` 字面 `disabled` 且已删除 onClick（`CandidatePanel.tsx:110`）；`version-revert` 同样禁用（`:85`）；全 Studio 不再有对 `/candidates/:id/adopt` 的调用（`scene-adopt` 是 M1 资产采用，无关）。不存在"无检查可采用"窗口。 |
| 自动检查 / 自动重跑 | 通过 | 只有按钮 onClick 发起检查；同步/重连路径只 GET。 |

### Blocker

无。

### 应修

**C2-1 单个候选的检查视图不一致会把整页同步打成失败（`syncReady=false`），连带封死请示回答、PointSpeak 提交与所有写操作**
- 位置：`apps/studio/src/EventCenter.tsx:82-84`（任一 latestCheckRunId 的 GET 失败或结构不符即 `throw`）、`:99`（任一候选 `!associatedRun || !consistentChecks` 即 `continue`，3 次后 `:113` 抛"事件历史变化过快或不完整"）、`:161`（实时 `check.updated` 后任一候选不一致即触发重同步，从而进入同一循环）。
- 后端可达触发（不是假设）：
  1. 检查子系统不健康时（`checkFault` / `assertHealthy` 失败），`publicCandidate` 返回的 `checks` 是默认 `checks()`，**没有 `runId`**，但 `latestCheckRunId` 仍在（`apps/server/src/work/service.ts:298-303`@bc615bf）→ `consistentChecks` 恒为 false。这正是 M3-B 真实故障（持久化失败、资源不可用）以及 C2 卡 mock 清单"缺浏览器/预算/持久化错误呈现"的场景：设计要求的是"该候选禁采用并显示原因"，实际结果是整个 Studio 永久"状态待同步"，提示语还错误归因为事件历史变化过快。
  2. `syncCandidateChecks` 对 `policyVersion !== POLICY_VERSION` 或 `toolIdentity` 为空的 run 同样给出无 `runId` 的默认 checks（`service.ts:285-291`）——旧记录/升级数据目录即可触发。
  3. `GET /candidates` 返回**全部**候选（含已采用/已撤回，`service.ts:546`），任一历史候选的 latest run 读取 404/异常，同样让整次同步失败。
- 与设计冲突：§4.5"跨请求组合不一致时再读对应候选/run；**稳定前禁采用**"、§4.6"关键 GET 失败 syncReady=false"——检查明细不是让全局失去同步的关键 GET；设计把它限定为单候选门禁。
- 最小修法（只改 Studio）：
  - 只为 `decision === 'pending'` 的候选拉 latest run（历史候选不参与门禁，也顺带消除每次同步 O(全部历史候选) 的 GET）；
  - 单个 run 的 GET 失败/结构不符不 `throw`，记为该候选"检查状态不完整"（`checkView` 已有该分支，`runs` 中缺失即可）；
  - `:99` 的不一致仅在"快照窗口内确有该候选/该 run 的检查事件"时才 `continue` 重取；重试用尽后**仍提交快照、`syncReady=true`**，让该候选显示"检查状态不完整"并禁检查/采用；
  - `:161` 实时路径同理，只对事件涉及的那个候选判断，且失败后不应反复触发全局重同步（避免故障期间每条 `check.updated` 都打一轮 5+ 个 GET）。
  - 补单测：无 runId 的故障视图、run GET 404、历史候选不一致三种情况下 `syncReady` 仍为 true 且该候选不可检查/不可采用。

### 建议

- **C2-S1** `CheckPanel.tsx:53` Evidence 的 key 含 `syncReady`，而 CandidatePanel 传入的是 `syncReady && !busy`：每次点击运行/取消/撤回、每次重同步（含所有 `version.changed`、`check.started/finished`）都会重挂载并重新 GET + SHA-256 六份（单份上限 2 MiB）。"按同步代次重验"是设计要求，但 `busy` 翻转带来的重复读取没必要；建议 key 去掉 `syncReady/busy`，仅以 `[candidateId, runId, syncEpoch, refs]` 为键，`enabled` 改为 prop 传入控制是否发起。
- **C2-S2** 活动 run（queued/running）期间也会读取已出现的部分 artifacts；C2 未消费可读性结果，C3 门禁只需要终态 run 的六份。建议仅在 run 终态时自动读取，运行中改为按需。
- **C2-S3** `CheckPanel.tsx:61` 的 `blocked_by` 前缀判断与后端实际文案不符（runner 用"未开始执行：…"，`runner.ts:309`@bc615bf），该分支永远不命中；后端 message 已原样展示，无功能影响，建议删除或按真实前缀匹配。
- **C2-S4** 未知错误码直接显示 `ApiError.message`（文本节点，安全）；设计 §5 要求未知码走"安全通用错误"，C3 统一错误表时一并处理。
- **C2-S5** 撤回候选成功后不再 `onMode('current')`（旧代码有），依赖 App 的 effect 在无候选时回到 current；多候选时会停在 candidate 模式显示下一个候选，行为可接受，但建议 Pi 留意撤回后预览模式。

### 未覆盖与风险

- 浏览器级：真实四检查 queued→running→完成、六证据可读、构建/运行/遮挡真实失败 UI、取消、服务重启与断线期间完成、三候选与多 run 切换——全部归 Pi；C2 单测没有覆盖 `synchronize` 中 latest run 拉取与 `continue` 分支（正是 C2-1 所在）。
- 故障态呈现（缺浏览器、预算、持久化错误）在 C2-1 修复前无法得到设计期望的"单候选禁用+原因"，Pi 在 C2/C3 未修版本上测这些 mock 会看到整页不同步——应记为实现缺陷而非测试问题。
- 证据完整性校验是前端可见性门禁，后端 `validatePassedRun` 仍在采用锁内终裁；前端不能排除校验后到采用前的外部篡改（设计已声明，非缺陷）。
- `check.started` 实时触发全量重同步：多候选同时检查时同步频率较高，但仍有界（每次 4+N 个 GET）。C2-1 修法中限定 pending 候选后 N ≤ 3。

---

## C3 — 按钮门禁与失败态 UI（冻结 `91134d7`；C3 本体 `16ce0c4`/`1baa587`/`d09ce49`，整改 `1644d10`/`a94add0`/`91134d7`）

审查范围：`git diff 974ffa2 91134d7 -- apps/studio docs/reports/M3-C-impl.md`（21 文件），对照任务卡 `c3-gates-failure-ui.md`、设计 §5/§4/§7、基线 `bc615bf` 后端（`work/service.ts`、`checks/runner.ts`、`scene/service.ts`、`app.ts`）与基线 E2E（`tests/e2e/m1b`、`m2b`）。只读提交字节，未运行任何测试。

**结论：有条件通过**（0 blocker / 3 应修）。采用门禁本身没有发现绕过窗口；3 条应修都在门禁之外的衔接面（M1 场景草稿、旧记录重跑、任务重试范围），均为 Studio 内小改。**不建议直接把 `91134d7` 冻结交 Pi 做正式验收**：建议先修 3 条应修（尤其 C3-1 直接影响 Pi 要跑的 M1 回归稳定性）再冻结；Pi 可先在 `91134d7` 上起草 `tests/e2e/m3c` 和 `--list`，正式轮次以修后的冻结提交为准。

### 重点复核逐条结论

| 复核点 | 结论 | 依据 |
| --- | --- | --- |
| 采用门禁完整性 | 通过 | `adoption-gate.ts:8-24` 依次要求：同步+连接；无 work 锁；候选 pending；有 candidateCommit；`baseVersion===version`；run 关联且 `mainVersion===version`；该 run 未被 409 封存；`completed+passed+无 error`；contentDigest/policyVersion/toolIdentity 非空；`consistentChecks` 且四项 passed；六份必需证据各恰好一份且主证据 hash 对应；最后要求**证据回执** `receipt.ready` 且 `receipt.key === proofKey(candidate, run, version, epoch)`。回执由 `Evidence` 在六份全部通过 MIME/大小/SHA-256 校验后发出（`CheckPanel.tsx:33-35`），key 绑定整份 candidate/run JSON、版本与同步代次，任一变化或新同步开始即失配；卸载时撤回。无 canAdopt 类后端字段。 |
| 绕过窗口（事件/键盘/直接调用） | 通过 | 唯一发起点 `CandidatePanel.action('adopt')`，执行前用 `receiptRef.current` **再算一次** `adoptionReason`（`:70-71`）并要求 `checkIssue` 为空；按钮为真 `disabled` 且 onClick 内再判（`AdoptButton`），键盘无法激活 disabled 按钮；没有任何事件回调或同步路径会自动 POST adopt。`version.changed`/`check.started`/`check.finished` 实时到达即全量重同步、`syncReady=false`、epoch 变化→回执失效，所以 M1 写回或回退后旧候选立即关灯。 |
| TOCTOU 交后端 | 通过 | 前端只做可见性门禁，门禁文案"采用时仍由服务器最终核对"；后端 `validatePassedRun` 在锁内重核字节与证据（基线未改）。 |
| `CHECKS_NOT_PASSED` / `STALE_CANDIDATE` 语义 | 通过 | `operationError`：adopt+`CHECKS_NOT_PASSED`→"检查未通过或证明已失效…"，并 `rejected[id]=run.id` 封住该 run，只有新 run 才可能恢复，不自动再采用；`STALE_CANDIDATE` 只在 `run/rerun` 分支处理并永久禁用该候选的检查。不期待 adopt 返回 `STALE_CANDIDATE`，无 `MERGE_CONFLICT` 分支。与后端一致。 |
| 共享锁：死锁 / 漏放 | 通过 | `MutationLocks`（`mutation-locks.ts`）：含 `work` 的请求与任何在途锁互斥，实体锁按 key 互斥；锁在请求返回后 `awaiting` 标记 `after=epoch+1`，只在之后一次**成功同步**时释放（`EventCenter.tsx:124`）。`api()` 与场景 `request()` 均加 60s 超时，`json()` 20s，所以不存在"请求永不返回→锁永不进入可释放态"；断线重连后的自动同步也能释放。ApprovalPanel（`approval:id`+`task:id`）与 PointSpeak（`task:id`、`task:create`）共用任务锁，C1-S3 已落实。代价是任一在途写操作会短暂封住所有作品级写入（保守，可接受）。 |
| 回退入口 | 通过 | `canRevert = ready && !locked(['work'])`，不依据本地历史猜测；`NO_ADOPTION`→"暂无可回退的采用记录"。 |
| 撤回运行中候选 / 晚到 run | 通过 | 撤回仅受本候选锁与同步约束；候选关闭后 `reduceM2Event` 拒绝 pending 回写，晚到 run 事件不再更新候选（只有 latest 指针匹配时才写候选）。 |
| 回答错误路径 | 通过 | `STALE_APPROVAL`/`ALREADY_ANSWERED`/`NOT_PENDING` 写入 `blockedIds` 永久禁该卡；网络未知先权威重读；刷新失败不误报为操作失败。 |
| 跨源隔离 / 单 WS / 文本安全 | 通过 | origin+source 校验未动；候选 iframe 仍不进入选取；仍只有一个 WebSocket；新增文案与服务端 message 均为文本节点。 |
| M2 选择与 STALE_SELECTION | 通过（行为有变，见 C3-S4） | `App.tsx:45-56` 版本变化即作废选取、停止选取模式；PointSpeak 要求 `selection.baseVersion===state.version`，旧 Selection 不能生成任务。 |
| M2-B 现有采用 E2E | 预计兼容，需 Pi 实证 | `tests/e2e/m2b/01-ui.spec.ts:122-128` 先由 helper 走真实 checks API 跑通四检查再点 `candidate-adopt`。C3 下 `check.finished` 触发重同步→终态证据读取→回执就绪后按钮才可用，Playwright 的可操作性等待会覆盖这段时间；`candidate-checks [data-status]` 在无 run 时仍全为 `not_run`。 |
| SceneEditor 移入 inspector 列的 M1 风险 | **仍存在，且 C3 新增了一个更直接的风险**（C3-1） | 布局层面：场景编辑器仍在 `aside.inspector` 内、原内容 `hidden`。C3 又给场景写入加了同步/作品锁门禁并改为"写完靠事件与重载刷新"。`scene-diff` 现在只由 `scene.changed` 事件设置（服务端在 HTTP 返回前发出，`scene/service.ts:102-103`），一般不影响 `m1b/02-writeback` 读取；主要问题见 C3-1。 |

### Blocker

无。

### 应修

**C3-1 任意一次全量同步都会用服务器配置覆盖场景编辑器里尚未保存的草稿（M1 衔接回归）**
- 位置：`apps/studio/src/SceneEditor.tsx:86`（`state.reload` → `load()` → `applyConfig` 无条件覆盖、清 `dirty`），配合 `EventCenter.tsx:127`（**每次**成功同步都会发 `state.reload`）与 `:173`（`version.changed`/`check.started`/`check.finished` 都会触发全量同步）。基线里 `state.reload` 只在首连/截断时出现；C1–C3 后它在每次检查开始/结束、每次任何面板写操作后的 `reload()`、每次版本变化时都会出现。
- 失败情形：
  1. 用户在 3D 场景编辑器里拖了参数还没点"设为首屏"，此时任何候选的检查开始/结束、请示被回答、他处采用/回退，都会把草稿悄悄重置。
  2. 首连时序竞争：`writeBlocked` 让 fieldset 在 `syncReady` 变 true 的同一刻才启用，而同一刻 `state.reload` 触发的 `GET /scene` 正在途中；`m1b/02-writeback` 与 `03-undo` 一启用就 `setSlider` 再保存，若 GET 晚于滑条到达，草稿被覆盖、保存的是原配置，画面不变化而超时。基线中 fieldset 不受同步门禁，这一竞争窗口小得多。
- 最小修法（只改 SceneEditor）：`state.reload` 分支与 `scene.changed` 分支一致，`if (!dirty.current) { void load(); }`（资产列表照常刷新）；`action()` 写成功后显式 `dirty.current = false`（或像基线一样以本次写入返回的 `config` 调 `applyConfig` 并 `setLatest`，这是 M1 自己写入的确定结果，不属于 M2/M3 实体乐观更新）。补一个"dirty 时收到 state.reload 不覆盖草稿"的单测。

**C3-2 `checkIssue` 同时封住"重新检查"，把后端要求"显式重新检查"的旧记录变成死路**
- 位置：`apps/studio/src/CandidatePanel.tsx:56`（`canRun` 含 `!checkIssue`）、`:58`（`canCancel` 同理）；来源 `sync-state.ts:28`。
- 后端可达：`runner.ts:147-151`（基线）把缺 outcome 的旧 run 标为 `LEGACY_CHECK_RECORD`"旧记录缺少完整检查证明，请显式重新检查"；`service.ts:285-291` 对 policyVersion 不符或 toolIdentity 为空的 run 给出无 `runId` 的默认 checks → 前端判为视图不一致 → `checkIssue` → 运行/重跑/取消全部 disabled。用户只能撤回候选重新生成，后端提供的恢复路径在 UI 上不可达。
- 最小修法：区分"run 读不到（`failed`）"与"run 已读到但视图不一致/旧记录"。后者若 run 为终态，允许 `check-rerun`（仍发 `{rerun:true}`，由后端裁决：故障期间返回 503/`STALE_CANDIDATE` 均已有文案）；若 run 仍活动，允许取消该 run。采用继续由 `checkIssue` 封住。补单测：旧记录/无 runId 视图下 rerun 可用、adopt 仍 disabled。

**C3-3 "重试"不再沿用原任务的选取范围，可能把一次"共享 Button"范围的任务悄悄变成整页任务**
- 位置：`apps/studio/src/PointSpeak.tsx:77`（`submit(active.instruction, selection)`，基线为 `active.selection ?? null`）。
- 失败情形：`App.tsx:45-56` 在任何版本变化时把 pick 置 none；`canSubmit` 允许 none（"可以提交整体修改"）。于是选中共享 Button 发起的任务失败/取消后，只要期间作品版本变过（或用户没有重新点选），点"重试"就会发出**不带 selection** 的任务——范围、请示策略（out_of_scope/shared_component）与用户原意都变了，且 UI 没有任何提示。若用户点了别的元素，重试会换成新元素的范围。
- 最小修法：重试时若 `active.selection` 存在：其 `baseVersion===state.version` 则沿用它；否则禁用重试并提示"页面已变化，请重新点选后再重试"（或在用户重新点选同一 src 后用新 Selection）。原任务无 selection 时才按整页提交。

### 建议

- **C3-S1 确定性 4xx 被说成"无法确认服务器状态"**：`adoption-gate.ts:36` 的兜底把所有未列出的码（如 `MODEL_MISSING`、`INVALID_TASK`、`INVALID_SELECTION`、`NOT_READY`、`INVALID_OPTION`）都变成"无法确认服务器状态，请刷新后继续"。设计里这句话是给网络/5xx 的；对已明确拒绝的 4xx 会误导用户去刷新。建议：`ApiError` 且 `status` 为 4xx 时显示"操作被拒绝：<服务器 message 文本>"，仅网络错误/超时/5xx 用"无法确认"。PointSpeak 任务提交由此比基线丢失了原有错误说明。
- **C3-S2** 未运行过检查时门禁原因显示"检查状态不完整或基线不一致"（`adoption-gate.ts:15`，`!run` 也走这条），应改为"尚未运行检查，请先运行检查"，避免把正常的未检查说成异常。
- **C3-S3** 影响模式下 `App.tsx:115` 吞掉主 iframe 的**所有** `error` 消息，包括页面真实运行错误（bridge 的 `window.error`/`unhandledrejection` 转发），并为每条错误重发一次高亮。建议只吞"未找到带源码标记的外层容器"这类选取错误，其余照常显示。
- **C3-S4** 版本变化时 `App.tsx:55` 无条件显示红色 alert"页面已变化，请重新点选"，即使用户之前没有任何选取（例如只是做了场景写回或采用）。建议仅在原先有 ready/pending 选取时提示。同时注意它会关闭选取模式，Pi 需留意 M2 用例里"采用后继续点选"的步骤。
- **C3-S5** `reconcileLiveEvent` 只累加 `checkIssues` 不清除，问题只能等下一次全量同步（`check.finished` 会触发，所以实际会自愈）；建议在 live 路径对事件涉及的候选重算而不是合并保留，减少误报持续时间。

### 对 CodeBuddy 建议取舍理由的核对（`M3-C-impl.md`）

| 项 | 取舍 | 核对 |
| --- | --- | --- |
| C1-S1 | 采纳 | 成立，已见 `App.tsx:74`。 |
| C1-S2 | 不采纳（重载即清理，不恢复旧选取） | 成立：重载后旧 Selection 不可信，保守。 |
| C1-S3 | 采纳 | 成立，任务锁已共享。 |
| C1-S4 | 部分采纳（抽纯函数，不重写驱动） | 成立，`sync-state.test.ts` 8 例覆盖决策逻辑；完整异步驱动仍是 Pi mock UI 的责任，需在 Pi 报告中单列。 |
| C1-S5 | 不变 | 成立，符合设计 §4.6。 |
| C2-S1 | 不采纳缓存重构 | 成立：重复读取只是成本，换来"失步即作废凭据"的保守语义；终态才读取（C2-S2）后成本已明显下降。 |
| C2-S2 | 采纳 | 成立，`CheckPanel.tsx:61`。 |
| C2-S3 | 采纳 | 成立，前缀改为"未开始执行："。 |
| C2-S4 | 采纳通用文案 | 方向成立，但兜底范围过宽，见 C3-S1。 |
| C2-S5 | 不变 | 成立，交 Pi 验证。 |

### 未覆盖与风险

- 全部浏览器级行为（完整闭环、三处高亮、真实四检查与六证据、409 两路径、POST 响应丢失、断线/重启、双击、M1 写回后旧候选关灯）归 Pi；本次只读代码，`job_1f28cd58` 结果未纳入。
- EventCenter 的异步驱动（真实 WebSocket + fetch 交错）仍无自动化测试，只有决策纯函数测试。
- M1 回归：除 C3-1 外，场景写入期间 fieldset 会在同步窗口内短暂 disabled、`scene-diff` 改由事件更新，均依赖 Playwright 的等待；建议 Pi 在完整回归里关注 m1b 三套的时延与偶发。
- 每个在途写操作都会短暂封住全部作品级写入（含场景写回、采用、回退、回答）；属于设计允许的保守互斥，但高频检查事件期间 UI 会频繁出现"状态待同步"。
- `real-model` 套件（`tests/e2e/real-model/real-model.spec.ts:352/380`）直接点采用/回退，不在 146 例回归内，但若后续启用，需要先跑检查。

---

## 总结

| 卡 | 结论 | Blocker | 应修 | 是否建议继续 C3 |
| --- | --- | --- | --- | --- |
| C1 `886bd99` | 有条件通过 | 0 | 1（C1-1 影响模式页面内高亮可被点击改写） | 是，C3 内顺带修复 |
| C2 `974ffa2` | 有条件通过 | 0 | 1（C2-1 单候选检查不一致导致全局同步失败） | 是，但 C2-1 须在 C3 冻结前修复并补单测，C3 审查时复核 |

| C3 `91134d7` | 有条件通过 | 0 | 3（C3-1 同步覆盖场景草稿；C3-2 checkIssue 封死重新检查；C3-3 重试丢失选取范围） | 不直接冻结；修完 3 条应修后冻结交 Pi 正式验收 |

C1-1、C2-1 修后复核均确认已修；C1-S3 共享任务锁已落实；采用门禁完整消费了六证据可读性回执并绑定同步代次；`version-revert` 已恢复且由后端判定。C3 三条应修修后需要复核（只看对应 diff 与新增单测即可），之后 0 blocker / 0 应修 + Pi 正式通过才能收口。
