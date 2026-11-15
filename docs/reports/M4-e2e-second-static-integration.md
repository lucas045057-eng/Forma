# M4 第二次专项前静态收尾

基于 Pi 固定提交 fc5caf5。Codex 直接修正以下比较前提，未运行新的测试。

1. 原始 GLB 的 preset/sourceHash 与优化后 model.glb 的 outputHash 是两层合同。已有运行原件表明 split 原始素材约 11MiB，处理后约 988KiB，二者哈希不同。现在核对 sourceHash==独立 preset SHA、outputHash==HTTP 下载实际产物 SHA，并在采用后核作品实际 GLB、已验证 sidecar 和场景 model URL。
2. F4 的请求前状态是测试主动写坏后的四文件字节。每个负例现在在写坏之后、发请求之前取基准，断言 409 不改变任何一份，包括不覆盖坏 sidecar。每例响应和前后哈希单独落盘；finally 恢复原 sidecar，历史证据不改。
3. 已有 5175 监听不能仅凭 PID 和创建时间声称自有。复用前要求其与 3001 API 同一身份，并匹配本轮后端网络守卫 loaded marker 的真实 PID；同时真实 health/main preview 应答。demo 自己随机预览端口必须返回 200，不能用任意 404 冒充作品预览。

原 19 例断言、预算、禁止 retry/skip/flaky 的要求保留；生产、脚本、实现侧测试、模板与锁不改。上一专项仍为 13 通过、3 失败、3 未执行，未转写为新提交通过。下一步只安排一次完整 M4 19 例专项，不运行 full 或旧 174。
