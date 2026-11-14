# M3-B 实现交付记录（进行中，尚未验收）

## 接手与第一批边界修正

用户2026-11-14“那你来吧”授权Codex接手M3-B实现；Claude独立审查、Pi独立验收不变。基线为CodeBuddy部分提交 `6e44961b6e145da9aa367e8b4ca8eaffa39c1a13`。原B2草稿和debug-build.mjs保留；主目录 `.data/m3b-codebuddy-handoff-6e44961/` 有六份草稿的逐字节备份/hash与429作业原输出。

已修正候选根/父路径与快照目标junction跟随、证据写入编号/路径边界、真正并发start的保存await窗口、drain后的新准入、损坏持久记录只验证数组，以及11MiB模型被10MiB上限误拒绝。文件读改为单句柄有界读取，快照目标必须为空；复制核对预期摘要、源字节及复制后源/目标。单文件上限32MiB，总量仍50MiB，文件数500；超限显式失败。证据日志有界截断，JSON超限拒绝，列表复用安全读取，删除统一验证runId。

原重启测试曾造出 `Check.status=running`，与共享类型/检查合同不符。现以run.running、build.not_run表达未完成，保留SERVICE_RESTARTED/已通过项/不重跑断言，并断言未完成项有原因。没有新增生产旁路。

## 已实际验证

- RED `job_78e7093e`：35项执行，原27通过、新8失败、0跳过。证据 `.data/m3b-takeover-red-1794655373672/`，identityPreserved=true。
- 第一批修正后 `job_f4561135`：exit0，35/35通过、0失败/跳过。证据 `.data/m3b-takeover-green-1794655848940/`（tests.json、tests.log、evidence.json；含文件SHA256/Git blob、命令、PID、时间、HEAD/status前后），identityPreserved=true。
- 此次是在6e44961加本批未提交文件上验证，不声称在后续提交HEAD上重新跑过。

## 尚未完成

Claude固定B1审查 `M3-B-B1-review.md` 的H1完整内容/commit/工具身份、H2跨候选唯一运行器、H3持久失败恢复、H4强制中止与截止时间，以及任务状态同文件集成、真实受控构建、浏览器检查、采用门禁均未关闭。本轮是边界子集验证，不能称B1/B2或整个M3-B通过。

本批没有运行完整typecheck/build/单测或正式E2E，没有读取真实.env/ASKS，也未启动模型/Lux3D/浏览器/网络服务。正式交付仍需后续完整验证、独立复审及Pi验收。
