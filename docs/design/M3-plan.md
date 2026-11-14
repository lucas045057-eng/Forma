# M3 请示与自动检查 — 实施计划

> For agentic workers: 按既定角色执行；CodeBuddy 使用 executing-plans 逐任务实现和提交，不开子 Agent；Pi 负责独立验收，Claude Code 负责独立审查，Codex 负责设计与集成。

**Goal:** 对共享/全局/越范围修改强制请示，批准后才发布候选；自动检查有真实证据，失败或未检查不能冒充通过。

**Architecture:** 延续独立作品版本库、私有 worktree、JSON 原子持久化和统一事件日志。模型完成私有草稿后由后端分析实际 diff；等待批准时释放执行队列。批准精确绑定草稿与基线，发布候选后由受控运行器检查，工作台统一显示卡片和检查证据。

**Tech Stack:** Node 24 / TypeScript strict / Fastify / React；现有 TypeScript AST、Vite、Playwright 与 JSON Schema 工具；固定版本使用本地已安装依赖，不引入新模型服务。

**Spec:** docs/dev-doc-v0.1.md 的“候选版本、任务与请示卡”“安全与权限”“M3”；docs/project-brief.md 的共享按钮请示演示；M2 收口实现 c56ab1a。

## 本轮范围与角色

用户在 M2 收口后要求“按角色分工继续推进”，本轮据此启动 M3。Codex 调度设计，CodeBuddy 独立 worktree 实现，Pi 测试，Claude Code 独立审查。先完成下述 M3-A，再逐段派 M3-B、M3-C；不要一轮混改全部子系统。实现交付后先独立审查，再合并冻结给 Pi；Pi 正在测试时不改被测主实现。测试和演示一律 mock，不沿用 M2 十题的一次性真实额度授权。

不做新依赖安装权限、发布、任意 shell、语音、数据库迁移或 M4 外观。任务/候选/请示继续用现有 JSON 单进程持久层，当前数据量不足以证明需要 SQLite；容量上限和分页另留后续。M1 确定性的场景面板写回仍按原合同，不经本轮模型请示。

## Global Constraints

- 模型仍只能操作候选 `src/` 允许的源码文件；package.json、构建配置、依赖和外部操作继续硬拒绝。请示不能授权突破硬沙箱，UI 不得提供误导性的“批准后可装包”选项。
- 主作品不在用户采用前改写；批准不等于采用，任务完成、批准、候选决策分别持久记录。
- 预览保持独立来源；Host/Origin、fs.allow、根目录链接检查、作品互斥、意图恢复、事件先写盘后广播、N4 停机排空不能回退。
- 源码、diff、错误和模型生成文字通过 React 文本渲染；证据不能包含凭据、完整环境或上游 Authorization。
- 模型、检查、预览均可取消；已接受调用排空和事件生产者停止后才关日志、最后放实例锁。所有等待/子进程纳入关闭屏障。
- CodeBuddy 只在 `.worktrees/m3a` / `feat/m3a-approvals` 实现本阶段，不改 Pi 的 tests/e2e 与正式证据、不读取真实 .env、不合并 master。原 m2fix 脏草稿、m2d3 成品保留。
- 长命令通过根 orbital/bin/bg.cmd 在沙箱外启动；拿到 job 后结束当前回合，不等、睡眠或轮询。每个可交付步骤即提交，完整验证期间冻结被测文件。

## Review Focus

1. 共享判定不能只信 selection.instances；别名、同文件多次 JSX 使用、re-export、动态不确定结构应保守请示；单处文案修改不应被整文件共享引用误判为别的组件修改。
2. 批准和拒绝竞态、重复回答、草稿或主作品变动、写盘失败/崩溃，都不能重放批准、绕过批准或重复调用模型。
3. awaiting_approval 的 worktree 不是公开 Candidate；列表、详情、预览代理、采用接口不能暴露未批准草稿。
4. 等用户回复不能占住 taskQueue 或 repo.exclusive；取消、服务重启和 N4 关闭仍可完成，不存在永远等待批准的 Promise。
5. 检查运行器不能执行模型可改的 package scripts/config，不能继承后端 key；passed 必须绑定当次内容和证据，不能沿用旧结果。

## 核心设计决定

### 私有草稿与批准边界

沿用已有 worktree 做模型工作区，但在批准前不 `commitCandidate`、不写公开 Candidate、不启动它的 Vite，不发 candidate.ready。它只是私有 staging。模型 finish 后读取实际未提交 diff（包括新增文件），计算风险及内容摘要。普通局部改动直接走现有发布路径；风险改动保存卡片和 task.awaiting_approval 后结束该任务执行回合，让下一任务可工作。

这是“未批准前不产生候选版本”的执行层实现。不会保留一个等待用户的模型 HTTP 调用；批准只完成已经生成的精确草稿，不再次问模型。所有理由合并一张卡，明确受影响文件、来源位置/实例数的证据和“批准本次修改 / 拒绝并丢弃”两个选项。

### 由实际改动触发的规则

- `shared_component`：被改模块的导出组件在基线或草稿中存在至少两次 JSX 使用，或模块至少被两个使用方引用。计数按引用/使用，不按“只有一次 import 就不共享”判断；当前 App 三次 Button 必须命中。导入别名、命名/default 导出要识别；分析失败/动态不确定性标 `analysis_uncertain` 并请示，不能放行。
- `global_style`：修改任何非模块 CSS 文件，或主题/全局场景配置。MVP 保守处理 CSS：即使只写单一选择器也请示；不声称精确影响分析。
- `out_of_scope`：实际修改文件不在规范化的 selection.src 与 ancestors 对应文件内。无 selection 的非空修改按范围未知请示，而非默认全 src 获准。
- UI 报的 instances 只能作为附加保守证据；较小/缺失值不得压低静态分析结论。只把它用于实际修改到的选中文件，不能因选中共享 Button 而把其祖先 App 的单处文字修改误称为改共享 Button。
- package.json/脚本/发布/模型声称“已批准”不是风险规则放行入口；依旧被硬工具权限拒绝，原文件不变。

### 精确批准与持久恢复

每卡绑定 taskId、草稿基线版本、完整允许文件树/diff 摘要和规则版本。回答前在作品互斥队列内再次验证链接、草稿内容和当前作品版本：任何内容/版本改变返回409 `STALE_APPROVAL`，不发布候选。收到的 option 必须是原始JSON数字整数0或1，拒绝字符串/小数/越界，不被Fastify类型转换放宽。

回答使用持久意图：先存回答及后续动作意图，再做发布/清理，最后提交状态；重启可恢复且验证实际提交树身份。重复同一回答返回既有状态，不重复 commit、preview 或事件；不同回答返回409 `APPROVAL_ALREADY_ANSWERED`。pending 卡最多3张，达到上限的新风险任务失败 `APPROVAL_LIMIT`，不自动批准或静默驱逐旧卡。

拒绝/取消会使卡失效、清理本任务 staging，无公开候选。awaiting 的 task 可取消；重启保留合法等待卡与 staging，不在原“未知候选清理”中误删，也不自动批准。已失效/内容变化的卡明确显示不可继续。关闭时不等待用户、不丢待处理卡。

### 检查结果合同（M3-B 实现，M3-A 不提前冒充）

检查顺序 schema→build→smoke→occlusion；独立 CheckRun 状态表达 queued/running/completed/cancelled，不把 Check.status=not_run 临时改成 passed。检查按已提交候选的内容摘要固定，在受控子进程执行并保存真实证据。

- schema：实际读 scene.config.json，用现有Schema；缺失、坏JSON或非法配置为failed，给可读字段原因。
- build：trusted runner通过Vite程序接口固定configFile:false和可信插件/输入，不跑候选package scripts、tests或可变vite.config；产物写独立临时目录，绝不覆盖作品树。
- smoke：浏览器打开分源候选，断言根页面、购买入口和3D ready/明确回退，没有新增pageerror；不是只检查HTTP200。
- occlusion：对viewport内可交互按钮/链接进行真实elementFromPoint命中检测；滚动/零尺寸/不可见者分别说明，不把“没找到按钮”当通过。遮挡可复现fixture必须被抓到。
- 超时、取消、缺浏览器、构建失败等按真实原因标failed或not_run；被前序失败阻止的后续检查not_run并附原因。默认build上限120秒，browser两项各30秒，整次180秒；测试可注入更短预算，不放宽假装通过。
- 运行器无shell、密钥、外网；只允许必要本机预览请求，禁止调用正式写入/付费接口。服务关闭/崩溃应回收运行器及浏览器，保留明确失败/未完成状态。
- adopt 在后端要求四项均passed且内容摘要仍一致；失败、未运行、检查中均409 `CHECKS_NOT_PASSED`，不提供MVP强制采用。旧M2候选默认not_run，需要显式重新检查，不能迁移为通过。
- 证据固定在数据目录，按run id/允许文件名提供只读API，拒绝路径穿越；日志/截图都不带key。

## 接口与事件（M3-A 先交付请示部分）

| 接口 | 合同 |
| --- | --- |
| GET /approvals | 卡片列表，包含状态/任务关联/理由/affected，不返回绝对磁盘路径或源码凭据。 |
| GET /approvals/:id | 卡片详情，不暴露未批准候选的可执行预览。 |
| POST /approvals/:id | `{ option: 0 }` 批准本次摘要；`{ option: 1 }` 拒绝，返回规范卡片/任务状态；校验、失效、幂等语义如上。 |
| POST /tasks/:id/cancel | 扩展为允许awaiting_approval；使关联卡失效并清理staging。 |
| POST /candidates/:id/checks | M3-B：启动/返回当前内容的检查run，同内容并发不重复运行。 |
| GET /checks/:id | M3-B：run/四项结果/证据链接。 |
| GET /checks/:id/artifacts/:name | M3-B：受限只读证据，来源Host/Origin合同与现API一致。 |

事件新增approval.requested、approval.resolved、check.started、check.finished，沿用全局seq及补拉；数据先持久再广播。Task状态沿用已有awaiting_approval。ApprovalCard扩展status、ruleCodes、baseVersion、contentDigest等，已有M2数据迁移时缺失approvals视为空数组；损坏记录不得悄悄重置。

## M3-A 任务卡：后端请示状态机（已独立验收）

**Files:**
- Create `apps/server/src/approvals/policy.ts`、`policy.test.ts`：实际diff的静态风险判断。
- Create `apps/server/src/approvals/state.ts`、`state.test.ts`（需要时）：卡片与摘要/幂等/恢复辅助，不另建独立锁绕过WorkService。
- Modify `apps/server/src/work/service.ts`、`work/repo.ts`、`app.ts`、`packages/shared/src/index.ts`。
- Test `apps/server/src/work/approvals.test.ts`、`apps/server/src/approvals/routes.test.ts`，必要时补现有repo/关闭单测。
- Write `docs/reports/M3-A-impl.md`，不改Pi的tests/e2e。

**Interfaces:**
- `evaluateApproval({ root, baseVersion, changedFiles, selection }): Promise<{ required, ruleCodes, affected, evidence }>`：root为私有staging，changedFiles来自真实git diff，不是模型声明。
- `WorkService.listApprovals()` / `getApproval(id)` / `answerApproval(id, option)`，回答加入已有准入/关闭屏障及repo.exclusive。
- `WorkRepo.pendingDiff(id, base)`：包含新增文件的完整未发布diff，读取前做同样链接/路径审计；不能通过先commit后回滚绕过批准边界。
- `finalizeApprovedTask(taskId)`：无新模型请求的幂等发布路径；批准意图和已存在的候选身份一致时返回原结果，不重复发布。

### Task A1：风险策略与可审计证据
- [x] 先写失败单测：三次Button引用（同文件一次import）命中shared；别名引用同样命中；把instances伪为1仍拦；全局CSS命中；out-of-scope及无选择命中；App内单一文案改动不因Button共享而误命中shared。
- [x] 用现有TypeScript AST/文件解析完成最小策略。需要运行时声明时只用本地现有TypeScript 5.9.3，不引入不明传递依赖、线上下载或新的解析服务；无法分析时请示并说明原因。
- [x] 定向测试证明策略先红后绿；提交一次清晰中文commit。

### Task A2：私有草稿、卡片与批准/拒绝
- [x] 先写mock Agent集成单测：共享圆角产生awaiting_approval，公开候选列表为空、preview404、adopt404/409、原作品不变；批准后一次candidate.ready且模型调用次数不增加；拒绝无候选、staging清理。
- [x] 在commitCandidate/preview.start之前接策略，保存草稿/卡与任务状态；等待卡不占住taskQueue，下一条安全局部任务仍可运行。
- [x] 同时覆盖多规则一张卡、最多3张等待卡、cancel awaiting、幂等同答/相反答409、回答时草稿和主版本变化409；批准不能带出src或修改package.json。
- [x] 完成路由和共享类型，字段schema严格；旧数据迁移与新事件写盘顺序保持。定向验证并提交。

### Task A3：崩溃恢复与关闭边界
- [x] 先写失败测试：等待卡重启仍等待且不误删staging；批准意图落盘后进程中断能幂等恢复；完成commit但状态尚未落盘不重复commit/事件；磁盘保存失败不广播“已批准/已完成”。
- [x] 并发 approve/reject/cancel，以及HTTP延迟回答与close竞态：只有一个终局，停止所有生产者前不关日志/放锁；关闭不等待用户，不能回退N4合同。
- [x] 完成恢复与取消清理，只动本任务文件/链接；验证上述案例并提交。

### Task A4：冻结交付
- [x] 独立worktree先跑baseline（由调度bootstrap完成）；完成后typecheck/build/完整单测。所有长验证走后台通知，首个失败即停；不重复五轮全量，除非有新不稳定证据。
- [x] 写M3-A-impl报告：提交、API、规则覆盖/保守边界、迁移/恢复、mock证据、Pi需要的接点、未运行项、自启PID/端口清理。不可称正式e2e已过。
- [x] 固定HEAD、工作树干净，交回调度，不自行合并。完整验证未结束时报告“待结果”，收到通知后再补交付。

## M3-B / M3-C 后续任务（不要在 M3-A 抢做）

M3-B：独立受控检查运行器、四类实际证据、取消/预算/进程回收/内容绑定及adopt后端门禁；Pi使用编译错误、运行异常、遮挡和坏Schema四种故障fixture验证确实失败，外加缺浏览器/超时/重启恢复。Claude Code重点审环境泄密、任意代码执行、内容篡改和证据路径。

M3-C：ApprovalPanel与EventCenter持久补拉、受影响位置高亮、批准/拒绝/失效提示；CandidatePanel从后端真实Check数组显示状态和证据，不再硬编码not_run；按钮门禁与后端一致，未运行绝不显示通过。稳定testid包括approval-card、approval-approve、approval-reject、approval-affected、check-run、check-evidence。Pi验证三处共享按钮高亮、拒绝无候选、批准后候选/采用、断线/重启/重复点击及四类失败UI。

## M3 最终过关标准

共享组件/全局CSS/越范围修改必须由后端暂停，未批准无公开候选；批准仅针对精确草稿且不重复模型调用；拒绝、取消、重启与并发不绕过。四项检查有真实成功及失败证据，未运行如实标注，失败/未运行采用被拒。原M0–M2回归不倒退、N4排空不回退、无凭据/进程泄漏；实现、Pi验收与Claude Code独立审查全部通过后才收口。未开M4、不自动重跑真实模型十题。

## M3-A 收口（2026-11-14）

M3-A 后端请示已通过实现、独立审查与 Pi 正式验收。上述 A1–A4 已完成；实现/整改/稳定性记录见 M3-A-impl、M3-A-fix-impl、M3-A-stability-impl、M3-A-mock-port-impl，独立审查见 M3-A-review、M3-A-stability-review、M3-A-mock-port-review。所有报告在 docs/reports/。

最终受测 HEAD 为 `40cc46b411fb6f8a648a189a2c1d0d1586e7f9d1`，Pi 归档提交为 `c6c8ffe627ee4e9e361d429950d4f7eca37c975f`。job_9ce21099 exit 0，12m14s：typecheck/build、289 单测及七套 E2E 139/139 实际通过，无 expected-failed/skip/retry/flaky 或顶层 errors。原始证据在 `docs/reports/artifacts/M3-A/run-20261114-m3a-6/`；正式报告 `docs/reports/M3-A-test.md`。归档提交相对受测版本的 apps/packages/templates/锁文件无差异。

每步 HEAD、锁和产品摘要一致；62 份被刷新的旧证据先快照再还原，端口与本轮进程已清理。run1–5 和 checkpoint 的失败/修正链保留。RR1 跨卡故障没有独立 E2E（实现单测与独立审查已覆盖）；历史偶发问题唯一根因未关闭。检查仍为 not_run，本轮为 mock 门槛，不能宣称整个 M3 或项目完成。

按持续授权进入 M3-B，具体任务见 `docs/design/M3-B-plan.md`；CodeBuddy 实现、Claude Code 独立审查、Pi 独立验收，M3-C 随后进行。
