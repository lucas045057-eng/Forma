# M3-A 集成测试预算与并发修正

本次只修正测试运行配置及三处测试定义（四个用例）的预算。标准 `pnpm typecheck`、`pnpm build`、`pnpm test` 全部通过；M3-A 仍须 Claude Code 独立审查、合并后 Pi 完整验收。本轮没有运行 E2E。

## 问题与证据

Pi 在冻结 a947f9f 的首次验收中，server 176/179 通过、三项超过默认 5000ms，Studio 与七套 E2E 未运行；失败原件保留在 `artifacts/M3-A/run-20261114-m3a-1/`。此前 012d9a6 实现全量虽通过，但四候选用例已耗时 4961ms，余量不足。

Codex 在同一隔离基线 012d9a65b4242cad2407a40c34614b2d162c8032 做了以下对照，未改产品代码或锁文件：

| 作业 | 范围与结果 | 能说明什么 |
|---|---|---|
| job_0b429d93 | server 完整 179 项，1–2 worker、原 5 秒预算；178 通过、四候选 5005ms 超时 | 只降低并发不足以容纳这些流程 |
| job_4c23f8cf | 诊断性筛选三项、外层预算 15 秒；3 通过、176 筛选跳过；4353/5082/5691ms | 原有断言可完成，完整工作流确实可能超过 5 秒；不能计为全量通过 |
| job_9123ecc1 | 本次改动后标准 typecheck → build → test；三步 exit 0、signal null、身份一致 | 当前修改通过一次标准全量验证 |

原阶段探针把主要耗时定位到四次串行真实 Git 工作流，队列/关闭本身未见挂起；先前复用基线清单只减少约 146ms。以上不能确定每次历史超时的唯一原因，也不能证明产品性能已被改善。

## 最终改动

- 新增 `apps/server/vitest.config.ts`：`minWorkers: 1`、`maxWorkers: 2`，限制真实 Git 集成套件同时争用磁盘/CPU；不设置全局 testTimeout。
- 四候选淘汰/清理、三审批卡上限、多卡 stale 后释放名额的三处定义，显式预算 `15_000`。最后一处参数化为 draft/main，共四个用例，每项都有四次完整真实 Git 任务。
- 普通用例仍默认 5000ms；断言、四任务数量、fixture、重试和跳过均未改。产品源码、业务请求/模型/预览超时、依赖和锁文件不变。

代价：这四项挂起时最多晚 10 秒报告失败；较低并发可能拉长整套运行时间。15 秒是这些集成流程的有界测试预算，不是产品延迟目标，不保证其他硬件下永不超时。

## 标准全量结果

job_9123ecc1 在 012d9a6 加三个已知修改路径上验证，未提交状态由每步 HEAD、diff、文件 SHA256、锁摘要绑定。类型检查约 5.4s、构建约 7.2s、完整单测约 93.5s，三步前后文件身份一致。提交后审查须核对这三个路径与证据；不能把它描述成提交前已在新提交号上运行。

单测 280/280：shared 68、plugin 20、bridge 1、scene-renderer 5、server 179、Studio 7；无筛选、失败或跳过。server 30 个文件全部通过。四项实际耗时：三卡上限 4435ms、stale draft 4763ms、stale main 5281ms、四候选清理 5710ms，证明新预算在本轮实际被使用。

证据根：`artifacts/M3-A/stability-20261114/`，含 `controlled-original-budget/`、`completion-diagnostic/`、`standard-validation/`、固定验证入口及 SHA256 清单；原始 `.data` 与历史失败目录不覆盖。`standard-validation/job-output.log` 是 job_9123ecc1 的原输出。

未读取真实 `.env`，子进程显式 fake key 与 loopback 配置，未调用真实模型/Lux3D，未改 Pi E2E 接线或旧 worktree。M3-A 独立验收、M3-B/C 与 M4 仍待后续推进。
