# M3-B 实现交付记录（进行中，尚未验收）

## 接手与第一批边界修正

用户2026-11-14“那你来吧”授权Codex接手M3-B实现；Claude独立审查、Pi独立验收不变。基线为CodeBuddy部分提交 `6e44961b6e145da9aa367e8b4ca8eaffa39c1a13`。原B2草稿和debug-build.mjs保留；主目录 `.data/m3b-codebuddy-handoff-6e44961/` 有六份草稿的逐字节备份/hash与429作业原输出。

已修正候选根/父路径与快照目标junction跟随、证据写入编号/路径边界、真正并发start的保存await窗口、drain后的新准入、损坏持久记录只验证数组，以及11MiB模型被10MiB上限误拒绝。文件读改为单句柄有界读取，快照目标必须为空；复制核对预期摘要、源字节及复制后源/目标。单文件上限32MiB，总量仍50MiB，文件数500；超限显式失败。证据日志有界截断，JSON超限拒绝，列表复用安全读取，删除统一验证runId。

原重启测试曾造出 `Check.status=running`，与共享类型/检查合同不符。现以run.running、build.not_run表达未完成，保留SERVICE_RESTARTED/已通过项/不重跑断言，并断言未完成项有原因。没有新增生产旁路。

## 已实际验证

- RED `job_78e7093e`：35项执行，原27通过、新8失败、0跳过。证据 `.data/m3b-takeover-red-1794655373672/`，identityPreserved=true。
- 第一批修正后 `job_f4561135`：exit0，35/35通过、0失败/跳过。证据 `.data/m3b-takeover-green-1794655848940/`（tests.json、tests.log、evidence.json；含文件SHA256/Git blob、命令、PID、时间、HEAD/status前后），identityPreserved=true。
- 此次是在6e44961加本批未提交文件上验证，不声称在后续提交HEAD上重新跑过。

## 第二批：内容、证据、持久化与中止语义

已加入完整快照摘要预检和工具身份，主版本过期先拒绝；去重包含candidate/base/main/policy/完整摘要。运行器分别记录status/outcome，阶段结果必须匹配阶段名、登记实际证据并核对hash。公开查询只见已经持久化的快照，失败的终态保存使内存绿灯失效、停止新准入，wait/drain返回PERSISTENCE_FAILED。取消与deadline区分，迟到成功/证据不能写回；准备与分段文件读取检查signal。生产executor仍需真实子进程及stop屏障，不把Promise层验证冒充进程回收证明。

- RED `job_76bcb9b4`：44项，原35通过/新增9失败，0跳过，源码身份一致；`.data/m3b-reliability-red-1794656282121/`。
- `job_28b40490`：44/44回归通过、0失败/跳过；随后基础模块定向typecheck仅预算数组推断TS18048，exit2，原生导入未调度；`.data/m3b-reliability-green-1794657083984/`。
- 只补预算数组的readonly tuple类型注解（as const），不改预算/判断。`job_31832add`：基础模块定向typecheck、原生Node导入均exit0；`.data/m3b-foundation-types-native-1794657398639/`。SHA验证撤销注解后等于44项受测源码，其余受测文件字节不变；新运行前后身份一致，没有重复宣称44项在新提交上执行。
- 上述五轮原始实现证据归档于 `docs/reports/artifacts/M3-B/foundation-20261114/`（manifest逐文件SHA256、局部.gitattributes保留原字节）。属于实现阶段证据，不替代Pi独立验收。

### 仍未完成的集成边界

Claude固定B1审查 `M3-B-B1-review.md` 中，完整摘要/证据/持久化/逻辑中止已有上述实现用例，但尚未独立复审关闭；H1与Git commit绑定、H2服务级跨候选唯一运行器、H4真实进程强制中止，以及tasks.json同文件集成、真实构建、浏览器与采用门禁仍待完成。不能称B1/B2或整个M3-B通过。

本批没有运行完整typecheck/build/单测或正式E2E，没有读取真实.env/ASKS，也未启动模型/Lux3D/浏览器/网络服务。正式交付仍需后续完整验证、独立复审及Pi验收。
