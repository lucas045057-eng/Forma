# M3-C 独立审查（Claude Code）

审查方式：只读冻结提交字节（`git show <sha>:<path>` / `git diff`），未读取或操作 `.worktrees/m3c` 工作区，未运行 e2e，未改产品代码。对照依据：`docs/design/M3-C-plan.md`、`orbital/coordination/m3/c1-approval-events.md`、`orbital/coordination/m3/c2-checks-evidence.md`，以及基线 `bc615bf` 的后端/bridge 实际实现（`apps/server/src/events.ts`、`work/service.ts`、`checks/{runner,artifacts,routes}.ts`、`packages/bridge/src/index.ts`）。

已冻结语义按正确行为处理：`adopt` 失效证明统一 409 `CHECKS_NOT_PASSED`；`STALE_CANDIDATE` 仅出现在 `startChecks`；`MERGE_CONFLICT` 不再是公共 API 可达目标（C2 已移除该分支，符合设计）。

自测实况（调度提供，未作审查结论）：C1 `job_4a6d1a6a` Studio 16/16 + typecheck + build；C2 `job_77a38b3d` Studio 29/29 + typecheck + build。

---

## C1 — ApprovalPanel 与事件持久补拉（`886bd99`，基线 `bc615bf`）

**结论：有条件通过**（0 blocker / 1 应修）。**建议在该基础上继续 C3 收口**，应修项在 C3 内一并修掉并由 Pi 的三处高亮用例覆盖。

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

## 总结

| 卡 | 结论 | Blocker | 应修 | 是否建议继续 C3 |
| --- | --- | --- | --- | --- |
| C1 `886bd99` | 有条件通过 | 0 | 1（C1-1 影响模式页面内高亮可被点击改写） | 是，C3 内顺带修复 |
| C2 `974ffa2` | 有条件通过 | 0 | 1（C2-1 单候选检查不一致导致全局同步失败） | 是，但 C2-1 须在 C3 冻结前修复并补单测，C3 审查时复核 |

C3 审查时将一并复核：C1-1、C2-1 的修复；C1-S3 共享任务锁；采用门禁是否完整消费证据可读性结果；`version-revert` 恢复与 M2 采用/回退回归。
