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
- C3 共同门禁尚未实现，采用与回退始终 disabled。尚未完成 Pi 独立测试、Claude Code 独立审查和 M3-C 全量验收；本卡不宣称这些结果。

### 需批准

无后端/协议变更请求；未修改 apps/server、packages、templates、依赖清单、锁、Pi E2E 或历史证据，未读取真实 .env、访问 staging 或调用付费模型。
