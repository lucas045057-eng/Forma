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
