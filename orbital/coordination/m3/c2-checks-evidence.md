# C2 — CandidatePanel 真实检查与证据

负责人 CodeBuddy；Codex 调度、Pi 独立测试、Claude Code 独立审查。状态：待 C1 固定提交后派发。先读 `docs/design/M3-C-plan.md`，不得把计划中的示意链接当成现有字段。

## 目标与范围

修改 `apps/studio/src/CandidatePanel.tsx`、`EventCenter.tsx`、`m2-state.ts`、`api.ts`、`style.css`；可新增 Studio 内检查归并、证据引用函数及单测。接入 C1 同步机制，补拉每个 latestCheckRunId 的 GET /checks/:id；处理 check.started/updated/finished 的 run 和可选 candidate。实现报告补 `docs/reports/M3-C-impl.md` C2 节。

按 schema/build/smoke/occlusion 从真实 Check 数组展示；首次检查、显式 rerun、取消及六份证据读取。Check.evidence 是 hash，以 runId 和 artifacts.name 生成受限相对链接。C3 前采用保持保守禁用。

## 禁止修改

后端/共享类型/bridge/模板/锁/依赖与 Pi E2E、既有断言证据均不改；不增加生产测试旁路，不自动检查、自动 rerun 或付费模型调用。不改运行器预算、错误码或身份规则。独立 M3-C worktree 串行实现、不自行合并、不启子 Agent。

## 可执行验收断言

- 无 run 四项均显示“未检查”；queued/running 保留 not_run 项，不能因任务 done/iframe ready/run completed 变 passed；缺项/重复/跨候选结果不可采用。
- 首次点击只发一次 POST /candidates/:id/checks，body={}；running 时运行/重跑 disabled；取消仅发指定 run cancel；终态“重新检查”只在用户点击时发 `{rerun:true}`，立即撤掉旧采用绿灯。
- check.updated 可推进四项状态；finished 后 GET 及 UI 均与后端四项、message、run outcome 一致；重连通过 latestCheckRunId 恢复，而非默认 not_run 或复用本地旧绿灯。
- 依次切换三个候选、同候选显式重跑，迟到的旧 run GET 不改变当前 run 的状态/证据；历史 run 不覆盖 latest。
- check-evidence 链接为 `/checks/<编码id>/artifacts/<固定安全名>`，不可等于 hash 或任意返回文本；四主证据 hash 对应 artifacts，展示 bytes/hash，六份必需产物 GET 成功可阅。
- 文本/JSON 按文本，PNG 按图片；恶意日志不执行，未知 MIME/HTML/SVG 不嵌入执行。404/读取失败有错误且关闭采用；切换和卸载清理 fetch/object URL。

## Pi 用例清单

real UI：mock Agent 产生安全候选后点击真实四检查，观察 queued/running/完成及六证据可读；真实构建错误、页面运行错误、遮挡各失败 UI；取消、重启、断线期间完成恢复；三候选和 run 切换。复用 M3-B 真实后端故障证据作为比对，新增 UI 证据独立存档。

mock 边界：schema failed（公共候选路径会先被工具/clean 守卫拦截）；缺浏览器/预算/持久化错误呈现；证据缺失/404/hash 不符；未知或重复 Check、缺 run、跨候选 run；迟到详情/断线响应。schema 后端能力由现有 server 测试支撑，不能直改候选再期待 schema failed，不改断言以掩盖 STALE_CANDIDATE。

## Claude Code 复核风险

把 completed 当 passed、把 hash 当 URL；未知状态静默绿灯；同候选多轮串证据；GET 非原子组合；路径/链接注入及日志执行；取消误操作另一 run；不必要的证据请求与内存泄漏；重连缺 run 时错误继承绿灯。

## 交付

实现单测覆盖状态/证据映射/迟到结果，适用验证结果与原件路径写报告，保留失败记录。长验证根 `orbital\bin\bg.cmd` 首次沙箱外启动，取得 job 立即结束、不等不轮询。固定提交后交 C3，不宣称正式 M3-C 通过。
