# M3-A 测试 mock 监听端口修正

测试夹具现在直接绑定 20000–65535 范围的端口，并保留成功的真实监听。标准 `pnpm typecheck`、`pnpm build`、`pnpm test` 全部通过，单测 287 项。本次只涉及测试支持代码与夹具；仍需独立审查、合并后 Pi 完整验收，M3-A 未收口。

## 触发与诊断

Pi 的 run4（job_d7e19d77，冻结 e6b177ff42547c0089842667ec75e6f962d01d55）在 server 单测失败：`agent/client.test.ts:62` 预期 no-tools 响应触发 `AGENT_PROTOCOL`，实际约 14ms 得到 `AGENT_UPSTREAM`；server 178/179，Studio 与七套 E2E 未运行。原目录 `run-20261114-m3a-4/` 保留。本次不是 5000ms 超时，不修改协议断言或产品错误码。

本机 `netsh int ipv4 show dynamicport tcp` 为起点 1024、数量 13977（到 15000）；本地 Node 24.14.1 的 Undici 禁用端口表包含 6000、6665 等，最高为 10080。夹具使用 `listen({ port: 0 })` 时可能得到内核可监听但 fetch 拒绝访问的端口。

隔离对照 job_708ba780 使用真实 no-tools mock 与原 CodingAgent：

| 监听 | node:http 控制 | 原客户端 fetch | 请求是否到 mock |
|---|---|---|---|
| 6000 | HTTP 200，assistant、空 tool_calls | 底层 `TypeError: fetch failed`、cause=`bad port`，映射 `AGENT_UPSTREAM`，约 2.8ms | 客户端请求未到达 |
| 20000 | 相同 HTTP 200 响应 | 正确触发 `AGENT_PROTOCOL`，约 9.5ms | 客户端请求到达 |

该对照复现了同样的失败路径并证明端口选择可影响协议测试。**run4 当时未记录端口或底层 cause，无法断言它的历史唯一原因就是禁端口**；此前资产测试偶发失败也不据此自动关闭。

## 修正范围

- 新增仅由测试导入的 `src/test-support/fetch-listener.ts`，直接在 loopback 绑定随机高位端口，成功后将同一监听交给调用方。没有“探测空端口后释放再绑定”的竞争窗口。
- 最多考察 32 个候选；只有 `EADDRINUSE` 才关闭失败实例并分配下一候选。其他绑定错误原样抛出，关闭失败也停止分配。没有 HTTP、模型调用、断言或整项用例的自动重试。
- 8 个原测试文件共 9 处由 fetch 访问的 mock/HTTP 监听接入该支持代码，覆盖 Agent、作品服务/API、资产服务/恢复和 Lux3D 取消测试；N4 使用 node:http 的真实请求监听保留原 port 0。
- 7 项回归覆盖禁用候选、占用后清理、非占用错误传播、清理失败、分配耗尽、真实 HTTP 可访问/关闭、真实 Fastify 端口冲突不影响原监听者。原协议、取消、超时、权限和候选断言未改。
- 产品客户端/服务端、业务超时、依赖/锁、server worker 配置及上轮四个集成预算不变。不修改本机 TCP 动态端口设置。

代价与限制：高位端口仍可能被占用；连续 32 次无法分配时明确失败，而非无限尝试。端口范围依据当前 Node fetch 的禁用表选取，未来运行时改变策略需重新核对。测试支持代码位于 src，会随既有测试文件一起被 tsc 编译，但生产入口未导入它。

## 验证与归档

- job_37193743 为新增支持代码的预期 RED：模块尚未实现导致收集失败，五项当时没有执行，不能描述为五项断言失败。真实传输边界的 RED 由上述固定端口对照提供。
- 实现后 job_a479e370 顺序执行标准 typecheck/build/test，三个步骤 exit 0、signal null，HEAD、锁、diff、十个受测路径的物理 SHA256 与 Git blob id 前后一致。
- 单测 **287/287**：shared 68、plugin 20、bridge 1、scene-renderer 5、server 186、Studio 7；没有过滤、跳过或重试。新增 7 项通过（约 113ms），原 client 4 项通过。新增回归使总数由 280 变为 287，不沿用旧计数。
- 验证是在 c2f79f8227466e908d064c81e49d530cc264756e 加十个固定未提交路径上进行，证据明确记录 dirty 状态；报告不冒称验证时已有后续提交号。本轮没有执行 E2E。

归档：`artifacts/M3-A/mock-port-20261114/`，含固定端口对照、RED 输出、标准验证三段日志/证据、运行入口和 SHA256 清单。原 `.data`、run1–run4、checkpoint 与此前 stability 目录均保留。所有请求仅 loopback/假 key，未读取真实 `.env`，未调用真实模型/Lux3D。
