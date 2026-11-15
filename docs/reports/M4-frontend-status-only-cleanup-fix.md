# M4 status-only 保留响应生命周期与夹具收尾修正

## 历史运行事实

受测提交 `c8f35b0d5a4eaf7684a2b721b93169edf20c6832`，`job_a2f7466f`，run `.data/frontend-close-focused-2026-11-15T18-35-43.132Z`，exit 1。实际 tests=8、pass=7、fail=1、cancelled/skipped/todo=0、changed=[]。本批不重写该结论，也不把旧 7 项与后续新项拼成同轮 8/8。

三份真实 result 均记录 production driver/backend/frontends 自然 exit/close 0、manifest stopped、forced=false、problems/remaining/fallback/listeners 为空。consumed 的真实 HMR computed marker 与 CSS update 帧一致，pageErrors/denied 为空，主文档导航 1→1，浏览器原身份均消失。status-only 的 primary=null，唯一 cleanupErrors 为 finally 在生产 shutdown 完成后调用 body.cancel 所得 TypeError terminated，堆栈为 Undici Fetch.onAborted/Socket.onHttpSocketClose。

旧夹具未记录响应 URL、原始 error.cause 与流终态时刻，因此不能确证具体是哪条响应、何时已进入错误终态，也不能将任意 terminated 直接豁免。这不是原 watcher forced 复发的证据。

## 原件保全

新增 `artifacts/M4/frontend-status-only-cleanup-20261116/`：focused-run/ 与 launcher/ 原字节复制 27 个载荷，复制前后源与目标 SHA256 匹配；另保存三组实际 run 的 manifest/plan 六个普通文件及静态派生 historical-result-summary.json。旧 run、旧 7/8 输出、watcher 追踪及全部历史原件保持不变，不复制嵌套仓库或依赖链接。原 run.json 保留当时固定 HEAD 和源码 SHA。

外层 sha256-manifest.json 排除自身并逐份复算；目录 .gitattributes 禁止 Git 换行转换，新增归档均以普通文件入库。

## 仅测试辅助修正

新增 `test-support/retained-response.mjs`：在 status-only HTTP 200 headers 到达后，不读取数据，只取得 reader 并观察 reader.closed。请求 URL 必须与 response.url 精确一致，每条响应有独立 id，记录锁定/未消费状态、单调时钟与 UTC 时刻、原始终态错误及递归 cause/socket code/端点。

真正发出生产 shutdown 消息之前，同步为全部保留 reader 记录 shutdown mark 和 bodyUsed/locked 状态；自然 ChildProcess.close 时刻及角色原生 exit/close 仍独立记录。mark 不消费或取消数据，也不改变请求场景。

释放逻辑：

- 已 closed 的 reader 直接 releaseLock，不重复 cancel；
- 已 errored 的 reader保留原终态并分类，再 releaseLock，不再次取消已终止流；
- 仍 readable 的 reader，仅在已验证自然生产关闭后才尝试 reader.cancel，并记录 cancel 前后和异常；调用的是持有锁的 reader，不对 locked body.cancel；
- 即使分类或取消失败，也在 finally releaseLock，核对 response.body.locked=false。新的取消失败只有在同一原始错误对象已经由 reader.closed 观察、且满足严格预期终态条件时才可分类，其他 I/O 拒绝仍失败。

预期 socket 终态必须同时满足：明确 status-only 保留流、HTTP 200 和精确 URL/自有 loopback 端口关联、shutdown 前未消费且持锁、错误时刻不早于真实 shutdown 请求、原始 TypeError.cause.code 为 UND_ERR_SOCKET、cause 中提供的 remote 端点与请求一致，以及生产自然关闭的全部证据。生产证据要求 driver code0/signalnull、stopped、两个角色与真实 childPid 关联的 exit/close0、无 forced/problems，并且 PID+创建身份均 gone/reused、端口为空、查询成功、无主错误。分类不依赖 message 字符串。

关闭前异常、未知 cause、URL 不关联、socket 端点冲突、角色 forced、原生 close 缺失、查询 unknown、主错误存在、shutdown 时间缺失仍判失败。原错误的 name/message/stack/code/cause 和 socket 元数据原样派生记录，不用新错误覆盖。

`frontend-close-confirm.mjs` 保留原自然退出、manifest、角色事件、端口、PID创建时间及兜底失败断言。仅 status-only 响应使用上述观察器；原 gate、frontends、launch、runtime、45秒预算和 HMR 行为不改。

## 分类回归与唯一新入口

新增 `retained-response.test.mjs`，覆盖：已关闭无重复取消、shutdown 后已观察的 socket 终态、shutdown 前 socket 错误、未知/失配/未证实生产关闭的多个拒绝分支、仍 readable 的关闭后取消及释放锁、取消新 I/O 错误不得按 message 豁免。分类回归使用本机 Web Streams，未访问任何外部服务。正常 close/错误 close 与锁释放均有断言。

新增 `frontend-status-only.focused.test.mjs`，只导入上述必要分类回归及一个真实 production status-only 场景；不导入旧五项门禁、不执行 no-request/consumed/HMR、不使用 test-name-pattern 或 skip。分类回归同时接入 safety.test.mjs 供未来全套运行，但本批不启动全脚本。

固定仅 helper/测试/报告提交后，唯一授权入口 `.data/run-frontend-status-only-focused.mjs` 记录新固定 HEAD、源码字节前后身份、命令/PID/创建时间、TAP 实际计数、每条保留响应及自然关闭/资源清理原件和排自身 SHA 清单。新场景实际结果尚未取得，不预填通过数；新轮实际数与旧 7/8 分开记录。

## 交付边界

本批固定前只静态阅读、归档、语法和 Git 差异检查，不运行任何测试。生产 `c8f35b0` 的 gate/frontends/launch/runtime 与原45秒预算不变，依赖锁、模板、Pi验收树 e375b73、独立套件及历史原件未改。不M4/full/全脚本/614/旧174，不真实调用或读凭据，不merge/push。

拿唯一 job 后立即交回冻结，不轮询、不加监视、不失败自动改试；后续由 Codex 核新结果并统一集成。真实 Windows 控制台 Ctrl+C、外部提供商、真人 A/B 与彩排仍不在本轮覆盖范围。
