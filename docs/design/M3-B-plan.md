# M3-B 真实检查与采用门禁实施计划

> **For agentic workers:** 按用户既定分工，由 CodeBuddy 用 executing-plans 逐任务实现，不开子 Agent；Claude Code 独立审查，Codex 集成，Pi 独立验收。无需再确认开工。每步先失败测试、最小实现、实际验证、精确提交。

**Goal:** 候选只有在真实 schema/build/smoke/occlusion 检查全部通过、证据仍对应当前内容时才能采用。

**Architecture:** WorkService 管理持久 CheckRun 与候选结果，沿用 repo.exclusive 和关闭准入。锁内审计并生成不可变检查快照，锁外由可信固定子进程检查；结果回到锁内核对摘要再发布。浏览器检查同一份真实构建产物的独立本机静态源，不使用工作台 API 或可变 Vite 配置。

**Tech Stack:** Node 24、TypeScript strict、Fastify、现有 Ajv/Scene Schema、已安装 Vite/React 插件与 Playwright Chromium。只允许离线声明本机已安装的精确工具依赖，不升级或下载新包/浏览器。

**Spec:** `docs/design/M3-plan.md` 的检查合同；`docs/dev-doc-v0.1.md` 的基本检查与候选；已验收 M3-A `40cc46b`，归档 `c6c8ffe`。

## Global Constraints

- 不改 Studio UI、tests/e2e、Pi 正式证据或旧 worktree；不读真实 .env/ASKS，不发真实模型/Lux3D 请求。provider 配置只用 fake key/loopback。
- 顺序 schema → build → smoke → occlusion。build 120000ms、smoke/occlusion 各30000ms、整个 run 180000ms；schema/准备也受整体截止约束。测试可注入更短预算，不能放宽产品预算掩盖失败。
- 单后端同一时刻只跑一个检查子进程；候选最多三份，不需要通用任务平台。等待/运行不能占住 repo.exclusive，用户任务、回答请示和取消仍可推进。
- 不运行 package scripts、候选配置、任意 shell、用户提供的命令或 Playwright spec。运行器入口与 argv 由后端固定，工具选项不能来自 HTTP。
- 新准入、取消、结果落盘、事件、进程/浏览器/端口回收加入 N4 关闭屏障；不以 catch 吞错假装清理成功，不盲杀其他进程。
- 无强制采用/临时 bypass。旧候选缺少运行记录时仍 not_run；检查状态不能由前端或模型写成 passed。

## Review Focus

1. 候选改动、基线变化、检查途中 discard/trim/adopt 不能复用旧绿灯或晚写已经关闭的候选。
2. imports、CSS URL、?raw/?url、动态 import、链接、公共资产不能让构建读取后端 .env、工作区私密文件或执行候选 Node 模块。
3. 浏览器的 HTTP/重定向/WebSocket/worker/service worker 不能访问工作台写入/付费 API；禁止以“localhost 全放行”代替精确静态源。
4. 取消/超时/缺浏览器/子进程错误/父进程退出后不能留下 running 或孤儿；进程身份和子树清理要有证据。
5. 保存失败与损坏状态不能广播 passed；证据路径 traversal/编码分隔符/符号链接不得逃逸数据目录。

## 文件职责与接口

- `packages/shared/src/index.ts`：扩展 Check 的 runId、message、证据引用；新增 CheckRun（id、candidateId、baseVersion、candidateCommit、contentDigest、mainVersion、policyVersion、status、checks、时间、错误），Candidate 可带 latestCheckRunId。Check.status 保留 passed/failed/not_run；queued/running/completed/cancelled 是 run 状态，另有 outcome，不能混淆完成与通过。
- `apps/server/src/checks/snapshot.ts`：安全审计/复制/逐字节树摘要；候选 src、可用 public 资产、可信入口/工具版本组成身份；有序路径+长度+原字节，覆盖未被修改的依赖源码和删除。不得只复用 pendingDiff 的改动摘要。
- `checks/runner.ts`：固定 process.execPath + 可信 worker 入口、最小 env、预算/中止、输出上限、归属与清理；不运行候选 JS 于后端 Node。
- `checks/worker.ts`、`checks/build.ts`：固定 worker 协议与可信构建。schema 复用 validateScene；构建/静态服务/浏览器由本次 worker 拥有。
- `checks/browser.ts`：真实页面冒烟、命中检测、截图与机器可读报告；浏览器依赖缺失如实失败。
- `checks/artifacts.ts`：固定文件名集合、原子结果、体积限制、只读安全打开；不暴露绝对路径。
- `work/service.ts`、`work/repo.ts`：同一 tasks.json 中持久 runs（旧数据缺失=[]），检查操作与既有互斥/持久恢复/候选生命周期协作；必要时抽取小型 coordinator，不重构无关审批。
- `app.ts`：POST `/candidates/:id/checks`，GET `/checks/:id`，POST `/checks/:id/cancel`，GET `/checks/:id/artifacts/:name`，沿用 Host/Origin 与错误合同。
- 实现单测集中 `checks/*.test.ts`、`work/checks.test.ts`、`checks/routes.test.ts`；报告 `docs/reports/M3-B-impl.md`。Pi 后续自行编写独立 E2E。

接口：`startChecks(candidateId)` 接受 pending 的公开候选，返回 run（202）；同候选同身份 queued/running 返回同 run，不重复进程。已完成同身份也返回现有结果；显式 `{rerun:true}` 才新建，不自动重试。参数原始 JSON 严格验证，无预算/命令/env 注入。`cancelChecks(id)` 取消 queued/running，重复取消幂等；完成后不得改写成 cancelled。GET 详情返回状态和证据相对 API 链接。

## 身份与隔离合同

锁内先 recover 既有持久意图、审计候选路径与分支、snapshot 当前作品。当前主版本与 candidate.baseVersion 不一致时拒绝启动 `STALE_CANDIDATE`（409，需重新生成候选），避免拿孤立候选检查代替合并后结果。复制前/后重新核对内容身份，变动即失败；锁不防外部编辑，必须重读字节，不能只认 branch HEAD。快照只收 src 和安全 public 资产，禁止链接（含根目录），过滤凭据/隐藏配置/可执行服务文件，限制条数与体积并给明确超限原因。node_modules 只能链接/解析可信已安装依赖，不复制后端目录。

可信 HTML 固定 root + src/main.tsx；可信 Vite 选项 configFile:false、envFile:false、独立 root/cache/outDir、固定 React 插件，禁用任何可变 package/plugin/config 自动发现。固定 resolve 白名单为模板现有声明的浏览器依赖及其已安装传递依赖；对实际解析后的路径执行边界检查，防止 ?raw、CSS 导入、绝对路径、node:、网络 import 及 src 内新脚本变成 Node 执行。使用现有共享包源码时纳入 trusted tool identity。构建程序转换候选代码，不在 Node 中 import 候选模块。最小 env 明列必要 Windows/SystemRoot/TEMP 等，绝不继承 NODE_OPTIONS、provider key 或整个 process.env；不用 .env 文件。

浏览器只打开 worker 创建的精确 `http://127.0.0.1:<port>/` 静态源，不使用 Vite dev server/现有后端。静态服务只读构建产物和已审计资产，拒绝目录逃逸/链接/未知 Host/任意代理。Playwright 在导航前安装请求与 WebSocket 拦截，禁用 service worker，阻断其他本机端口、外部网络、file 协议、重定向逃逸；记录被阻断请求且相关检查失败。数据/blob 只作为页面内资源，不放开外部 URL；防范页面新建 context/popup/worker 的绕过。固定 worker 的 Node 网络仅必要 loopback 静态服务，无真实 API。可使用可信网络 preload 守卫，但报告明确应用层隔离的范围，不声称 Windows OS 安全沙箱。

产物固定为 schema.json/build.log/smoke.json/smoke.png/occlusion.json/occlusion.png/runner.log/summary.json（可按需要细化固定集合），禁止 HTTP 传入磁盘路径。每份引用带 MIME/bytes/hash；日志限长、敏感字段不输出。未知 run/name 404，路径攻击拒绝，已有文件被换链接也拒绝；证据响应禁缓存、nosniff，日志纯文本、截图 image/png，不能执行 HTML/SVG。

## 可复现页面判据（当前模板）

固定 Chromium viewport 1440×900、deviceScaleFactor=1；记录浏览器版本、页面 URL、viewport、耗时和最终截图，不宣称跨浏览器覆盖。

- **schema**：真实读取 `src/scene.config.json`，缺失/JSON 解析/Schema 或语义错误均 failed，字段原因进入证据；成功保存实际配置 hash。
- **build**：实际调用可信 Vite build API、产物存在且非空才 passed；语法/解析失败为 failed，不以 typecheck/mock 结果代替。记录真实工具版本和 exit/error。
- **smoke**：等待 `#root main`、唯一可见可用 `[data-testid=buy-button]`、`[data-testid=product-scene]` 的 ready 或可见 product-placeholder 明确 fallback；实际点击购买，`action-status` 的 data-purchases 必须增加1并有非空反馈。不靠易改的按钮文案。全过程 pageerror 为空，阻断请求为空；本地资产失败只能在明确 fallback 且无未捕获异常时按该合同通过并记录限制。
- **occlusion**：枚举当前 viewport 中 button/a[href]/input/select/textarea/[role=button] 的可交互元素。disabled/hidden/零尺寸/完全在视口外分别记录排除原因；不能把空集合当通过。对每个剩余元素的可见矩形中心及四个内缩角点调用真实 elementFromPoint（小元素去重采样），命中自身或后代才可交互。没有任何命中点的元素 failed，购买入口中心必须命中。报告每个目标的定位/rect/样点/命中遮挡元素/理由。只覆盖首屏，offscreen 不算通过项；不自动滚动掩盖固定遮挡。

前序失败停止后续，后续 not_run + blocked_by；timeout/error 使当前 failed，未启动后续 not_run；取消 run=cancelled，已经完成的真实结果保留，其余 not_run + cancelled。全部检查必须有证据才可成为 adopt 绿灯。

## 任务 B1：内容快照、状态与安全协议

- [ ] 写身份失败测试：改动未修改文件/资产、未提交文件、删文件、草稿期间篡改、根/子路径 junction、旧候选缺记录、损坏 runs；断言不继承绿灯或静默重置。
- [ ] 实现共享类型、受控快照和最小持久 run/严格 API，同身份并发仅一条。启动时 queued/running 标 SERVICE_RESTARTED 失败/未运行，绝不自动重跑或自动采用。
- [ ] 定向 typecheck 与上述测试实际先红后绿，短后台命令记录身份；提交独立中文 commit。

## 任务 B2：真实 schema/build 及受控子进程

- [ ] 失败测试包含坏 schema、语法错误、候选配置/脚本写哨兵、.env 诱饵、?raw/CSS/绝对路径逃逸、超时/异常退出/日志上限；不读真实凭据。
- [ ] 实现可信 worker/build 和按归属取消/父进程断开回收；成功产物与证据 hash，前序失败不启动浏览器。证明模型变动 package/config 无法执行或带出文件。
- [ ] 用真实 Vite 成功与故障快照验证（不能只 stub build），定向绿灯后提交。

## 任务 B3：浏览器冒烟/遮挡、网络与资源清理

- [ ] 写运行异常、盖住购买入口、所有目标缺失、明确 fallback、外部请求/后端端口/WebSocket/重定向/worker、浏览器缺失、预算中止回归；popup 不能访问正式 API。
- [ ] 实现静态源和上述固定真实判据；真实 Chromium 成功/故障测试（loopback），检查截图/报告/进程与端口清理。固定高位端口有界分配，参考现有 fetch-listener 经验，不改 OS。
- [ ] 定向验证并提交。真实浏览器故障用例可合理单独预算，不能放宽业务30s/180s，不自动补跑。

## 任务 B4：采用门禁、持久化与关闭

- [ ] 写 WorkService/API 失败测试：四 passed 但无 run/无证据、任一 failed/not_run/检查中、检查后改字节/基线、discard/trim 竞态、旧数据、跨候选结果、伪造请求、保存失败、关机/重启不能晚发 passed。
- [ ] 在 adopt 同一 repo.exclusive 中 snapshot 主作品后，核对最新成功完整 run 的 candidate/commit/base/main/policy/digest/证据。失败统一409 CHECKS_NOT_PASSED，保留作品与候选；过期需新候选，禁止复用旧绿灯。检查完成后锁内再次核对候选仍存在且 pending、身份不变，再保存 runs/candidate.checks 后发 check.finished。
- [ ] start/cancel/close 纳入准入排空；discard/trim 先终止该候选检查再删自己的快照，不能锁内等一个还需要该锁的结果收尾。事件全部先持久再广播，seq 沿用 EventLog；关机等待运行器/浏览器实际退出才关日志放锁。
- [ ] 迁移受影响的实现单测：以前直接 adopt 的测试改为真实检查或明确注入受控 runner 测试替身（只通过构造参数，不能提供生产HTTP旁路）；保留所有原采用/回退/审批/锁断言。不改 Pi E2E，其适配由 Pi 在合并后独立完成。
- [ ] 完成定向、typecheck/build/标准 pnpm test 单轮，所有长任务后台启动后立即结束回合。报告真实判据/身份/隔离限度、失败路径、迁移、预算、证据与清理，固定干净HEAD交审，不自行合并或标正式E2E通过。

## 独立交付门禁

CodeBuddy 完成 B1–B4 后，Claude Code 独立审查上述 Review Focus、实际源码执行/网络/文件边界、digest/采用竞态与N4恢复；整改通过后由 Codex 合并冻结。Pi 独立验证成功以及编译/运行/遮挡/Schema四故障、取消/超时/缺浏览器/重启、证据读取和采用拒绝，再迁移旧 E2E 走真实检查并跑完整回归。M3-C UI 未开始前旧UI仍不可采用是该阶段的可见限制，不能偷偷移除后端门禁换取旧用例绿灯。

### B3 当前模板的 worker 策略补充

当前模板无需 dedicated/shared/service worker，因此浏览器检查统一禁止它们创建。静态源worker-src none作为底层策略，导航前构造器/注册入口守卫记录被阻断尝试，检查失败。不能仅凭Playwright主页面路由声称覆盖任意worker内部WebSocket。未来依赖worker的模板需重新设计并独立验证；本阶段不外推通用页面支持。
