# M3-C 实现报告

## C1 — ApprovalPanel 与事件持久补拉

状态：实现已提交，首次后台自测待执行/核对；不是 C1 测试通过，也不是 M3-C 正式验收通过。

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

计划由根 `orbital/bin/bg.cmd` 单次后台启动（拿到 job 立即结束回合，冻结受测文件）：

```text
cd /d .worktrees\m3c && set CI=true&& call pnpm install --offline --frozen-lockfile && call pnpm --filter @spatial/studio test && call pnpm typecheck && call pnpm build
```

新 worktree 没有 node_modules，因此先离线、冻结锁安装；失败属于入口准备问题，未运行的后续检查不记为通过。自测结果待后台完成后如实补录。

新增单测覆盖：请示排序、按 id 归并、终态防回滚、损坏 payload 拒绝、同基线/关联任务/同步门禁、定位降级、模式恢复策略、历史与缓冲乱序去重和缺号拒收；静态 React 渲染检查文本转义、实体 testid、终态/不同步真实 disabled、C1 采用固定 disabled。没有运行 Pi 正式验收套件。

### 未覆盖与 Pi 接点

- 待 Pi real UI：三按钮 overlay=3、真实 HTTP 数字回答与双击/键盘单次 POST、批准前无候选/批准不增加模型请求、拒绝与任务取消、合法服务重启、断线恢复、单 WS、3D 场景编辑与 M2 选择/分源衔接。
- 待 Pi 受控 mock：旧 GET/旧 socket 晚到、回答响应丢失、快照失败/截断/缓冲溢出、409 终态竞态、未知 payload。纯函数/静态渲染测试不冒充这些集成证据。
- 现有 bridge 无精确 DOM 回执，草稿与当前基线坐标可能不同，仍需 Pi 在当前 iframe 内独立核查 overlay。仅展示“查看源码对应位置”，不保证任意源码均能命中 DOM。
- 保留冻结 testid：approval-panel/card/approve/reject/affected/status/error/highlight-exit、state-refresh；卡容器含 data-approval-id/data-task-id/data-status；原 preview-frame/candidate-frame、events-status/seq、pick-toggle 保留。
- C2/C3 尚未实现。独立测试与 Claude Code 独立审查尚未进行。

### 需调度批准

目前无后端/协议变更请求。所有实现仅使用现有 HTTP/事件/bridge 合同。
