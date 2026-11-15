# M4先确认父死测试原因，再重试

用户最新要求：“运行又失败了，已经失败好几次了，检查一下原因在试呢”。暂停盲目全仓重跑。本次允许必要的、小范围、带证据的原因诊断；不以增加超时、删断言或静态猜测再启动完整轮。

## 实际状态

job_6cce1181已结束exit1，受测ba3e61b、实现97bd686，run `2026-11-15T15-45-17-321Z-full`。类型/构建成功，614单测全过（68+20+5+1+378+142）。此前pointer捕获测试已看到trusted down→got→lost（同ID、buttons1、无up），之后liveTracks0/stops1/零上传，不能说录音又失败。

首次进入demo-safety：10项9过1败。失败 `body.test.mjs:83` 只是在杀测试父进程后，`await run.closed` 的返回stderr为空，与 `/DEMO_ORPHAN_TIMEOUT/` 不匹配。这个断言在后代退出/无关进程/cleanup JSON断言之前，所以本轮日志尚不足以证明资源回收失败或成功。

## CodeBuddy：先诊断，不改成品

实现树固定97bd686，暂不修改生产runtime/测试断言。静态核拓扑：测试runner→parent.mjs→orphan.mjs(ownedLifetime)→4角色worker，另有unrelated。child()的run.closed和stderr来自哪一层，继承stdio是否继续保持到orphan关闭，杀哪层、IPC断开在哪层触发、watchdog.unref是否影响实际触发、Windows对子进程终止语义分别核清。不要仅凭stderr空就删标记断言，不要仅凭unref就先改生产timer。

准备一个隔离、有界的focused诊断入口（.data内，新run原件），只用临时替身角色、本地文件和原runtime；不启动模型、浏览器或完整demo。原固定源码字节不变。记录每个层级PID/创建时间/parent关系，以及spawn/ready/IPC disconnect/close调用/close完成/exit/beforeExit/stdio关闭的时序。关键阶段写各进程自己独立的文件，stdout/stderr按角色保存，避免只依赖已死父进程的pipe。

至少区分原始kill路径与不杀父进程而明确断开IPC的控制路径；控制close可完成与故意永不完成的情形，解释预期。保证所有ready包括实际4个worker就绪后才操作，记录实际退出与orphan-cleanup内容，按PID+创建时间确认无关进程未被动、测试后代全部清理。兜底kill与watchdog自主回收分开，不得广杀。

诊断允许运行一次含必要对照的有界job，但不修改生产逻辑、不运行typecheck/build/614单测/193E2E/full、不循环试改。静态发现机制后以对照证据确认；若无法确认则保留原始记录明确哪一步仍欠证据，不能再猜根因。根指定bg-root.cmd、相对ASCII入口、白名单环境，获得job即交回，不轮询不加第二监视。当前无其他验证job运行，Pi并行只归档。

结果返回后由Codex核证据，再给最小修正及针对性验证范围；只有针对性结果证明修正有效，才重启完整集中轮。此任务是诊断不是成品返工，不自行merge/push/创建完整验证job。原失败日志和测试阈值不改写。

参考已查Node官方文档（仍以当前Node24实测为准）：https://nodejs.org/api/child_process.html#event-close 解释exit与close/共享stdio不同；https://nodejs.org/api/timers.html#timeoutunref 解释unref不保持事件循环。这两条仅是排查线索，不是本轮根因证明。

## Pi：只归档当前完整轮

验收树ba3e61b保留614单测与脚本9/10事实；原pointerEvents、cleanup、脚本原件、launcher/身份/614逐包数/未执行10套E2E、PID创建时间与端口核验、SHA排自身复算。脚本失败finally可能已清掉临时orphan目录，无法回溯的原过程如实列；不捏造父死成功。只docs提交，不改产品/测试/runner、不补跑、不派实现者。

共同不读真实.env/ASKS/代理/提供商凭据，不付费调用；fallback未跟踪，历史retained现场不擅删。Claude独立复审仍欠，不用新单测全绿抵扣审查。
