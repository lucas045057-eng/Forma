# C1 — ApprovalPanel 与事件持久补拉

负责人 CodeBuddy；设计调度 Codex、独立测试 Pi、独立审查 Claude Code。状态：待派发。前置 master `3a886f1`；先读 `docs/design/M3-C-plan.md` 全文，以其中冻结合同为准。建议第一张实现卡。

## 目标与范围

创建 `apps/studio/src/ApprovalPanel.tsx`；修改 `App.tsx`、`EventCenter.tsx`、`m2-state.ts`、必要的 `PointSpeak.tsx`、`style.css`；可新增 Studio 内 approvals 状态/坐标选择纯函数及单测。EventCenter 为 C2 预留按 runId 接入状态的位置，不另建 WS。实现报告 `docs/reports/M3-C-impl.md` 的 C1 节。

实现持久卡片、真实数字回答、独立影响查看模式及跨源 bridge 使用；补拉引入同步就绪、连接/请求代次和事件缓冲，沿用其它面板订阅。首连/每次重连/截断重载均从 REST 恢复 approvals/tasks/candidates/version，按全局 seq 重放并去重。禁止旧响应回滚终态。

## 禁止修改

不改后端/共享协议/bridge/模板/依赖/锁、Pi E2E 与历史报告证据；不访问私有 staging，不读真实 .env，不调用付费模型。批准不代替采用。只在调度确认的独立 M3-C worktree 实现，不自行合并，不开子 Agent。C1 中采用先保持禁用，不能暂时开放无检查入口。

## 可执行验收断言

- 持久 pending 卡在刷新、断线恢复、合法服务重启后仍仅一张同 id 卡；approval.requested/resolved 重复 seq 不增卡、不回滚状态；未知 payload 不崩溃、不赋予可操作权限。
- 批准/拒绝实际 body 分别深等于 `{option:0}` / `{option:1}`；同一卡连点与键盘提交只发一次 POST，另一回答同步 disabled；不自动重发。approved/rejected/stale 等终态回答按钮 disabled。
- 在批准响应前后分别断线，重连按服务器持久状态显示；POST 成功但刷新失败显示“操作已提交，状态刷新失败”；不得把它当失败再次发 POST。
- mock Agent 生成共享 Button 草稿：批准前 UI 卡存在且公开 candidates=[]；拒绝后仍无候选；批准后仅一次 candidate.ready，mock 请求计数不增加。
- 同基线从已选共享 Button 打开“查看影响位置”，当前 iframe 内同源码 overlay=3，候选 iframe 无选取；退出清理 overlay 并恢复先前合法模式。影响模式点击不替换 Selection，不触发 PointSpeak 提交。
- 文件级影响、CSS、坐标不适用时显示明确限制；不把文件名发作 highlight.src。version.changed 后退出影响模式、关旧卡门禁。
- WS 只有一个活动事件连接；截断/seq 倒退/缓冲溢出重新同步；快照中产生的新事件不会丢失，旧代次 GET/WS 回调不得覆盖新卡；关键 GET 失败 syncReady=false 且显示刷新入口。

## Pi 用例清单

real UI：共享三按钮高亮；pending→批准→候选（不自动检查/采用）；拒绝无候选；取消待请示；重启待卡；断线期间完成回答后恢复；双击；保持 M2 选取、单 WS 与候选分源。模型仅 loopback mock。

mock 边界：旧响应晚到、乱序/重复/截断历史、POST 响应丢失、快照失败、APPROVAL_ALREADY_ANSWERED/NOT_PENDING/STALE_APPROVAL、文件级定位降级、恶意 reason/evidence 文本。逐项标出 mock，不冒充真实后端故障。

## Claude Code 复核风险

快照非原子与游标跳跃；迟到响应/终态回滚；回答与取消竞态；模式恢复是否破坏 Selection；source/origin 校验；候选 iframe 是否获取选取能力；文字 XSS 与私有草稿泄漏；资产/场景原订阅是否受损。

## 交付与后续

Studio 纯函数单测覆盖新排序/归并/模式策略，实际跑适用检查；报告 commit、测试/未覆盖项和 Pi 接点。所有可能长跑验证用根 `orbital\bin\bg.cmd` 首次沙箱外启动，拿 job 即结束回合、不轮询。固定提交交调度，随后 C2；本卡通过不等于 M3-C 验收通过。
