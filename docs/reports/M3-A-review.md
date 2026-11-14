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
