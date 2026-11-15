# M4统一返工四：运行诊断与集中入口

本批依据已归档的运行失败开展必要修正，不等待审查服务恢复才处理已确认缺陷。Claude返工三复审两次API ECONNRESET，尚无报告或结论，不能用Codex协调核对代替独立审查或记为通过。待可用后仍补审。本批双方全部开发交回前，不启动测试/类型/构建/collect/浏览器/服务/探针，保持用户“整批开发后集中验证”顺序。

## 输入与所有权

- CodeBuddy仅改实现树 `.worktrees/m4` / `feat/m4-demo`，基 `6fc11de8d6e6fb67fdac8bbc5d9d8bfea3d446df`。
- Pi仅改验收树 `.worktrees/m4-acceptance` / `test/m4-acceptance` 的独立runner，基归档 `60d37241d5310251dab02d9ba4c78e2ac0c6fe6d`。不改实现源码/单测，不派实现者。
- 原run `docs/reports/artifacts/M4/regression/2026-11-15T13-06-44-442Z-full/`，job_7e0bfabc整体exit1/4m35s；受测047cae7，类型/构建成功，server375过3败；Studio单测、demo-safety和全部E2E未执行。193仍仅收集数。
- 10载荷已归档且Codex复算匹配，无身份漂移。旧原件不可重写。子进程早退stderr和原始断言被覆盖时必须标不可回溯，不能凭静态猜测写成历史已证根因。

## CodeBuddy整批范围

1. `fallback-process-lifecycle.test.ts:73`：finally写清理JSON报ENOENT遮原错误。实现测试也须自主创建自己的证据子目录，捕获诊断写失败，保存主失败+清理失败+写证据失败，不让finally覆盖主错误。成功清理与自主worker退出证据分开。可诊断时输出阶段/父子stderr/PID创建时间；写证据也失败时仍保留安全的stderr/聚合错误，不吞失败。对测试fixture递归删除仍须检查归属，不能因日志失败删掉活进程现场。
2. `recovery.test.ts:96`：owner identity undefined。当前首次身份轮询只查spawn error，没有核早退/退出码/已有stderr，后续阶段才检查，导致只见undefined。整条真实子进程启动/preload/解析/IPC静态核查并修正可确认错误；注册钩子须只处理其精确目标，不让不支持的specifier/parentURL干扰其它模块。明确spawn、early-exit、identity、held、kill、restart阶段，有界且实际错误优先，不只改断言或延长等待。早期身份尚未取得时也应负责句柄清理并保留证据。保留submit/idle/close拒绝持活锁、死PID接管、creates始终1、不重提与显式恢复断言；生产锁/jobFailure不得被改弱。
3. `work/approvals.test.ts:452` terminal-save分支5s超时，上轮通过且该测试未被返工三修改。静态检查现有事务/fixture及新测试中的同步PowerShell/CIM频繁轮询与并发资源开销，优先消除新增fixture不必要的阻塞或失控等待，不直接提高原审批超时、不加skip/retry、不能预先称产品死锁。对仍无法定性的等待点增加阶段计时诊断，确保原审批恢复/终态保存/不重放与模型调用数断言保留。没有新的运行证据就写待诊断，不捏造根因。不要为这条重写审批功能。

全部相关测试/夹具的失败与收尾通道一起静态检查，避免每轮仅修最先显现的日志异常。本批以可定位的接线/诊断修正为限，不要求凭缺失原件虚构原始屏障原因。生产安全合同、旧阈值/超时、依赖锁、模板模型/来源sidecar、脚本和Pi独立E2E不得无关改动。

写 `docs/reports/M4-rework-4-impl.md`，分列能确认的缺陷/静态修正/仍待运行问题。固定提交，tracked干净交回，不起job、不merge/push。

## Pi集中入口范围

只修 `tests/e2e/m4/full-regression.mjs` 中unit阶段的D2_RUN_DIR准备：在启动unit子进程前明确mkdir递归创建实际输出目录，目录不可创建则在runner层记录入口失败、不要启动子进程。保留身份门禁、全量顺序、白名单环境、首败即停、报告判据、证据归档还原、计数与原断言。不要更改产品/实现单测；诊断finally聚合由CodeBuddy处理。

只静态检查并提交runner及一份准备说明（建议 `docs/reports/M4-runner-rework-4.md`），不另跑自验、collect或服务，不启动full。你的受测身份稍后必须同时纳入CodeBuddy本批固定提交和runner提交，由Codex在双方齐备后安排。历史证据一字不改，不扩ignore。

## 共同保护

Git全程longpaths，精确add，无reset/clean，fallback未跟踪不入库。不读真实.env/ASKS/代理凭据，不改https_proxy，不做付费调用；真实语音主链仍阿里云。双方不触对方树或root产品，不把实现测试变化称新通过。外部真实阿里/真人A-B/彩排、真实Windows Ctrl+C仍按证据列未执行。
