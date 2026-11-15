# M4 统一返工三交付（未运行验证）

日期：2026-11-15。仅在 `.worktrees/m4` / `feat/m4-demo`，从 `1aa54500ebab4efd5cd457b94c145e71880990df` 开始，原tracked干净、fallback未跟踪。已全文读取根统一返工三任务、返工二审查和本树返工二交付；未为读取主线文档merge。

**本批只做代码修改和静态阅读/Git diff核对；没有运行typecheck、build、单测、collect、浏览器、服务、探针或审查，没有创建job。新增测试/夹具均未执行，不宣称三项已经运行验证通过。**

## 原始运行事实

- `job_f4565bb7` 已结束，整体exit1/4m56s，受测Pi合并提交 `e863f261e0263e857c71cefd785bbed7c42e6f3d`，产品为1aa5450。
- typecheck/build均code0；server单测375通过/3失败（378）。Studio单测、demo脚本安全及全部E2E未运行；其余包/总体计数由Pi独立归档，不在这里推填新总数。193仍仅为收集数。
- 失败原件在Pi树 `docs/reports/artifacts/M4/regression/2026-11-15T12-48-33-510Z-full/`。本批只读其unit日志开头及manifest中的Node版本（v24.14.1），没有改写原件或验收树。
- 本轮类型检查没有再报Buffer或TS1375；这不等于全项目验收通过。返工二审查0 blocker/0 should-fix/3建议保留原文；不扩moduleDetection或其它功能。

## 1. 模型处理屏障超时：通信接线与诊断

### 静态可确认的原因和证据边界

原`asset-loader-register.mjs`使用异步`module.register`，`asset-model-loader.mjs`的load hook为原生`.ts`URL返回替换源码；替换源码用可选的`process.send?.`报告。异步hook在加载器线程执行，**但它返回的模块源码本应在worker应用线程执行**，不能简单把源码里的send误说成加载器线程发IPC。旧结果仅有“等待屏障超时”，worker stderr没有被父夹具转发，屏障等待也不检查worker-closed/parent-error；因此现有原件不足以确定历史运行到底停在hook命中、替换模块求值、IPC还是worker早退中的哪一步。不能据此认定生产process-worker的disconnect实现有缺陷，也不冒称已用新运行证明某一个Node内部原因。

可以直接确认的夹具缺口是：跨异步加载接线缺乏阶段诊断、可选send会静默跳过无IPC、stderr被丢弃、只在屏障之后登记worker归属。原等待超时没有区分这些情况，失败清理还可能漏掉屏障前已启动的worker。

### 修改

- 测试专用preload改为当前记录Node24支持的同步`registerHooks({resolve})`。只把精确`process-model.ts`解析为普通`data:text/javascript`替身模块，避免向原生TS load返回替换source的多层接线；不加载真实重库、不修改生产文件。
- 替身模块在应用线程真正求值时设置保活计时器，强制检查IPC存在且connected，再发送带自身PID的`fixtureModelBlocked`，随后保持受控处理中。**resolve命中本身不算就绪**。生产process-isolated仍清空execArgv，没有HTTP/env暂停开关，生产disconnect先注册顺序不变。
- 测试父夹具在fork的spawn事件即报告worker PID/stage，转发worker stderr，报告worker错误/close与父错误。主测试先记父进程创建时间，worker-spawned后即查OS身份；没有等屏障到达才负责清理。
- 屏障等待收到错误或早退即失败并附阶段事件/stderr，不再只空等10秒。10秒屏障预算和整个30秒用例预算保持原值，没有加超时/skip/删屏障。
- 测试仅在收到匹配PID的模块求值屏障后才杀父进程；先断言worker自主因IPC断开退出，再验证raw完整、未发布model、重启记LOCAL_IMPORT_INTERRUPTED且清staging。失败清理在停父之前也发现其已fork的worker；只按PID/创建时间收本fixture资源，有界确认退出。清理失败保留目录、写诊断并抛AggregateError，不拿兜底kill算自主回收成功。

修改文件：`test-support/asset-loader-register.mjs`、`asset-model-loader.mjs`、`asset-parent.ts`、`assets/fallback-process-lifecycle.test.ts`。以上仍是测试加载替身，不是生产process-isolated完整spawn/优化发布链的验收。

## 2. HTTP202来源unknown：受理阶段与成品证明

### 已确认的静态根因

`prepareLocal`在返回202之前只保存处理中的输入来源，尚无输出hash。公开`publicAsset`调用`cleanAssetProvenance`，后者的`parseProvenance`要求合法outputHash；输出尚未处理完时返回`{kind:'unknown'}`是当前的保守合同。原用例把202当作可信成品，期待fallback来源，断言阶段错误。另一个同源夹具问题是HTTP正例复用了只有12字节头的bytes——它仅适用于注入的合成processor，真实HTTP走生产模型处理，12字节没有场景几何，不能成为ready模型。

### 修改

- 保留真实`{}`POST→202正例，增加processing、来源unknown、无modelUrl断言；没有改生产来源清洗或把受理包装成可信成品。
- HTTP正例改用NodeIO构造有真实三角形几何的合成GLB，受控内部preset摘要绑定实际输入bytes。HTTP仍使用真实本地隔离处理，不给App注入虚假的ready处理器。
- 通过真实service.idle等待处理终态，再GET资产断言ready、固定preset/sourceHash以及等于实际model.glb字节SHA256的outputHash，并核HTTP模型响应字节一致。
- 原危险path/URL/provenance字段400、拒绝后资产列表仍为空、preset固定目录/可用性断言均保留；额外监视Lux3D三个入口，要求全流程无上游create/get调用。

只修改`assets/fallbacks.test.ts`，不改生产202/200接口或可信来源规则。以上实际处理/HTTP/hash断言全部待运行。

## 3. taskId写盘失败后close报disk full：旧重启前提与持锁合同冲突

### 已确认的静态根因

`save()`把写失败记入粘性jobFailure，`idle/close`按既定合同必须拒绝，close不能释放仍活着的所有者锁。旧测试`await first.close()`既没有期待失败，又想在同一个活PID内马上init新实例。该前提与保留所有权合同冲突，disk full来自原故障注入，不能通过吞jobFailure、假close成功或手删活锁修测试。

### 修改

- 原测试改为受控真实子进程运行第一次提交；新增仅测试preload `asset-persistence-register.mjs`，同步resolve把atomic模块包装成普通JS：只在index.json将写入含taskId记录时抛相同`disk full`，其它写入调用真实原始atomic模块。生产ServiceOptions/HTTP/env没有故障开关。
- `asset-persistence-parent.ts`连明确127.0.0.1假key mock。保持原上游响应已接受但taskId未落盘场景；真实断言submit、idle和close都拒绝disk full，自己的第二实例仍INSTANCE_LOCKED，磁盘仍为submitting且锁PID确为自己，然后报告并保持存活。
- 主测试记录子进程PID+创建时间，自己也验证活PID占用拒绝和create次数恰好1；真正终止该子进程并有界等待close，核该创建身份已消失，保留原锁文件不手删。随后由生产init正常识别死PID并接管。
- 保留原“相同幂等key重启后submit_unknown、不再次create、显式importTask('9000001')恢复ready、最终create仍恰好1”断言。
- 子进程启动和关闭均有界、stdout/stderr可诊断；该用例改为15秒集成预算是因为新增加真实进程启动/死亡/创建时间核查与真实恢复处理，**不是延长旧close等待来绕过disk full**。生命周期屏障原预算未增加。
- recovery afterEach改为尝试所有登记cleanup并聚合错误，不吞失败；若持久失败子进程未能退出，移除本fixture递归删除回调并保留目录，避免删活进程现场。不释放活锁、不重复付费提交。

修改`assets/recovery.test.ts`，新增两份测试parent/preload。生产save/jobFailure/close/lock/submit未修改；这不是简单把原断言删掉，而是以真实进程死亡满足“restart”前提，并增加失败持锁断言。

## 交付范围与集中验证

本批修改限上述实现测试/测试夹具和本报告。没有修改AssetService、provenance清洗、process-worker/生产process-isolated、实例锁、审批/采用/取消门禁、安全预算、依赖/锁、Pi E2E、旧阈值/skip/retry、默认模型/sidecar或历史证据。原报告与失败原件保留，fallback未跟踪不入库。不merge/push，不改主线/验收树/旧树。

执行情况：仅静态源码阅读、Git身份/差异与`diff --check`；没有运行新加载器、故障注入、合成模型、服务、IPC/OS进程查询、处理、单测或任何探针。代码中创建/终止子进程和计时器均是**待执行测试代码**。没有新结果清单、通过计数或新job。

固定新提交后由Codex统一安排Pi从头集中验证与Claude有限差异复审。必须实际确认：屏障报告确在worker应用线程、屏障前失败清理无遗留、202和ready两阶段及真实模型hash、disk-full活锁拒绝/真实死亡接管/create仅1/显式导入恢复。新加载器及恢复夹具只针对现记录的Windows/Node24测试环境，不冒称跨平台或真实生产spawn链已经覆盖。

Studio单测、demo脚本和19+174 E2E的本轮未执行事实不因这次开发而变化；新通过数只认后续实际日志。真实阿里/厂商语音、编码/Lux3D、真人A/B、完整彩排、Windows真实控制台Ctrl+C仍按独立证据列未执行。M4及全项目尚未验收。
