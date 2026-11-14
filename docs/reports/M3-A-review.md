# M3-A 后端请示状态机 · Claude Code 独立审查

- 日期：2026-11-14（Asia/Shanghai）。角色：独立审查，只读，未改实现、测试、依赖、锁文件、验证入口或其他报告，未提交。
- 基线：master **`012838d3047e72c2e957731699f1916b8f8b1e1c`**。审查 HEAD：**`7fad918c93108d3a2f385ac1b0d836ede614a380`**（feat/m3a-approvals：5357cbc、b236ac3、43e86fc、b8f815c、7fad918）。代码用 `git show 7fad918:<path>` 读取，下文行号均对应该提交；探针运行时导入的 `.worktrees/m3a` 开始和结束时都是 HEAD=7fad918、工作树干净。
- 依据：M3-plan（7fad918）、M3-A-impl（7fad918）、`docs/dev-doc-v0.1.md` 的“请示卡”与“安全与权限”条款、主线 M2-N4-final-review。正式 E2E 和 M3-B/C 按约定不在本轮范围。
- 全仓验证 `job_049bdc52` 在审查期间没有返回，**本报告不替它预写通过**，也没有轮询它。

## 1. 结论

**不通过（阻断 1、应修 2）。** 状态机的主体设计是对的：私有草稿不公开、硬拒绝不能被审批转授权、回答幂等与终局互斥、先持久后广播、N4 准入与排空都做到了。但是：

1. 风险策略在**真实模板**上，会把每一次源码修改都判为 `analysis_uncertain`，连 M2 已验收的“点选 → 改 App 文案 → 直接出候选”主流程也会变成必须请示。合并后 M2 主流程会退化（阻断）。
2. 批准意图在发布阶段失败后，会挡住其他所有卡片的回答和后端重启（应修）。
3. 回答时检测到草稿或主版本已变化，只返回 409，卡片仍显示 `pending`、继续占用 3 张上限（应修）。

## 2. 阻断

### B1 · 非代码本地导入被当成“无法解析的引用”，真实模板上任何源码修改都要请示
- 位置：`apps/server/src/approvals/policy.ts:77`–`:93`（`moduleName`/`resolveModule` 只认 `.tsx/.ts/.jsx/.js`），`:262`（引用解析为 `null` 就记为 unresolved），`:285`–`:286`（凡有 unresolved 就请示）。
- 触发条件：真实模板 `templates/product-page/src/main.tsx:4` 有 `import './style.css'`，`src/scene-config-store.ts:4` 有 `import rawConfig from './scene.config.json?raw'`。这两个目标不是源码模块（后者还带 `?raw` 查询），`resolveModule` 返回 `null`。而 `unresolved` 是对**整棵树所有模块**统计的，与改了哪个文件无关。
- 实证（临时探针，数据放在 `.data/claude-m3a-review-probe`，用 `git archive 7fad918` 取出真实模板；直接用原生 Node 导入 7fad918 的 `WorkRepo` 与 `evaluateApproval`）：选中 `src/App.tsx`，只在 `<h1>` 文案后加“（改）”，`changedFiles=['src/App.tsx']`。结果为 `required=true`、`ruleCodes=['analysis_uncertain']`，证据是基线与草稿两侧都出现“src/main.tsx 含无法解析的本地模块引用；src/scene-config-store.ts 含无法解析的本地模块引用”。
- 为什么是阻断：
  - 计划要求“普通局部改动直接走现有发布路径”。实际上真实模板里每个源码任务都会进入等待请示；第 4 个任务直接 `APPROVAL_LIMIT` 失败。
  - Pi 的 M2 E2E 主流程（选中 buy-button，祖先含 App.tsx，mock 修改 App.tsx）在合并后会停在 `awaiting_approval`，看不到候选。
  - 单测夹具里没有任何从源码导入 CSS 或 JSON 的情况（`policy.test.ts:9`–`:27`、`work/approvals.test.ts` 的夹具），“App 文案不误报”的用例因此在夹具上通过，却掩盖了真实模板上的行为。
- 修法：
  - 解析本地引用时先去掉 `?raw`/`?url` 等查询串；目标在草稿或基线树中**作为任意文件存在**时，视为叶子资源，不算不确定；只有目标确实不存在，或超出 `src/`，才记为 unresolved。
  - 同时建议只统计与改动文件相关的模块（改动文件本身、它的消费者、导出链）的不确定性，避免树中任何一处动态 `import()` 就让所有任务都要请示（见 S5）。
  - 补一条基于**真实模板副本**的回归：App 的 `<h1>` 文案修改 → `required=false`；Button 修改 → 命中 `shared_component`；导入一个不存在的本地文件 → 命中 `analysis_uncertain`。

## 3. 应修

### R1 · 批准发布阶段失败后，意图一直留着，挡住所有回答和重启
- 位置：`apps/server/src/work/service.ts:404`–`:408`（先保存 `approved` 和 approve 意图，再发布），`:192`–`:193`（`commitCandidate` → `previews.start`），`:208`（成功后才清除意图），`:389`（每次回答前先 `recoverApprovalIntent()`），`:144`（approve 意图会重新执行 `finalizeApprovedTask`），`:97`（`init` 不捕获地等待恢复）。
- 触发条件：批准后预览启动失败（启动超时默认 90 秒、Vite 子进程退出、端口或依赖问题），或者 commit 之后、保存之前的任何异常。
- 实证（临时探针：真实 `WorkService`/`WorkRepo`，用伪造的 `CodingAgent.run` 修改 Button.tsx，不调用模型；`previews.start` 改为抛错，模拟启动失败）：
  - 批准卡 1：抛出预览错误；卡 1 变成 **`approved`、answer=0**，但任务仍是 `awaiting_approval`，候选数为 0。
  - **拒绝另一张卡 2：同样抛出卡 1 的预览错误**，所有回答都被挡住。
  - 关闭后重启：`init()` **失败**，后端起不来；把 `previews.start` 换回正常后重启，卡 1 才完成发布（候选数 1）。
  - 唯一的出口是对卡 1 的任务执行 cancel（`:416`–`:427` 会用 cancel 意图覆盖 approve 意图），但重启失败时连 HTTP 都没有，这个出口也用不上。
- 为什么：把“一张卡的发布失败”变成了“全局卡死”和“服务不可启动”；卡片对外显示“已批准”，实际却没有候选，状态不一致。现有测试都把 `previews.start` 替换成必然成功（`approvals.test.ts:45`、`:202`、`:235`），覆盖不到这条路径。
- 修法：
  - 发布要分阶段持久化：commit 完成后记录“已提交”；预览启动失败作为这张卡/这个任务的明确终态（例如任务 failed `PREVIEW_FAILED` 并清理，或者先发布候选、之后再重试预览），然后清除意图，不要一直留着 approve 意图。
  - `answerApproval` 遇到不属于本卡的遗留意图时，失败不能阻止本卡的回答。
  - `init` 中恢复失败时记录错误、保留意图并继续启动，让用户可以取消。
  - 卡片在发布完成前不要显示 `approved`（可加 `approving` 状态或只依据意图判断）。
  - 补“预览启动失败或被中止”时批准、重启、回答其他卡片的回归。

### R2 · 回答时发现已过期，卡片仍是 `pending`，占用上限且无法批准
- 位置：`apps/server/src/work/service.ts:396`–`:400`（检测到过期直接抛 409，不改变状态），`:316`（上限只统计 `status==='pending'`），`:395`（只有 pending 才能回答）。
- 触发条件：卡片等待期间，采用另一个候选、回退、M1 场景面板写回、或者手动编辑主作品后快照，主 HEAD 就会前移；或者草稿内容被改动。之后回答批准，会得到 `STALE_APPROVAL`。
- 现状：卡片保持 `pending`，任务保持 `awaiting_approval`，私有草稿保留，仍计入 3 张上限。GET /approvals 看不出这张卡已经不能继续。只有逐张拒绝或取消才能释放；在这之前，新的风险任务会 `APPROVAL_LIMIT` 失败。测试 `approvals.test.ts:162`–`:178` 只断言 409 和候选为空，没有断言卡片状态。
- 为什么：计划要求“已失效/内容变化的卡明确显示不可继续”，实现报告第 4 节也称“失效……的卡片标为 stale”，但这只在恢复路径（`:176`–`:187`）中成立，回答路径没有做到。
- 修法：在同一个 `exclusive` 内，把卡片持久化为 `stale`、任务置为 failed `STALE_APPROVAL`、清理草稿，按先保存后广播发出 `approval.resolved` 和 `task.updated`，再返回 409（或返回规范的过期结果）。补一条“过期后释放上限”的断言。

## 4. 建议

| 编号 | 位置 | 内容 |
| --- | --- | --- |
| S1 | `service.ts:193`、`:388` | `finalizeApprovedTask` 在 `repo.exclusive` 内启动预览（最长 90 秒），期间 `/version`、场景读写和其他任务的作品操作都要排队。另外，close 中止 controller 的循环（`:494`）可能早于排队中的回答登记自己的 controller，导致关闭要等完整的预览启动。安全上没有问题，建议在“已提交”状态持久化之后，把预览启动移到 `exclusive` 之外。 |
| S2 | `service.ts:318`–`:323` | 卡片只有 affected/evidence，没有待批准的差异文本，用户等于看不到改动就批准。建议在详情中加入截断后的文本 diff（按 React 文本渲染，不可执行），供 M3-C 使用。 |
| S3 | `service.ts:89`–`:95` | 启动时只检查 `approvals` 是不是数组，不检查每张卡的字段（status、contentDigest、baseVersion、taskId）。字段损坏的卡会被接受，到回答时才出错。建议逐项校验，遇到损坏拒绝启动，与“不静默重置”一致。 |
| S4 | `service.ts:162`–`:172` | `finalizeApprovedTask` 是 public，没有准入/互斥包装，`:167`–`:172` 的两个分支返回同样的值。建议改为 private，并删掉重复分支。 |
| S5 | `policy.ts:260`–`:263`、`:152`–`:153` | 不确定性按整棵树统计：任何无关文件里的 `import()`/`require`/命名空间再导出都会让所有任务请示。另外，`.map()` 中只有一个 JSX 位置但渲染多次的组件，静态计数为 1。实际上只有选中文件本身被改且上报 instances>1 时才会补救；没有选中或改动越范围时，由 `out_of_scope` 兜底。属于低风险，建议记入规则版本说明。 |
| S6 | `app.ts:163`–`:165` | 原始 JSON 的 `0.0`、`1e0`、`-0` 经 JSON.parse 后与 0/1 无法区分，会被接受。这不影响语义，建议在接口说明里写明“数值为 0 或 1”，不要声称拒绝一切字面小数写法。 |

## 5. 逐项核对：没有发现问题的部分（附依据）

- **实际 diff 与硬拒绝**：`repo.ts:250`–`:273` 的 `pendingDiff` 先 `assertNoLinks` 和 `auditTree`；新增文件用 `add -N` 纳入 diff，删除也计入；`modelWritable`（`repo.ts:13`，只允许 `src/` 下的 tsx/ts/css/json/svg，不允许点开头的文件）同时约束新增文件和全部改动。package、配置、`public/` 都 409 `UNSAFE_CANDIDATE_DIFF` 硬失败，不会出卡，审批无法转授权。摘要覆盖 base、每个文件的路径、长度和字节，以及完整未截断的 patch。
- **共享判定**（夹具层面）：同文件多处 JSX、别名、default、具名或 barrel 再导出、模块消费者计数（`policy.ts:105`–`:209`、`:264`–`:284`）都正确。基线或草稿任一侧失败都以 `analysis_uncertain` 补上，不会因此抹掉另一侧已知的证据（`:238`–`:256`）。`instances` 只在选中文件被改且大于 1 时追加证据，不会压低结论（`:294`–`:297`）。App 引用 Button 不会被误判为改了 Button（模块与导出绑定是分开计的）。前提是 B1 修复。
- **私有草稿**：只有 `finalizeApprovedTask` 会写 candidates（`service.ts:196`–`:200`）和启动预览（`:193`）。卡片路径（`:312`–`:339`）不 commit、不启动预览、不发 `candidate.ready`。等待中的任务查 `/candidates/:id` 和 adopt 都返回 404（routes 测试 `:47`–`:48`）。`publicApproval` 去掉了模型 summary（`:239`–`:242`）；策略证据把根路径替换为 `<作品>`（`policy.ts:242`、`:255`、`:289`）。
- **队列与终局**：创建卡片后 `execute` 直接返回，释放 `taskQueue`；回答、取消、创建卡片都走 `repo.exclusive`，状态检查在锁内（`:313`–`:316`、`:388`–`:395`、`:414`–`:429`）。同一答案重复提交返回原结果，相反答案 409（`:391`–`:394`）。approve 与 cancel、reject 不可能同时成为终局。
- **持久化**：首次保存卡片失败会回滚（`:330`–`:336`）；保存回答或取消失败会恢复卡片和意图，不广播（`:406`–`:407`、`:422`–`:426`）。重启时保留合法的等待卡和草稿（`:98`–`:104`），等待任务缺卡则拒绝启动（`:93`–`:95`）。commit 之后、状态保存之前中断：恢复时 `pendingDiff` 的摘要不变，`commitCandidate` 不会产生第二个提交（测试 `:216`–`:250`）。这条恢复路径本身成立，问题只出在 R1 的失败分支。
- **N4**：`answerApproval` 与 submit、cancel 一样同步登记到 `inFlight`（`:67`–`:76`）；close 的顺序与 e468c20 相同（`:492`–`:504`），HTTP 仍由 onClose 排空（app.ts 未改动关闭逻辑）。内部发布调用的 `trimCandidates` 和 `pendingDiff` 都在已有作用域内，或者发生在 drain 之前，不会被误拒绝。关闭期间被接受的回答，其事件发生在日志关闭之前。
- **路由**：preValidation 在 Ajv 处理之前拒绝额外字段和非对象请求体；`option: {}` 不会被类型强转；字符串、0.5、2、null 都返回 400（routes 测试 `:49`–`:54`）。
- **运行时依赖**：`typescript` 5.9.3 已列入 server 的 dependencies；本次探针用原生 Node 直接导入 `policy.ts`、`repo.ts`、`service.ts`，运行正常。

## 6. 验证范围与限制

- 静态审查范围：`git diff 012838d 7fad918` 中的实现、类型和测试。
- 运行过两个短探针，数据放在 `E:/空间化AI工作台/.data/claude-m3a-review-probe`（已被 git 忽略），结束后已删除：
  - B1：在真实模板副本上调用 `evaluateApproval`；
  - R1：真实 `WorkService`/`WorkRepo`，用伪造的 `CodingAgent.run`（不调用模型），`previews.start` 用抛错代替，没有启动任何 Vite 或预览进程，也没有监听端口。
- 没有读 `.env` 或 ASKS 全文，没有使用真实 key、模型或 Lux3D，没有跑构建、单测或 E2E，没有碰 orbital 运行时。
- 修复后需要在新的固定提交上复审 B1、R1、R2，并核对 `job_049bdc52`（或其后续作业）的完整证据。

## 复核（首轮整改）

- 日期：2026-11-14。固定 HEAD：**`25c33a83877bff173ffa5635c52ef5cb7b526cd7`**（feat/m3a-approvals；ff6fe99 = B1，b82efad = R1/R2，25c33a8 = 报告）。复核差异 `git diff 7fad918 25c33a8`，并追踪了 `answerApproval`/`cancel`/`finalizeApprovedTask`/`recoverApprovalIntent`/`init` 的完整调用链。行号对应 25c33a8。
- 探针导入的 `.worktrees/m3a` 在开始和结束时都是 HEAD=25c33a8、工作树干净。全量 `job_c2efd2aa` 尚未返回，**本节不预写全量通过**，也不拿 7fad918 的 job_049bdc52 或分阶段的定向作业拼成全量结论。
- **结论：仍不能转为通过，暂判“有条件通过”**。B1、R1、R2 都可以关闭，没有新阻断；新增 1 条应修（RR1：取消会覆盖另一张卡已持久化的清理意图）。RR1 修好、全量作业通过后，可以转为通过。

### B1 · 关闭
- `policy.ts:83`–`:96` 的 `baselineFiles` 用 `ls-tree -r` 从真实 Git 基线树读取：链接、子模块或非常规模式、`src/` 外、非法字符，一律报基线错误。草稿则由 `sourceFiles`（`:62`–`:78`）从磁盘独立读取，并检查源码根和每一项是否为链接。两侧各自出错、各自记 `analysis_uncertain`，不会抹掉另一侧的证据（`:262`–`:276`）。
- `moduleName`（`:96`–`:101`）去掉 `?`/`#` 后缀后解析；含反斜杠、越出 `src/` 的引用直接视为不确定（`:130`–`:134`）。非源码资源只有在**对应一侧快照中确实存在**时才放行（`:285`）；TS/JS 带查询串仍按源码模块参与共享计数。
- 实证（临时探针，`git archive 25c33a8` 取出真实模板，原生 Node 导入真实 `WorkRepo`/`evaluateApproval`）：
  - App `<h1>` 文案 → `required=false`；
  - Button（instances=1）→ `shared_component`；
  - 导入不存在的 `./nope.css` → `analysis_uncertain`；
  - `../package.json?raw` → `analysis_uncertain`；
  - 反斜杠路径 → `analysis_uncertain`。
- 别名、default、barrel、坏语法、基线失败等原有断言保留在 `policy.test.ts`。S5（整树统计不确定性）按整改报告保留，没有新的升级依据。

### R1 · 关闭
- 批准先保存为 `approving` 加 approve 意图（`service.ts:424`），这时没有候选、没有 `approved`。`:197`–`:204` 只在 `previews.start` 和随后的取消检查外层捕获异常，异常转为持久化的 `preview_failed` 清理意图（`:167`–`:172`）。commit、摘要、路径和写盘错误不在这个 catch 范围内，会照常抛出。
- 实证（真实 `WorkService`/`WorkRepo`，伪造 `CodingAgent.run` 不调用模型，`previews.start` 抛错代替预览失败，不启动 Vite、不监听端口）：
  - 批准卡 A → `failed/failed/PREVIEW_FAILED`，候选数 0；
  - 再次以同一答案回答 A → 原样返回 `failed`，不重启预览；
  - 拒绝卡 B 正常；
  - 关闭后重启 init 成功，A 仍是 `failed`。
- 旧数据中 `approved` 加 approve 意图的组合，恢复时同样走 finalize（不检查卡片 status），预览失败时同样进入 `preview_failed`。
- 成功发布但最后一次保存失败时（`:219`–`:224`），会回滚候选、卡片和任务，停掉预览并保留 approve 意图；之后由 commit-before-save 恢复重新发布，不会产生第二个提交（原有测试保留）。

### R2 · 关闭
- 回答时发现过期（`:414`–`:419`），在同一 `exclusive` 内先持久化 `stale` 意图，再清理本卡草稿、写入终态，然后才发 `approval.resolved`/`task.updated`，最后抛 409。卡片已是 stale 后，任何答案都在 `:407` 稳定返回 409。pending 计数只统计 `pending`，名额随之释放。新增测试 `approvals.test.ts`（diff 第 104–158 行处）覆盖了草稿变化、主版本变化、保存失败、清理失败加重启，断言了卡片/任务状态、磁盘内容和名额。

### 新问题

#### RR1 · 应修：取消另一个任务会覆盖已持久化但尚未完成的清理意图，留下永远“approving”的卡
- 位置：`service.ts:433`–`:447`（`cancel` 没有先执行 `recoverApprovalIntent()`，直接写入唯一的 `approvalIntent` 槽位再保存），对比 `answerApproval` 在 `:405` 会先恢复。相关代码在 `:145`、`:156`–`:162`（终态保存失败时保留意图）。
- 触发条件：卡 C 预览失败，`preview_failed` 意图已落盘，草稿也已删除，但终态保存遇到一次瞬时写盘失败。此时状态为 C=`approving`、任务 `awaiting_approval`，磁盘上保留着 C 的意图。在任何 `answerApproval` 之前，用户先取消了另一个等待中的任务 D。
- 实证（同一探针，第 3 次 `save` 注入一次失败）：
  - 回答 C 报出注入的错误，磁盘意图为 `preview_failed`/C；
  - `cancel(D)` 成功后，**磁盘意图变为 null**；
  - C 变成 `approving answer=0`、任务 `awaiting_approval`，草稿已不存在；
  - 再次以同一答案回答 C，返回 `approving/awaiting_approval`（200），按“同答返回既有状态”永远不会推进；
  - 重启 init 正常，但 C 仍是 `approving`，没有任何恢复依据。只有用户对 C 也执行取消才能结束。
- 为什么：违反了“不得丢失恢复依据、不得用清理覆盖新的意图”的合同，对外表现为一张卡长期“正在批准”却没有草稿也没有候选。7fad918 里同一个 cancel 也会覆盖 approve 意图，只是当时被 R1 掩盖了；现在可以单独复现。
- 修法：`cancel` 在 `exclusive` 内先 `await this.recoverApprovalIntent()`（与 answer 一致）；或者在存在不属于本卡的未完成意图时拒绝取消。更稳妥的做法是把意图改成按卡片 id 存储，避免单一槽位。补一条回归：终态保存失败 → 取消另一个任务 → 断言原意图仍在磁盘上，并在下一次回答或重启时完成为 `failed`。

### 建议（不影响关闭结论）
- RS1 `service.ts:160`、`:220`：回滚用的是 `Object.assign(previous)`，不会删掉新增的键。从磁盘加载的任务对象本来没有 `error` 键、发布前没有 `candidateId` 键，回滚后内存里会残留 `task.error=PREVIEW_FAILED`，或在 awaiting 任务上残留 `candidateId`。如果在重试之前恰好有其他操作保存，这些残留会写入磁盘。建议整对象替换（与 `state.approvals[index] = previous` 的做法一致）。
- RS2 `service.ts:197`–`:204`：正常关闭时中止 controller，会把用户已经批准的草稿转成 `PREVIEW_FAILED` 并删除，而不是保留 approve 意图到重启后继续发布。这符合本轮合同（AbortError 视为失败），但用户可能因为一次停机丢掉已批准的修改。建议在 closing 时保留意图，或者由 M3-C 明确提示。
- 原 S1–S4、S6 的处理说明与代码一致（锁的作用域、diff 展示、逐卡 schema、方法可见性都未改；S6 已在文档中澄清），没有新证据要求升级。

### 本节验证范围
- 只追加本节；没有改实现、测试、依赖或其他报告，也没有提交。
- 一个临时探针，数据放在 `E:/空间化AI工作台/.data/claude-m3a-rereview-probe`，结束后已删除；用伪造的 Agent，`previews.start` 用替身代替，没有模型、网络、端口或子进程。故障注入只在探针进程内替换 `save`。
- 没有跑构建、单测或 E2E，没有读 `.env` 或 ASKS 全文，没有等待 `job_c2efd2aa`。RR1 修复后需要在新的固定提交上复核，并核对全量证据。

## 复核（RR1与基线读取优化）

- 日期：2026-11-14。固定 HEAD：**`012d9a65b4242cad2407a40c34614b2d162c8032`**（feat/m3a-approvals）。范围 `25c33a8..012d9a6`：50a13b6（RR1）、6fe015c（policy 基线读取）、24879aa 和 012d9a6（报告）。行号对应 012d9a6。
- 探针导入的 `.worktrees/m3a` 在开始和结束时都是 HEAD=012d9a6、工作树干净。全量 `job_d6233862` 尚未返回，本节**没有**等待或预写它的结果；上一轮全量 job_c2efd2aa（25c33a8，server 175/176，四候选用例 5012ms 超出 5000ms 预算）仍是失败记录。
- **结论：RR1 关闭；基线读取优化可以接受；本轮没有新的阻断或应修。M3-A 代码审查转为“通过”**。这只是代码审查结论：冻结提交的全量 `job_d6233862` 必须由调度核验通过（尤其是四候选 5000ms 用例），合并后还需 Pi 的正式验收。不代表 M3-B/M3-C、正式 E2E 或全量测试已经通过。

### RR1 · 关闭
- `service.ts:435`：`cancel` 在 `repo.exclusive` 内、读取目标任务**之前**先 `await this.recoverApprovalIntent()`。我逐一追踪了 `approvalIntent` 的所有写入点：
  - `:170`（`failApproval`）：只会在本卡的 approve 恢复过程中（`:190`/`:202`），或回答本卡时已先恢复过（`:405` → `:417`）的情况下被调用，替换的是同一张卡的意图；
  - `:425`（answer）：前面有 `:405` 的恢复；
  - `:442`（cancel）：前面有 `:435` 的恢复；
  - `:158`、`:161`、`:218`、`:221`、`:427`、`:446`：清除或回滚的都是同一个意图。
  - `execute` 和 `init` 不写这个槽位，`init:97` 只做恢复。现在已经没有“先覆盖、后恢复”的入口。
- 实证（临时探针：真实 `WorkService`/`WorkRepo`，伪造 `CodingAgent.run`，`previews.start` 用替身代替，不启动 Vite、不监听端口；数据放在已被 git 忽略的 `.data/claude-m3a-final-probe`，结束已删除）：
  - 卡 C 预览失败、第 3 次 `save` 注入瞬时失败 → 磁盘意图 `preview_failed`（属于 C），草稿已删除。
  - **持续写盘失败**期间 `cancel(D)` 报错，D 仍是 `pending/awaiting_approval`，磁盘意图仍是 C 的 `preview_failed`，没有丢失也没有被覆盖。
  - 故障解除后 `cancel(D)` 返回 `cancelled`；C 先被恢复为 `failed/failed/PREVIEW_FAILED`。
  - 再对 C 执行 cancel → `409 INVALID_STATE`，C 保持 failed。C 以同一答案 option 0 再回答，返回既有的 `failed`；相反答案返回 `409 APPROVAL_ALREADY_ANSWERED`。
  - 整个过程 `previews.start` 只调用了 1 次，候选数 0。重启 init 成功，卡片状态为 `failed,cancelled`，意图为 null，没有残留的 approving 卡，**重启后也没有再次启动预览**。
- 并发终局、`inFlight` 同步准入、嵌套 `repo.exclusive` 和 N4 关闭顺序都没有改动（`service.ts` 只增加了 `:435` 这一行）；新增测试只在 `approvals.test.ts`，没有改动 timeout、retry、skip 或 fails 标记。

### 基线读取优化 · 可接受
- `policy.ts:76`–`:89` 的 `baselineFiles` 先检查版本格式（`:77`），`ls-tree -r -z` 失败直接报错；每条记录都校验 `100644/100755 blob`、`src/` 字符集和 `..`，并有 500 个文件的上限。这些检查都在调用 `gitShow`（`:85`）**之前**。`gitShow`（`:52`–`:56`）唯一的调用者就是这里，只读取已审计清单中的路径；读取失败抛出“无法读取基线文件”，最终记为 `analysis_uncertain`，**不会被当成文件不存在**。链接、子模块、非常规模式在清单阶段就会失败。草稿与基线仍然分别读取（基线不再用草稿副本代替）。
- 探针复测：真实模板 App `<h1>` → 不请示；Button → `shared_component`；新增文件 → `out_of_scope`；基线版本不存在 → `analysis_uncertain`。原有的别名、barrel、坏语法测试文件未改动。
- 性能：只减少了重复的逐文件 `ls-tree`（报告中阶段 Git 调用 168 → 160 次，约少 146ms，四个策略窗口约 110ms → 70ms）。`WorkRepo`、全局锁、`work/service.test.ts`、`policy.test.ts`、配置、依赖和 lockfile 都没有改动，四候选 5000ms 预算与断言保持原样。这只是**单次测量到的改善**，不能证明全量超时已经消除，也不能确定历史失败的唯一根因，要以 `job_d6233862` 的结果为准。

### 建议的状态
- 原 S1–S6、RS1（`Object.assign` 回滚不删除新增键）、RS2（关闭时中止会丢弃已批准的草稿）都按整改报告保留。本轮没有发现使它们需要升级的新证据。其中 S1（预览启动期间持有作品锁）与四候选耗时没有直接关联：该用例走的是不需要请示的发布路径。建议在 M3-B 引入检查运行器之前处理 S1。

### 本节验证范围
只追加本节，没有改实现、测试或其他报告，也没有提交。一个短探针（伪造 Agent 和预览替身，在进程内注入写盘失败），没有模型、网络、端口或子进程，临时数据已删除。没有跑构建、单测或 E2E，没有读 `.env` 或 ASKS 全文，没有接触旧 worktree 或 Orbital 运行时。
