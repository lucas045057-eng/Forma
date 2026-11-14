# M3-A mock 监听端口修正 · Claude Code 独立审查

- 日期：2026-11-14。角色：独立审查，只读，未改实现、测试、配置、依赖或锁文件，未提交，未写项目记忆。
- 固定提交：**`b66e1f46734925ebb46ab93e5a159a5412bfa62d`**（feat/m3a-approvals）；比较基线 **`c2f79f8227466e908d064c81e49d530cc264756e`**。`.worktrees/m3a` 在开始和结束时都是 HEAD=b66e1f4、工作树干净。
- 依据：b66e1f4 的 `M3-A-mock-port-impl.md`、证据 `docs/reports/artifacts/M3-A/mock-port-20261114/`、主线 `M3-A-stability-review.md`；本机 Node 24.14.1 的 fetch 行为，以及本机 Windows TCP 排除端口范围。

## 1. 结论

**有条件通过：修正方向正确，接入的 9 处也都正确，但同类问题还没有修完，有 1 条应修。** 没有阻断。

- Agent 协议断言的那类失败（run4 中 `client.test.ts:62` 期望 `AGENT_PROTOCOL` 却得到 `AGENT_UPSTREAM`）已经由 helper 覆盖，没有绕过真实协议失败。
- 但 server 标准套件中还有 **2 处测试**仍让 `fetch` 连接 `port 0` 随机分配的监听（应修 F1），会以同样的机制偶发失败。
- 修完 F1 并补跑一次标准全量后可以转为通过。即使通过，也只说明这次补修可以集成；M3-A 仍需 Pi 在合并后新冻结的主线上完整验收，M3-B/M3-C 尚未开始。

## 2. 修正是否正确

### 2.1 机制与边界
- 本机实测 Node 24.14.1 内置 fetch：`6000`、`10080` 报 `bad port`，`10081`、`20000` 报 `ECONNREFUSED`（说明会真正发起连接）。这与 Fetch 规范 bad port 列表的最大值 10080 一致。本机动态端口范围是 1024 起共 13977 个（`netsh … show dynamicport tcp`），因此 `listen(0)` 可能分到 bad port。helper 改为在 `randomInt(20_000, 65_536)`（即 20000–65535）中直接绑定（`fetch-listener.ts:15`、`:19`）。这个范围避开了全部 bad port，也不在本机的动态端口范围内。
- 这是修正测试的监听方式，不是绕过：mock 仍是真实的 HTTP/Fastify 服务，客户端仍走生产代码中的 `CodingAgent`/`Lux3DClient`/fetch。协议、权限、取消、超时和候选相关断言都没有改动。

### 2.2 helper 的生命周期（`apps/server/src/test-support/fetch-listener.ts`）
- 绑定成功后直接返回仍在监听的实例（`:22`–`:23`），不存在“先探测、关闭、再绑定”的竞争窗口。
- 绑定失败时先 `close()` 本次创建的实例（`:25`），只有 `EADDRINUSE` 才继续尝试（`:26`）；其他错误照常抛出；close 自身失败也会抛出并停止尝试。最多 32 次（`:17`），超过就报错。不会关闭别人已有的监听。
- `listenHttpForFetch` 的适配器（`:33`–`:56`）：`once('error')` 和 listen 回调中的 `off` 成对；只有在 `listening` 时才 `closeAllConnections` 和 `close`，所以绑定失败的服务器不会被误关，也没有泄漏的 socket。
- 7 条回归（`fetch-listener.test.ts`）：禁止端口不会被采用、冲突时先关闭再重试、其他错误会抛出、清理失败会停止、尝试次数有上限、真实 HTTP 用原生 fetch 可以访问并能关闭、真实 Fastify 端口冲突时不会关闭已有监听者且后者仍可访问。覆盖面足够，而且后两条用的是真实服务器，不是 mock。

### 2.3 接线范围
- 8 个文件共 9 处，都是把 `create + listen({port:0})` 换成 `listenForFetch(...)`/`listenHttpForFetch(...)`，没有其他改动（`client.test.ts:13`、`app.test.ts:11`、`lux3d.test.ts:18`、`recovery.test.ts:18`/`:120`、`assets/service.test.ts:31`、`m2-api.test.ts:14`、`task-id.test.ts:12`、`work/service.test.ts:17`）。
- 没有生产代码引用 `test-support`（`git grep` 结果只有测试文件）。helper 位于 `src/`，会随 tsc 一起编译进构建产物，这与报告说明一致。
- 正确保留 `port 0` 的地方：`events-lock.test.ts` 用 `node:http` 的 `get`/`request` 访问；`download.test.ts` 的 `downloadGlb` 用的是 `node:http(s).get`（`download.ts:3`–`:4`）；`preview-origin.test.ts` 没有使用 fetch；生产代码 `preview.ts` 中的 `freePort` 对应的是 `probe`，用的是 `node:http` 请求（`preview.ts:19`–`:25`），浏览器也只通过 preview-origin 代理访问。这些都不受 fetch 端口限制，**不算遗漏**。

### 2.4 证据
- `standard-validation/evidence.json`：status 为 passed，typecheck/build/test 三步都是 exit 0、signal null、身份一致（5505/7998/91317ms）。`test.log`：shared 68、plugin 20、scene-renderer 5、bridge 1（skipped 0）、server 186（31 个文件，含 `fetch-listener.test.ts` 7 项，113ms）、Studio 7，**合计 287，无失败或跳过**。
- 验证是在 c2f79f8 加十个未提交路径上运行的，报告如实说明了这一点。我逐一对比证据中记录的 `gitBlob` 和 `git rev-parse b66e1f4:<path>`，**10 个全部一致**；同时记录物理 SHA 与 blob id，也采纳了上一轮的建议 S2。
- 报告没有声称已确定历史失败的唯一根因，也没有关闭资产偶发问题的调查，表述是如实的。

## 3. 应修

### F1 · 还有两处 fetch 连接 `port 0` 监听的测试没有接入 helper
- 位置：
  - `apps/server/src/isolation.test.ts:19`（`createPreviewOrigin` 返回的服务器 `listen(0)`）与 `:26`（循环中 5 次 `fetch(http://127.0.0.1:${port}…)`）；
  - `apps/server/src/work/preview.test.ts:17`（代理服务器 `listen(0)`）与 `:20`、`:23`、`:26`（`fetch(base…)`）。上游 `:11` 由代理通过 `node:http` 访问，这一处不受影响。
- 触发：操作系统给这两处分到 bad port（本机动态范围内有 1719、1720、1723、2049、3659、4045、4190、5060、5061、6000、6566、6665–6669、6679、6697、10080 等）时，fetch 会立即抛出 `TypeError`（cause 为 bad port），断言报错，与 run4 的机制完全相同。job_708ba780 已经证明这个机制在 6000 端口上成立；本轮我用 fetch 实测，6000 和 10080 都被拒绝。
- 影响：概率较低，但在 server 标准套件中每次运行都会遇到，这次补修声称要消除的偶发失败没有完全消除。报告中“8 个原测试文件共 9 处由 fetch 访问的 mock/HTTP 监听”的范围不完整。
- 修法：
  - 这两处同样接入 helper：`createPreviewOrigin(...)` 已经是 `http.Server`，可以给 `listenForFetch` 加一个接受现成 server 的适配器，或在 helper 中加一个 `listenServerForFetch(createServer)` 变体（预览代理同理）；
  - 在报告中修正接线范围，并补跑一次标准全量。
  - 断言和预算都不需要改。
- 验证限制：本轮没有为这两处真的分配到 bad port 去复现失败（以免占用端口），依据是代码路径加上已经实测成立的 fetch 机制。

## 4. 建议

| 编号 | 位置 | 内容 |
| --- | --- | --- |
| S1 | `fetch-listener.ts:26` | Windows 的“排除端口范围”中的端口绑定时返回 `EACCES`，不是 `EADDRINUSE`，helper 会直接抛错，不会换下一个候选。本机 `netsh … show excludedportrange` 在 20000–65535 内有 `50000–50059`（带 * 的托管排除，实测可以绑定）、`50080`、`50443`；实测 `50080`、`50443` 绑定都返回 **EACCES**。在本机，每次分配命中的概率约为 2/45536，很低。但装了 Hyper-V/WSL/Docker 的机器上，排除范围常常有上百到上千个端口。建议在 win32 上把 `EACCES` 也当作“换下一个候选”处理（仍然只在绑定阶段、仍然 32 次上限），其他错误继续抛出。 |
| S2 | `packages/bridge/src/index.test.mjs:19`、`:24` | Chromium 有自己的不安全端口列表（同样包含 6000、6665–6669、10080 等，访问时报 `ERR_UNSAFE_PORT`）。这个测试用 `listen(0)` 后由 `page.goto` 访问，同样可能偶发失败。它不属于 fetch，也不在 server 包内，所以列为建议；可以复用同样的高位端口分配策略。 |
| S3 | `fetch-listener.ts:19` | 不合法的候选端口也会消耗一次尝试；`nextPort` 只用于测试注入，目前没有问题。建议在注释中写明。 |

## 5. 验证范围与限制

- 静态审查了 `git diff c2f79f8 b66e1f4`、全部剩余的 `port 0` 监听及其客户端、证据 JSON 和日志、blob 对照。
- 运行过的短探针：
  - 原生 fetch 访问 6000/10080/10081/20000（都是本地没有监听的端口，只观察错误类型）；
  - 对 50030、50059、50080、50443、40123 各做一次毫秒级的 `listen` 后立即关闭，观察 Windows 排除端口返回的错误码；
  - 读取 `netsh` 的端口范围。
- 没有创建项目临时数据，没有占用项目默认端口，没有跑构建、单测、E2E 或任何服务，没有读 `.env` 或 ASKS 全文，没有调用模型、Lux3D 或外网。
- 证据只来自一次标准全量；Studio 之外的七套 E2E 本轮没有运行，需要由 Pi 合并后验收。

## 复核（F1与监听边界，a0f10a8）

- 日期：2026-11-14。固定 HEAD：**`a0f10a86792bb655fe56bdcce5c19eb1b9287469`**；比较基线为上一轮的 `b66e1f4`。`.worktrees/m3a` 在开始和结束时都是 HEAD=a0f10a8、工作树干净。本节只追加，上一轮的“有条件通过”与 F1 历史保留不动。
- 范围：`git diff b66e1f4 a0f10a8` 共 9 个文件，**全部是测试文件或仅供测试使用的支持代码**（`test-support/*`、6 个 `*.test.ts`、bridge 的 `index.test.mjs`）。生产代码、业务超时、vitest 配置、依赖和 lockfile 都没有改动；生产代码中也没有对 `test-support` 的引用。
- **结论：F1 关闭，S1–S3 的处理都合适，没有新的阻断或应修。这次补修的代码复核转为“通过”。** 这不代表 M3-A 已完成验收：Pi 的 E2E harness `freePort` 同样会随机分配 port 0 并被 fetch 就绪探测使用，这个问题不在本 worktree 内，由 Pi 在正式回归前另行修正；合并后仍须在新冻结的主线上做完整回归（含七套 E2E）。M3-B/M3-C 尚未开始。

### F1 · 关闭
- `fetch-listener.ts`：新增 `listenServerForFetch(create: () => Server)`，`listenHttpForFetch` 改为复用它，生命周期与上一轮已审过的适配器相同（绑定失败时不会误关，成功后保持监听）。每次尝试都会调用 `create()` 新建一个服务器，未绑定成功的实例没有句柄，不会泄漏。
- `isolation.test.ts`：`createPreviewOrigin(work.previews)` 改由 helper 绑定，5 次 `fetch(baseUrl+url)` 仍断言 404，付费/写入/提交/采用的 spy 都未被调用的断言保留。**Host 边界仍然成立**：preview-origin 比较的是 Host 端口与**自身实际监听的端口**（`preview-origin.ts:13`、`:20`），不是固定的 5175，所以换端口后 404 仍是经过 Host 校验后的路由结果，而不是被拒绝。
- `work/preview.test.ts`：外层 proxy 改用 helper；上游服务器（`:12`）只由 `PreviewManager.proxy` 通过 `node:http` 访问，继续使用 port 0，这是正确的。
- 剩余随机监听的**实际客户端**我逐一核对过：`download.test.ts`（`node:http(s).get`）、`events-lock.test.ts`（`node:http` 的 `get`/`request`）、`preview-origin.test.ts`（`net.connect`）、`http-get.test.ts`（`node:http`）、生产代码 `preview.ts:12`（由 `node:http` 的 probe 和代理访问）。都不受 fetch 端口限制。测试中剩下的 `fetch(` 只有 `isolation.test.ts` 和 `preview.test.ts`，都已改用 helper 分配的端口。

### 新增的 Node HTTP 探测（fs-boundary / preview-recovery）
- 这两处原本用 fetch 直接访问由生产 `PreviewManager` 随机选取的 worker 端口，与 F1 是同一类问题，上一轮我也漏掉了，这次一并修正。`test-support/http-get.ts` 用 `node:http` 的 `get`（`agent:false`、`connection: close`）读取完整响应，返回真实的状态码和全部正文分块（`:9`–`:15`），请求或响应出错都会 reject（`:11`、`:16`）。
- 断言含义没有减弱，反而更严格：fs-boundary 的 200/403 和“正文不泄露”的断言保留。preview-recovery 的“父进程死亡后连接失败”原来用 fetch 时，**如果 worker 端口恰好是 bad port，fetch 会立即 reject，这个断言就会空洞地通过**；改用 `node:http` 后，只有真正连接失败才算通过。`http-get.test.ts` 用真实服务器验证了 403 状态、分两块写出的正文被完整拼接（`PRIVATE-SENTINEL`）、以及断开连接时 reject。
- `vi.waitFor` 的 10s 超时和其他业务超时都没有改。

### S1–S3
- **S1**：`fetch-listener.ts:30`–`:31` 只在 `EADDRINUSE`，或 win32 下的 `EACCES` 时才换下一个候选；其他平台的 `EACCES`、`EIO` 等其他错误、以及 close 失败都会停止。仍然最多 32 次，耗尽时的报错会带上最后一次绑定错误作为 `cause`。回归测试按平台分支断言：Windows 下换下一个候选，非 Windows 下原样抛出；原来的“其他错误”用例改用 `EIO`。这与上一轮实测（本机 50080、50443 绑定返回 `EACCES`）对应。
- **S2**：bridge 测试的 `listenForBrowser` 在 20000–65535 中最多尝试 32 次，复用同一个 `http.Server`（Node 允许在 listen 出错后再次 listen），`once/off` 成对，处理哪些错误码与 server 包的 helper 相同。只调整监听，浏览器的启动、操作和断言都没有改，也不依赖 server 包的测试代码。Chromium 的受限端口也都在 10080 以内。
- **S3**：注释已写明非法候选也计入 32 次。

### 证据
- `standard-validation/evidence.json`：status 为 passed，typecheck/build/test 均 exit 0、signal null、身份一致（19586/14923/96242ms）。`test.log`：shared 68、plugin 20、scene-renderer 5、bridge 1（真实浏览器 pass 1，fail 0，skipped 0）、server 188（32 个文件，其中 fetch-listener 8 项、http-get 1 项）、Studio 7，**合计 289，没有失败、跳过或重试**。
- 验证是在 b66e1f4 加 9 个未提交路径上运行的，报告如实说明了这一点。证据中记录的 9 个 `gitBlob` 与 `git rev-parse a0f10a8:<path>` **全部一致**。上一轮报告的原文快照（`incoming-review-b66e1f4.md`）和旧证据目录都保留着，历史上“run4 端口未知、不宣称唯一根因”的限制也照样保留。

### 建议（不影响结论）
- RS-a `test-support/http-get.ts:8`：探测请求没有设置自己的超时。如果 worker 已经接受连接却一直不响应，只能等 vitest 用例超时才失败（不会误判为通过）。可以考虑加一个短的 socket 超时，让失败信息更明确。
- RS-b：`listenForBrowser` 与 `listenForFetch` 的分配策略各自维护了一份（为了避免跨包依赖，这是合理的）。以后修改其中一份时应同步另一份，可以在两处注释中互相注明。

### 本节验证范围
只追加本节，没有改实现、测试或其他报告，也没有提交。全部是静态核对：diff、剩余随机监听及其实际客户端、`preview-origin` 的 Host 判定、证据 JSON 和日志、9 个 blob 对照。本轮没有运行任何探针、构建、单测、E2E 或服务，没有创建临时数据，没有读 `.env` 或 ASKS。上一轮已实测的 fetch bad-port 行为和 Windows `EACCES` 行为直接引用，没有重跑。
