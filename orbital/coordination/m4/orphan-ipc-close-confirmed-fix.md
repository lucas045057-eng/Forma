# 关闭计数对照确认后的最小测试修正

job_7ee86124 exit0/47s，源码changed=[]。原件`.worktrees/m4/.data/orphan-handle-close-diagnosis-20261116/probe-2026-11-15T16-42-49.593Z/`，81载荷Codex复算全匹配、不自引用。

## 本机当前版本确证

spawn+pipe、fork+pipe均exitSeen=true、closeSeen=false、exitCode1、IPC disconnected/channel absent、stdout/stderr destroyed/readableEnded/closed=true，closesNeeded4/closesGot3；spawn+file同样exitSeen=true/closeSeen=false，2/1。所有remaining=[]。所以不是仅换fork或输出目标就解决，也不能称watchdog不工作。

当前Node24.14.1内置源码原件：IPC stream在433行增加_closesNeeded；channel.onread EOF路径638–644调用maybeClose；父侧主动target._disconnect的finish只channel.close+emit disconnect，不调用maybeClose。结合实际少一计数，定位为当前父侧主动断开路径。该私有计数只用于诊断，不得写入或作为产品依赖。

## CodeBuddy最小修正与一次针对性确认

固定实现eb00eec，先归档诊断81载荷及原始Node源码/入口/launcher/原失败和说明，清单排自身、保留原字节，不改已归档历史。生产runtime/launch/unref/关闭预算与依赖锁保持。

仅测试helper修发起断开的方式：driver不再直接main.child.disconnect；通过本地fixture专用IPC消息要求已ready的orphan角色调用process.disconnect()。父侧接收EOF，仍等待真正原生close。子角色记录消息接收、主动断开、disconnect及close-called/exit时序，保证不是正常shutdown。消息仅测试角色支持，不进生产API/env。不要修改Node内部计数、emit假close、改成仅exit就判闭合，或吞未关闭的stream错误。

保留12项脚本范围/三个分支及全部四role真实ready、PID+创建时间/所有后代退出/无关进程保护；hung分支仍要求close不完成、watchdog marker、非零退出、runtimeCleanup归属4worker且errors/remaining空；正常close无forced；hard-kill只看实际退出。测试标题和报告准确注明主动断开由fixture角色发起，硬杀父死覆盖仍由独立hard-kill分支提供，不把控制路径伪装成父进程真死亡。

保留主错/清理/证据错误聚合和失败现场。添加原生exit/close与stdout/stderr关闭诊断，验证不再丢IPC计数，但断言使用公开事件与真实资源结果，私有计数只可选诊断。不能仅延长20s/5s。

完整静态核对后补报告并精确固定提交，再**唯一一次 `node --test scripts/demo/safety.test.mjs`**针对性确认，不grep不skip不retry，白名单fake/loopback，root指定bg-root.cmd相对ASCII入口，新run记录HEAD/字节/命令PID创建时间/exit-close-stream/各角色事件和清理。取job立即交回、冻结不轮询，不失败自动改试。结果核实前不跑type/build/614/193/full、不merge/push。

不读取真实.env/ASKS/代理/提供商凭据，不付费调用；fallback不入库。独立Claude复审仍欠，不以脚本绿代替M4验收。
