# D1：后端语音适配、限额、取消与关闭

角色：CodeBuddy实现；Codex设计/集成；Claude Code独立审查；Pi独立验收。用户持续授权已覆盖此卡，无需重复询问。仅D1，不抢做D2–D5。

## 固定依据与工作树

先读`orbital/PROJECT_STATE.md`、`orbital/instructions/project_goals.md`、`docs/design/M4-plan.md` §3/§8/§10、原始`docs/reports/M4-design-review.md`。原审查0 blocker/8 should-fix，允许设计修S1–S3后开D1，本轮设计已全部回应S1–S8，不假称修订已独立复审。

由调度派发时给固定设计HEAD。在根用`git -c core.longpaths=true worktree add .worktrees/m4 -b feat/m4-demo <固定HEAD>`，先确认目标不存在/分支不被其它树占用；若已存在先核对身份，不删除或重置。实现仅该树，禁止改root/任何旧工作树。新树tracked应干净，记录基线HEAD/产品树/锁，fallback暂不需要复制（D1不用）。任何MAX_PATH问题按已有LESSONS处理，不擅自移历史证据。

## 范围与接口

- 新增`apps/server/src/speech/{client,service,routes}.ts`及有意义的失败/边界单测；共享speech类型、AppOptions内部speech构造参数、app.ts钩子、Studio `/speech`代理与其真实连接验证可在本卡修改。无录音UI、无资产或视觉改动；不修改Pi的tests/e2e、历史JSON/报告/阈值。
- GET `/speech/config`，POST `/speech/transcribe` raw音频+UUID header，DELETE `/speech/transcribe/:requestId`；严格按修订设计。DELETE completed表示已终止而非识别成功，不篡改已完成/失败的原结果。
- 固定qwen3-asr-flash兼容HTTP协议，Node fetch，无新SDK/依赖/锁改动；生产只后端env配置，开发全部内部构造传假key/固定loopback。缺key/base禁用、不借编码key。
- 精确HTTPS主机名单/业务空间锚定式、default443/固定base路径、禁userinfo/query/hash/redirect，不能按aliyuncs后缀宽放；内部测试loopback例外不能由HTTP或普通生产env打开。
- 语音Fastify子作用域parser和安全CTP状态映射，4MiB body上限；原JSON路由16KiB不变。35秒真实业务总预算、响应流256KiB边读边限、文字非空≤4000，不整体json()后才限体积。
- 单上游在途+最多32条/5分钟终态缓存（不存音频），同ID同MIME/bytes摘要共享，同ID异内容409，其它ID忙429。每消费者独立计数，最后一个异常断开才abort；正常reply.raw.writableFinished后的close不算取消。显式DELETE/预算/preClose取消共享调用，晚到成功不覆盖终态。
- preClose封准入并立即abort，不在preClose等待HTTP排空；onClose只等已取消请求settle，原WorkService/资产/EventLog/锁顺序不回退。

## 必须由目标失败证明的验证

1. loopback mock实际收到单段音频Data URI、固定model及假Authorization；成功结果与协议一致，未配置不调用。
2. 4MiB+1返回413、text/plain415、空音频400，包含codecs参数的支持MIME成功；安全错误无内部message，上游计数0。非语音JSON路由不接受audio或4MiB body。
3. 错误域名（OSS、相似后缀）、HTTP、userinfo、query/hash、非默认端口/错误路径在发请求前失败。mock重定向不跟随、不转发key。
4. 上游401/429/500、坏JSON/空文本/4001字、超大或持续流均安全失败；取消/超时/close后迟到passed不能成为成功。256KiB在流上生效。
5. 同ID双连接仅1上游；断一个其它仍得结果；都断上游取消；显式DELETE两者都取消；正常close不写cancelled；异内容409；不同ID忙429；终态缓存/TTL/上限不重发音频。
6. 在途app.close显著早于生产35秒预算完成，真实mock连接观察中断，结束后无producer/晚响应；Host/Origin拒绝与关闭拒绝准入仍在。
7. Studio真实代理可访问config/POST/DELETE，不使用固定5173测试端口，不绕过后端Host/Origin保护；沿用已有listen(0)真实HTTP server机制及安全回收。

测试可通过内部时钟或timeout构造做快速预算负例，默认生产预算不变。测试记录单位与真实PIDs/端口归属，cleanup失败必须失败留诊断，不能catch吞掉。假env/canary只放临时夹具，不读真实文件。

## 执行纪律与交付

- 不读任何真实`.env`、`orbital/ASKS.md`、凭据；不用root的pnpm dev/server dev（会读.env）；不新增真实语音/模型/Lux3D调用。所有验证由独立白名单env、fake key、loopback守卫启动，不能继承NODE_OPTIONS等注入。
- 如新树需安装，仅复用缓存`pnpm install --offline --frozen-lockfile --ignore-scripts`，缓存缺失先如实交回，不在线升级。安装/测试/构建/服务等长命令必须从**根目录**首次即沙箱外使用`orbital/coordination/m2-takeover/bg-root.cmd "<相对ASCII命令>"`，拿到job立即结束回合，禁止poll/sleep/第二监视作业，测试期间冻结受测字节。严禁直接跑其它代理CLI。
- 先失败负例→实现→受影响定向测试/作用域typecheck；接口稳定后全仓typecheck/build/标准pnpm test单轮。沿用已有M3正式baseline501，不无意义重复baseline或跑Pi E2E。首失败停，先定性修正，不循环重跑求绿、不改旧断言阈值。
- 用新run目录记录HEAD/锁/真实源码字节、命令/PID/时间/退出码与原始日志，SHA清单排除自身；已知历史证据不得覆盖。每阶段固定提交，git均带longpaths，精确add，无git add .、reset或clean。
- 报告`docs/reports/M4-D1-impl.md`写实际API、取消/关闭/缓存/安全边界、真实count和未覆盖，尤其无真实阿里调用/未验语音质量、无UI或正式E2E结论。仅验证返回后记通过。
- 返回固定干净HEAD与产品改动清单/锁零diff/清理证明，由Codex交Claude独立代码审查；不自行合并、不声称M4或项目完成。
