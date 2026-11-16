# Lux3D 错误处理器注册顺序修补

起点 `76282dc20fc5eae6ac317ba2af4a0f6d194be68b`。CodeBuddy 两次未返回完成信号，根检查没有部分产品改动后接手。

## 问题与最小变更

已有失败轮四类 API 的状态为400/409，但 `body.error.code` 不存在。根追踪本机 Fastify 源码：`lib/route.js` 在 after 队列中保存当时的 errorHandler；`setErrorHandler` 创建新对象而非回溯更新所有路由 context。产品先 await 注册 Lux3D upload 子插件和其它路由、websocket，之后才安装统一处理器，存在路由已绑定默认处理器的顺序问题。

本批仅将原 `app.setErrorHandler` 的完整回调提前到 `registerLuxWorkbench` 之前。所有分支、状态码、错误码、消息与 fallback 原样保留；上传的 octet-stream parser 继续仅在子 scope 内。Host/Origin onRequest 规则与位置不改：Fastify `_addHook` 会向子实例递归传播，不能把 handler 快照机制推断为防护绕过。

原失败轮缺少完整响应正文，因此上述是源码因果定位，不伪称已抓到 Fastify 默认 envelope。Pi 仍在另一棵固定762验收树执行已授权的四例定向采集，未受本批实现树修改影响。

## 回归

新增 `lux3d-http-contract.test.ts`，使用真实 `createApp` 与 `app.inject`：

- upload 子 scope 的 INVALID_IMAGE/INVALID_GLB envelope；
- workbench INVALID_OPERATION_INPUT/409 IDEMPOTENCY_CONFLICT；
- 旧导入 API 的 INVALID_TASK；
- upload、workbench、旧资产和 tasks 路由的 HOST_DENIED/ORIGIN_DENIED。

只有远端 createProviderTask 边界替换为立即拒绝的桩，防止任何云创建；参数校验、插件、路由、真实任务存储和错误处理均未替换。幂等例等待实际首次调用并断言仅一次，不固定 sleep。测试数据独立 temp 目录，清理核对真实路径后进行。

已有 E2E 失败是该合同的红态证据；新增回归尚未执行。没有提高旧超时、删改旧断言或依赖/锁。

## 唯一交付检查计划

新提交固定后，使用本机不入库入口 `.data/lux3d-http-contract-check.mjs`：workspace typecheck → 一次 server Vitest（新合同测试、原 app、isolation、speech/routes 共四文件）。白名单环境、禁 bootstrap，不读取 env/ASKS/真实凭据；Git tracked 类型感知身份前后、stdout/stderr/退出码/计数留证。只使用本地 API 注入与原测试的 loopback fixtures，不跑完整 E2E/build/全量/真实云。

本报告写入时没有运行上述检查，不能宣称可编译或修复通过。旧 run、Pi 树、live20884/39743 和主线保持不变。
