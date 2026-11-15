# M4 父进程死亡诊断与测试前提修正

## 已确认的原因

受测成品基线为 `97bd68652108b808b8f5de9117ceefd8a8c888f9`。上一完整轮 `job_6cce1181` 的类型检查、构建和 614 项单测通过；脚本安全套件 9/10，失败是原 orphan 用例要求被杀父层的 stderr 必须包含 `DEMO_ORPHAN_TIMEOUT`。后续后代退出和 cleanup 归属断言尚未执行，不能据此判定回收失败或成功。

唯一隔离诊断 `job_6562acc2` exit 0，表示四组观测完成。原件已归档在 `artifacts/M4/orphan-focused-diagnosis-20261115/`，其中 160 个载荷已由调度复算匹配、清单排除自身；raw 原件 150 个载荷保持不变。本次不重新诊断、不重新复制归档。

| 对照 | 实际证据 | 含义 |
| --- | --- | --- |
| kill / hung 与 kill / complete | 原进程链在 fallback 前退出；无关进程存活；orphan 无 disconnect、close、超时 marker，本地 stderr 也为空 | 此 Node/宿主/调用路径没有留下执行 watchdog 的 orphan，硬杀测试不具备强求超时日志的前提 |
| disconnect / hung | close 被调用但未完成；父捕获与 orphan 本地 stderr 均含 marker；runtime cleanup 回收四个 worker，errors/remaining 为空 | 明确 IPC 断开且关闭挂起时，watchdog 实际触发并回收已确认归属的后代 |
| disconnect / complete | close 调用且完成；无 marker、无 forced cleanup；原链退出、无关进程存活 | 可完成关闭应作为无强制回收的对照 |

旧测试混用了硬杀原父层和仍能执行 watchdog 的前提，且只通过被杀父层的 stderr 收集下一层日志。证据未证明 `unref()` 或生产 runtime 有缺陷，因此不改生产 runtime、launch、unref 或生产关闭预算。结论不推广到所有 Windows 杀进程方式，也不代表生产模型处理、预览与检查的完整孙进程链已经验证。

## 本次测试修改

仅修改 `scripts/demo/body.test.mjs`，增加两个测试专用 helper：`scripts/demo/test-support/orphan-case.mjs` 与 `orphan-role.mjs`。

1. 硬杀父进程：保留原 parent → orphan → 四 worker 拓扑，验证全部原身份退出及无关进程存活，独立保存 orphan 文件日志；不强求未观测到的 watchdog marker。
2. 明确 IPC disconnect + 挂起 close：直接持有实际运行 watchdog 的 orphan 子句柄，要求非零退出、marker、disconnect/close-called 事件、无 close-completed、forced cleanup，以及四 worker 的 PID/创建时间归属。runtime errors/remaining 必须为空，所有已发现后代退出。
3. 正常 close：通过 shutdown 消息完成关闭，要求零退出、close-completed、forced=false、无超时 marker、无强制 cleanup。

三分支均等待四 role 实际 ready，再以 CIM 核对 PID、PPID 和创建时间；按真实父子关系递归发现辅助后代，不假设总数恰好四个。必需 role 还核对入口命令和直接父级。动作后检查全部发现后代原身份消失、无关进程原身份仍存活。清理仅操作核验身份的自有进程，fallbackKills 与动作前自主退出证据分开；无关测试进程只在 finally 主动结束，不作为回收成功证据。

主错误、finally 清理错误和证据写入错误聚合；任一失败保留临时现场并输出定位信息。角色各自独立写事件及日志，运行 watchdog 的层级不再依赖已杀父层的 stderr。每个分支将报告、输出和事件复制到本轮 `M4_SCRIPT_RUN_DIR/orphan/<kind>/`。

## 静态核对与待运行确认

本批已阅读并核对三个分支、四 role ready、全部发现后代、PID/创建时间、无关进程保护及错误聚合。原有安全、网络守卫、隔离准备、端口传递、正常停止测试继续由 `safety.test.mjs` 导入全部 body 执行。没有通过删除 marker 断言规避失败，而是将其放在明确触发 watchdog 的分支。

生产 runtime、依赖锁、模板、Pi 独立套件及历史原件未改；fallback 不入库。本批未启动类型检查、构建、614 单测、193 E2E 或完整回归，不读真实凭据或环境配置、不调用真实服务、不合并或推送。

固定提交后，仅经根 `bg-root.cmd` 启动一次 `node --test scripts/demo/safety.test.mjs` 全脚本针对性确认。新 run 保存固定 HEAD、实际字节哈希、命令、PID/创建时间、开始结束与退出信息、stdout/stderr、各分支事件及清理。实际用例数和结果由该作业给出；当前不预填通过数。取得 job 后立即交回，不轮询、不启动第二监视或自动试改。完整回归由 Codex 根据结果决定。

Claude 独立复审仍缺正式报告；193 E2E 尚未执行；真实 Windows 控制台 Ctrl+C、生产 worker 完整处理链、真实服务、真人 A/B 和完整彩排不以本次测试抵扣。M4 尚未验收。
