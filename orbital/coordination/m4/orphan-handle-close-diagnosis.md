# 针对性失败后：查清原生句柄关闭，不改生产回收

job_2f05614c已结束exit1/44s，受测eb00eec，run `.worktrees/m4/.data/orphan-safety-confirm-2026-11-15T16-34-53.564Z/`。脚本12项11过1败，只有disconnect-hung失败。changed=[]，完整回归继续停止。

Codex已核独立原件：`orphan/disconnect-hung/orphan-15312.events.jsonl` 16:35:04.941断开IPC，04.942调用hung close，07.189退出code1；`main.captured.stderr.log`真实含DEMO_ORPHAN_TIMEOUT；`orphan-cleanup-15312.json` forced=true列4个worker、errors=[]/remaining=[]。但测试helper的main.closed Promise20秒未完成，finally再次等closed5秒也超时。日志不能推断是哪条stdio/IPC句柄或事件未收，也不能把已有runtime证据当整项用例绿。

## CodeBuddy本次任务

保持生产runtime/launch/unref/预算不变，先对eb00eec的orphan-case launch/bounded/main.closed建立原因证据。现helper只记spawn/close/error，没有exit或stdout/stderr end/close/IPC disconnect状态，缺口在此。不要延长超时、吞错误、提前resolve闭合Promise或以文件存在代替资源关闭。

1. 静态核子进程创建/监听安装/IPC断开/close计数与stdio所有权。已完成的原run及诊断原件先逐字节归档，报告严格分“orphan已退出且watchdog成功记录”和“父侧handle/stream关闭未确认”。
2. 若静态不足，只准备**一个有界、只针对挂起disconnect分支**的诊断job，不直接重跑整个脚本或全仓。保留原runtime，分别记录child exit/close/error/disconnect、stdout/stderr end/close/error及事件后的exitCode/signalCode/connected/stream destroyed/readableEnded、真实PID创建时间的生死。事件写独立文件。必要时加入fork与spawn的可比控制、管道与文件stdio控制，明确每次仅改变哪项，不运行真实demo/模型/浏览器。
3. 证据必须定位“进程未退出”“有继承pipe未关”“IPC关闭事件未计入”“监听/Promise接线错误”中的实际原因，不能先说Node bug、不能擅自改生产回收。诊断有真实4worker ready、全部发现后代/无关进程保护及最终清理，fallback kill不能算自主回收。
4. 原脚本固定源码/断言先不改；诊断脚本可在.data。结果回来后Codex核原因，才给最小修正和再次针对性确认；**本任务不自动修后重试**。root bg-root.cmd相对ASCII白名单，拿唯一job立即交回，不轮询/不加监视。已有同任务job若存在不重复起。

无新依赖锁/模板/PiE2E或历史原件修改；不读真实.env/ASKS/代理凭据、不真实调用、不merge/push。独立审查仍欠，完整回归停止。
