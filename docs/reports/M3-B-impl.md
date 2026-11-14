# M3-B 实现交付记录（进行中，尚未验收）

## 接手与第一批边界修正

用户2026-11-14“那你来吧”授权Codex接手M3-B实现；Claude独立审查、Pi独立验收不变。基线为CodeBuddy部分提交 `6e44961b6e145da9aa367e8b4ca8eaffa39c1a13`。原B2草稿和debug-build.mjs保留；主目录 `.data/m3b-codebuddy-handoff-6e44961/` 有六份草稿的逐字节备份/hash与429作业原输出。

已修正候选根/父路径与快照目标junction跟随、证据写入编号/路径边界、真正并发start的保存await窗口、drain后的新准入、损坏持久记录只验证数组，以及11MiB模型被10MiB上限误拒绝。文件读改为单句柄有界读取，快照目标必须为空；复制核对预期摘要、源字节及复制后源/目标。单文件上限32MiB，总量仍50MiB，文件数500；超限显式失败。证据日志有界截断，JSON超限拒绝，列表复用安全读取，删除统一验证runId。

原重启测试曾造出 `Check.status=running`，与共享类型/检查合同不符。现以run.running、build.not_run表达未完成，保留SERVICE_RESTARTED/已通过项/不重跑断言，并断言未完成项有原因。没有新增生产旁路。

## 已实际验证

- RED `job_78e7093e`：35项执行，原27通过、新8失败、0跳过。证据 `.data/m3b-takeover-red-1794655373672/`，identityPreserved=true。
- 第一批修正后 `job_f4561135`：exit0，35/35通过、0失败/跳过。证据 `.data/m3b-takeover-green-1794655848940/`（tests.json、tests.log、evidence.json；含文件SHA256/Git blob、命令、PID、时间、HEAD/status前后），identityPreserved=true。
- 此次是在6e44961加本批未提交文件上验证，不声称在后续提交HEAD上重新跑过。

## 第二批：内容、证据、持久化与中止语义

已加入完整快照摘要预检和工具身份，主版本过期先拒绝；去重包含candidate/base/main/policy/完整摘要。运行器分别记录status/outcome，阶段结果必须匹配阶段名、登记实际证据并核对hash。公开查询只见已经持久化的快照，失败的终态保存使内存绿灯失效、停止新准入，wait/drain返回PERSISTENCE_FAILED。取消与deadline区分，迟到成功/证据不能写回；准备与分段文件读取检查signal。生产executor仍需真实子进程及stop屏障，不把Promise层验证冒充进程回收证明。

- RED `job_76bcb9b4`：44项，原35通过/新增9失败，0跳过，源码身份一致；`.data/m3b-reliability-red-1794656282121/`。
- `job_28b40490`：44/44回归通过、0失败/跳过；随后基础模块定向typecheck仅预算数组推断TS18048，exit2，原生导入未调度；`.data/m3b-reliability-green-1794657083984/`。
- 只补预算数组的readonly tuple类型注解（as const），不改预算/判断。`job_31832add`：基础模块定向typecheck、原生Node导入均exit0；`.data/m3b-foundation-types-native-1794657398639/`。SHA验证撤销注解后等于44项受测源码，其余受测文件字节不变；新运行前后身份一致，没有重复宣称44项在新提交上执行。
- 上述五轮原始实现证据归档于 `docs/reports/artifacts/M3-B/foundation-20261114/`（manifest逐文件SHA256、局部.gitattributes保留原字节）。属于实现阶段证据，不替代Pi独立验收。

## 第三批：Git身份、跨候选串行与持久层适配

`WorkRepo.candidateCommit(id,{clean:true,expectedCommit})`新增严格模式：确认预期分支提交、common gitdir、工作树HEAD、commit与路径审计，并拒绝未提交/ignored输入。不传选项保持原审批使用的语义。CheckRunner按candidateId重新解析并冻结输入，开始/结束都复核，单个执行队列在stop确认后释放名额；排队取消/超时可独立持久化终态。提供所属CheckStateStore适配，启用时不再竞争写check-runs.json，留给后端实际tasks.json接入。

- RED `job_b65e0f3c`：十一项真实临时Git/调度/store用例，2通过/9目标失败，0跳过；`.data/m3b-scheduler-red-1794658032674/`。
- GREEN `job_675d2ed6`：**63/63**（此前44、新调度11、既有repo8）通过、0失败/跳过；基础模块定向typecheck和原生Node导入均exit0，前后源码身份一致；`.data/m3b-scheduler-green-1794658761281/`。
- 原始证据归档 `docs/reports/artifacts/M3-B/scheduler-20261114/`，保留RED和GREEN，不把后续提交HEAD当作重新受测。

### 当前仍未完成

Claude固定B1审查 `M3-B-B1-review.md` 中，内容/证据/持久化/逻辑中止、Git提交绑定和单实例跨候选串行已有上述实现验证，尚未独立复审关闭。真实受控worker的强制中止/父进程退出与后代清理、实际tasks.json/事件/API、浏览器及采用门禁仍待完成；固定worker内真实Vite已通过下述十九项子集；不能称B1/B2或整个M3-B通过。

本批没有运行完整typecheck/build/单测或正式E2E，没有读取真实.env/ASKS，也未启动模型/Lux3D/浏览器/网络服务。正式交付仍需后续完整验证、独立复审及Pi验收。

## 第四批：冻结输入的真实 Schema / Vite worker（B2 子集）

固定Node入口worker-entry，无任意shell/worker路径；最小环境剔除provider配置、NODE_OPTIONS与VITE变量。父进程审计快照路径并管理证据落盘/ref，子进程只接收冻结buildRoot；Node文件权限只允许快照和明确工具根。Schema读冻结配置并返回实际schema.json摘要；Vite使用固定HTML/React/PostCSS与JSON字符串tsconfigRaw，关闭env/config自动发现，固定工作区范围，候选模块只被编译。AST/解析路径/CSS资源边界拒绝raw越界、Node内建与网络导入。工具依赖仅精确声明已有Vite7.3.7、React插件5.2.0与Playwright1.65.0，离线frozen安装通过。

- RED job_af6388e3：十四项全部目标行为失败，identityPreserved=true。
- 中间失败原件保留：两次14/19权限失败、workspace修正后14/19、HTML单例失败、19/19后DNS类型失败、types与19/19后验证探针同步throw捕获失败。没有将失败轮改写为通过。
- job_cdb84423：定向types0、19/19实际通过、0跳过；native导入完成但DNS探针同步拒绝未被.then捕获导致该步骤1。
- 仅修探针兼容同步throw/异步reject。job_48a1e8a2：native导入与DNS callback/promisify/promises全部拒绝验证0，unchangedFromPassedRun=true、identityPreserved=true；逐文件SHA证明生产源码/测试/包锁均与上一轮types/19项通过状态一致。未重复声称在本次提交HEAD全量重跑。
- 原件归档docs/reports/artifacts/M3-B/worker-20261114，各目录evidence包含具体命令/时间/PID/退出与源码SHA/Git blob；manifest与局部.gitattributes保留字节。

这不是OS级安全沙箱：可信Node工具仍有addons/child-process权限，Node网络守卫属于应用层防线。十九项包含实际worker取消并确认退出，但父进程死亡、esbuild后代/异常退出/超时/强制终止仍需补测；B2尚未完成。B3真实浏览器、B4集成、全量验证与Claude/Pi独立门禁均未完成，smoke/occlusion仍not_run。未读真实.env/ASKS，未启动付费模型/Lux3D。

## 第五批：worker 生命周期与 stop 等待者

四项新增测试先RED：job_1bd6b2e3为3通过/1失败，失败为不abort仅stop时进程已退出但调用方Promise未终结。stop现捕获待完成请求与首个终止原因，在实际exited后拒绝，停止期间close/send/ready故障不抢先覆盖CANCELLED/TIMEOUT。

job_3e2be5af只在types报测试expect.poll的intervals字段不兼容，运行测试未开始；改为Vitest支持的interval:200，10s观察预算不变。最终job_044b65b5：types、23/23（19+4）与native全部exit0，0失败/跳过，源码身份不变。真实父进程死亡用例先实际构建并观察esbuild服务，再按PID+创建时间断言worker/后代消失、同场无关Node进程仍存活；JSON保存断言与耗时，但本轮JSON reporter未保存console输出中的具体PID，原件不冒充有原始PID列表。后续正式证据需显式落盘身份表。

原始RED/类型失败/GREEN归档docs/reports/artifacts/M3-B/lifecycle-20261114。只证明已测Windows正常IPC断开回收和单worker取消/超时/异常退出；强制终止失败的异常支路与浏览器后代尚未覆盖。B2主要实现已有定向证据，仍须B3/B4完成后的全量与Claude/Pi独立门禁；尚未宣称M3-B完成。

## 第六批：B3 首批真实浏览器行为

新增只读独立静态源：仅dist、精确Host、GET/HEAD、路径/链接审计、高位loopback保留监听；无API/代理。固定Chromium1440×900、禁service worker、导航前context路由/WebSocket守卫/popup关闭。smoke实际点击并核对购买+1/非空反馈及场景ready或可见fallback；occlusion真实中心+四内缩角点命中，记录disabled/hidden/offscreen与空目标失败。截图/JSON通过父进程artifact回执保存；停止先关闭context/browser/static源再退出。

job_61d9f498：types0，B3十六项全因not_run失败。job_f7291cf5：types0，39项26通过/13失败，原23全过；浏览器初始化被守卫误拦Node数字loopback监听，三项反向状态断言不能当浏览器已执行。实查Node24 net.lookupAndListen及dns.isIP快路径后，仅允许dns.lookup('127.0.0.1')本地数字地址处理，其它DNS/Socket/http/fetch/WebSocket守卫保留。

job_7d959041最终types、39/39（16浏览器+23既有）、native均exit0，0跳过、identityPreserved=true；包括真实模板缺资产fallback、JS未捕获错误、购买失败、主/次控制遮挡、空目标、四种不同loopback源请求被拦且诱饵收到0请求、静态源Host/路径/API与stop端口释放。原件归档browser-initial-20261114。该轮测试会验证PNG签名/大小与JSON证据，但清理夹具后未保留每页PNG/JSON，不声称归档已有这些原件；下一批需显式导出。

这仍是B3子集。service worker/子worker WebSocket、重定向、缺浏览器与取消/超时真实浏览器后代、静态链接替换和证据保留仍需补测；B4持久化/API/采用门禁未实现，无正式E2E/独立验收结论。Node权限不等于OS沙箱，浏览器守卫是应用层策略。

## 第七批：浏览器 worker 绕过与证据原件

adversarial RED job_f1f301f4：types0，新增五项3过/2失败，原16筛选未运行。service worker虽被Playwright禁用但检查错误返回passed；专用worker内WS不受原routeWebSocket策略覆盖。主页面跳转、静态目录替换junction、浏览器安装根不可读的失败证据三项通过。

当前模板没有dedicated/shared/service worker依赖，现明确采用禁止创建策略：静态源CSP worker-src none，导航前锁定构造器/注册入口并记录attempt，原生CSP违规也进入blockedRequests。子worker WS用例按此策略验证创建即拒绝、failed/证据/诱饵0请求，未伪称在worker内部逐包拦截。代价是未来依赖worker的页面需重新设计，本阶段只支持既定模板。

job_d5d6f767：types0、44/44（浏览器21+既有23）与native0、0跳过，identityPreserved=true。原件browser-adversarial-20261114保存两轮全部evidence/tests/log及实际browser-artifacts（固定报告/PNG与test/runId映射），manifest逐文件SHA。已人工查看真实模板smoke.png：1440×900首屏、可见商品占位和购买入口，反馈已加入购物袋；报告Chromium158.0.8127.18、fallback可见、0→1、pageErrors/blockedRequests为空。PNG属于实际检查，不是UI设计稿。

浏览器资源取消/超时/父死亡后的Chromium进程身份与端口回收尚需补测；B4未实现，完整typecheck/build/单测与独立Claude/Pi门禁未完成。没有真实模型或Lux3D调用。

## 第八批：实际 Chromium / 端口 / 父死亡原件

job_68cc8540：types0，8项7过/1失败；timeout测试8s预算晚于浏览器5s内部等待，得到正常smoke.failed而非父deadline拒绝。仅将测试阶段预算缩短到4s使父deadline先触发，生产默认30s和全部资源/错误码断言不变。

job_468fc844：types0、8/8通过、0失败/跳过、identityPreserved=true。生产代码与44项通过的4b8f905无差异，仅生命周期测试/父夹具扩展。实际观测worker、esbuild、Chromium与后代PID/创建时间，取消和缩短deadline后remaining为空、静态监听URL无法连接、lateArtifacts=0；浏览器父死亡后owned子树为空、静态源关闭，同场decoy保持存活；IPC stop被忽略时确实强制结束自有worker。两轮原件含process-artifacts与实际检查报告/截图，归档browser-resources-20261114，有逐文件manifest。

B2/B3主要实现与定向证据现具备，进入B4实际WorkService/tasks.json/事件/API/采用门禁。仍未做全仓typecheck/build/单测、独立Claude复审与Pi正式E2E，不将定向实现测试称为整阶段验收。Windows进程证据不外推跨平台；强制回收命令自身失败的保锁处理仍要在集成与独立审查中核对。

## 第九批：B4 WorkService 第一组集成

运行记录由WorkService所属store写入tasks.json，不再单独check-runs.json；候选记录生成提交，旧无提交证明的候选需重新生成。store同repo锁内复核最终通过身份/六份证据，保存成功后更新公开durable视图再发check事件。CheckCompletionInvalidated把完成时过期转为可持久failed，不误报成永久I/O故障。start/get/cancel/artifact内部方法已接入；HTTP尚未接线。

adopt同repo锁中快照主作品后核对最新run、完整输入摘要、candidate commit/base/main/policy/tools、四passed、各阶段报告hash及两张截图引用；任一不符409 CHECKS_NOT_PASSED。撤回/自动裁剪先标retiring封检查准入，在repo锁外停止检查，再锁内保存撤回意图并清理；审批发布后的裁剪移到答复锁外。关闭先封准入/启动checker drain，等任务与trim/checker屏障后再drain repo、关preview、放锁。

RED job_91b1f5f0：types0，十项全部目标失败。GREEN job_d1db8079：types0，89/89实际通过、0失败/跳过、identityPreserved=true（新10项、B1四套55项、work approvals23及routes1）。原件归档work-integration-20261114。集成测试用内部构造参数注入产生实际artifact ref的受控executor，不能称其为真实浏览器E2E；HTTP不提供覆盖入口。

保存故障/完成时失效/跨候选与裁剪竞态、HTTP接口与鉴权/关闭、旧直接adopt单测及Pi E2E迁移仍待完成。完整标准typecheck/build/单测、Claude独立复审与Pi正式验收未完成，不称B4或M3-B通过。

## 第十批：B4 保存 / 发布 / 并发故障验证

job_e295fcc8：定向types0；新增九项全部实际通过，原十项按testNamePattern筛选未执行（JSON total19/pass9/pending10），源码身份不变。生产与83759a9无差异。覆盖初始保存失败不执行/不发事件，终态保存或事件发布失败不给绿灯并保留锁，完成后candidate/evidence变化转为持久failed且不误报I/O故障，失败重跑不复用旧绿，跨候选串行/释放资源先于下一执行，主动检查中自动裁剪先取消，终态保存阻塞时公开状态不提前completed。原件work-faults-20261114。

故障测试先断言正常close拒绝PERSISTENCE_FAILED、第二实例INSTANCE_LOCKED；之后仅测试夹具用明确清理路径等待无进程executor屏障再释放自己锁，不是生产HTTP旁路或放宽关闭保锁规则。当前没有重跑完整十九项，不能写19/19。

HTTP接口、真实HTTP并发关闭/证据响应、旧直接采用单测与Pi E2E迁移、完整回归和独立审查仍待完成。
