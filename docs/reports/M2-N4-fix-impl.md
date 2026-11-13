# M2 N4 停机屏障实现（待验证/审查）

## 来源与范围

- 调度正式将 N4 移交本分支 `fix/m2-d3`；基于已包含 d79c467 的现有工作树，不合并 master。
- 只读使用根 `orbital/coordination/m2-takeover/n4-draft.patch` 与 snapshot.json。原草稿 HEAD d79c467，patch SHA-256 为 f04f997f2d1a9257bc0bcdc348f0557540674996a976c5a3b1fbd9f1b82a6fab。`git apply --check` 成功后仅在本工作树应用并改进。没有修改、提交或还原原 m2fix/主工作树。
- Pi 真 HTTP 失败证据 `docs/reports/artifacts/M2-A/takeover-n4-shutdown.json`：operationAcceptedAndBlocked=true 时 lockHeldWhileBlocked=false、第二实例 started=true，version.changed 与作品写入在解锁后发生。它是修复前缺陷证据，不是通过记录。

## 实现

1. Fastify preClose 只关闭 HTTP 新请求准入，不等待作品队列；websocket 插件自身的 preClose 负责关闭升级连接。已接收请求继续运行，包括在请求体解析/作品队列等待阶段的请求。
2. 资源清理移至 onClose，即 Fastify 等待 HTTP 请求完成之后。此时才调用 WorkService.close：取消/等待 Agent 任务收尾，repo.drain 拒绝新的顶层 repo 操作并等待已有队列，然后停止预览、等待状态写盘。
3. WorkRepo 的 AsyncLocalStorage 重入检查早于 closing 检查；已经进入队列的操作运行在既有 scope 中，其内部 snapshot/head 等调用仍可完成。HTTP 准入与 repo 排空是不同阶段，不能在 preClose 一刀切禁止尚未调用 repo 的已接受请求。
4. 正常资源顺序为 work → assets → scene → events → work-data unlock。EventLog.close 后 publish 明确拒绝，这是补充防线，文件写入安全依靠前面的请求/任务/作品/场景屏障。
5. 若任一生产者关闭失败，仍尝试其余生产者清理，但不关闭日志、不释放 work-data 锁；初始化失败也使用同一路径。若仅构造失败且已登记生产者均成功停止，则正常关日志解锁。保守保锁可能需要进程重启恢复，不冒称关闭成功，也不允许第二实例接管仍可能有写入者的数据目录。日志关闭本身失败也不会继续解锁。

## 验证代码

`apps/server/src/events-lock.test.ts` 保留 F4/N3 原有用例，并增加/改进：

- repo 已入队操作阻塞时开始关闭，用可控 drain 信号代替草稿的固定睡眠；排空前锁保持，新顶层 repo 调用拒绝，旧操作的事件写入在关闭前完成。
- 独立临时作品目录、动态端口的真实 HTTP GET /version：暂停 snapshot、启动 app.close、第二实例必须 INSTANCE_LOCKED、关闭后 inject 必须拒绝（FST_ERR_REOPENED_CLOSE_SERVER）；释放旧操作后 HTTP 200，真实 Git 快照及 version.changed 完成，关闭后 repo 写入口及日志拒绝，重启 seq 接续。
- 注入 work.close 失败：其他资产生产者仍收到 close，第二实例仍被锁拒绝，日志仍可承载尚未确认停止的生产者。测试 finally 恢复关闭方法并明确停止全部 fixture 生产者后移除临时目录。

这些是实现侧回归，不修改或替代 Pi 正式 E2E。新 HTTP 测试使用 node:http，避免浏览器 fetch 的禁用端口策略干扰动态端口的服务生命周期验证。

## 当前状态与限制

- job_0d8d2596 已结束（exit 1），不是运行中：typecheck 通过，22 项通过，新增真实 HTTP 用例 5000ms 超时。尚不能宣称 N4 已修复验收。
- 固定实现提交及后台 job id 以交回消息为准。后续仍需 Claude Code 独立审查、Pi 真 HTTP 正式回归和最终冻结 HEAD 验证。
- D3 强杀两种场景未复现，身份/端口与局限已在 M2-D3-fix-impl.md 更新（0049ada）；没有为旧全局数量盲改 preview/worker。重启孤儿回收仍缺独立证据。
- service.test.ts/lux3d.test.ts 偶发失败尚未归因：动态端口上的 Node fetch bad-port 是已复现机制，但未与原失败端口关联，不盲改超时/重试/断言。本轮后台定向运行这两个文件以收集结果；连续五次全量、build/typecheck 最终验证尚待完成。
- 全程不读真实 .env，不主动安装依赖，不使用真实模型/Lux3D，不修改账号配置。

## HTTP 测试接线修正（ffe4672 后续）

- 已读 job_0d8d2596 完整输出。原日志只有总耗时 5016ms，没有阶段信息，因此不能据此判断实际卡在 inject、HTTP 关闭或重启。
- 静态确认的测试错误：本地 Fastify fastify.js:506–515 在 started 且 closing 时，inject 返回 rejected Promise，错误码 FST_ERR_REOPENED_CLOSE_SERVER；原测试强行期待 statusCode=503 不符合此接口。本次改成验证明确的拒绝码，不改变生产逻辑。
- 本机短探针确认 node:http.globalAgent 默认 keepAlive=true、timeout=5000。测试客户端改用 agent:false 和 Connection: close，让该单次 HTTP 验证自行结束连接，避免失败 finally 等待测试客户端连接池的空闲周期。尚无前轮逐阶段实测证明这个周期就是超时根因，不把机制线索当最终归因。
- 增加带相对毫秒数的阶段输出：init-start/init、listen、accepted、preClose、第二实例拒绝、新请求拒绝、释放 gate、旧响应、关闭完成/await 返回、重启，以及 finally 的 gate/close/目录清理。catch 在进入 finally 前输出原始测试异常，避免只剩清理超时掩盖首错。
- 保留旧操作阻塞时第二实例拒绝、旧请求 HTTP 200、关闭后 repo/log 拒写与重启 seq 接续断言；新增 events.close 边界断言：锁文件仍存在、作品内容正确且 version.changed 已写入，再关闭日志。未增大默认 5 秒预算、未增加重试。
- 此提交是测试接线及诊断改进，不是又修复一个生产缺陷。job_0c03b711 已结束 exit 0：本地 tsc 与三个文件共 23 项通过。真实 HTTP 用例 974ms，accepted 416ms、preClose 417ms、第二实例拒绝 418ms、gate 放行 423ms、旧响应 761ms、文件/事件持锁边界 763ms、close 764ms、重启 958ms、清理 973ms。现在通过不能反推前轮超时的唯一根因。
- 前轮 pnpm 输出包含自动依赖检查/Already up to date；为避免包管理器自动行为，后续验证直接使用已解析的本地 TypeScript/Vitest Node 入口，不再经过 pnpm 启动。

## N4-a/N4-c 最后边界（516676c）

已读取独立审查的固定旧草稿结论，不将它当成 ffe4672 的最终审查。ffe4672 的 HTTP onClose 顺序已消除“HTTP handler 尚未结束就关闭 WorkService”的入口；a79cd0b 是测试接线修正，不计为新的生产修复。

直接服务调用仍有独立合同：一旦 submit/cancel 通过准入，close 必须等待其结束；submit 在 validateSelection 中等待时尚未把 execute 接到 taskQueue，单等旧 taskQueue 不足。516676c 在构造时为这两个非完整 repo 队列方法同步登记在途 Promise，close 同步关闭准入、取消已运行 Agent，先等全部已接受调用 settle，再等最终 taskQueue、drain repo、stopAll 和 writes。关闭期间新 submit/cancel 统一 SERVICE_CLOSING/503；已接受提交可完成入队并由停机逻辑持久化 SERVICE_STOPPED 终态。准入已关且在途集合只减不增，不需要循环。repo 的既有重入规则不变；N4-b 的生产者失败保锁/保日志不变。

新增实现侧回归：

- 直接 submit/close：无 selection 与合法 selection 两组，阻塞 repo，准入后调用 close；新提交/取消拒绝，原提交完成，close 返回时 task 已终态；idle 后 tasks.json 和事件不变。
- 真实 HTTP POST /tasks：无 selection/合法 selection 两组，已进入 submit 后卡在 repo 队列再 app.close；阻塞期间第二实例拒绝，释放 gate 后 202，日志关闭边界锁仍存在、tasks.json 终态与内存一致，close 后字节不变且重启 seq 接续。
- 真实 HTTP POST /tasks/:id/cancel：运行中 Agent 使用可控本地替身，取消 handler 已接受后延迟，再 app.close；不走 repo 的 handler 同样被 Fastify HTTP 排空保护，完成后才进入 work.close。取消与停机竞态允许 cancelled 或 SERVICE_STOPPED failed 终态，绝不允许 queued/running 越过日志关闭边界。
- 所有新 fixture 均动态 loopback 端口、Connection: close、独立临时目录；Agent.run 使用本地替身，无真实模型请求、无候选 Vite。finally 放开 gate、等待 app.close（包括客户端响应结束），恢复替身并删除 fixture。具体运行及清理结果等待后台，不能预称所有新用例通过。

## 冻结验证安排

- 生产/边界测试固定提交 516676c；资产偶发诊断固定提交 dae89c7，只增加 mock 端口与 fetch 底层 cause 记录/恢复 spy，没有重试或放宽断言。
- `apps/server/m2-validation.mjs` 逐包执行现有 package.json 脚本对应的本地 Node 工具入口，完全不经过包管理器。顺序：7 包 typecheck → 7 包 build → 6 个测试包全量单测连续 5 轮；与根 test 脚本范围一致，bridge 使用 node --test，其余 Vitest。
- 每步保存命令、PID、起止时间、exitCode/signal、独立日志与 HEAD；开始、每步和结束核对固定 HEAD、pnpm-lock.yaml SHA-256、工作树状态，首个非零或身份变化即停。汇总 `.data/m2-validation-<时间>/evidence.json` 保存已完成轮次，不能用最后一步掩盖前面失败。后台运行后不再编辑被测源码/单测。
- 当前仅 `git diff --check` 和验证入口语法检查；新测试、typecheck/build、五轮结果待新后台任务，不拿 job_0c03b711 的旧 23 项结果替代本次验证。新 HEAD 与 job ID 以最终交回为准。
- 最终仍需 Claude Code 审最新固定提交及 Pi 合并后的正式回归；不合并 master，不宣布 M2 过关。
