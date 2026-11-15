# M4 前端关闭后迟到 watcher 注册修正

## 根因证据与观察边界

本批起点为实现树 `70e82cafbd23af19902e327bb647847c67663661`。原 `job_4c0cdd5a` 三场景诊断只代表观测完成：未请求场景正常退出，consumed 与 status-only 均在原 45 秒关闭预算后被 forced。两个 Vite.close、HTTP close callback、环境关闭和 owned-close-finished 均已完成，不能将其解释为 Vite.close Promise 或 HTTP close 仍未返回；也不能归因于响应体未消费。

唯一补充 watcher 来源追踪 `job_5117bda5` exit 0 / 55s 也只表示观测完成，真实 consumed 场景仍为 cleanup_failed：

- 原始 watcher JSONL 共 88 次 watch-created，87 个原生 watch-event close；observer-wrap-error / observer-track-error 均为 0，已有生命周期快照中的 unmatched 为空。
- owned-close-finished 为 `2026-11-15T18:11:20.597Z`；随后进程断开 IPC，快照中 activeWatcherHandles=[]。
- `18:11:20.598Z` 创建 id 88，路径为实现树 `packages/scene-renderer/src/index.tsx`，persistent=true、原生 FSEvent.hasRef=true，之后没有其 close 调用或事件，最终仍被父启动器按原 45 秒预算强制结束。
- 创建栈来自 Vite 7.3.7 内置 chokidar：createFsWatchInstance → setFsWatchListener → NodeFsHandler._watchWithNodeFs → _handleFile → _addToNodeFs → add 的异步路径。

最后一次生命周期快照早于 id 88 的创建。因此“快照无漏配”只适用于已采集的快照，不代表精确采样了强杀前每个瞬间的全部资源。前一轮曾记录 3 个残留 FSWatcher，本次来源追踪确证的是一个关闭后新建的持久 watcher；不将两轮时序混写为固定数量。`observer-verification.json` 保留这些边界。

静态源码显示 chokidar.add 会将其 closed 设为 false 并异步注册路径，而 Vite 并行关闭 watcher 与环境；_handleFile 与异步 stat 后均会检查 closed。可确认的运行事实是关闭完成后出现新的持久原生监听；内部异步任务的每个精确调度停点没有被逐一采样，不写成已观测事实。

## 原字节归档

`artifacts/M4/frontend-late-watch-20261116/` 保存：

- trace/：完整单场景追踪、创建/关闭/ref 事件、阶段日志、源 SHA、实际日志副本与差异、本机 Vite 与 Node fs 源码、身份/清理记录及原 SHA 清单；
- launcher/：job_5117bda5 的原始启动和退出记录；
- predecessor-archive/：前序三场景诊断和 launcher 的既有封存副本，不覆写历史；
- real-run/：本次真实 consumed run 的 manifest、plan 和两个角色的诊断 stderr，仅复制指定普通文件，不打包候选仓库或链接；
- archive-verification.json、real-run-verification.json、observer-verification.json：复制前后源与目标字节核验及观察器静态审计。

前三类共复制 75 个原始载荷，real-run 再复制 4 个；源文件未变、逐文件 SHA256 一致。加派生审计和属性文件，外层清单实际登记 83 个载荷、排除自身，静态复算 0 mismatch；.gitattributes 禁止 Git 换行转换。所有新增归档均为普通文件，不产生新的 gitlink。

## 最小生产修改

新增 `scripts/demo/frontend-watch-gate.mjs`，只负责本前端生命周期拥有的 watcher.add 门禁：运行时保持原 receiver、参数、返回值和异常；封口后不再委托新增注册，按公开链式契约返回调用 receiver。没有访问或修改 chokidar.closed、Node 私有句柄或计数，没有全局 fs patch、残留 unref、主动 process.exit 或依赖变更。

`frontends.mjs` 创建一个进程内门禁，供 main/Studio 两个自有 watcher 使用。stop 回调第一步同步 seal，随后继续等待真实 Vite.close，原 Studio→main 顺序和聚合异常不变。封口独立于 ownedLifetime.closing，不依赖其 async 初始化表达式的赋值时机。

ownServer 收到实例后先安装同一门禁并登记归属，再检查关闭状态。关闭已开始时，迟到 createServer 的实例不会进入 listen，仍等待其真实 close 后报告启动中断；listen 期间中断的原关闭检查也保留。生产 launch/runtime、45 秒预算及失败处理未改。

## 回归代码与唯一 focused 确认

新增门禁回归，验证：正常 add 的 this/参数/链式返回、同步封口阻止所有已归属 watcher 的迟到注册、封口后附加的 watcher、运行期原异常透传，以及独立生命周期互不影响。回归由 safety.test.mjs 导入，原有 12 项脚本断言未删除；安全全套本轮不执行。

专用 `frontend-close.focused.test.mjs` 复用上述纯门禁回归，并执行三个真实生产场景：no-request、consumed、status-only。实际测试数与通过数由唯一作业的 TAP 输出给出，不预填成功。

focused 的 driver 直接调用当前提交的生产 launch，prepare 日志包装仍调用原 prepareDemo；backend/frontends/runtime/真实 Vite 均走新生产源码，没有旧诊断 frontend/launch 副本、没有 loader 注入或 fs watcher 观察器。通过只读 Node child_process 诊断通道记录真实 backend/frontends 的 spawn、exit、close、IPC 和 stderr 生命周期，不替换子进程行为。

两个请求场景均实际请求自己新建 demo 的 Studio、API health、预览代理，以及 main Vite 的 `/@fs/` scene-renderer 外部模块路径。consumed 完整读取响应；status-only 保留未消费响应至关闭后。原 45 秒生产预算保持，观察等待不是修改生产预算。

consumed 场景还用本机 Chromium 打开真实作品和原生 Vite HMR WebSocket，修改且仅修改新 demo 隔离副本的 style.css：要求收到对应 HMR update 帧、浏览器 computed CSS marker 变化、主文档不导航重载。原模板不写入；浏览器与请求仅允许 loopback，记录自有浏览器创建身份和退出。

每个真实场景必须自然 exit/close 0、manifest stopped、cleanup.problems=[]、forced 全 false，真实 backend/frontends 的 exit 与 close 各一条且为 0/null；按 PID＋创建时间确认所有已发现自有进程消失、所有自有端口释放。查询 unknown 不当 gone；fallback kill、浏览器清理错误、写证据错误均导致失败，主错/清理错分开保留。

固定实现提交后，仅经根 bg-root.cmd 启动一次 `.data/run-frontend-close-focused.mjs`。该入口只运行上述 focused 文件，保存固定 HEAD、完整实际字节身份前后对照、真实命令/PID/创建时间、实际 TAP 计数、每场景原件和 SHA 清单（排除自身）。拿 job 即交回冻结，不轮询、不加监视；失败只保留并交回，不自动改试。

## 当前状态

本次交付前只做证据静态校验、差异和语法检查，没有运行 focused 或任何其他验证，不宣称门禁已运行验证成功。依赖锁、模板、Pi 验收树 e375b73、独立 19 例及历史原件未改。M4/full/脚本全套/614 单测/旧 174 均不启动，不合并、不推送，不读真实凭据或真实调用。

focused 返回后由 Codex 核验并与 Pi 点选修复统一集成，之后是否恢复专项由调度决定。真实 Windows 控制台 Ctrl+C、真实提供商调用、真人 A/B、彩排及项目验收不由本次关闭确认替代。
