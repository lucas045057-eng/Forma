# M4 disconnect-hung：父侧 close 未完成的证据与诊断准备

固定源码 `eb00eec17902bdbcea804724e9c30b52efee7a3c` 保持不变。本次不修 runtime、不改测试断言或预算、不重试脚本套件及全仓。

## 失败原件已保全

`job_2f05614c` exit 1 / 44s；脚本 12 项中 11 过、1 败；run 的 changed=[]。仅 disconnect-hung 失败。

源 `.data/orphan-safety-confirm-2026-11-15T16-34-53.564Z/` 与根 `orbital/jobs/job_2f05614c/` 完整复制至本目录 failed-run/ 与 launcher/。archive-verification.json 记录 91 个原始载荷的逐文件 SHA256 与大小，复制前后源哈希及目标哈希一致；空目录随目录复制保留，原始现场不删除、不重写。

归档工具的 Node 同步复制入口两次发生原生退出，其中一次明确退出码 -1073740791，未得到可用 JS 异常；未以此推断测试根因。改用 PowerShell 文件复制与逐文件哈希，91 载荷 0 mismatch。没有因工具异常启动或重试被测分支。

## 运行事实分开记录

- orphan PID 15312 的独立事件显示：16:35:04.941 IPC disconnect，04.942 调用挂起 close，07.189 exit code 1。
- main.captured.stderr.log 实际含 DEMO_ORPHAN_TIMEOUT。
- orphan-cleanup-15312.json 为 forced=true，列四个 worker，errors=[]、remaining=[]。
- 父测试的 main.closed 等待 20 秒未完成；finally 再等 5 秒也未完成。因此完整用例未通过，不能用 marker 或 cleanup 文件代替父侧 ChildProcess/流关闭证据。
- 旧 helper 只监听 spawn/error/close，未保留父侧 exit、IPC disconnect、stdout/stderr end/close/error 与状态，无法确认是哪一个关闭计数或句柄未收束。

## 静态核对

`orphan-case.mjs:26–29` 使用 spawn + ignore/pipe/pipe/ipc，启动后同步安装数据监听、error/spawn/close 监听并建立 closed Promise。`48–49` 显式调用父侧 disconnect() 后等待真正 close；Promise 构造器同步注册监听，未发现明显先 await 后订阅的接线竞态。原 finally 再等同一真实 close，不存在新的关闭动作或替代条件。

角色 `orphan-role.mjs:14–17` 将四个 worker 的 stdout/stderr 写入独立文件，父侧在 fork 后关闭自身文件描述符。没有从源码看到四 worker 显式继承 main 的 pipe 句柄；这不能替代原生流关闭证据。

本机 Node v24.14.1 内置 internal/child_process 源码直接读取的线索：

- 258–259 初始化 closesNeeded=1 / closesGot=0；433 为 IPC 增加 needed，455–458 为 stdout/stderr 各增加 needed，并在 stream close 时 maybeClose。
- 270–305 的进程退出路径先 emit exit，随后 maybeClose。
- 638–644 的 IPC EOF 路径在 disconnect/channel.close 后调用 maybeClose。
- 900–944 的父侧主动 disconnect/_disconnect 路径将 channel 置空、关闭 channel 并发 disconnect，未在该路径调用 maybeClose。
- 1096–1101 仅在 got===needed 时发 close。

这是具体的 IPC 关闭计数差异线索，尚缺本次父侧 exit、流事件及只读计数，故不泛称 Node bug、不将其写成已运行确证根因。生产 runtime/unref/预算保持不变。

## 唯一有界诊断设计（尚未给出运行结论）

入口 `.data/diagnose-orphan-handle-once.mjs` 只运行 disconnect + hung close，同一冻结 orphan-role/runtime，三个明确控制：

1. spawn + pipe：与失败 helper 的实际创建方式一致；
2. fork + pipe：仅改变创建 API；
3. spawn + file：保持 spawn，仅改变 stdout/stderr 从 pipe 为独立文件。

每组均启动真实四 worker，等待全部 ready，核对 PID/PPID/创建时间与父子归属，发现所有辅助后代；无关进程独立存在。每组记录 child spawn/exit/close/disconnect/error、pipe data/end/close/error，以及每事件后的 exitCode/signalCode/connected/channelPresent、流 destroyed/readableEnded/closed/pending、只读 closesNeeded/closesGot。角色独立事件和 runtime cleanup 原件保留。最多观察 8 秒，不将观测截止写成 close 成功，也不延长原测试预算或提前 resolve 原 Promise。

动作后用原创建身份核查全部发现后代生死和无关进程存活；最终只回收身份匹配的本组进程，fallbackKills 与自主退出分开。任一清理未确认即停止后续控制。新 probe 保存固定 HEAD、冻结文件字节哈希前后对照、原生实现副本、各层事件、观测及 SHA 清单（排除自身）。

root bg-root.cmd 仅启动该入口一次，取得 job 即冻结交回，不轮询、不加监视、不自动修复或再验证。完整回归继续停止；193 E2E 未运行，614 单测是历史结果；独立 Claude 审查仍欠正式报告。
