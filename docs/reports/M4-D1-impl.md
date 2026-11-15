# M4-D1 语音后端实现记录

状态：D1 原47项定向验证通过，产品固定 cb2237a；首轮标准459通过/2失败、Studio未运行。新守卫定向已通过五组canary与download原11项，失败原件和新证据已归档，尚待文档冻结后的完整标准轮。不能把新守卫冒称为旧47项GREEN的同一身份。Claude独立代码审查与Pi验收未完成，D1未正式收口。

## 基线与本轮范围

工作树 `.worktrees/m4`，分支 `feat/m4-demo`，从固定设计提交 `d6ec495fa6bb9cf30961dfb2e7240ee03c606e40` 创建。初始 tracked 干净；`HEAD:apps = 8df06a9b57fd8e00e98a0eb946ad9b6b5c8f64a8`；锁 Git 对象 `3c8dba901b5be775ad3502cc523468e174cbc586`。未修改主树或任何旧工作树，没有复制 fallback。

依据任务卡 `orbital/coordination/m4/d1-speech-backend.md` 全文与修订设计 `docs/design/M4-plan.md` §3/§8/§10；原始 Claude 设计审查针对 cf9576d，本报告不声称 d6ec495 修订已独立复审。

本轮在已确认 RED 上实现 D1 语音后端草稿与边界验证，未开始 D2 录音 UI、D3 资产、D4 视觉或 D5 彩排。没有更改 Pi E2E、旧阈值、历史报告或历史证据。

## 首批合同测试（12 项已收集，首轮仅执行首项）

`apps/server/src/speech/routes.test.ts` 定义 12 项 HTTP 合同：缺配置诚实禁用且不借编码 key；配置不泄露 key/base；带 codecs 的 raw WebM 经固定模型、单 Data URI 与假 Authorization 请求 loopback 上游；4MiB+1/不支持 MIME/空音频/JSON 冒充音频分别在上游前安全拒绝；必需 UUID；未知取消 404 不创建调用；正常完成与重复读取缓存不被 DELETE 改写、同 ID 异内容 409；Host/Origin 拒绝；旧 JSON 路由不接受新增 binary parser 或大 body。

测试的 `speech.testLoopback` 是计划接入 AppOptions 的内部构造参数，不可由普通生产 env 或 HTTP 打开；本轮未为测试添加任何生产旁路。所有模型、Lux3D 配置均为 fake key 与固定 loopback，不会提交其它业务。

扩展 `apps/studio/src/dev-proxy.test.ts`：沿用现有真实 Vite 反代测试、`httpServer.listen(0)` 和 finally 清理，增加 GET `/speech/config`、携 UUID 与真实 raw 音频字节的 POST、DELETE 转发验证；原有接口与字节断言保留。仅将代理 target 替换为测试自身的 loopback stub，不绕过真实后端路由用例中的 Host/Origin 校验。

## 验证入口与证据

依赖已在首轮通过离线 frozen 安装，后续本轮不重复安装。`.data/d1-red.mjs` 从白名单构造新环境，不继承调用者密钥、NODE_OPTIONS 或网络代理；只设置假业务 key、loopback 地址，并显式加载本卡 `.data/d1-loopback.cjs` 守卫。守卫限制 fetch、TCP 及 DNS 到明确 loopback，拒绝信息写入本轮独立日志。不会读取真实 .env 或运行 dev/server dev。

原入口先执行 `pnpm install --offline --frozen-lockfile --ignore-scripts`，已成功，无依赖或锁改动。本次入口移除安装步骤，只依次执行：

1. `pnpm --filter @spatial/server exec vitest run src/speech/routes.test.ts --bail=1 --reporter=verbose --reporter=json --outputFile=<本轮独立目录>`。
2. 只有前一步 exit 0 才运行 Studio 的 `src/dev-proxy.test.ts` 定向用例；首失败即停，未执行的阶段不记为通过。

每轮输出 `.data/d1-red-<UTC>/`，保存 HEAD、产品树、锁及真实源码/测试字节 SHA256、工作区状态、命令、PID、时间、退出码、原始日志和 JSON；清单排除自身。安装失败属于入口问题；测试必须实际执行并因目标合同缺失失败才可记为 RED，不能把安装/收集失败当成目标红灯。

本轮未重跑已通过的 M3 baseline、501 单测、旧 E2E、全仓构建或类型检查。取得带通知 job 后立即交回并冻结文件，不轮询或另起监视作业。

## 首轮实际结果与夹具修正

`job_2ffe7154` exit 1，原件 `.data/d1-red-2026-11-15T06-21-54.942Z/` 保持原字节不改写。离线安装成功，`identityUnchanged=true`。12 条已收集，因 `--bail=1` 仅首个测试运行：GET `/speech/config` 期望 200 实际 404，是目标合同缺失的真实 RED；另外 11 条 pending 未运行，代理阶段未调度。不能写成 12 failed，也不能称纯目标 RED。

同时存在独立 `Failed Suites`：afterAll 错误调用 `upstream.mock.close()`，而 `listenHttpForFetch` 实际返回 `{server, baseUrl}`，导致 TypeError。此次仅修测试夹具：关闭两个自有 app，按 helper 的真实返回结构对自有 server 执行 closeAllConnections 并 await close 回调，再实探该 loopback 端口必须 ECONNREFUSED；各关闭步骤独立保留错误，失败保存诊断并以 AggregateError 使测试失败，保留临时目录，不吞拆除错误。新 run 经 `D1_RUN_DIR` 保存含 PID、上游地址/端口、关闭状态及错误的 `speech-cleanup-<pid>.json`。

只读资源核对（2026-11-15T06:23:32.1533944Z）：原 Vitest PID 9504 已不存在，命令路径属于 m4 的 node/cmd/conhost 数量 0，其自有监听 0；未结束任何进程。首轮未记录具体 mock 端口，因此不补造其端口归属，后续夹具新增当场记录并验证关闭。

首轮全部 5 份原始文件与原执行入口额外逐字节保留至 `.data/d1-first-red-preserved/`，`preservation.json` 列出来源/字节/SHA256 和定性；复制不修改旧 run 的 log/JSON/manifest。新的同范围 RED 使用新目录、跳过已成功的安装，不修改生产实现，不并行修改受测文件。新结果返回前不宣称拆除验证通过；干净目标 RED 确认后再进入 D1 实现及其它任务卡负例。

## 干净 RED 与本次生产草稿

第二轮 `job_0fd1468c` exit 1，原件 `.data/d1-red-2026-11-15T06-25-21.663Z/` 保留，未再重复 RED 或安装。原始日志只有 GET `/speech/config` 期望 200 实际 404 的首条目标失败，余 11 条 pending、代理未调度；没有 Failed Suites 钩子错误。`speech-cleanup-33476.json` 记录两 app closed、serverListening=false、port=56924/portClosed=true、directoryRemoved=true、errors=[]；identityUnchanged=true。Vitest 聚合 numFailedTestSuites 不是实际失败文件数，本文以真实断言、文件与钩子日志定性。

先写新增 `boundary.test.ts`、`lifecycle.test.ts` 的目标边界，再写如下实现；新增边界已在后续 GREEN 实际通过，但没有逐项执行修复前 RED，不冒称每个边界都单独取得过 RED。

- `speech/client.ts`：固定 qwen3-asr-flash、单 Data URI、stream=false、Node fetch、redirect=error；精确官方 HTTPS 主机与锚定业务空间形式、默认 443/固定 base 路径及无 userinfo/query/hash，内部 testLoopback 不读 env。流式 256KiB 上限，非空且至多 4000 字，响应错误只映射安全码。不记录上游 body/音频/key。
- `speech/service.ts`：35 秒总预算（内部测试只可缩短）；同 UUID/MIME/音频摘要复用进行中或终态、异内容409、其它 ID 忙429；当前上游直到真实 settle 才释放占位；终态 32 条/5 分钟，不保留音频。每消费者独立释放，最后异常断开才 abort；DELETE、预算、preClose 取消共享调用；先固定终态，迟到成功不能覆盖。DELETE 等实际 settle，completed 只表示已结束，不重写失败/成功结果。
- `speech/routes.ts`：封装子作用域三种音频 parser 与转写路由4MiB，POST onRequest 在继承 JSON parser 前拒绝非音频；UUID、可判定格式头、空/大包校验；仅局部 FST_ERR_CTP_* 的已知400/413/415安全映射。继承原 Host/Origin/关闭准入；正常 writableFinished 的 close 不记取消，消费者监听器最终移除。GET config 不含 base/key，DELETE 未知ID404。
- `AppOptions.speech` 仅内部配置与测试短预算；生产从独立语音环境变量读取，不借编码key。preClose 同步封准入并 abort，不能等待 HTTP；原 onClose closeAll 先 settle speech，再沿原 work/asset/scene/EventLog/锁屏障顺序关闭。shared 增加仅公开安全语音类型，Studio 增加 `/speech` 代理。

## 新增边界与定向 GREEN

`boundary.test.ts` 包含精确域名/协议/路径拒绝且零请求、官方形式接受（仅构造不联网）、内部loopback也拒远端；真实loopback 401/429/500与坏JSON/空/4001字、重定向不跟随/不泄露鉴权；响应流第一块就超256KiB立即cancel；真实未完成响应体触发内部短预算并中断传输。服务级独立gate验证单上游、冲突/忙、断一个继续、全断取消、显式取消两消费者并等真实settle、迟到成功不翻终态、32条/5分钟缓存及关闭准入。gate/fetch替身与真实HTTP在测试名中明确区分。

`lifecycle.test.ts` 用真实后端和loopback流式上游：同ID双HTTP连接断一个后另一个仍成功；双断开使上游响应传输中断；真实 DELETE 取消两个等待连接并保留取消终态；生产35秒预算下进行中的 app.close 显著提前完成并返回取消，不等满预算。只关闭自身服务器，关闭错误向测试传播；未启动 preview、模型、Lux3D 或外部服务。

首次 GREEN `job_c8723f0d` exit1，原件 `.data/d1-green-2026-11-15T06-37-50.098Z/` 未改写：shared-typecheck exit0；server-typecheck exit2，TS2345 位于 routes.test.ts:135，默认参数 randomUUID() 被推断成 UUID 模板类型，非法字符串负例在编译阶段被挡住。identityUnchanged=true。studio-typecheck、speech 三文件与真实代理阶段均未调度，实际测试 0 执行，不能记成测试失败或通过。

本次仅把测试助手 requestId 显式注解为 string，空串及 not-a-uuid 原负例不变，不 cast 成 UUID、不改生产校验。`.data/d1-green.mjs` 从 server-typecheck → studio-typecheck → speech 三文件 → 真实代理单文件续验，shared 未变故不重跑，首失败即停。输出新 `.data/d1-green-<UTC>/`，继续记录白名单环境下的命令/PID/时间/退出、源码测试真实字节、HEAD/锁、原始日志/JSON与排除自身的SHA清单；不重复安装、RED、M3 baseline、501全量或Pi E2E。未返回的步骤绝不记为通过，草稿保持未提交实现状态，期间冻结文件。

## 定向结果、归档与冻结（2026-11-15）

`job_55d2232d` exit0，原 run `.data/d1-green-2026-11-15T06-39-35.911Z/`：server-typecheck、studio-typecheck、speech-tests、proxy-test 四步 exit0，逐步及整体 identityUnchanged=true。原始 Vitest JSON 逐文件/逐断言复核：后端3文件46 passed、0 failed、0 pending；Studio1文件1 passed；合计47项，不用 numFailedTestSuites 推断实际文件数。shared-typecheck 在上一轮 exit0，后续源码字节未变，不重复检查。以上是实现侧定向验证，不是正式独立验收。

完整分轮归档 `docs/reports/artifacts/M4/D1/targeted-20261115/`：

| 子目录 | 作业及真实事实 |
| --- | --- |
| 01-red-fixture-error | job_2ffe7154：安装成功，首条404目标失败，11 pending；另有拆除钩子错误，代理未运行 |
| 02-clean-red | job_0fd1468c：仅首条404目标失败，11 pending；拆除与端口释放通过，代理未运行 |
| 03-type-error | job_c8723f0d：shared typecheck成功、server TS2345失败；实际测试0执行，其余阶段未调度 |
| 04-targeted-green | job_55d2232d：server/studio类型成功、后端46与代理1项通过 |

各自保留原 manifest、日志、JSON、cleanup、原清单与 launcher cmd/job/exit/output.log。`entries/` 保存对应运行入口及守卫：01/02/04为当时入口字节，03入口根据仅已记录的 mode/共享命令变更逆向还原，并与原 manifest 的 SHA256 完全相同；不是重跑或补造执行结果。所有历史原件未改写。

`verification.json` 记录原始结果解析、182份 GREEN 身份文件的当前字节核对（仅报告后续增补不属于受测产品）、全部16份 cleanup、各轮守卫日志状态与当前资源检查。16份清理记录均 errors=[]，相关 listening=false；HTTP cleanup-45196 的两 app closed、端口32204已关闭、临时目录已删。各轮未产生非空 network-denied.jsonl；这表示预加载守卫未记录拒绝，不冒充完整网络包捕获。

2026-11-15T06:43:41.4065362Z 当前 OS 只读核验：原 run/步骤/worker PID无存活、记录端口监听0、m4自有 node/chrome 进程0，未结束任何进程。templates及默认scene配置、依赖清单和锁均相对固定基线零diff，实际字节亦与 GREEN 一致。

归档 `.gitattributes` 禁用文本换行转换；`sha256-manifest.json` 明确排除自身，列出60个载荷文件及来源/字节/SHA256，生成后静态重算60/60一致。四轮分开保存，不把失败轮或历史通过成绩计入本次47项，也未重复安装、RED、定向测试或Pi E2E。

精确提交 D1 client/service/routes、三份 speech 测试、AppOptions与钩子、shared类型、Studio代理/真实代理测试、本报告与专用证据。提交前核对暂存的产品对象与 GREEN 对应文件的 Git归一化对象一致，同时保存受测原始字节SHA256；不能把工作区CRLF与blob LF差异当成产品改动。提交号由交付消息提供，不为写回提交号再移动冻结 HEAD。

## 未覆盖与下一步

在新固定 HEAD 上通过根 `orbital/coordination/m2-takeover/bg-root.cmd` 启动单轮 `pnpm typecheck` → `pnpm build` → 标准 `pnpm test`，首败即停。输出新的 `.data/d1-standard-<UTC>/`，白名单环境、fake keys、loopback守卫、无dev/env-file，记录 HEAD/锁/真实源码测试字节、命令/PID/时间/退出和原始日志及排除自身的SHA清单。取得 job 即结束本轮，期间冻结，不预写全仓通过或预填测试总数；不拿M3的501项抵扣新验证，不额外启动服务或原生服务入口。

标准轮实际失败及后续守卫定向处理见下节；不自行合并、不抢做D2–D5。

未运行真实阿里语音或验证语音质量/延迟，没有付费模型或 Lux3D 调用、真实录音 UI、正式 Pi E2E 或整体验收结论。

## 标准失败：验证守卫抢先拦截纯 IP lookup

`job_71627189` exit1，受测固定 `cb2237a40da8aa7a5ebe720085038e558fdb8f73`，run `.data/d1-standard-2026-11-15T06-46-35.875Z/`，整体 identityUnchanged=true。typecheck exit0、build exit0、test exit1。按原始日志分别解析 Vitest 与 Node test runner：shared68、source-tag插件20、renderer5、bridge1、server365通过/2失败；实际合计459通过/2失败。Studio单测未调度，不能写成547减2或全仓接近通过。

两项均为旧 `assets/download.test.ts:58` 的重定向安全负例：`https://10.0.0.1` 与 IPv4-mapped IPv6 期望 UNSAFE_OUTPUT_URL，却得到 DOWNLOAD_DNS。原守卫日志恰有两条 blockedHost=10.0.0.1、::ffff:7f00:1。download.ts先做lookup再做publicAddress；旧守卫把纯IP字面量的本地lookup也提前拒绝，导致尚未进入产品安全地址判断就变为DNS错误。这是验证守卫干预，不改产品或旧安全断言来迁就守卫。

本轮归档 `docs/reports/artifacts/M4/D1/standard-20261115-guard-interference/`：原标准日志/manifest/守卫日志/全部cleanup与原SHA清单、launcher原件、失败时准确守卫 `guard-before.cjs` 和标准入口 `standard-entry-before.mjs`。原清单另存 original-sha256-manifest.json，避免与新归档清单混名；新清单排除自身，29个载荷生成后逐字节静态复算一致。原 `.data` 与既有已提交历史证据均未改写。

`verification.json`记录15份cleanup均无错误，290份当时来源文件字节核对；2026-11-15T06:53:46.9208563Z只读OS核验原PID、m4自有node/chrome、记录端口均无残留，未结束任何进程。

### 本次仅守卫 DNS 分支修正

`.data/d1-loopback.cjs` 仅在 dns.lookup 与 dns/promises.lookup 分支增加 `typeof host === 'string' && net.isIP(host)` 的本地解析快路径，交给原生lookup处理字面量；不放行其它域名DNS，不改net.Socket.connect和global.fetch的loopback限制，私网/公网IP实际连接依旧禁止。不增加任何阿里域名/DNS后缀例外，不关闭守卫，不删除拒绝日志。生产、原download实现/11项测试、依赖、锁及Pi E2E完全不改。静态复核其余289份原身份文件字节未变，旧标准入口及其门禁亦未变；守卫SHA256从 `cfaee3abbae61a06691220c669f129613279739227fc5bf1d58bc66b00fe05e4` 变为 `aef54b3cb7bd72c338aacd1784ced2ac6cf1a2d0da1549841f61b0d5ee6a2136`，精确差异只有两个DNS字面量分支。

`.data/d1-guard-targeted.mjs` 在新run先验证守卫，再跑旧download.test.ts完整11项；只有前一步通过才进入下一步，不重跑标准全轮、安装或speech定向。运行身份同时记录固定产品HEAD、新旧守卫SHA与源码/原测试SHA，并精确验证guard只变了两个DNS分支。

守卫探针 `.data/d1-guard-probe.cjs` 先装原生边界canary，再无条件加载同一新守卫，任何网络动作都在加载后；这样能证明非loopback域名DNS、TCP、fetch在原生调用前就被拒绝，即使守卫有错canary也会阻止负例外联。原生边界计数检查、私网/公网/mapped IPv6/域名负例与loopback真实连接正例分别记录；单独拒绝日志保留预期负例，不与download阶段日志混淆。实际download进程仍使用NODE_OPTIONS预加载同一守卫，没有无守卫测试窗口。

### 守卫定向实际结果与文档冻结

`job_3154fb57` exit0，原 run `.data/d1-guard-targeted-2026-11-15T06-58-56.026Z/`。guard-verification.json 五组全 passed：IPv4/IPv6 字面量 callback/promise 本地lookup；非loopback域名DNS在两个原生边界前拒绝；私网/公网/mapped TCP 在原生connect前拒绝；域名/IP fetch 在原生fetch前拒绝；loopback DNS/TCP/fetch正常。原生 canary 调用只含允许的IP字面量和loopback，28个预期拒绝均另存探针日志，关闭后 probe serverListening=false。

download.test.ts 完整11项 passed、failed0、pending0；下载阶段没有守卫拒绝日志。manifest identityUnchanged=true，产品/原测试仍为cb2237a字节，旧 `.data/d1-standard.mjs` 和原旧GREEN哈希门禁保持原字节。新 guard SHA256 为 `aef54b3cb7bd72c338aacd1784ced2ac6cf1a2d0da1549841f61b0d5ee6a2136`，与 guard-before/after 及 validated-guard-identity.json 一致；该证明仅覆盖本轮守卫+11下载，不扩展为47项 speech GREEN 的新身份。

新增归档 `docs/reports/artifacts/M4/D1/guard-targeted-20261115/`：原manifest/日志/下载JSON、guard-verification及28拒绝日志、validated-guard-identity、guard前后、五组探针、目标入口/旧标准入口原件、launcher及原SHA清单；新清单排除自身，21载荷生成后静态复算一致。本轮无app实例，不虚构独立app cleanup；download沿用原afterEach真实服务器关闭，probe关闭状态已记录。2026-11-15T07:01:51.4053638Z只读核验相关PID和m4自有进程无残留，未kill任何进程。

精确文档归档提交（提交号随交付回报），相对cb2237a的apps/packages/templates/tests/依赖清单/锁必须零diff、tracked干净。随后创建明确新版本 `.data/d1-standard-v2.mjs`，expectedHead固定该docs提交；其守卫门禁要求SHA等于已归档 validated-guard-identity.json，并逐文件核该证明的载荷与当前守卫/归档字节，同时核旧产品字节不变。不是删除或绕过旧身份检查，不修改旧入口。

使用新入口从头执行且仅执行一次 `pnpm typecheck → pnpm build → pnpm test`，首败即停、新run目录、fake key/loopback白名单、无dev/env-file。拿job立即冻结交回；实际返回后才从日志计数，不预填通过数量。未重跑安装、RED、47定向、守卫定向或Pi E2E，不改产品凑绿。全轮通过后仍需Claude独立审查，D1未收口、不merge、不做D2–D5。
