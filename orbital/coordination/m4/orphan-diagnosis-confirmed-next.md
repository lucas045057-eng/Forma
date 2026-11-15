# 对照证据确认后：仅修测试前提并验证脚本套件

用户要求先查原因再试，完整回归仍不启动。隔离诊断job_6562acc2 exit0/52s只代表四组观测完成，根因证据如下（Codex已直接解析原件）：

原件 `.worktrees/m4/.data/orphan-diagnosis-2026-11-15T16-04-02.325Z/`。四组errors/cleanup.errors空，identityUnchanged=true。

| 对照 | 原生观测 | 原测试错误前提 |
| --- | --- | --- |
| kill/hung 与 kill/complete | familyGoneBeforeFallback=true，unrelatedAlive=true；orphan无IPC disconnect/close调用/marker，本地stderr也空，无runtimeCleanup | 本机原ChildProcess.kill方式没有留下可执行watchdog分支的orphan，不能要求必有DEMO_ORPHAN_TIMEOUT |
| disconnect/hung | closeCalled=true/closeCompleted=false；父捕获及orphan本地stderr均有marker；runtimeCleanup列出4worker、errors=[]/remaining=[]，family gone且unrelated alive | 对明确IPC断开并挂起关闭的分支，watchdog应触发且实际触发，不能仅凭原kill stderr空判其失效 |
| disconnect/complete | closeCalled/completed=true，family gone、unrelated alive，无marker/forcedCleanup | 正常关闭不应被要求超时或强制回收 |

不要扩成“所有Windows所有杀进程方式都必然整树终止”；仅此Node/宿主/调用路径的实测。也不能说生产所有孙进程链已证明，诊断使用临时角色/原runtime。unref暂不动，四组没有证明它是失败原因。

## CodeBuddy一次完成

1. 核对并逐字节归档四组完整原件、诊断入口/角色源码、launcher，保存SHA排自身。原始记录不改写，报告分开诊断成功/产品验证。
2. m4基97bd686仅改scripts/demo/body.test.mjs与所需测试工具/报告，不改生产runtime/launch/unref/关闭预算。原单例拆出明确分支：硬杀父进程验证原进程链按PID+创建时间退出、无关进程存活；明确IPC disconnect且挂起close验证watchdog真正触发/非零退出/cleanup归属和所有后代退出；可完成close对照验证没有强制回收。保留原四role必须存在、所有发现后代、无关进程保护。不得仅删除marker断言变绿，marker移到确实应执行该分支的用例。
3. 所有worker实际ready后动作。按实际发出日志/运行watchdog的层级取得证据，独立文件/IPC或直接子句柄可靠收集，不再只靠已被kill的父stderr。主断言和finally清理/写证据失败聚合，保留失败现场；清理fallback与自主回收分开。保留精确PID创建时间，不广杀。
4. 写M4-orphan-diagnosis-and-fix.md，根因、原件、范围与局限明确。静态核对精确固定提交，然后才启动唯一一次**脚本安全套件** `node --test scripts/demo/safety.test.mjs`（包含全部body，实际计数由结果给出，不只grep单例）。这是用户最新要求的针对性确认，不是重跑全仓。
5. 入口使用root bg-root.cmd、相对ASCII、白名单fake/loopback环境，新run保存stdout/stderr/各进程事件、HEAD/字节身份/命令PID时间退出和资源清理。取得job立即交回，冻结不轮询不加监视。首个脚本结果回来后由Codex核对，**不要自动启动type/build/614/193/full**，失败也不要自动再改再试。

成品/依赖锁/模板/Pi独立E2E/历史证据不改，fallback不入库。不读真实.env/ASKS/代理或提供商凭据，不付费调用；不merge/push。独立Claude审查仍缺，不能用针对性绿灯抵扣。
