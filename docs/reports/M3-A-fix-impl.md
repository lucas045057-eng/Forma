# M3-A 首轮审查整改实现报告

本轮只整改独立审查的 B1、R1、R2。分支 `feat/m3a-approvals`，工作目录 `.worktrees/m3a`；没有改主工作树、Pi 正式测试、旧 worktree 或独立审查报告。模型全部 mock，未读取真实 .env 或调用真实模型/Lux3D。实现方定向测试通过不代表独立复审通过，M3 整体仍未过关。

## 提交与范围

- `ff6fe99b1aebd104e3040d9e4505710e2381ad9a`：B1，真实模板叶子资源与查询引用解析。
- `b82efad5431aca32f8bbfa3351a36155b3ba595a`：R1/R2，预览失败隔离、可恢复清理意图与过期终态；共享类型新增 approving/failed。
- 本报告及原报告补充说明在后续冻结文档提交。最终全仓验证以启动时记录的 HEAD 为准。

## B1：真实模板局部改动被资源引用误拦截

触发：真实 main.tsx 导入 CSS，scene-config-store.ts 导入 JSON?raw；旧策略只解析源码模块，导致任何源码修改均携带 analysis_uncertain。

修复：本地引用去除查询/hash 后缀后解析；TS/JS 继续参与组件绑定和共享计数，其余真实存在的本地文件作为叶子资源检查。基线集合从真实 Git 基线树读取，草稿集合从磁盘独立读取，不用草稿新建文件冒充基线存在。源码根及子路径链接、越界路径、真正缺失文件仍保守拦截。两侧错误独立，保留另一侧已知共享证据。

回归：逐文件复制真实模板 src（不复制二进制资产或环境文件），验证 App h1 局部改动不请示、instances=1 的 Button 共享、源码 query 不吞计数、CSS/JSON 删除、缺失及 src 外引用、仅草稿资源不冒充基线；原别名/barrel、基线失败与坏语法断言保留。

## R1：预览失败堵塞所有卡片与重启

触发：旧 approve 意图在 commit 后遇到 preview.start Error/AbortError，无法结束；其他回答和 init 会反复重放同一失败。

修复及对外合同：

- 回答批准先保存 `approving` 与 approve 意图；此时任务仍 awaiting_approval，没有公开 Candidate，不显示 approved。
- 仅在预览启动及其取消检查周围捕获故障。commit、摘要/路径审计、写盘与清理错误不被转换成预览成功或吞掉。
- 预览故障转为持久 `preview_failed` 清理意图，先保存，再停止本任务预览、删除本任务 staging，最后保存卡片 `failed`、任务 `failed / PREVIEW_FAILED`，清除意图并广播。
- 正常处理完故障时 POST 返回 200 和规范卡片/任务失败状态；不会发 candidate.ready，不返回底层诊断或绝对路径，不再调用模型。
- 同答批准返回既有 failed 结果，不重启预览；相反回答仍 409 APPROVAL_ALREADY_ANSWERED。另一张卡可正常回答。正常关闭后重启不重放已终结失败。
- M3-C 应把 failed/PREVIEW_FAILED 显示为“候选预览启动失败，本次草稿已丢弃，请重新提交任务”，不能当成已发布候选。

失败窗口：清理决策保存失败时不清理、不广播成功；同进程重试会再次保存意图。清理失败保留已持久意图；终态保存失败会恢复内存卡/任务与意图，磁盘仍保留清理意图，即使 staging 已删除，重启也只继续幂等清理，不重新启动预览。若清理意图本身尚未成功持久化即崩溃，磁盘只能恢复先前 approve 意图；不能声称该窗口已记录预览故障。

正常发布的最后状态保存失败时，回滚内存 Candidate/卡/任务，停止当前预览，保留 approve 意图；恢复仍验证摘要并复用已有提交，不重复模型请求。既有 commit-before-state 恢复测试保留。

## R2：过期卡仍 pending 且占用额度

触发：回答时主版本或草稿摘要变化，旧实现只返回 409，卡和任务不变。

修复：在同一作品互斥作用域中保存 `stale` 清理意图，再清理当前 staging，保存卡片 stale、任务 failed/STALE_APPROVAL 并广播 approval.resolved 与 task.updated，最后返回 409 STALE_APPROVAL。pending 数量下降，新风险任务可申请；后续批准或拒绝该卡都稳定返回 409 STALE_APPROVAL。

M3-C/Pi 应以 GET 卡片 stale 与关联任务错误展示“草稿或主作品版本已变化，不能继续批准”，禁用继续回答。清理或写盘尚未完成时请求报错、不提前广播终态；GET 可能仍显示旧 pending/awaiting 状态，但回答入口优先恢复意图，不允许据此绕过检查。保存失败不先删除恢复依据；清理失败及终态保存失败保留意图供重试/重启。若持久化故障持续存在，可阻止操作或启动，不能为了可用性丢弃安全证据。

## 关闭与权限保持

沿用 answerApproval 的同步 inFlight 准入与 repo.exclusive；已接受操作排空后才停止预览、等待写入、关闭事件日志、释放锁。保留真实 HTTP Connection:close、第二实例拒绝、重启 seq 接续和无晚写断言。硬文件权限、Host/Origin、分源预览、摘要绑定不放宽；等待批准仍不公开 staging，不占 taskQueue。

## 实际红绿证据

| 作业 | 命令/范围 | 实际结果 |
| --- | --- | --- |
| job_48fd1454 | `pnpm --filter @spatial/server exec vitest run src/approvals/policy.test.ts` | B1 红灯：18 项中 15 过、3 失败，均为真实模板资源误报 |
| job_a0b91881 | server typecheck → 同上 policy 定向命令 | exit 0，tsc 与 19/19 通过；随后提交 ff6fe99 |
| job_71c3753e | `pnpm --filter @spatial/server exec vitest run src/work/approvals.test.ts` | R1/R2 红灯：既有 12 过，新增 5 失败 |
| job_912db73a | shared typecheck → server typecheck → `pnpm --filter @spatial/server exec vitest run src/work/approvals.test.ts src/approvals/routes.test.ts src/events-lock.test.ts` | exit 0；两次 tsc 通过，审批 20 + 路由 1 + events-lock 9 = 30/30，无跳过/预期失败；随后提交 b82efad |

结果由调度核验已结束 job 的 exit 文件及完整日志；本轮未重复安装或上述已完成验证。B1 与 R1/R2 在不同阶段验证，不拼接为最终提交全量通过。

### 最终全量验证

待后台结果。冻结报告提交后使用已有 `node apps/server/scripts/m3a-full-validation.mjs`，依次七包 typecheck → 七包 build → 六测试包完整单测一次，首败即停。入口记录 HEAD、锁 SHA256、每步命令/日志/PID/exit/signal、结束 HEAD 和工作树状态；证据目录为本 worktree `.data/m3a-validation-<启动时间>/`，准确目录由日志打印。全量未返回前不预写测试数量或成功。

原 7fad918 的 job_049bdc52 已由调度核验通过：20 步、261 单测，HEAD/锁/工作树不变；这是整改前基线，不证明本轮修复。原件 `.data/m3a-validation-1794636746586/` 不改写，核验报告见主工作树 [M3-A-validation.md](E:/空间化AI工作台/docs/reports/M3-A-validation.md)（主线文件，当前 worktree 不复制或修改）。

## S1–S6 分流

| 建议 | 本轮处理 |
| --- | --- |
| S1 预览期间持全局作品锁/晚注册 controller | 保留。R1 解决可归属预览故障的终态；未重构锁作用域，预览启动期间其他作品操作仍排队，晚登记 controller 可能延长关闭等待。N4 排空合同不变。 |
| S2 卡片 diff 展示 | 留 M3-C，不做 UI 或额外详情 diff。 |
| S3 启动逐卡字段校验 | 保留。当前仍只有既有数组/等待任务关联检查，未宣称完整记录 schema 校验；损坏字段校验需后续加固。 |
| S4 finalize 私有化及重复分支 | 保留。未扩大当前失败路径整改到方法可见性重构；仍应通过 answerApproval 作为外部入口。 |
| S5 整树保守分析/动态实例 | 保留限制。无关动态 import/require 仍可能使全任务保守请示；map 中单 JSX 的运行时多实例不能完全静态计数，instances 只辅助实际修改的选中文件，范围规则仍兜底。 |
| S6 JSON 数值说明 | 文档澄清：option 必须为 JSON number，数值等于 0 或 1；字符串、0.5、2、null 拒绝，0.0、1e0、-0 经 JSON 解析后的等值形式接受，不引入字面解析器。 |

## Pi 接点与清理

Pi 可按两卡 A/B 场景验证：A 预览失败后 failed/PREVIEW_FAILED、无候选、同答不重启；B 可拒绝/批准；重启不重放 A。主版本/草稿变动后检查 409、GET stale、任务 failed、pending 名额下降，以及重复两种答案稳定 409。故障注入仅属于实现单测，不增加生产控制端点。

未启动常驻服务；本轮定向测试使用 mock Agent 和临时 loopback HTTP，由测试 finally 关闭，job_912db73a 已由调度确认退出。最终全量启动 PID 与 job 在交回消息记录，结束后的身份/残留核对待结果；不按端口盲杀其他会话。未运行正式 E2E、真实模型或 Lux3D，M3-B 检查与 M3-C 界面未做。独立复审和 Pi 正式验收由调度安排。
