# M2 N4 最终固定提交复核 · Claude Code

- 日期：2026-11-14（Asia/Shanghai）。角色：独立审查（只读；未改实现、测试、历史审查和记忆，未提交）。
- 固定提交：**`e468c20ecd34de6bc9b767ba085d041a3a14c28d`**（fix/m2-d3，未合并 master）。代码一律用 `git show e468c20:<path>` 读取；下文行号都对应该提交。运行探针时导入的 `.worktrees/m2d3`，经核对 HEAD=e468c20 且工作树干净。
- 审查范围：`git diff d79c467 e468c20 -- apps/`，即 ffe4672、a79cd0b、516676c、dae89c7、e468c20 五个提交。旧 `n4-draft.patch` 不作为本次实现；本报告结论不沿用上一轮对草稿的判断，只复测它当时暴露的路径。

## 1. 结论

**N4 实现审查：通过。** 原 N4、N4-a、N4-b 全部关闭，没有阻断项，也没有应修项。余下 3 条建议，均不影响“close 返回前没有活的生产者、锁最后释放”这一安全性质。

这不等于 M2 整体通过。还需要：合并到 master 后由 Pi 在同一冻结 HEAD 上去掉 retry/N4 的 `test.fail` 跑正式回归；D3 的五场景只各跑了一次（见第 5 节）。

## 2. 各项状态与证据

| 项 | 状态 | 关键位置（e468c20） |
| --- | --- | --- |
| N4 preClose 早于请求排空就关日志、放锁 | **关闭** | `app.ts:99`、`:104`、`:206`–`:208`、`:54`–`:66` |
| N4-a submit 在 taskQueue 被等待后才挂上任务 | **关闭** | `work/service.ts:57`–`:65`、`:311`–`:320` |
| N4-b 关闭失败仍放锁 | **关闭** | `app.ts:57`–`:64` |
| N4-c（旧建议）cancel 不在屏障内 | **关闭** | HTTP 排空 + `service.ts:57`–`:65` 的准入登记 |
| N4-d（旧建议）错误码不统一 | **关闭** | `app.ts:104`、`service.ts:60`、`repo.ts:38` 统一为 `SERVICE_CLOSING`/503；Studio 与 e2e 中没有依赖旧 submit 409 `SERVICE_STOPPED` 的地方（`git grep` 只命中 m0a 资产的同名码，那是另一语义） |
| N1/N2/N3 初始化、R1 | 无回归 | `repo.ts`、`PointSpeak.tsx` 的相关段在本轮没有改动；`app.ts` 只改了关闭所有权（见 2.4） |

### 2.1 HTTP 准入与排空（检查点 1）
- `app.ts:99` 在 preClose 中只设置 `closing=true`；`:104` 让 onRequest 对之后的新请求返回 503；Fastify 5.12.8 自身也会在 close 时 `router.closeRoutes()`。`:208` 把 `closeAll` 挂在 **onClose**。
- 顺序是否成立，取决于 avvio 的 onClose 按后进先出执行：Fastify 内部负责 preClose 和 `server.close()` 的 onClose 是在 preReady 时注册的，比 createApp 里的注册晚，所以先执行。我用临时探针（只用项目依赖里的 fastify，不加载项目代码）实测：
  - 已在执行的 handler：preClose → handler 结束 → 用户 onClose。
  - **请求头已到、请求体仍在读入**的请求：preClose 之后才补完请求体，handler 照常执行并返回 200，用户 onClose 在它之后。
  - close 开始后才来的新连接：ECONNREFUSED。
  - 结论：已接受的请求（含请求体还在上传的）都会在 closeAll 之前排空。
- POST /tasks（带或不带 selection）、取消、/version、场景和资产路由都是普通 handler，全部被这道 HTTP 排空覆盖；WS 客户端由 `@fastify/websocket` 11.3.7 的 preClose 主动关闭，不会卡住 `server.close()`。

### 2.2 WorkService 直接调用的准入（检查点 2、3）
- `service.ts:57`–`:65`：submit/cancel 包装器**同步**检查 closing，同步调用原方法并把返回的 Promise 加入 `inFlight`，结束（成功或失败）都会移除。async 方法不会同步抛错，所以不存在“已经开始却没登记”的情况。
- `:311`–`:320` 的关闭顺序：设 closing → 中止 controller → `allSettled(inFlight)` → 等 `taskQueue` → `repo.drain()` → 停预览 → 等 `writes`。closing 设好之后包装器拒绝新调用，`inFlight` 只会减少，所以快照等待是完整的。`taskQueue` 是在 inFlight 全部结束**之后**才读取的，已接收的 submit 挂上的 execute 一定会被等到。drain 之前作品队列仍接收操作，submit 里的 `validateSelection`、execute 里的 `trimCandidates` 都能继续执行，不会互相等待而死锁。drain 之后，新的顶层调用由 `repo.ts:38` 拒绝，已在 AsyncLocalStorage 作用域内的重入由 `:37` 放行。没有发现有异步任务跨出作用域、借作用域绕过 closing 的路径（taskQueue 的 then 是在 submit 的作用域外注册的）。
- 复测上一轮的 N4-a 竞态：同一个临时探针，存储写临时目录、emit 用记录替身，导入 e468c20 真实的 `WorkService`/`WorkRepo`。结果：迟到的 submit 返回 `SERVICE_CLOSING`；已接收 submit 的“已排队”保存/事件和 execute 的“失败”保存/事件**全部在 `work.close()` 返回之前**完成；返回后没有任何写入。上一轮草稿上同一探针观察到的“close 返回后才保存、才发事件”已经消失。

### 2.3 关闭期间的生产者（检查点 3、4）
- 正常路径（`app.ts:57`–`:65`）：按 work.close → service.close → scene.idle 的顺序关闭（`:96`、`:85`、`:78` 的登记顺序反过来），然后 `:63` 关事件日志，最后 `:64` 释放锁。资产轮询在 service.close 里中止并等待结束；场景操作都在作品队列里，已由 work.close 排空。没有发现日志关闭后仍会改 files/tasks/events 的路径。`EventLog.close` 之后拒绝写入（`events.ts:36`、`:57`）只是额外保险，真正的屏障是前面这几步等待。
- 失败路径：任何关闭项抛错，其余关闭项照常执行，但 `:62` 会直接抛出，**不关日志、不放锁**。初始化失败时（`:210`–`:212`）走同一个 closeAll，规则相同：如果事件日志在构造阶段就失败，`closeEvents` 已赋值或尚为空都能正确处理，没有 closer 失败时会正常放锁。
- 线上入口 `index.ts:17` 在信号到来时执行 `void app.close()`。关闭失败会变成未处理的 rejection，进程以退出码 1 结束；锁文件留下的是已死进程的 PID，下次启动可以按死 PID 接管；预览 worker 在 IPC 断开后自行退出。这一行为是安全的，但依赖默认的未处理 rejection 行为，见建议 S2。

### 2.4 测试是否有辨别力（检查点 5）
- `events-lock.test.ts:77`–`:160`（真实 HTTP /version）：在关闭边界上要求锁仍在、第二实例返回 `INSTANCE_LOCKED`、事件和文件都已落盘。在 d79c467（preClose 里直接 closeAll）上这一条会失败，Pi 的 `takeover-n4-shutdown.json` 就是这种失败形态。
- `:162`–`:249`（submit / selection / cancel 三种模式）：在 `events.close` 的边界上比对 `tasks.json` 与内存，并断言 close 之后文件和日志字节都不再变化。spy 只用来卡住时序，调用的仍是实例上的真实包装器。cancel 模式的 spy 在包装器**之前**等待，所以它验证的是 HTTP 排空，不是 `inFlight`。
- `work/service.test.ts:37`–`:63`（直接调用，带/不带 selection）：去掉 `inFlight` 后，`:52` 断言 `failed` 会因为 execute 还没跑而失败，`:47` 拿到的也会是旧错误码，所以这条测试能辨别实现有没有修好。
- `:251`–`:274`：只把 `work.close` 换成拒绝，资产照常关闭；断言锁仍被持有、日志仍可写，确实测的是失败时保留所有权。
- 资产测试（dae89c7）：`lux3d.test.ts`、`service.test.ts` 只加了透传 native fetch 的 spy，用来记录端口和 cause，然后原样抛出，并在 afterEach/finally 里恢复。**没有重试，断言没有改动或放宽。**
- Fake Agent 只替换了 `CodingAgent.prototype.run`；被验收的关闭逻辑（`app.ts` 的 closeAll、`service.ts` 的 close 和包装器）都没有被替身代替。

## 3. 完整验证证据（亲自核对）

`docs/reports/artifacts/M2-N4/e468c20-job_de0c9cc8/`：
- `evidence.json`：head、finalHead 都是 e468c20；`lockHash`（pnpm-lock.yaml）首尾一致，均为 `50e02a0c…1725`；`finalStatus` 为空；`passed=true`。**44 步**全部 `exitCode=0`、`signal=null`，每一步的 head、headAfter、lockHashAfter、statusAfter 都与开始时一致，逐项检查后不符合的步骤数为 0。
- 步骤：7 包 typecheck、7 包 build、5 轮 × 6 个测试包（templates 没有 test 脚本，所以是 6 包）。每轮日志：server 27 个文件/134 项，studio 7，shared 68，插件 20，scene-renderer 5，bridge 1（node test 格式），合计 **235**，五轮相同，没有 skip/todo/失败。`events-lock.test.ts`（8 项）和 `work/service.test.ts`（8 项）在五轮里都通过。
- 局限：五轮只说明同一提交在本机这次是稳定的。资产测试历史上的偶发失败根因仍未定位（日志里只看到预期内的 abort 记录）。验证脚本把完整的 `process.env` 传给了子进程，这不影响本次结论。

## 4. 剩余问题

| 级别 | 编号 | 位置 | 内容 |
| --- | --- | --- | --- |
| 阻断 | — | — | 无 |
| 应修 | — | — | 无 |
| 建议 | S1 | `app.ts:99`、`:208`；Fastify 默认 `keepAliveTimeout=72s` | **关闭时正处理请求的长连接，会把 closeAll 和放锁推迟约 72 秒**。实测（临时目录、假 key、e468c20 真实 createApp）：在作品队列里卡住一个 `GET /version` 后调用 close。客户端带 `Connection: close` 时，应答 310ms、放锁 310ms；客户端是 keep-alive 时，应答仍是 311ms，**放锁要到 73 272ms**。原因：preClose 时 Fastify 只关闭当时空闲的连接，请求处理完后变空闲的连接要等 keepAliveTimeout 到期。这是安全的，锁多保留一段时间；N4 的测试都用 `agent:false` / `connection: close`，所以看不出来。Studio 经 Vite 7.3.7 代理访问后端，代理会设 `connection: close`，不受影响；受影响的是直连的 keep-alive 客户端（脚本、Pi 的 fetch 大约多 4 秒）。建议在 closing 后用 onSend 加 `Connection: close`，或在 onResponse 里 `closeIdleConnections()`，并给整个停机设上限。 |
| 建议 | S2 | `index.ts:17` | `void app.close()` 关闭失败时，靠未处理 rejection 来结束进程。建议显式 `.catch(记录日志 → process.exit(1))`，保证“关闭失败 → 保锁 → 退出 → 下次按死 PID 接管”不依赖 Node 的默认行为；也可以给第二次信号或停机超时设定明确策略。 |
| 建议 | S3 | `app.ts:210`–`:212`；`events-lock.test.ts:251`–`:274` | 初始化失败且某个 closer 也失败时，按设计保留锁，同一进程里重试会得到 `INSTANCE_LOCKED`。这与“无法确认生产者已停就不放锁”一致，但与 N3 的“修配置后可在同进程重试”是取舍关系，建议写入实现说明。另外，cancel 的 `inFlight` 登记只被拒绝路径覆盖，可以补一条“已接收的直接 cancel 被 close 等待”的单测。 |

## 5. D3 / R6 证据范围（只核对已完成证据）

- 已确认是**测试统计口径的误报，已纠正**：旧的全局计数匹配到计数用的 cmd/powershell 自身（上一轮已用探针确认）。`cf8f8df` 的 `zz-kill.spec.ts` 改为按 backend/worker 身份（PID + 创建时间）判定，并保留 decoy 负向对照。
- `job_11ed6da0`：job.json 记录 `state=exited`、`exit_code=0`；output.log 显示 **5 passed（57.3s）**——只杀 backend PID、整树强杀、同一 backend 下 3 个候选、预览尚未 ready 的启动窗口、负向对照。evidence 中的 `environment.head` 是 `e0584426…`，各场景 `gone=true`、`stillAlive=[]`、无残留；多候选的 3 个端口与 origin 杀后都是 0；启动窗口场景在 origin=502、worker 已存在时杀进程。e058442 与 e468c20 之间 `preview.ts`/`preview-worker.ts` 没有差异，所以这些证据对生产预览代码有效。
- **尚未覆盖或不能推出的部分**：
  - 每个场景只跑了一次。
  - 没有在合并后的冻结 HEAD 上跑。
  - 没有覆盖“上次 IPC 自退失败留下的孤儿，在重启时被清理”：生产代码没有启动时的孤儿清扫，这次的证据也没有涉及。
  - 跑在主工作树上，生成的 `isolation-r6-attributed-*.json` 尚未提交，前三份覆盖了 cf8f8df 提交时的版本；首轮原件保存在 `d3-run-c0b6a407/`。
- 因此 R6/D3 现在可以表述为：“误报已纠正，五场景在 e058442 各通过一次”。**不能**表述为“启动、多候选、重启遗留孤儿全部覆盖”，也不要为了让旧计数归零去改生产预览代码。

## 6. 验证边界

- 只写了本报告。运行过的临时探针（全部用系统临时目录、假 key、回环地址，用完已删除；没有读 `.env`，没有调用模型或 Lux3D）：
  1. Fastify 的 close/onClose 顺序与请求体读入中的请求（只用依赖包）；
  2. e468c20 真实 createApp 在 keep-alive 与 `Connection: close` 两种客户端下的放锁时间；
  3. e468c20 真实 WorkService 的 submit 与 close 竞态复测。
- 没有自己跑 typecheck、build 或整套测试，以第 3 节核对过的 job_de0c9cc8 证据为准；没有改动 m2d3 工作树。
