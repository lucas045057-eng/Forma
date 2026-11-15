# M4 设计独立只读审查（Claude Code）

- 日期：2026-11-15（初次派审 12:04 被额度中断，14:09 续审完成）。审查人：Claude Code（独立审查，不实现、不提交、不合并）。
- 对象：固定 master **`cf9576ddafef872ac2e600f680135d6ec091ec75`** 的 `docs/design/M4-plan.md`（D1–D5）。产品为已受审的 `393fe9f`，M3 收口于 `276f0f9`；本审查不重审 M3。
- 对照的实际源码（只读）：
  - `apps/server/src/app.ts`：bodyLimit、onRequest 准入、错误处理、preClose/onClose/closeAll。
  - `apps/server/src/index.ts`：信号处理。
  - `apps/server/package.json`：dev 脚本。
  - `apps/server/src/assets/service.ts`：`importLocal`、`start`、`exclusive`、`close`。
  - `apps/server/src/scene/service.ts`：`adopt`。
  - `packages/shared/src/index.ts`：`Asset` 类型。
  - `apps/studio/src/PointSpeak.tsx`、`App.tsx`、`SceneEditor.tsx`。
  - 模板 `scene.config.json` 与 `public/assets/`，以及 `fallback/` 文件清单。
- 没有运行 build、测试、服务或探针；没有创建工作树；没有读 `.env`、ASKS、凭据；没有调用真实模型、语音或 Lux3D。计划引用的阿里官方 Qwen-ASR 文档我**没有独立打开核对**，涉及协议细节的结论以计划自述为准，并标“未核实”。

## 结论

- **blocker 0；should-fix 8；suggestion 9。**
- **D1 能否开工**：先在设计中修掉与 D1 直接相关的 3 项应修（S1 关闭时机、S2 4xx 状态映射、S3 端点白名单精确化），然后可以派 CodeBuddy 开工 D1。另外 S4（重复请求共享取消的归属）也属于 D1，篇幅很小，建议一并写清。
- **其余 4 项**：D2 的 S5、S6，D3 的 S7，D5 的 S8。只需在对应卡派发前修完，不阻塞 D1。

---

## 应修（should-fix）

### D1 后端语音

**S1 关闭时，在途的语音请求必须在 preClose 阶段就中止，而不是 onClose**
- 依据：`app.ts:105` 的 preClose 只设置 `closing=true`；`app.ts:233-235` 的注释写明“Fastify 在 preClose 之后排空 HTTP”，`closeAll` 挂在 onClose 上。M4-plan §3.2 第 46 行写“停机先关准入、abort 在途、等待全部生产者结束，再沿用既有 closeAll 顺序”。
- 问题：如果语音服务的 abort 照惯例登记进 `closers`（onClose），它要等 Fastify 把在途 HTTP 排空后才执行。而在途的转写请求本身正是要排空的那个 HTTP，于是停机最长要等满 35 秒，SIGTERM 期间仍在计费。
- 最小修正：设计明确写出，speech 服务在 **preClose** 中封住准入并 abort 全部在途 fetch；在 onClose/closeAll 中只等这些请求 settle。不改变既有的事件日志、锁释放顺序（speech 不发事件，放在 events 关闭之前 settle 即可）。
- 负例：转写进行中调用 `app.close()`，应在远小于 35 秒内结束；mock 上游观察到连接被中止；关闭之后没有返回成功响应。

**S2 现有错误处理会把 413/415 统一变成 500，计划写的状态码目前达不到**
- 依据：`app.ts` 的 `setErrorHandler`（约第 122–131 行）只特殊处理 Scene、Work、Artifact、Snapshot、Asset 几类错误和 validation 错误，其余一律返回 **500 `SERVER_ERROR`**。Fastify 的请求体超限（`FST_ERR_CTP_BODY_TOO_LARGE`，413）、不支持的媒体类型（`FST_ERR_CTP_INVALID_MEDIA_TYPE`，415）、空 body 等错误都会进入这个处理器。M4-plan 第 40 行要求“400/415/413”。
- 最小修正：设计里写明，错误处理器对 Fastify 自带的 4xx 错误（`statusCode` 在 400–499 且 `code` 以 `FST_ERR_CTP_` 开头）保留原状态码，只输出安全错误码（如 `SPEECH_TOO_LARGE`、`SPEECH_UNSUPPORTED_MEDIA`），不回显原始 message。附带说明：现有 JSON 路由的超大 body 目前同样返回 500，这是既有行为，修正对其无害。
- 负例：4MiB+1 字节返回 413；`text/plain` 返回 415；空 body 返回 400；三种情况的响应体都不含内部 message，且上游调用计数为 0。

**S3 “允许的阿里域名/业务空间子域名”需要精确到主机名模式**
- 依据：M4-plan 第 31 行。
- 问题：按后缀放行（如 `*.aliyuncs.com`）会包含任何人都能创建的 OSS bucket 域名之类，配置一旦写错，Authorization 头就会发到第三方可控的主机。配置只来自运营者的环境变量，HTTP 无法注入，所以这不是远程漏洞，但“域名校验”必须足够精确才有意义。另外，“官方协议依据”不等于真实配置已经可用，这一点计划已经写到。
- 最小修正：列出精确白名单，例如 `dashscope.aliyuncs.com`、`dashscope-intl.aliyuncs.com`，以及官方文档给出的业务空间端点形式；采用精确匹配或锚定正则。只允许 https，不允许 userinfo、query、hash 和非默认端口；`redirect:'error'`；内部测试构造只允许固定的 loopback mock。这里的端点形式我未核实官方文档，请 Codex 按 2026-11-15 所读文档填入。
- 负例：`evil.oss-cn-hangzhou.aliyuncs.com`、`dashscope.aliyuncs.com.evil.com`、`http://dashscope…`、`https://user@dashscope…`，以及带 query 的 URL，都应在启动或首次调用前被拒绝，且不发出任何请求。

**S4 重复请求共享同一个上游调用时，“取消”归谁需要写清**
- 依据：M4-plan 第 44 行“同 ID 同 bytes 复用同一进行中 promise”，第 46 行“请求断开……都取消 fetch”。
- 问题：两个 HTTP 消费者共用一个上游 fetch 时，若任一连接断开就 abort 共享 fetch，另一个仍在等待的消费者会被连带取消。另外，在 Node 中，响应**正常写完**后 `reply.raw` 同样会触发 `close`；如果只监听 `close` 而不区分是否已完成，就会把正常结束误判为取消。
- 最小修正：
  - 上游 fetch 归 speech 服务所有，按“仍在等待的消费者”计数；只有最后一个消费者断开、预算超时或服务关闭时才 abort。
  - 判断客户端断开要检查响应是否已经写完：用 `reply.raw.writableFinished`，或在 `close` 时检查 `!reply.sent`。
  - 显式取消用独立的接口或请求，例如 `DELETE /speech/transcribe/:requestId`，不要靠“断开连接”来表达用户的取消意图。
- 负例：
  - 同一 ID 两个并发消费者，其中一个断开，另一个仍拿到结果，上游只被调用 1 次；
  - 两个都断开，上游被中止；
  - 正常完成的请求不会被记成 `SPEECH_CANCELLED`。

### D2 前端录音

**S5 PointSpeak 在场景模式下只是被隐藏，没有卸载，录音不会靠“组件卸载”释放**
- 依据：`App.tsx:208` 用 `<div hidden={showScene}>` 包住选取区和 `PointSpeak`（`App.tsx:218`），切换到场景编辑时组件仍然挂载；PointSpeak 已有 `blocked={!!impact || showScene}`（`App.tsx:218`、`PointSpeak.tsx:12-15`）。M4-plan 第 56 行把“组件卸载、模式切换”作为资源释放的触发条件。
- 问题：按住录音时切到场景编辑或影响查看模式，录音器、麦克风 track 和 timer 会在不可见的状态下继续运行，浏览器的麦克风指示灯一直亮着。
- 最小修正：设计写明 SpeechInput 以 `blocked` 变为 true、`document.visibilityState==='hidden'`、窗口失焦、卸载这四者中任一发生为取消条件，立即停止所有 track、录音器、timer 和在途 fetch，**不能只依赖卸载**。转写进行中如果进入 blocked，丢弃结果、不进入 review。
- 负例：录音中打开场景编辑，所有 track 都变为 `readyState==='ended'`，状态为 cancelled；转写中进入影响查看模式，结果被丢弃。

**S6 录音期间选中对象发生变化时，不能静默套用到新对象**
- 依据：M4-plan 第 60 行写“开始录音记下……selection/baseVersion”和“review 确认后使用当前有效选择，旧选择不能被录音器偷偷恢复”，但没有规定“新选择也不能被静默套用”。“指着说”的核心语义是说话时指着的那个对象。
- 问题：用户指着 A 说“把这个改成圆角”，转写期间又点了 B，确认后指令会被绑定到 B，而且界面上没有任何提示。
- 最小修正：review 草稿保存录音开始时的 `selection.src` 和 baseVersion。确认时若当前选择的 src 或 baseVersion 与之不同，就同时显示两者，要求用户明确选择“用于当前选中对象 B”或“放弃，重新点选 A”。不能自动恢复 A，也不能静默用 B。没有选择时录音、确认时有选择，同样要提示。
- 负例：录音时选中 A、确认前改选 B，必须出现明确提示；未经选择，不能提交带 B 的任务。

### D3 备用资产

**S7 资产来源要绑定在作品里实际采用的模型上，并覆盖模板自带的模型**
- 依据：
  - M4-plan 第 76–78 行：来源存在 AssetService 的记录里，Studio 按 `scene.model` 的 `/assets/<id>.glb` 严格映射去查，查不到就显示“来源未核实”。
  - 模板当前的 `scene.config.json` 是 `"model": "/assets/diffuser-4969889.glb"`，这个文件是模板随仓库提交的，不是 AssetService 资产。
  - `SceneEditor.tsx:103` 已经对这个模型特殊处理了 parts sidecar。
  - `scene/service.ts:125-148`：`adopt` 已经把 `<id>.parts.json` 写进作品的 `public/assets`。
  - D5 第 94 行要求每次演示新建独立的数据目录。
- 问题：
  1. 演示一开场的默认模型（实际是 Lux3D 生成 4969293 再经 part-split 得到 4969889）会显示“来源未核实”。
  2. AssetService 的索引在独立数据目录或换机后为空，回退、重新载入后，已采用模型的来源也会丢失。
  3. 来源跟着 AssetService 的记录走，而不是跟着作品版本走，回退之后可能对不上。
- 最小修正：
  - 让 `scene.adopt` 在写 parts sidecar 的同时，用服务端的资产记录写一份 `public/assets/<id>.provenance.json`，内容为 kind、presetId 或 sourceTaskId、源文件 SHA256、处理后 SHA256、importedAt。客户端和模型都不能写这个文件（Agent 沙箱只能写 `src/`）。
  - Studio 从作品当前版本读取 sidecar，并校验其中的“处理后 SHA256”与实际 GLB 一致，不一致或缺失时显示“来源未核实”。
  - 模板自带的默认模型补一份如实的 sidecar，例如“Lux3D 任务 4969293 → part-split 4969889，预先生成，时间未记录”，由设计者确认措辞。
  - legacy 资产没有 sidecar 时显示 unknown。
- 负例：
  - 新数据目录下首次打开，默认模型显示预先生成的 Lux3D 来源；
  - 采用备用模型后回退，标识跟着回到原模型；
  - 篡改 GLB 字节后显示“来源未核实”；
  - 客户端无法通过任何 HTTP 字段设置来源。

### D5 演示与彩排

**S8 mock 彩排的启动方式不能经过 `pnpm dev`，因为它会自动加载真实凭据**
- 依据：`apps/server/package.json` 的 dev 脚本是 `node --env-file-if-exists=.env --watch src/index.ts`，根目录的 `pnpm dev` 会并行启动它。M4-plan 第 94 行说“不自动读根 .env”，但真实凭据放在 `apps/server/.env`，dev 脚本会直接读取，包括编码服务和 Lux3D 的 key，以后还会加上百炼 key。
- 问题：“无 key 的 mock 连续 3 次彩排”如果按习惯用 `pnpm dev` 启动，会带着真实编码 key 运行，提交任务就会产生真实付费调用，违反“不自动继承 M2 真实十题额度”。
- 最小修正：D5 提供专用的 mock 启动入口，显式构造环境白名单：假 key、loopback 上游、`CODING_AGENT_BASE_URL` 指向 mock、隔离的数据目录，不经过 `--env-file`。启动时检查上游地址必须是 loopback，否则拒绝启动。真实彩排使用另一个入口，并在每轮记录中注明“读取真实配置”。
- 负例：在存在 `apps/server/.env` 的机器上运行 mock 启动入口，上游地址全部是 loopback，出站守卫没有记录到任何非本机请求；如果把上游改成非 loopback，启动入口拒绝启动。

---

## 建议（suggestion，非阻断）

1. **raw parser 放在封装作用域内注册**（D1）：在只包含 `/speech/transcribe` 的 `app.register` 子作用域里，用 `parseAs:'buffer'` 注册三种音频类型，路由级 `bodyLimit: 4MiB`，不要在根作用域注册，避免其他路由也接收音频 body。Fastify 匹配 content-type 时会忽略 `;codecs=opus` 之类的参数，测试要覆盖带参数的形式。
2. **上游响应按流计数读取**（D1）：256KiB 上限要在读取流的过程中计数，超限立即中止，不能先 `response.json()` 整体读完再判断。错误统一映射为安全错误码，不回显上游返回体。
3. **简化请求 ID 去重**（D1）：既然一次只允许一条转写、忙时返回 429，“32 条、5 分钟、活跃项不可淘汰、满了就拒绝”大部分条件不会触发。保留“当前在途 1 条 + 最近结束的少量结果（≤32 条，5 分钟）”就足够，测试也更好写，避免过度设计。
4. **Space 键按住录音**（D2）：要处理 `keydown` 的 `repeat`，并在按钮上对 Space 调用 `preventDefault`，否则松开时浏览器会再触发一次 click。`pointerdown` 时用 `setPointerCapture`，`pointercancel` 和 `lostpointercapture` 都应视为取消。
5. **语音与提交使用同一套门禁**（D2）：开始录音的可用条件，应与 `submittable` 的前置条件（`syncReady`、`connected`、未被 `blocked`、未锁定 `task:create`）一致，避免在不能提交的状态下花费转写额度。
6. **备用资产 ID 与处理结果是否确定**（D3）：用源文件 SHA256 绑定稳定资产 ID 时，如果处理流程（简化、WebP 压缩）输出的字节不完全确定，数据目录重建后重新导入同一 preset，会得到不同字节的同 ID 资产，再次采用时会被现有的 `ASSET_NAME_CONFLICT` 拒绝（`scene/service.ts:141-143`）。建议设计说明处理输出是否确定；如果不确定，资产 ID 应同时绑定处理后的哈希，或者明确接受冲突提示。
7. **本地导入复用现有的安全读取工具**（D3）：`importLocal` 目前是 `copyFile(input, …)`（`assets/service.ts:160`），会重新打开路径。建议复用 `checks/paths.ts` 的 `assertPlainPath` 和 `readPlainFile`：检查祖先链接、单句柄有界读取、读后核对 dev/ino，再写入数据目录。同时把它改为与远端任务一样，登记进 `jobs`，并接受 `abort` 信号，纳入 `close()` 屏障。
8. **画布完整性护栏**（D4）：计划第 86 行的方向正确。建议明确断言内容：对照画布的 `getBoundingClientRect()` 必须完全落在最近一个裁剪或滚动祖先的 padding 盒内；或者容器出现横向滚动条时，状态区显示“画布超出可用宽度”。同时保证装饰层 `pointer-events:none`，不进入焦点顺序。
9. **记账口径写进模板**（D5）：`rehearsal-log.md` 和对照记录表开头固定列出 mode（mock / 真实），以及各项凭据和参与者情况是否具备。M4 收口文案分成“开发/mock 验收完成”和“真实语音、真人 A/B、三次完整彩排”两栏，后者未执行时写“未执行”。计划第 96–98 行已有这一原则，建议直接落进模板字段，防止日后口径混淆。

## 已确认合理、无需修改的设计点

- 音频不写入磁盘、事件日志或任务记录；转写结果只有在用户提交任务时才进入任务存储。
- 一次用户动作只发一次上游请求，不自动重试，也不在阿里失败后自动切换到浏览器识别。
- 浏览器 Web Speech 作为显式选择的备用方式，使用前告知第三方去向，结果同样进入 review。
- 识别完成不自动生成候选；保留原有的生成按钮、Ctrl/⌘+Enter、`canSubmit`、同步/影响模式/场景模式锁和 STALE_SELECTION 处理。
- preset 不接受任何路径或 URL 字段，客户端不能设置来源，旧数据默认 unknown，不伪造生成时间。
- 不自动勾选 force，`webReady` 和部件识别使用真实处理结果。
- 修复请示卡贴边只改卡片自身的外层容器，不恢复 inspector 的 padding 或 border；不使用 CSS transform 缩放画布；作品区不加透明度、滤镜或浮层。
- 真人对照和三次完整彩排未执行前，项目不能标为全部完成；M4 不继承 M2 的真实额度。

## 判定

- **D1 可以开工的条件**：Codex 在 `M4-plan.md` §3 中修掉 S1、S2、S3（建议同时写清 S4），固定新的设计提交，然后派 CodeBuddy 在 `.worktrees/m4` 开工 D1。不需要再向用户请求开工许可，因为持续授权已经覆盖。
- **S5、S6** 在派发 D2 前修掉，**S7** 在派发 D3 前修掉，**S8** 在开始 D5 或任何彩排前修掉。
- 本报告是设计审查，不是任何实现或验收结论；真实语音配置可用、真人对照、三次完整彩排都还没有任何证据。
