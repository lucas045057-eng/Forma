# M4清理证据的机制边界（独立复审S1回应）

日期：2026-11-16。只更正文档及历史标签的解释，不改生产代码、测试、阈值、预算或原始证据，不运行任何验证。

独立复审 `M4-post-diagnosis-review.md` 的S1要求区分“观察到退出”和“证明IPC/watchdog执行”。以下解释优先于旧实现/验收报告中未限定的“自主回收”表述，旧报告、JSON和事件原件不改写。

| 路径 | 当前已观察证据 | 可以声明 | 不能声明 |
| --- | --- | --- | --- |
| 本机临时角色hard-kill父进程 | 原PID+创建时间身份在fallback前全部消失，无关进程仍活；中间角色无disconnect/close-called/exit记录，无watchdog清单 | 该机器与该调用路径下原测试链已退出，无补杀被测家族 | 由IPC处理或watchdog自主回收；所有Windows/生产整链均如此 |
| fixture角色主动断开IPC、close故意挂起 | 消息、主动断开、disconnect、close-called、watchdog marker、exit/close1和四worker归属清单齐全，errors/remaining为空 | 该控制分支实际执行watchdog，四worker按记录身份回收且无关进程未受影响 | 父进程真实死亡的机制已证明；生产默认50秒预算已实测 |
| 正常关闭控制分支 | close-completed forced=false、原生close0，无watchdog清单，原家族消失 | 正常关闭对照无强制回收 | Windows真实控制台Ctrl+C或所有生产孙进程处理链均已验证 |
| 资产专用父死夹具 | worker原身份在测试fallback前消失，raw完整/未发布半成品/重启清staging断言通过 | 该夹具的退出结果与恢复语义通过 | worker退出必由disconnect处理器造成；生产process-isolated完整optimize/publish链已覆盖 |

硬杀时由操作系统或宿主直接终止整链是与记录相容的解释；现有诊断没有单独定位具体OS/Job Object实现，不把这个机制推断升级成跨平台保证。生产代码存在退出处理器，也不能替代事件记录证明该处理器实际执行。

历史字段`autonomousWorkerExit=true`按原生成条件仅代表“观察到worker已退出，测试没有fallback杀该worker”；不代表已观察到IPC处理器。资产用例名中的“loses its worker”与原始断言、结果不变。本文件只收紧可对外声明的因果范围，不否认已经证明的raw/恢复/资源状态。

Pi `04-demo` 的硬杀场景在当前受测版本上继续冻结；归档时说明为“按实际PID（及能取得的创建时间）观察原进程链退出”，若没有IPC/close事件和回收清单，不标“IPC回收已验证”。PID复用处理是否完整、生产所有孙进程是否覆盖，按独立原件列限制，不为文案更正修改运行中的测试。

生产runtime/launch相对受测`f9e21f5`零改动。脚本针对性12/12与历史614单测结果保持；Pi当前完整轮受测`280e282`不移动，不用本文更正触发重跑。193E2E是否实际完成以该完整轮后续结果为准。本文件不宣称M4验收，真实服务、真人A-B、完整彩排及真实控制台Ctrl+C仍须分别有证据。
