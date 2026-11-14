# C3 — 按钮门禁与失败态 UI

负责人 CodeBuddy；Codex 调度集成、Pi 独立验收、Claude Code 独立审查。状态：待 C1/C2 固定提交。合同 `docs/design/M3-C-plan.md` §5；这是阶段最后一张实现卡，不授权本轮设计者写实现。

## 目标与范围

修改 `apps/studio/src/CandidatePanel.tsx`、`ApprovalPanel.tsx`、`App.tsx`、`PointSpeak.tsx`、`api.ts` 及状态/CSS；新增 Studio 门禁纯函数及单测。汇合 C1/C2 同步与证据就绪状态，落实所有按钮 disabled、禁用原因、错误恢复与作品决策互斥。完成 `docs/reports/M3-C-impl.md`。

## 禁止修改

不改 apps/server、packages、templates、锁/依赖、检查预算、公共 API 与 Pi 的断言/证据；不解除后端门禁，不新增 bypass/强制采用，不新增真实付费调用。不以旧阶段成绩替代新 UI 验收。不自行合并、不派子 Agent、不动旧 worktree/fallback/orbital 运行状态。

## 可执行验收断言

- 门禁参数表至少覆盖：未同步/断线、pending/关闭候选、无 commit、基线不同、无 latestRun、跨候选/commit/run、queued/running/cancelled、completed 非 passed、任意 failed/not_run、缺项/重复项、hash 不符、缺必需证据/不可读。每组 candidate-adopt.disabled=true，且点击/键盘产生 adopt POST 次数=0。
- 唯一正向可用组满足设计 §5 全部前提；真实四检完成+六证据可读后 enabled，采用成功切 current 并刷新版本/候选；批准完成但未检查时仍 disabled。
- 运行/重跑/取消/采用/撤回/回退/回答均同步获取对应实体锁；快速连点不重复 POST。撤回运行中候选仍可用，完成后不接受晚到 run 重新开放该候选。
- adopt 收到 409 CHECKS_NOT_PASSED 立即关绿灯、显示“检查未通过或证明已失效”，只刷新不自动再采用；startChecks 的 STALE_CANDIDATE 提示重新生成候选；不能期待 adopt 返回 STALE_CANDIDATE 或公共 MERGE_CONFLICT。
- STALE_APPROVAL/已回答/非 pending 禁旧回答；NO_ADOPTION 明示暂无可回退记录；网络结果未知先读取权威状态，刷新失败不误报已提交操作失败。所有错误可读、文字安全、无无限 spinner。
- M1 场景写回或回退导致 version.changed，旧基线采用立即 disabled；M2 重新点选等待版本时不能用旧 Selection 生成任务；分源预览、对比、滚动、diff、单 WS 保持。

## Pi 独立用例与交付

real UI：完整“选共享按钮→mock 修改→请示三处高亮→批准→候选→真实检查→六证据→采用→回退”；另测拒绝无候选、真实构建/运行/遮挡失败、未检查门禁、断线/重启恢复、双击、撤回检查中候选、M1 写回旧候选失效、三候选切换。

mock 边界：schema failed、缺失/篡改证据、CHECKS_NOT_PASSED/STALE_CANDIDATE 两路径、缺 run/不一致组合、POST 响应丢失/刷新失败、损坏 payload。逐例标 real 或 mock，不把 mock 当运行器真实失败；公共不可达场景不能靠改后端/改断言造绿。

Pi 新建 tests/e2e/m3c 与配置、独立报告 `docs/reports/M3-C-test.md` 和 `artifacts/M3-C/`，保留失败轮次与 hash。CodeBuddy 不改 Pi 用例。实现者先交固定 HEAD 和 typecheck/build/全量单测结果；Claude 独立审查整改通过后调度集成冻结，再由 Pi 在相同产品身份上完整跑原八套146例+新 UI 套件（新增条数先 --list 固定），每例一条 passed result、retry/skip/flaky/expected-failed/errors 均0。测试期间不改被测文件；证据归档先保留后还原，原件不得删除。清理只限本轮进程/端口。

## Claude Code 复核重点

门禁真值表完整性；前端不能验证字节导致的 TOCTOU 是否仍交后端裁决；HTTP 成功后刷新失败的误导；全局作品决策与实体锁；旧证明复用/缺证据开启采用；错误码路径准确；M1/M2 回归、跨源隔离、日志文本安全、无新付费或后端合同变更。

审查报告 `docs/reports/M3-C-review.md` 列 blocker/应修/建议及实际检查范围，0 blocker/0应修与 Pi 正式通过后才能收口。所有长命令从根 `orbital\bin\bg.cmd` 首次即沙箱外启动，拿 job 结束回合、不睡眠不轮询；失败按原件定位整改，不能无理由重跑到绿。
