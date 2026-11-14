# M3-A 测试 mock 监听端口修正

当前补修标准 `pnpm typecheck`、`pnpm build`、`pnpm test` 全部通过，单测 **289 项**。只涉及测试支持代码与夹具；独立复审与合并后 Pi 完整验收仍待完成，M3-A 未收口。下文保留首版 b66e1f4 的实现与 287 项历史；最新范围和结果见末节。

## 触发与诊断

Pi 的 run4（job_d7e19d77，冻结 e6b177ff42547c0089842667ec75e6f962d01d55）在 server 单测失败：`agent/client.test.ts:62` 预期 no-tools 响应触发 `AGENT_PROTOCOL`，实际约 14ms 得到 `AGENT_UPSTREAM`；server 178/179，Studio 与七套 E2E 未运行。原目录 `run-20261114-m3a-4/` 保留。本次不是 5000ms 超时，不修改协议断言或产品错误码。

本机 `netsh int ipv4 show dynamicport tcp` 为起点 1024、数量 13977（到 15000）；本地 Node 24.14.1 的 Undici 禁用端口表包含 6000、6665 等，最高为 10080。夹具使用 `listen({ port: 0 })` 时可能得到内核可监听但 fetch 拒绝访问的端口。

隔离对照 job_708ba780 使用真实 no-tools mock 与原 CodingAgent：

| 监听 | node:http 控制 | 原客户端 fetch | 请求是否到 mock |
|---|---|---|---|
| 6000 | HTTP 200，assistant、空 tool_calls | 底层 `TypeError: fetch failed`、cause=`bad port`，映射 `AGENT_UPSTREAM`，约 2.8ms | 客户端请求未到达 |
| 20000 | 相同 HTTP 200 响应 | 正确触发 `AGENT_PROTOCOL`，约 9.5ms | 客户端请求到达 |

该对照复现了同样的失败路径并证明端口选择可影响协议测试。**run4 当时未记录端口或底层 cause，无法断言它的历史唯一原因就是禁端口**；此前资产测试偶发失败也不据此自动关闭。

## 首版 b66e1f4 修正范围（历史）

- 新增仅由测试导入的 `src/test-support/fetch-listener.ts`，直接在 loopback 绑定随机高位端口，成功后将同一监听交给调用方。没有“探测空端口后释放再绑定”的竞争窗口。
- 最多考察 32 个候选；只有 `EADDRINUSE` 才关闭失败实例并分配下一候选。其他绑定错误原样抛出，关闭失败也停止分配。没有 HTTP、模型调用、断言或整项用例的自动重试。
- 8 个原测试文件共 9 处由 fetch 访问的 mock/HTTP 监听接入该支持代码，覆盖 Agent、作品服务/API、资产服务/恢复和 Lux3D 取消测试；N4 使用 node:http 的真实请求监听保留原 port 0。
- 7 项回归覆盖禁用候选、占用后清理、非占用错误传播、清理失败、分配耗尽、真实 HTTP 可访问/关闭、真实 Fastify 端口冲突不影响原监听者。原协议、取消、超时、权限和候选断言未改。
- 产品客户端/服务端、业务超时、依赖/锁、server worker 配置及上轮四个集成预算不变。不修改本机 TCP 动态端口设置。

代价与限制：高位端口仍可能被占用；连续 32 次无法分配时明确失败，而非无限尝试。端口范围依据当前 Node fetch 的禁用表选取，未来运行时改变策略需重新核对。测试支持代码位于 src，会随既有测试文件一起被 tsc 编译，但生产入口未导入它。

## 首版验证与归档（历史）

- job_37193743 为新增支持代码的预期 RED：模块尚未实现导致收集失败，五项当时没有执行，不能描述为五项断言失败。真实传输边界的 RED 由上述固定端口对照提供。
- 实现后 job_a479e370 顺序执行标准 typecheck/build/test，三个步骤 exit 0、signal null，HEAD、锁、diff、十个受测路径的物理 SHA256 与 Git blob id 前后一致。
- 单测 **287/287**：shared 68、plugin 20、bridge 1、scene-renderer 5、server 186、Studio 7；没有过滤、跳过或重试。新增 7 项通过（约 113ms），原 client 4 项通过。新增回归使总数由 280 变为 287，不沿用旧计数。
- 验证是在 c2f79f8227466e908d064c81e49d530cc264756e 加十个固定未提交路径上进行，证据明确记录 dirty 状态；报告不冒称验证时已有后续提交号。本轮没有执行 E2E。

归档：`artifacts/M3-A/mock-port-20261114/`，含固定端口对照、RED 输出、标准验证三段日志/证据、运行入口和 SHA256 清单。原 `.data`、run1–run4、checkpoint 与此前 stability 目录均保留。所有请求仅 loopback/假 key，未读取真实 `.env`，未调用真实模型/Lux3D。

## 独立审查后补修（当前）

Claude 的 job_76d1d6e5 对首版有条件通过：原 9 处接线正确，但 `isolation.test.ts`、`work/preview.test.ts` 两处 fetch 随机监听遗漏（F1 应修）；另提出 Windows 排除端口 EACCES、bridge 浏览器随机端口、非法候选消耗尝试次数的三条建议。首版 287 项通过不能代替这些整改后的验证。

- **F1**：新增 `listenServerForFetch(createServer)` 适配器，接受创建原生 Server 的工厂，端口冲突时每次使用新实例；两处遗漏的外部 fetch 监听均接入，保留全部状态码/权限/代理断言。首版 8 文件 9 接点现扩为 10 个原文件 11 个外部 fetch 监听接点。
- **S1**：仅 win32 的监听绑定 `EACCES` 也可在清理后重新分配候选，仍最多 32 次；其他平台 EACCES 保留原样抛出，其他异常与清理失败也停止。耗尽错误保留最后一次绑定 cause。旧“其他错误”回归改用 EIO，保证仍检查非候选错误不会被吞掉。
- **S2**：bridge 的浏览器测试监听改为 20000–65535 的直接绑定、最多 32 次，只在 EADDRINUSE 或 Windows 绑定 EACCES 时重新分配，没有浏览器动作或测试重试，也未改变原交互断言。测试内部独立实现这段小型分配逻辑，避免 bridge 依赖 server 私有测试目录。
- **S3**：注释明确非法候选也占用一次候选预算。
- **继续追踪实际客户端**：`fs-boundary.test.ts` 与 `preview-recovery.test.ts` 原来直接 fetch 内部生产 worker 的随机端口，生产代理实际使用 node:http。本次改为 `getInternalPreview` 的真实 node:http GET，保留成功/403、完整正文不泄漏与父进程死亡后连接失败的原断言。原生产端口分配与代理逻辑不变。新增正文/断连回归验证探测 helper 不会丢弃正文或把掉线当成功。
- Node HTTP 自身访问的 N4、下载、预览源请求以及内部代理上游仍使用原端口方式；生产入口、业务时限、旧测试预算、依赖/锁未改。

RED/绿灯：job_97a678d8 在首版上实际执行 8 项，7 通过、Windows EACCES 新回归 1 失败。随后 job_df16928e 在 b66e1f46734925ebb46ab93e5a159a5412bfa62d 加九个固定 dirty 路径上跑标准三步，均 exit 0、signal null、identityPreserved=true，九路径 SHA/Git blob 与锁/diff 前后一致。验证时尚未有新提交号。

当前单测 **289/289**：shared 68、plugin 20、bridge 1、scene-renderer 5、server **188**、Studio 7；无筛选、跳过或重试。监听分配器 8 项通过（含 Windows EACCES），正文/断连 1 项通过，bridge 原浏览器测试 1 项通过。当前证据在 `artifacts/M3-A/mock-port-review-20261114/`，首版及 run1–run4/checkpoint 原件不改写。本轮未执行七套 E2E。

额外边界：Pi 的 E2E harness `freePort()` 也由 port 0 分配且由 fetch 轮询就绪，该测试接线尚未在本隔离分支修改，将交 Pi 在下一轮正式回归启动前核对并处理；不因当前 server/bridge 全绿就宣称完整回归已过。历史 run4 未记录端口/cause 的限制仍保留，不宣称历史唯一根因已确定。
