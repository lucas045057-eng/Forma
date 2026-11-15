# M4 独立 E2E 静态集成收尾

基于 Pi 固定提交 `3ce1a40cdcc27848ddcfdcb5140c29203c7ef890`。Codex 直接修改测试夹具收尾；本报告不含新的运行通过结论。

- 将硬杀前的启动器 epoch 占位身份改为真实批量快照身份，缺失/无效先失败；同一时间源按毫秒精确比较，移除两秒容差。
- 其他 demo 用例也通过测试专用普通文件 driver 启动真实 mock 链；停止由进程内 SIGINT 事件触发原 `launch` 处理器，等待原生 close，并保留 exit 0、stopped、空清理问题与无 forced 的判据。不再使用已证实不适合作优雅关闭验证的 `child.kill('SIGINT')`。
- 为这些 demo 句柄加入 afterEach 收尾。强制结束只使用自有 ChildProcess 句柄，并使清理失败，禁止按旧 PID 调 taskkill /T。主动硬杀分支单独检查原始进程身份及端口；不据此声称 watchdog 因果。
- 显式断言优雅关闭驱动收到原生 exit 0 / signal null / close；真实 backend/frontends 的 PID 必须在启动前快照中有合法创建时间，避免空集合通过。
- 录音替身 stop 幂等；迟到权限放行时创建一条实际轨道，并让重复 getTracks 返回该轨道，核对 streams 增量和 live→ended 顺序。松手兜底不再吞掉异常。

生产、实现侧测试、脚本、依赖锁、模板与历史证据未改。真实 Windows 控制台 Ctrl+C 尚未验证；进程内 SIGINT 事件模拟只验证原处理器及真实 mock 角色收尾。既有完整轮的 614 单测和 12 脚本测试成绩属于旧受测身份；M4 19 例仍是 4 通过/8 失败/7 串行跳过，旧 174 未执行。

接续验证只安排一次 M4 独立专项；按实际执行报告核对计数、禁止 skip/retry/flaky 和身份漂移，记录资源清理。若失败先保存证据定位，不自动修改或再跑 full。
