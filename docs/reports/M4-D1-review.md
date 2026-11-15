# M4 D1 语音后端 · 独立只读代码审查（Claude Code）

- 日期：2026-11-15。审查人：Claude Code（独立审查，不实现、不提交、不合并，不替代 Pi 验收）。
- 对象：`.worktrees/m4`，分支 `feat/m4-demo`。审查时核对：HEAD 为 **`aa43c2a31d5236d1ba1228b63647384c6a4ceb39`**，tracked 干净。产品实现 `cb2237a`，标准验证实际受测 `d005c23`；`aa43c2a` 只是文档归档。
- 范围：`git diff d6ec495..cb2237a`，共 10 个产品/测试文件：`apps/server/src/app.ts`、`speech/{client,service,routes}.ts` 及其 3 个测试文件、`packages/shared/src/index.ts`、`apps/studio/vite.config.ts`、`apps/studio/src/dev-proxy.test.ts`。对照 `docs/design/M4-plan.md` §3 和我此前的设计审查 S1–S4（`docs/reports/M4-design-review.md`，原文未改）。
- 没有读 `.env`、ASKS、凭据；没有运行 build、测试、服务或探针；没有调用真实模型、语音或 Lux3D；没有修改任何实现、测试或受审 HEAD；没有创建工作树。

| 标记 | 含义 |
|---|---|
| **【代码核查】** | 我逐行读冻结源码得出的结论。 |
| **【引用实现证据】** | `job_fe569815`（typecheck、build、547 项单测）和 47 项定向测试的结果。我没有重跑。 |

## 结论

**blocker 0，should-fix 0，建议 7 条。** 设计审查的 S1–S4 在代码中都已落实，测试覆盖了真实 HTTP 连接、真实流读取和关闭边界。**D1 代码审查通过，可以接 D2。** 7 条建议都不阻断，可在 D2 或 Pi 验收时顺带处理。

**证据限度**：目前所有转写结果都来自 loopback mock，**没有任何真实阿里调用**。真实协议的兼容性（返回格式、Data URI 与 WebM 是否被接受、业务空间域名格式）、识别质量和延迟都没有证据。mock 测试通过不能算作真实语音能力。

---

## S1–S4 落实情况【代码核查】

**S1 关闭时机：已落实**
- preClose 中先 `closing = true`，再立即调用 `speech.beginClose()`（`app.ts` 新的 preClose 钩子）。`beginClose` 封住准入，并 abort 当前在途请求（`service.ts:105-108`；本节行号均为文件内行号）。
- onClose 中，`closeAll` 只等待请求 settle：`speech.close` 就是 `idle`，等的是 `active.settled`。
- speech 的 closer 最后登记，所以在逆序关闭时最先执行，排在 work、assets、scene、事件日志和锁之前，没有破坏 N4 顺序。
- 新请求在 preClose 之后会被全局 onRequest 返回 503，在 `join` 时则返回 `SPEECH_CLOSING`。
- 测试：`boundary.test.ts:177` 和 `lifecycle.test.ts:88` 用真实 HTTP 验证，停机不会等满 35 秒。

**S2 4xx 状态映射：已落实**
- 在语音路由的封装作用域里设了 `setErrorHandler`（`routes.ts:7-16`）：`FST_ERR_CTP_*` 的 400/413/415 被映射为安全错误码，其他错误交给上层处理器。
- 路由级 `onRequest` 在读取请求体之前就校验 MIME 和 UUID，非法请求不会上传 4MiB 才被拒（`routes.ts:21-24`）。
- 音频解析器只在这个作用域内注册，`bodyLimit` 为 4MiB；全站 16KiB 的 JSON 上限没有改动。
- 测试：`routes.test.ts:119`（超大、不支持、空 body、JSON 冒充音频）断言响应不含 `FST_ERR`、假 key、Data URI 和诱饵域名，且上游调用计数为 0；`routes.test.ts:170` 断言现有 JSON 路由的上限没有被放大。

**S3 端点白名单：已落实**
- `client.ts:30-40` 只允许三类主机：`dashscope.aliyuncs.com`、`dashscope-intl.aliyuncs.com`，以及锚定的 `<ws>.(cn-beijing|ap-southeast-1).maas.aliyuncs.com`。
- 同时要求：https，默认端口，不带 userinfo、query、hash，路径固定为 `/compatible-mode/v1`；fetch 使用 `redirect:'error'`。
- loopback 例外只能通过内部构造参数 `testLoopback` 打开。`createApp` 从环境变量读取配置时不会设置它（`app.ts` 中 `options.speech ?? {env…}`）；即使打开，也只放行 http 协议的 127.0.0.1、::1、localhost。
- model 固定为 `qwen3-asr-flash`；key 含换行即拒绝启动；所有错误都映射为固定文案，不回显上游内容或 key。
- 测试：`boundary.test.ts:23-46`、`:62`。

**S4 消费者与取消的归属：已落实**
- 上游请求归服务所有，按消费者计数（token 集合）；只有最后一个消费者离开、超时或关闭时才 abort（`service.ts:33-54`、`:88-92`）。
- 断开检测用 `reply.raw.writableFinished`，正常写完的响应不会被当成取消；连接已销毁时有兜底处理（`routes.ts:30-34`）。
- 显式取消走 `DELETE /speech/transcribe/:id`（`routes.ts:36-39`），会等上游真正 settle 后才返回。
- 迟到的成功结果，被 `!controller.signal.aborted` 判断和 `finish` 的幂等性丢弃（`service.ts:78`、`:66-67`）。
- 同一 ID、MIME 或字节不同返回 409；另一个 ID 正在处理时返回 429；完成结果缓存 5 分钟，最多 32 条，不保留音频。
- 测试：`lifecycle.test.ts:54/65/73` 用真实双连接验证断开、DELETE 和正常完成；`boundary.test.ts:113/127/141/155`。

**其他合同项**
- 35 秒预算从上游请求开始计时，覆盖响应体读取：读流循环每轮都检查 signal，fetch 本身也带 signal（`client.ts:72-93`）。上游响应真正按流计数，超过 256KiB 立即 `reader.cancel()`。返回文字必须非空且不超过 4000 字，与任务指令上限一致；JS 的 `.length` 按 UTF-16 计，比 Ajv 的码点计数更严。
- 音频只在内存中；缓存只保存结果；日志中不出现音频或 key。
- Studio 代理新增 `/speech` 路径，`dev-proxy.test.ts` 用真实 Vite 代理验证了 POST 的方法、MIME、请求 ID 和字节透传。
- 全局 Host/Origin 门禁在语音处理之前生效（`routes.test.ts:161`）。

## 新守卫与标准轮的证据【引用实现证据】

旧标准轮那 2 个失败，已有证据定位：是验证用的出站守卫拦截了纯 IP 字面量的 lookup，使旧的 download 负例在 `publicAddress` 校验之前就报了另一个错误码。

新守卫只在两个 DNS 分支中放行 `net.isIP` 确认的字面量；域名解析、非 loopback 的 TCP 和 fetch 仍然被拒绝。5 组 canary 和原 download 测试的全部 11 项都通过。新标准轮绑定的是新守卫的身份证明，没有借用旧的 GREEN 结果。

这是对验证工具的修正，不涉及产品代码。按实现方的证据，产品、原测试、依赖和锁相对 `cb2237a` 零差异。我认同这个定性：问题出在测试工具，不是产品。

---

## 建议（suggestion，非阻断）

1. **语音配置写错会导致整个后端起不来**【代码核查】。`SpeechClient` 构造时，如果 `SPEECH_BASE_URL` 或 `SPEECH_MODEL` 非法就直接抛错（`client.ts:36-37`、`:64`），`createApp` 随之失败，任务、场景、检查等全部功能都不可用。快速失败能防止带着错误配置运行，但影响面过大。可以二选一：降级为 `enabled=false`，并在启动日志中输出安全提示（不含 URL 或 key）；或者保留快速失败，在 D5 runbook 中写明。补一条负例，把预期行为固定下来。
2. **35 秒只覆盖上游阶段，不覆盖请求体上传**【代码核查】。请求体读取发生在 `join` 之前，不在 35 秒预算内。Fastify 默认 `requestTimeout` 为 0，一个缓慢上传的连接可以长时间占用，`app.close()` 排空 HTTP 时也会等它。服务只监听本机，Host/Origin 门禁拦掉了外部页面，同源 Studio 是一次性上传 Blob，所以实际风险低。建议在设计和报告中写明“35 秒从上游请求开始计”。可选：路由级上传超时，或关闭时对上传中的连接强制断开。
3. **真实协议需在首次真实调用时核对**。`client.ts:79-80`、`:95` 假设请求为 `input_audio.data` 的 Data URI，返回文字在 `choices[0].message.content` 字符串里；业务空间域名只放行 cn-beijing 和 ap-southeast-1 两个区域（`client.ts:34`）。这些都只出自计划对官方文档的转述，没有真实调用验证。如果真实返回的 `content` 是数组，或者用户的业务空间在其他区域，会安全失败（502 或拒绝启动），不会泄露信息，但功能不可用。拿到凭据后的第一次真实调用应专门核对这几项，并在报告中标明。
4. **上游 401/429 都映射为同一个 `SPEECH_UPSTREAM`**（`client.ts:81`）。界面和运维无法区分是“鉴权失败”还是“额度或限流”。可以增加不泄密的细分码（例如 `SPEECH_UPSTREAM_AUTH`、`SPEECH_UPSTREAM_RATE`），只用于提示，不回显上游的 message。
5. **代理测试只覆盖了 POST**。`dev-proxy.test.ts` 没有验证 `DELETE /speech/transcribe/:id` 和 `GET /speech/config` 是否经过真实 Vite 代理。前缀代理理应覆盖它们，但 D2 的取消按钮要依赖 DELETE，建议补这两条。
6. **取消返回 499**（`service.ts:53`、`:98`、`:107`）。这是非标准状态码，仍在等待的消费者会收到它。D2 前端要按 `error.code === 'SPEECH_CANCELLED'` 判断，不能依赖状态码；在共享类型或注释中写明。
7. **缓存中的错误结果会原样返回 5 分钟**。同一请求 ID 在 5 分钟内重复发送，会拿到当初的失败或取消结果。这符合“重试是用户的新动作”的合同，但 D2 每次重试都必须生成新的 UUID，在 D2 任务卡中写明，避免用户“重试”时一直收到旧错误。

## 判定

- D1 实现在代码层面满足 §3 合同和设计审查 S1–S4，没有阻断项或应修项。**可以开始 D2**（D2 派发前，设计审查中的 S5 场景模式隐藏不卸载、S6 选中对象变化，仍需按原结论写进 D2 设计）。
- 本审查不是验收结论：Pi 的独立 E2E 尚未执行，真实阿里语音调用没有任何证据，mock 转写不代表真实识别质量。
