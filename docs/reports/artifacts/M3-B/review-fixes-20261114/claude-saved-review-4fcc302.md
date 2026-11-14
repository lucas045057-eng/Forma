# M3-B 真实检查与采用门禁 · 最终实现独立审查（Claude Code）

- 日期：2026-11-14。审查人：Claude Code（独立审查；不实现、不合并、不替代 Pi 验收）。
- 审查对象：`.worktrees/m3b`，分支 `feat/m3b-checks`，冻结 HEAD **`4fcc30221d53b6efd4353aa16f71ea6bcb42bfbc`**。审查前后核对：HEAD 不变，tracked 干净，只有已知未跟踪的 `debug-build.mjs`（未触碰）。
- 依据：`docs/design/M3-B-plan.md`（主线）、worktree 内 `docs/reports/M3-B-impl.md`、我此前对 `6e44961` 的 `docs/reports/M3-B-B1-review.md`（H1–H4、M1–M6）。行号均对应冻结 HEAD。
- 未读取 `.env`、ASKS、任何凭据；没有调用付费模型或 Lux3D；没有启动任何 agent CLI；没有修改冻结 worktree 的源码、测试、锁文件或 HEAD；没有合并。

## 证据类别说明

| 标记 | 含义 |
|---|---|
| **【代码核查】** | 我逐行读冻结源码得出的结论，没有运行。 |
| **【本人探针】** | 我实际运行的短探针（仅 1 个，见 S-1），夹具在 gitignored `E:/空间化AI工作台/.data/claude-m3b-review/`，只用 loopback 假服务，已自行清理并确认无残留进程。 |
| **【引用实现证据】** | 实现方 `job_50ea6887` 等运行的结果，我只核对了归档存在、`summary.json` 内容与报告一致，**没有重跑**。受测身份是 `b4b64c7` 加五个未提交测试/辅助文件，不是本 HEAD。 |

**Pi 的正式 E2E 尚未执行**，本报告不构成 M3-B 验收结论。

## 总结论

**无阻断（blocker 0）；应修 2 项（should-fix）；建议 12 项。**

B1 审查中的 H1–H4、M1–M6 已在最终源码中实质关闭（逐项见下表）。内容身份已从“改动摘要”改为完整树摘要，并叠加工具身份、Git 干净性和首尾复核；单执行队列、保存失败、超时与取消语义都已有具体实现。B4 的“先落盘、再发事件、再公开绿灯”，以及“采用时在同一把锁里复核全身份和六份证据哈希”都成立。

两项应修：

- **S-1**：浏览器检查没有阻断 WebRTC/UDP 出站，这一点由我的探针实测确认。
- **S-2**：强制终止失败时，`stop()` 会无限期等待，cancel 和关闭随之挂死。这一点是代码核查得出的，没有实际触发。

两项都不影响“不能调用工作台写入/付费接口”这一核心隔离，但与计划合同“阻断外部网络、记录并使检查失败”“回收失败要有明确结果”不符，建议在 Pi 正式验收前修掉。

---

## 应修（should-fix）

### S-1 浏览器检查未阻断 WebRTC/STUN UDP 出站，也不记录、不判失败【本人探针，已复现】

- 位置：`apps/server/src/checks/browser.ts:89-91`（Chromium 启动参数没有 WebRTC 限制）、`:118-126`（只拦截 HTTP 路由和 WebSocket）、`:103-117`（init 脚本只锁 Worker/SharedWorker/serviceWorker）。
- 计划合同（M3-B-plan.md:50）：“阻断其他本机端口、外部网络……记录被阻断请求且相关检查失败”。
- 探针做法：直接调用冻结 HEAD 的生产函数 `checkBrowser('smoke', ctx)`，实际跑 `static-origin.ts` 和真实 Chromium 158.0.8127.18。夹具页面满足冒烟判据，并在页面内执行 `new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:<假端口>'}]})`，再创建数据通道和 offer。用 Node `dgram` 在 loopback 上开一个假 STUN 端口接收。
- 实测结果（`.data/claude-m3b-review/rtc-probe-result.json`）：
  - `smokeStatus: "passed"`，`blockedRequests: []`，`pageErrors: []`。
  - 假 STUN 端口收到 **4 个 UDP 包**，首包 20 字节，magic cookie `2112a442`（STUN Binding Request）。
- 影响：页面 UDP 可以发往任意地址（同理也能发往外部），且不留任何记录。它到不了工作台 API：API 是 TCP 上的 HTTP，STUN/TURN 报文构不成合法 HTTP 请求。页面里也只有候选自身的构建产物，没有凭据。所以这不是付费或写入旁路，但违反了“外部网络全部阻断并判失败”的合同。实现报告所说的“外部请求被拦”只覆盖 HTTP 和 WebSocket。
- 最小整改：
  1. 启动参数加 `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`（已有 `--no-proxy-server`，因此实际没有可用的 UDP 路径）；
  2. init 脚本把 `RTCPeerConnection`（及 webkit 前缀）锁成构造即抛错，并通过 `__spatialChecksBlocked` 记录 `kind:'webrtc'`，使检查失败；
  3. 补回归：用假 UDP 监听，断言收到 0 包、`blockedRequests` 含 webrtc、smoke 判 failed。可直接复用本探针的思路。

### S-2 强制终止失败时 `stop()` 无界等待，cancel/关闭会永久挂起且不报 CLEANUP_FAILED【代码核查，未实际触发】

- 位置：`apps/server/src/checks/worker.ts:27-49`。第 39 行 `execFile('taskkill.exe', ['/T','/F','/PID',…], …, () => {})` 忽略了结果；第 44 行 `await s.exited` 没有上限，也没有二次升级。
- 调用链：
  - runner 在 `execute` 的 finally 里 `await executor.stop(run.id)`（`runner.ts:436`），之后才能保存终态并结束 `entry.promise`。
  - `cancelChecks` 会 `await entry.promise`（`runner.ts:319`）。
  - `drain`/`waitForActive` 会等待全部 active（`runner.ts:460-473`）。
  - `WorkService.close` 会 `await checksStopped`（`work/service.ts:705`）。
- 后果：只要 worker 不响应 IPC stop，同时 taskkill 也失败（拒绝访问，或进程进入不可终止状态等），这个 Promise 就永不完成：
  - 用户的 `POST /checks/:id/cancel` HTTP 请求一直挂着；
  - `app.close()` 一直挂着，SIGTERM 也退不出；
  - `runner.ts:438-443` 的 `CLEANUP_FAILED`/`resourceFault` 分支永远到不了，因为 stop 从不 reject。

  “故障时保留锁”在效果上成立（锁不会被释放），但表现为无诊断的挂死，而不是计划要求的“明确失败”。实现报告第八批也自承“强制回收命令自身失败的保锁处理仍要在集成与独立审查中核对”。现有测试覆盖的是“IPC stop 被忽略、taskkill 成功”，没有覆盖 taskkill 失败。
- 最小整改：
  - 检查 taskkill 的退出码和错误；
  - 加有界等待（例如 2s 发 stop → 强杀 → 再等 N 秒），超时后让 `stop()` reject `CLEANUP_FAILED`，由 runner 进入现有 `resourceFault` 分支：保留锁、拒绝新检查、cancel 返回明确错误；
  - 同时把“未确认退出”的 PID 和创建时间写进 runner.log，供人工处理。
- 补测：注入一个假的强杀函数让它失败，断言 cancel 在预算内返回 `CLEANUP_FAILED`、关闭失败且锁仍被持有、第二实例启动报 `INSTANCE_LOCKED`。

---

## B1 审查（6e44961）问题逐项关闭情况

| 项 | 结论 | 依据（冻结 HEAD） |
|---|---|---|
| H1 身份未绑定实际快照 | **已关闭**【代码核查】 | 完整树摘要包含路径、长度、原字节，以及 `m3b-snapshot-v2` 和工具身份（`snapshot.ts:98-112`）。在 repo 锁内由 `resolveCheckCandidate` 计算（`work/service.ts:268-283`），runner 重算比对（`runner.ts:243-246`）。`copyAudited` 带期望摘要，复制前、复制中逐字节、复制后的目标与源都要一致（`snapshot.ts:120-146`）。结束时再次 `verifyInput` 并重算摘要（`runner.ts:415-417`）。`candidateCommit({clean, expectedCommit})` 校验分支提交、common gitdir、工作树 HEAD，并审计树、拒绝未提交或被忽略的 src/public 输入（`repo.ts:274-297`）。 |
| H2 并发 start 重复执行 | **已关闭**【代码核查】 | 准入串行链（`runner.ts:205-206`）；按身份对 active 去重（`:256-258`）；全局单执行链 `executions`，前一 run 的 `executor.stop` 完成后才开始下一个（`:283-294`、`:432-437`）。 |
| H3 保存失败幽灵记录/永久 active | **已关闭**【代码核查】 | start 保存失败时回滚 push（`:263-265`）；`active.delete` 和计时器清理放在 `promise.finally`（`:278-282`）；保存失败进入 `poison()`/fault，停止准入，内存绿灯失效，公开视图读取 durable（`:157-195`、`:323-336`）。WorkService 侧保存失败时回滚状态并置 `checkFault`（`work/service.ts:329-363`）。 |
| H4 超时/取消依赖 executor | **已关闭**（但见 S-2）【代码核查】 | `bounded()` 在 abort 时立即 reject（`runner.ts:86-95`）；中止后返回的结果被 `phaseSignal.throwIfAborted()` 和 `assertActive` 丢弃（`:371-395`）；`TIMEOUT` 与 `CANCELLED` 分开记录（`:298-313`、`:420-452`），`finishedAt` 已设置；快照和复制接受 signal。资源回收交给 `executor.stop`，它自身无界见 S-2。 |
| M1 runner 绑定单候选、身份缺字段 | **已关闭** | 每次调用 `resolveCandidate` 并校验 id（`runner.ts:210-231`）；身份为 candidate/commit/base/main/policy/digest/tool（`:197-199`）；`STALE_CANDIDATE`（`:242`、`work/service.ts:275-276`）。 |
| M2 工具身份/根目录链接 | **已关闭** | 工具身份进入摘要；`assertPlainPath` 从盘符根起逐级检查 lstat 与 realpath（`paths.ts:3-19`）。 |
| M3 先整读再判体积、GLB 上限 | **基本关闭**，余项见建议 7 | 用句柄 stat 预检，分块读取，单文件上限 32 MiB（`paths.ts:22-47`、`snapshot.ts:24-26`）。 |
| M4 盲信 executor/latestCompleted | **已关闭** | 阶段名、结果结构、passed 必须带本阶段已登记证据的哈希（`runner.ts:396-403`）；`outcome` 字段；`latestCompleted` 只认 completed+passed 且无 error（`:333-336`）。`Check.blockedBy` 未加，仍用 message 文字表达（可接受）。 |
| M5 持久化只验证数组、文件分离 | **已关闭** | `validStoredRun` 逐字段校验（`runner.ts:476-499`）；改用 WorkService 的 `tasks.json` store（`work/service.ts:79-84`）；重启后未完成的记录标 `SERVICE_RESTARTED`，旧记录标 `LEGACY_CHECK_RECORD`（`runner.ts:136-154`）。 |
| M6 artifacts runId 穿越/哈希形同虚设/TOCTOU | **已关闭** | 所有入口都校验 runId（`artifacts.ts:26-46`）；ref 持久进 run，读取时比对 name/mime/bytes/hash，不一致返回 409 `EVIDENCE_CHANGED`（`:63-77`）；同一句柄读取，读后再核对 dev/ino（`paths.ts:22-47`）；日志截断不超上限，JSON 超限直接拒绝。 |

## 各范围核查结论

### B1 快照 / 身份 / 队列 / 中止 / 持久化【代码核查】
已按上表关闭。另外：快照只纳入 src 和允许扩展名的 public 文件，根级其他文件一律跳过；src/public 内的敏感名会被拒绝，点文件会被跳过（`snapshot.ts:56-91`）。Agent 沙箱写入范围（`src/` 下 tsx/ts/css/json/svg）与快照的 `srcPattern` 一致，所以 Agent 写入的内容都在摘要之内。

### B2 固定 IPC worker / 最小环境 / Node 权限 / 可信 Vite / 解析边界【代码核查】
- worker 入口固定为 `process.execPath`，加固定脚本和 32 位十六进制 runId，必须有 IPC；参数里不含任何 HTTP 可控内容（`worker.ts:66-68`、`worker-entry.ts:1-3`）。run 包必须与 cwd 一致，否则 shutdown（`worker-entry.ts:36-38`）。
- 环境变量只有 NODE_ENV、指向 buildRoot 的 TEMP/TMP、SystemRoot/WINDIR/PATH/ComSpec/PATHEXT/LOCALAPPDATA，不继承 NODE_OPTIONS、provider key、VITE_* 或整个 `process.env`（`worker.ts:62-65`）。
- Node 权限：只读 buildRoot、checks 源码、`atomic-file`、三处 node_modules、根和包的 package.json、锁文件、packages 三个工作区和 ms-playwright；只写 buildRoot（`tools.ts:50-62`）。`apps/server/.env`、docs、orbital、`.data` 的其他部分都不在读白名单内。实现方报告称哨兵读取会被拒绝，属【引用实现证据】。
- 可信 Vite 配置：`configFile:false`、`envFile:false`、HTML 入口固定、PostCSS 内联为空、Babel 关闭 rc 与配置文件、`tsconfigRaw` 用字符串、fs.allow 只允许 buildRoot（`build.ts:108-126`）。候选的 `vite.config.ts`、`package.json`、`index.html` 都不进快照，worker 自己写一份固定的 `package.json`（`worker.ts:61`）。候选代码只被编译，不在 Node 中执行。
- 应用层的 AST 审计和 resolveId 边界（`build.ts:19-96`）是纵深防御，不完整的地方见建议 5。实际的文件边界是 Node 权限模型。按设计说明，这是应用层守卫和 Node 权限，**不是 OS 安全沙箱**：可信工具仍有 `--allow-child-process`、`--allow-addons`，网络守卫只是在 JS 层替换函数（`network-guard.ts`），没有覆盖 dgram/子进程。

### B3 静态源 / 真实 Chrome 判据 / 网络与 worker / 资源回收【代码核查 + 本人探针】
- 独立只读静态源：只服务 dist；Host 必须精确为 `127.0.0.1:<端口>`；只接受 GET/HEAD；逐级检查链接和 realpath，读后再核对 inode；所有文件响应带 `nosniff`、`no-store`、`worker-src 'none'`；监听高位随机端口（`static-origin.ts`）。
- 冒烟判据与计划一致：唯一、可见、可用的购买入口；场景 ready 或可见的 fallback；真实点击后购买计数 +1，反馈非空；pageError 和被拦请求都为空（`browser.ts:185-202`、`:234-236`）。Playwright 的 `click()` 本身要求点击点不被遮挡。
- 遮挡判据与计划一致：每个目标取中心点和四个内缩角点，用 `elementFromPoint` 判断；disabled、hidden、零尺寸、视口外分别记录原因；目标集合为空时判失败；购买入口必须命中中心点（`:204-232`）。见建议 1、2。
- 网络：只放行同源的 GET/HEAD，其余 HTTP 中止并记录；所有 WebSocket 都关闭；service worker 被阻止；Worker/SharedWorker 构造器和 `serviceWorker.register` 被锁死，CSP `worker-src 'none'` 作兜底，CSP 违规的控制台报错也计入；popup 被关闭并记录（`:92-134`）。**本模板确实不需要 worker，采用“全部禁止创建 + CSP + 记录尝试”策略是恰当的，并不是在 worker 内部做网络拦截，实现报告也是这样表述的。** WebRTC/UDP 缺口见 S-1。
- 回收：worker 在 disconnect、SIGTERM、stop 时依次关闭浏览器上下文、浏览器、静态源，并停止 esbuild（`worker-entry.ts:12-23`）；父进程 2 秒后升级为 taskkill 树杀（`worker.ts:36-43`）。强杀失败的分支见 S-2。实际 PID、创建时间、端口回收证据属【引用实现证据】（browser-resources-20261114、standard-20261114）。

### B4 WorkService 集成 / 事件与公开顺序 / 采用门禁 / 关闭 / HTTP【代码核查】
- 与审批、候选共用同一个 `tasks.json`，`checkRuns` 字段缺失时视为 `[]`（`work/service.ts:111-117`、`:79-84`）。
- 公开顺序成立：先在 repo 锁内复核新的 passed 结果，再保存；保存成功后才更新公开视图（`captureCheckViews`/`durableCheckRuns`），最后发 `check.started/updated/finished`（`:329-363`）。保存失败时回滚，并置 `checkFault`。
- 采用门禁成立：`adopt` 在 repo 锁内先快照主作品，然后要求 runner 健康、没有 `checkFault`、不在撤回中、`latestCheckRunId` 是最新的 run；再调用 `validatePassedRun`，在同一把锁里（AsyncLocalStorage 可重入）重算候选提交、基线、主版本、完整摘要和工具身份，逐份读取六份证据并比对 ref，核对四项结果的证据哈希。任一不符一律返回 `409 CHECKS_NOT_PASSED`（`:647-657`、`:307-327`）。合并的分支提交就是经过干净性复核的受检提交，所以合入的 src/public 字节就是受检字节。
- 丢失证据、篡改、未提交文件、任意配置执行、父进程断开：分别由六份证据必读、哈希比对、`candidateCommit` 干净性检查、固定配置与 Node 权限、`disconnect→shutdown` 处理，均成立。
- 撤回/裁剪：先在锁内标记 `retiring`（封住检查准入），在锁外取消检查，再回到锁内保存撤回意图并清理（`:623-645`），没有在持锁时等待需要同一把锁的检查保存，N4 死锁已避免。关闭：先 `drain` 检查，等 inFlight、任务、裁剪和检查屏障，再 `repo.drain`、停预览、放锁（`:697-714`）。`app.ts` 的 closeAll 在任一生产者关闭失败时不关闭事件日志、不释放锁（`app.ts:59-71`），故障保锁成立。
- HTTP：四个固定路由；`preValidation` 在任何 schema 转换前严格校验原始请求体（只允许原始 JSON 布尔值 `rerun`，取消只接受空体或空对象）；证据只能按已登记的固定文件名读取，响应带正确 MIME、`no-store`、`nosniff`、哈希 ETag，被篡改返回 409；沿用全局 Host/Origin 门禁和关闭准入（`checks/routes.ts`、`app.ts:122-127`）。`checks` 构造参数只能在进程内注入，HTTP 无法覆盖。

---

## 建议（suggestion）

1. **遮挡检查测的是冒烟点击之后的页面**：两者共用同一个 page，URL 不变时不会重新加载（`browser.ts:165-173`）。计划写的是“首屏”。建议 occlusion 前重新导航，或在证据里写明“点击后状态”。
2. **隐藏判定只看元素自身的 opacity**（`browser.ts:212`）。祖先 `opacity:0` 时元素仍会被 `elementFromPoint` 命中、判为可交互通过。建议沿祖先链计算有效不透明度，或用 `checkVisibility({opacityProperty:true})`。
3. **排队等待超时会把 schema 标为 failed**（`runner.ts:307-309`），但 schema 实际没有运行。建议排队超时作为 run 级错误、四项全部 `not_run`；或者整体时限从开始执行时才计起。
4. **同身份去重会返回已取消或被中断的旧 run**：`['completed','cancelled']` 都会被复用（`runner.ts:259-262`）。用户取消后再点“检查”，如果不带 `rerun:true`，拿到的还是那个已取消的 run，HTTP 仍回 202。建议只复用 passed 或因检查本身失败的 run；cancelled、SERVICE_RESTARTED、TIMEOUT 等自动新建。M3-C 也应明确用 `rerun`。
5. **AST/CSS 审计不完整**（`build.ts:42-66`）：CSS 只用正则匹配 `url()`/`@import`，没覆盖 `image-set("…")` 这类字符串形式；JS 没覆盖 `new URL('…', import.meta.url)`。Vite 的 CSS URL 解析是否经过插件的 `resolveId`，我没有验证。实际的文件边界是 Node 权限模型。建议文档把这层定位为“纵深防御 + 权限模型兜底”，不要称作 CSS 真实解析，并补这两类回归。
6. **build.log 可能写入绝对路径**：异常的前 5 行堆栈和 `resource=` 原样写入（`build.ts:136-150`），与计划“不暴露绝对路径”不符。建议把 buildRoot、projectRoot 替换成占位符。
7. **快照总量在读完全部文件后才判断**（`snapshot.ts:107-109`）：最坏情况要读 500 × 32 MiB 才拒绝。建议在 walk 中累计，超限立即停止。
8. **重启后不清理遗留的 `check-builds/<id>`**（`runner.ts:341`；init 只改状态，`runner.ts:123-155`），也没有记录 worker PID，无法清理崩溃遗留的孤儿进程。建议启动时按 run 状态清理目录，并持久 worker PID 与创建时间以便校验后回收（与 M2 已知的“历史孤儿”局限相同）。
9. **`retiring` 标记可能残留，关闭失败时有资源没回收**：`closeCandidate` 在候选已不是 pending（例如被并发采用）或中途抛错时，不会删除 `retiring`（`work/service.ts:634-639`）。`checksStopped` 失败时，`WorkService.close` 直接抛出，跳过 `repo.drain()` 和 `previews.stopAll()`（`:705-709`），候选预览进程要等进程退出才回收。建议用 finally 清理 `retiring`；即使检查失败，也停止预览、排空 repo，再抛出错误（仍保留锁）。
10. **公开的 `candidate.checks` 在主版本变化后仍显示四个 passed**（`work/service.ts:285-292`），而采用会因 `STALE_CANDIDATE` 被拒绝。另外，任何 3D 写回或手工修改都会被自动快照成新的主版本，使所有待定候选过期、需要重新生成（多一次模型调用）。M3-C 界面不能用 `checks` 判断是否可采用。建议提供派生字段（如 `checksCurrent`/`adoptable`），并评估“过期后重新检查”而不是“重新生成”的方案。
11. **`auditTree` 允许根目录配置文件出现在候选提交中**，而采用会合并整个提交。目前 Agent 沙箱只能写 `src/`，没有实际路径。建议采用前断言“候选相对基线的改动只涉及快照覆盖的路径”，作为纵深防御。
12. **工具身份不含实际浏览器二进制版本**：`getCheckToolsIdentity` 包含 vite/plugin-react/@playwright/test 的版本、检查源码、工作区源码和锁文件（`tools.ts:25-48`），但不含已安装的 Chromium 版本。浏览器单独更新后，旧绿灯仍会被复用。另外，单张 PNG 超过 2 MiB 会被保守地判为失败（`artifacts.ts:13`）。建议把浏览器版本纳入身份，并评估截图上限。

---

## 本人实际执行的内容

- 只读核查冻结 HEAD 的 `checks/*`（snapshot、paths、runner、artifacts、protocol、routes、worker、worker-entry、tools、network-guard、build、schema、static-origin、browser）、`work/service.ts`、`work/repo.ts`、`app.ts`、`packages/shared/src/index.ts` 的相关部分，以及 `work/checks-real.test.ts`。
- **1 个短探针**（S-1）：`.data/claude-m3b-review/rtc-probe.mjs`，结果存于 `rtc-probe-result.json`。只用 loopback 假 UDP 端口，没有外部网络；夹具已删除；用 Win32_Process 查询确认没有残留浏览器或探针进程。
- **没有**重跑 typecheck、build、单测或任何 E2E。标准运行 416/416、六份证据哈希、真实截图等，均属【引用实现证据】（`docs/reports/artifacts/M3-B/standard-20261114/summary.json` 与实现报告一致），受测身份是 `b4b64c7` 加五个文件。

## 判定与后续

- 代码审查：**有条件通过**，没有阻断。建议在 Pi 正式验收前修 S-1、S-2，并补对应回归；12 条建议可按 M3-C/M4 的需要安排。
- **Pi 的正式 E2E（迁移旧套件走真实检查，加上四类故障、取消、超时、缺浏览器、重启、证据读取、采用拒绝）尚未完成。M3-B 不能据本报告判定验收通过。**
