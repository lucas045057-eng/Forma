# M4 统一返工四交付：诊断通道与有界子进程接线

日期：2026-11-15。实现树 `.worktrees/m4` / `feat/m4-demo`，基 `6fc11de8d6e6fb67fdac8bbc5d9d8bfea3d446df`。只读根交接22548d4中的 `orbital/coordination/m4/unified-rework-4.md` 并一次处理整批，不合并主线，不触验收树。

**本批没有运行typecheck、build、单测、collect、Chromium、服务、demo、探针或独立审查，没有创建job。仅静态源码阅读与Git差异检查，不宣称新增接线或测试已通过。** Claude返工三复审因两次外部API ECONNRESET尚无报告，不作通过；也未以本实现侧静态核对代替独立审查，没有调查代理配置。

## 原始事实与能确认的缺陷

`job_7e0bfabc` 已结束，整体exit1/4m35s，受测047cae7，产品6fc11de。Pi归档60d3724，原run `docs/reports/artifacts/M4/regression/2026-11-15T13-06-44-442Z-full/`：类型/构建通过，server375过/3失败；Studio单测、demo脚本、全部E2E未运行。193仍仅收集数；总体计数与清理由Pi独立归档，不在实现侧预填新成绩。旧原件和报告保持不动。

| 项 | 当前证据能确认 | 不能从历史原件确定 |
| --- | --- | --- |
| S1 finally ENOENT | runner传D2_RUN_DIR但没有建目录；测试finally也直接writeFile，没有自主建目录或保护主错误，诊断ENOENT确实能覆盖原始失败 | 被覆盖之前究竟是哪个断言、loader阶段或子进程错误，不能回溯后当作已证产品根因 |
| S2 owner undefined | 初始身份轮询仅检查spawn error，反复同步启动PowerShell，未先检查早退/已有stderr；preload对所有specifier无条件new URL解析，只按路径后缀拦截 | 旧子进程具体为何先消失/无身份，原stderr未保存，不能直接定性为CIM、preload或产品失败 |
| S3 terminal-save 5s | 这条旧审批测试未被返工三修改、上轮通过，本轮默认5秒内未完；新增资产夹具反复execFileSync会阻塞所在Vitest worker，且多次启动PowerShell带来共享CPU/磁盘开销 | 没有旧阶段耗时证据，无法证明该开销就是此次审批超时的唯一原因，更不能称产品死锁 |

## 1. 主失败、收尾失败和证据写失败分开保存

新增仅测试使用的 `apps/server/src/test-support/fixture-diagnostics.ts`，供两个相关资产夹具共用：

- `writeFixtureEvidence`递归创建自己的实际子目录再写文件。生命周期用 `D2_RUN_DIR/asset-lifecycle/cleanup-<pid>.json`，持久化恢复用 `D2_RUN_DIR/asset-recovery/persistence-<pid>.json`；无D2_RUN_DIR时写本fixture目录。Pi仍负责runner在启动unit前准备根目录，本树不改其runner。
- 测试主体先catch保存primary，再独立尝试close、归属核验/终止和写证据。任何清理或写证据错误加入同一失败集合；最后以AggregateError保留primary与全部次级错误，并向stderr输出结构化诊断。没有在finally直接throw新错误遮住旧断言，也没有吞错误使测试变绿。
- 记录Error名称/message/stack以及存在的子进程code/signal/stdout/stderr；AggregateError保留子错误。写文件本身失败时仍有stderr和聚合错误，不依赖目录一定存在。
- 生命周期诊断分开记录 `autonomousWorkerExit`（主断言里已证明的自主退出）与 `cleanupKills`（失败收尾实际尝试终止的PID）；兜底kill不冒充自主回收证据。
- fixture根/staging删除前核对创建时的realpath/dev/ino和普通目录身份。主断言、资源收尾或证据写失败时保留生命周期现场；持久化恢复失败时撤下本fixture的递归删除回调，保留目录，mock listener仍由原登记cleanup关闭。没有日志失败后继续删可能仍由活进程写入的现场。
- 模型测试父进程自身也等worker close后才结束处理Promise；spawn/error先记录，不在error刚触发就删staging。staging清理失败与worker主错误聚合。

这些都是待运行的测试代码；本批未创建上述目录、未查询/终止任何PID。

## 2. recovery精确preload与启动阶段诊断

### 可以静态修正的接线问题

旧resolve hook对全部specifier执行`new URL(specifier,context.parentURL)`。不是所有Node模块请求都可当相对URL解析，尤其bare specifier或非file父URL；按路径后缀匹配也不能证明就是本fixture的目标。**这是静态可确认的不安全接线范围，不等于已证明旧owner缺失就是由它引起。**

两个测试preload都改为先调用Node的 `nextResolve`，只比较解析结果与由当前夹具 `import.meta.url` 派生的**完整目标URL**：

- 持久失败hook只拦本树 `assets/atomic-file.ts` 的无query精确URL；原始模块通过带fixture-original查询的另一个URL正常加载，所有其他specifier/格式由Node原样处理。
- 模型屏障hook只拦本树 `assets/process-model.ts`。返回的普通JS替身仍在worker应用线程真正求值时报告屏障，不以resolver命中代替处理中证明。
- 生产execArgv清空、worker断开监听顺序、HTTP/env接口均不改，没有新增暂停或写盘故障后门。

### 分阶段、实际错误优先

恢复夹具现在分别记录spawn、preload installed/target-resolved/wrapper-evaluated、entry、init、submit/idle/close拒绝、活锁拒绝、held、kill、exit/disconnect/close、restart与cleanup阶段。preload可以在入口依赖解析失败前就报告installed，父夹具保存真实stdout/stderr和IPC事件。

身份查询前先等待原生spawn和入口已导入，所有等待持续检查spawn error、early-exit/信号、IPC断开和fixture错误；若子进程先失败，优先报告阶段和stderr，而不是只得到`owner undefined`。身份阶段仅发一次异步OS查询；确实活着却查不到身份仍失败，并保留诊断，不伪造创建时间。早期身份未取得也由直接ChildProcess句柄负责终止与等待close。

原合同断言保留：submit/idle/close均拒绝disk full、活PID第二实例INSTANCE_LOCKED、磁盘submitting、真实死亡后由生产init接管旧锁、不手删活锁、相同幂等key不重复提交、creates始终1、显式导入9000001恢复ready。生产jobFailure/close/实例锁未改弱。

## 3. 新增夹具阻塞开销与审批阶段计时

### 确认并移除的开销

两个新增资产测试不再使用 `execFileSync` 做CIM轮询。共用helper以 `execFile` Promise执行有界的过滤查询，使用OS变量白名单，不读代理/提供商环境：

- readiness与IPC阶段只等已接收的事件，不每20ms启动PowerShell；父/worker归属只在相应阶段建立。
- 一个快照按PID列表及必要的parentPID过滤并批量核验，不为每个PID单独启动一轮同步查询。
- worker/最终资源退出仍有界核验真实PID+创建时间，OS快照轮询间隔250ms；不是取消退出断言。失败收尾还会发现屏障前已经fork的worker。
- 生命周期用例30秒、其原10秒等待预算、恢复用例15秒均未增加；OS单次调用有5秒上限。server的maxWorkers与审批5秒默认预算不改，没有retry/skip。

异步和批量化能消除**确定存在的测试线程同步阻塞与冗余调用**；没有性能实测，不能说这已经证明审批超时根因或保证下轮通过。

### 审批事务只读核查与诊断

静态核对 `WorkService.cancel` 先在repo互斥中恢复旧approvalIntent；preview_failed恢复会持久化意图、停止预览、移除候选、尝试终态保存，失败回滚内存并保留恢复意图。该用例故意在C的终态保存、D取消前的旧意图恢复分别注入错误，再要求重试恢复、终态和不重放。静态阅读没有证明产品死锁，不重写审批功能。

只为 `approvals.test.ts` 的原cleanup/terminal-save参数化用例加计时：fixture初始化、两次submit/idle、C故障与意图保存、D恢复失败、读取durable intent、取消重试、work.close、restart.init/close、fixture清理。每个begin/end即时以静态标签和elapsed ms写日志，即使超时未走到finally也能看到最后阶段；正常/异常收尾输出汇总。故障注入仍是同一save顺序和同一错误消息，原approval/task状态、durable intent、candidate事件、不重放preview/commit及modelCalls=2全部保留。清理错误不盖住主体断言，mock还原后才清资源。

此处只有未来运行的阶段诊断，未提高原5秒、不重跑、不预判哪一步卡住。

## 修改范围与未执行清单

修改：两个资产实现测试、两个测试loader、两个测试parent、目标审批实现测试；新增共用fixture-diagnostics测试helper和本报告。生产AssetService/provenance/lock/WorkService/worker/process-isolated未变，demo脚本、Pi独立E2E/runner、旧阈值/配置/依赖/锁、模板GLB/sidecar、历史证据及报告均未改。fallback继续未跟踪、不入库；未merge/push。

本批只静态阅读/Git diff --check。没有运行新preload、合成GLB、CIM、IPC、诊断写入、stage计时、类型/构建/测试、浏览器/服务/探针或独立审查，没有创建job；代码里的进程操作与清理不是本轮实际动作。没有读取真实.env/ASKS、https_proxy或任何代理/提供商凭据，没有修改代理或真实付费调用。

Claude返工三复审仍欠正式报告；本批交回后由Codex同时纳入Pi的runner根目录准备修改，再安排统一冻结和集中验证，之后补齐独立复审。不借用D1/旧M3成绩，不提前填写新通过数量。Studio单测、demo脚本、193 E2E、真实Windows Ctrl+C/生产资产完整链以及外部真实阿里/厂商识别/编码/Lux3D、真人A/B与完整彩排，继续按实际证据分列未执行或未覆盖，M4和全项目未验收。
