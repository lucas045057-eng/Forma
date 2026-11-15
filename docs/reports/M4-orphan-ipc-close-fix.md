# M4 测试 IPC 关闭方向修正

## 已确认的原因与范围

固定起点 `eb00eec17902bdbcea804724e9c30b52efee7a3c`。脚本针对性确认 `job_2f05614c` exit 1 / 44s，12 项中 11 过、1 败，changed=[]。失败 orphan 已运行 watchdog、记录非零退出并回收四个 worker；真正阻断是测试父侧等待原生 ChildProcess.close 超时，不能将其写成 watchdog 没有触发。

唯一句柄对照诊断 `job_7ee86124` exit 0 / 47s，冻结源码 changed=[]。该 exit 0 表示观测和清理完成，不代表脚本用例通过。三个控制结果如下：

| 控制 | 进程及公开资源事件 | 只读计数观测 |
| --- | --- | --- |
| spawn + pipe | exit 1，IPC disconnected/channel absent，stdout/stderr 已 end/close/destroy，但无 ChildProcess.close | needed=4 / got=3 |
| fork + pipe | 同上 | 4 / 3 |
| spawn + file | exit 1、IPC 断开、无 ChildProcess.close | 2 / 1 |

三组全部 remaining=[]，无关进程存活。仅换 fork 或输出目标不能修正此路径。当前 Node v24.14.1 内置源码原件显示：IPC 增加关闭计数；IPC EOF 路径会调用 maybeClose；父侧主动 target._disconnect 的 finish 只关闭 channel 并 emit disconnect，没有对应 maybeClose。结合三组均缺一次计数，已定位当前版本父侧主动断开路径。结论限定于本机版本和该调用路径，不泛称所有 Node 或所有 Windows 场景都有同样问题；私有计数仅为诊断证据，测试与生产不依赖它。

## 原字节归档

新增 `docs/reports/artifacts/M4/orphan-ipc-close-20261116/`：

- `handle-diagnosis/` 完整保存前次归档、旧失败 run 与 launcher、诊断说明及入口，以及 probe-2026-11-15T16-42-49.593Z（含 Node 内置源码、三组原生事件、PID/创建时间、角色事件、cleanup 和原清单）。probe 原清单的 81 个载荷已由调度核验匹配、无自引用。
- `probe-launcher/` 保存 job_7ee86124 原始启动与退出记录。
- `archive-verification.json` 记录本次复制的 182 个原始载荷。复制前后源 SHA256 和目标 SHA256 全部一致，0 mismatch；原始目录和既有历史归档未修改、未删除。
- 本目录 .gitattributes 禁止 Git 换行转换，外层 SHA 清单排除自身，嵌套历史清单保留原字节。

## 最小测试修改

只改 `scripts/demo/body.test.mjs` 标题与两个测试 helper，不改生产 runtime、launch、unref、关闭预算、依赖锁、模板或 Pi 独立套件。

原 driver 的 `main.child.disconnect()` 改为向已完成真实 ready 和身份核对的 orphan 发送本地 fixture 专用 IPC 消息 `fixture-orphan-disconnect`。仅测试角色支持该消息，且仅 hung 模式执行：先记录消息接收，再记录主动断开调用，随后执行 `process.disconnect()`。父侧接收 IPC EOF，仍等待真正的原生 ChildProcess.close；不修改内部计数、不 emit 假 close、不改为 exit 就算闭合、不吞未关闭或流错误。

hung 分支要求事件顺序为：专用消息 → 角色主动 disconnect → 原生 disconnect → close-called(hung) → exit 1；close-completed 仍不得出现。仍要求 marker、非零退出、runtimeCleanup 的 parentPid 及四 worker 的 PID/创建时间归属、forced=true、errors=[]、remaining=[]，并核实全部已发现后代原身份退出、无关进程仍存活。

标题明确这是“fixture 角色主动断开”的控制路径，不声称父进程真实死亡。原 hard-kill 分支独立覆盖实际杀父进程后的原链退出；normal-close 分支继续要求完成关闭且无强制回收。仍为完整 12 项脚本范围，不增加 skip/retry，不删除旧安全或业务断言。

helper 新增原生 spawn/exit/close/disconnect/error，以及 stdout/stderr end/close/error 记录，每个事件保留公开进程和流状态。闭合后还要求看到真实 exit 和两条流 close，流错误进入失败聚合。每组保存 main/unrelated.native-events.json。原主错误、finally 清理错误与写证据错误聚合、失败保留现场及 fallbackKills 区分机制保留；20 秒动作预算与 5 秒清理等待不变。

## 验证状态与交回

本批仅静态阅读、差异和语法核对，不重跑句柄诊断。固定整批提交并确认 tracked 工作树干净后，仅经根 bg-root.cmd 启动一次 `node --test scripts/demo/safety.test.mjs`（含全部 body），使用白名单环境和本机替身。新 run 保存固定 HEAD、源码/脚本/锁等实际字节身份前后对照、命令、PID/创建时间、退出及原生关闭事件、stdout/stderr、各角色和清理原件。

取得 job 后立即回执冻结，不轮询、不加监视，不失败自动改试；当前不预填 12 项通过，不宣称修复已验证。typecheck/build/614 单测/193 E2E/full 均不启动。历史 614 全过与 193 E2E 未执行的状态不被本次针对性确认抵扣。

独立 Claude 复审仍欠正式报告；真实 Windows 控制台 Ctrl+C、生产完整 worker 处理链、真实服务、真人 A/B 和彩排均按原边界保留。无真实凭据读取或付费调用，不合并、不推送，M4 尚未验收。
