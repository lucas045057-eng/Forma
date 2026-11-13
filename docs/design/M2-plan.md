# M2 指着说闭环 · 设计

依据：`docs/dev-doc-v0.1.md` §系统架构、§数据模型、§接口与事件协议、§安全与权限。
**过关条件**：“指着说 → 候选 → 采用”连续 10 次至少 8 次改对，且不修改选中范围以外的文件；撤回后页面与源码完全恢复。
分工（用户 2026-11-13“按现有角色开工”）：Claude Code 设计与调度，CodeBuddy 实现，Pi 测试，Codex 审查。
编码模型：OpenCode Go `deepseek-v4.1-flash`（`docs/research/coding-agent-model.md`）。

## 一次“指着说”的路径

1. Studio 点选得到 Selection（`baseVersion` = 作品版本库当前提交），用户输入文字指令，`POST /tasks`。
2. 后端校验（版本、源码位置、路径），任务入队；同一时间只跑一个任务。
3. 建候选版本：作品版本库里开分支 `candidate/<id>`，检出到独立目录。
4. 编码 Agent 在候选目录里用受限工具改文件；每一步记成任务事件。
5. 提交候选分支，算出 diff，启动该候选自己的预览服务，发 `candidate.ready`。
6. 用户在 Studio 里切换/并排对比“当前版本”和“候选版本”，采用（合并进主线）或撤回（丢弃）。采用后还能“回退上一次采用”。

## 关键设计决定

1. **作品有自己的版本库，与主仓库的 git 分开**：`git --git-dir=<DATA>/work.git --work-tree=<WORK_ROOT>`。作品目录仍是 `templates/product-page`（M1 的预览、写回、测试都不用动）。版本库只跟踪作品自己的文件（`src/`、`public/`、`index.html`、配置），忽略 `node_modules`、`dist`。
   - “当前版本”= 作品版本库的 HEAD。任何读版本的操作先把未提交的改动（例如 M1 的 3D 写回、手工编辑）自动提交成一个快照，所以 HEAD 始终等于磁盘内容。
   - 采用 = `git merge --no-ff candidate/<id>`；冲突则中止并报 409，不留半合并状态。回退 = `git revert -m 1 <合并提交>`（新增一个提交，不改历史）。
2. **候选目录**：`<DATA>/candidates/<id>`（git worktree）。依赖不重装：在候选目录建 `node_modules`，里面给作品 `node_modules` 的每个包建一个指向真实路径的目录联接（junction）。整目录联接不可行——pnpm 的包链接是相对路径，换了位置就断。
   - 因此作品的 `vite.config.ts` 改为从环境变量读 base / 端口 / 缓存目录，`tsconfig.json` 改为不依赖主仓库根配置。
   - 删除候选前先摘掉联接、停掉预览进程（Windows 上进程占着目录删不掉）。
3. **候选预览**：每个候选一个 Vite dev server（空闲端口，HMR 关闭——候选只在 Agent 写完后才提供预览），浏览器经 `Studio 5173 → 后端 /preview/c/<id>/ → 候选端口` 访问，与工作台同源。后端内置一个只转发 GET/HEAD 的反向代理。
   - 同时最多 3 个待定候选；第 4 个产生时自动撤回最早的那个。
4. **编码 Agent**：OpenAI 兼容 chat-completions + 工具调用，后端自己跑循环（最多 16 轮、总时限 180 秒、可取消）。
   - 工具只有四个：`list_files`、`read_file`、`write_file`、`replace_in_file`（精确替换一处），外加 `finish`。**没有 shell。**
   - 写入只允许候选目录的 `src/` 下、限定扩展名与大小；路径在后端规范化并拒绝符号链接；`scene.config.json` 写入前过 Schema。`package.json`、`vite.config.ts` 等一律不可写（改依赖属于 M3 的请示卡）。
   - 给模型的上下文：指令、选中对象（源码位置、组件名、文字、实例数、祖先位置、关键样式）、选中文件带行号的源码。
   - 每个请求带 `x-opencode-session: <taskId>`；上游地址非本机时强制 https；key 只在后端。
   - **越界记录**：候选改动的文件若不在“选中对象所在文件 + 祖先所在文件”内，记入 `candidate.outOfScope`，界面明示。M2 只记录和展示，M3 再把它变成请示卡拦截。
5. **版本与路径校验（承接 M0-B 审查 S4）**：`POST /tasks` 时后端验证 `selection.src` 是 `src/…:行:列` 形式且文件存在、行号在文件范围内；`baseVersion` 是版本库里的提交；选中的文件在 `baseVersion` 与当前 HEAD 之间没有变化，否则 409 `STALE_SELECTION`，要求重新点选。
6. **事件（承接 M0-A 审查 S2）**：所有事件（资产、场景、任务、候选、版本）经统一的事件日志发布，带全局递增 `seq`，追加写入 `<DATA>/events.jsonl`，重启后序号接续。`GET /events/history?since=<seq>` 补拉；WebSocket 连接时先告知当前 `seq`。Studio 断线重连后从最后序号补拉。
7. **持久化用 JSON 文件而不是 SQLite**：任务与候选存 `<DATA>/tasks.json`（原子写、串行），与 M0/M1 一致。理由：单进程、数据量小，JSON 可直接查看；Node 内置 sqlite 仍是候选发布状态。偏离开发文档“SQLite”，M3 若需要查询能力再换。
8. **检查（构建、冒烟、遮挡）属于 M3**：M2 的候选 `checks` 四项一律 `not_run`，界面显示“未检查”，不显示为通过。
9. **3D 写回仍直接写作品目录**（M1 的 `PUT /scene` 自带历史与撤回），不走候选；它产生的改动会在下一次读版本时被自动快照进版本库。原计划“M2 改写候选 worktree”不做：3D 写回是确定性的、即时的，走候选只会让“调一下看一眼”变慢。

## 接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | /version | 当前作品版本 `{ version }`（先自动快照） |
| POST | /version/revert | 回退最近一次采用；没有可回退的 409 |
| POST | /tasks | `{ instruction, selection? }` → 202 Task |
| GET | /tasks、/tasks/:id | 任务列表 / 详情（含事件） |
| POST | /tasks/:id/cancel | 取消排队或运行中的任务 |
| GET | /candidates、/candidates/:id | 候选（含 diff、outOfScope、checks） |
| POST | /candidates/:id/adopt | 采用（合并）；冲突 409 `MERGE_CONFLICT` |
| POST | /candidates/:id/discard | 撤回候选 |
| GET | /preview/c/:id/* | 候选预览反向代理 |
| GET | /events/history?since= | 事件补拉 |

事件：`task.updated`、`candidate.ready`、`candidate.closed`、`version.changed`，以及已有的 `asset.*`、`scene.changed`；全部带 `seq` 与 `ts`。

## Studio

- 右侧检查器在“选中对象”下加指令输入框和“生成候选版本”按钮；任务状态与步骤列表实时更新，可取消。
- 候选就绪后，预览区上方出现“当前版本 / 候选版本 / 并排对比”切换；下方是改动文件列表与 diff、越界提示、四项检查（均“未检查”）、“采用”“撤回”。
- 采用后预览回到当前版本；提供“回退上一次采用”。
- `baseVersion` 改为点选时向后端取作品版本（原先是主仓库的 HEAD）。

## 起点：调度草稿（分支 feat/m2-point-speak，提交 56a23f8）

调度在设计时写了一部分代码验证路线，**未接线、未测试**，CodeBuddy 可以保留、修改或重写：
- `apps/server/src/events.ts`：持久事件日志（seq 跨重启接续、补拉）。
- `apps/server/src/work/repo.ts`：作品版本库（独立 git-dir、自动快照、候选 worktree、逐包 junction 链接依赖、合并采用 / revert 回退、崩溃后中止半合并）。
- `apps/server/src/work/preview.ts`：候选预览进程管理与只转发 GET/HEAD 的反向代理。
- `apps/server/src/agent/tools.ts`：编码 Agent 的沙箱工具（list/read/replace/write/finish，只写 src/，scene.config.json 过 Schema）。
- 作品 `vite.config.ts` 读 `PREVIEW_BASE / PREVIEW_PORT / PREVIEW_CACHE_DIR`，`tsconfig.json` 不再继承主仓库根配置。**已手工验证**：候选 worktree + 逐包 junction + 这份 Vite 配置可以起独立预览，源码标记插件生效，依赖预构建正常。整目录 junction 不行（pnpm 相对链接会断）。

## 任务卡

### M2-A 后端闭环（CodeBuddy）
事件日志接管全部事件推送并提供补拉；作品版本库与 `/version`；任务队列与 `/tasks`；编码 Agent 循环（OpenAI 兼容 + 工具调用，mock 上游可脚本化）；候选生命周期与 `/candidates`、采用、撤回、回退、最多 3 个待定；候选预览代理 `/preview/c/:id/`；选中对象的版本与路径校验；越界文件记录；`checks` 全部 `not_run`。

### M2-B Studio 界面（CodeBuddy，M2-A 之后）
指令输入与生成、任务步骤实时显示与取消、当前/候选/并排预览切换、diff 与越界提示、未检查标注、采用/撤回/回退上一次采用；断线重连按 seq 补拉；`baseVersion` 改为作品版本。

### 测试（Pi）
全部走 mock 模型上游，不打真实接口；真实模型的“10 次至少 8 次改对”单独做一轮实测并如实记录（这一轮会花 OpenCode 额度，用户已授权随意使用额度的是 Lux3D，模型额度跑前确认）。

### 审查（Codex）
M2-A、M2-B 各一轮，重点：沙箱写入边界、git 操作的崩溃安全、预览进程与端口泄漏、代理是否可被利用、事件补拉语义、key 不外泄。

## M2-A-fix 审查整改（依据 docs/reports/M2-A-review.md，结论“不通过”：阻断 2、应修 6）

### 设计变更：预览与工作台分源（解决 B1，取代开发文档“作品 iframe 与工作台同源”）
- 问题本质：编码 Agent 写进 `src/` 的代码会在预览里执行；预览与工作台、API 同源时，这段代码能直接调用 `PUT /scene`、`POST /assets/lux3d` 等正式写入和付费接口，工具沙箱形同虚设。
- 决定：**所有预览（当前作品 /preview/main/ 与候选 /preview/c/<id>/）都改由一个独立的“预览源”提供**——后端另开一个只做预览转发的监听端口（默认 127.0.0.1:5175，可配置），上面**没有任何 API 路由**；工作台与 API 仍在 5173（经 Vite 代理到 3001）。
  - 当前作品也一并分源：采用后的代码同样来自模型，非程序员无法逐行审 diff。
  - API 的 Origin 校验因此会拒绝来自预览源的请求（Origin 端口不同）；需加单测证明：从预览源发起的写入/付费请求被拒、计数为 0。
  - 当前作品的 HMR websocket 走预览源转发（Vite `hmr.clientPort` 指向预览源）。
  - bridge 改为跨源：工作台把自己的 origin 告诉预览（例如 iframe URL 参数或首条消息），bridge 只接受来自该 origin 的父窗口消息并用精确 targetOrigin 回发；工作台只接受来自预览源 origin 的消息。
  - 工作台不得再读 `iframe.contentDocument`（跨源后不可用）：M1-B 的“匹配作品画布尺寸”改为由 bridge 上报画布尺寸。
- 这会改 M0-B 的消息安全测试与 M1-B 一致性测试的前提，Pi 需要相应更新。

### 其余整改
- **B2**：候选 Vite 显式设置 `server.fs.allow`，只允许候选目录、作品 node_modules 链接到的真实依赖路径和受信共享包（packages/*）；拒绝主仓库根、apps/server、orbital、.data、docs。用主仓库哨兵文件验证 `/@fs/` 读不到。当前作品的 Vite 同样收紧。
- **R1** 快照只跟踪作品允许的路径清单，排除 `.env*`、密钥、备份、临时文件，暂存区提交前审计。
- **R2** 作品版本库的快照/采用/回退/候选创建删除统一互斥，跨 git 与 JSON 的操作写意图日志，启动时幂等恢复；与 3D 写回协调。
- **R3** 事件日志启动时修复断尾；持久化成功后再广播，写失败不静默；seq 只增不减。
- **R4** 任务级统一超时信号贯穿工具执行；限制单次响应字节、每轮工具调用数、累计读写字节。
- **R5** 路径规范化按 Windows 规则：大小写不敏感比较特殊文件、拒绝设备名、尾随点/空格、ADS（`:`）。
- **R6** 候选创建失败回滚；预览进程 error/close 统一处理；后端重启时清理遗留预览进程与无主候选目录。
- 建议 S1–S3 视工作量一并处理，未处理的写进报告。
- 顺序：等 CodeBuddy 交回 M2-B 并合并后再派（分源会改 Studio 的 iframe 与 bridge，和 M2-B 同一块代码）。

### M2-A-fix 追加（依据 Pi 的 docs/reports/M2-A-test.md，2 项阻断缺陷）
- **D1** 候选预览在浏览器里渲染不出：候选 Vite 仍注入 HMR 客户端，代理不转发 WebSocket，`@vite/client` 反复断线重连导致模块请求被中止。修法：分源后的预览端口要支持 Vite 的 WebSocket 升级（候选与主作品都走同一套），或让候选彻底不注入 HMR 客户端；以 Pi 的 `test.fail` 用例转为通过为准。
- **D2** 沙箱可经 `src/` 下的 junction 写出：Windows 上 junction 在 `lstat` 里显示为目录，逐段 `isSymbolicLink()` 拦不住。修法：逐段用 `realpath` 比对（或 `lstat` 后检查 reparse point），确认解析后的真实路径仍在候选 `src/` 之内；list/read/write 统一使用。与审查 R5 一起做。
- 观察：后端 `service.test.ts` 的并发/重启幂等用例偶发 `submit_unknown`（单独重跑通过），排查时序/端口竞争。

## M2 第二轮整改（依据 M2-A-review.md“复核（整改回合）”与 M2-B-review.md）
- **F1 阻断**（src/public 根目录本身是 junction 时漏查）：属于 D2 修复的遗漏，Claude Code 已修（master 92ec0c9）：根目录同样做 lstat + 真实路径比对；候选提交前检查候选目录；3D 写回与资产采用的路径检查加真实路径比对。
- **CodeBuddy（分支 fix/m2-review2）**：F2 预览源加 Host 白名单（HTTP 与 WebSocket 升级统一，默认仅 loopback）、Origin 只与配置的 Studio/预览源比较；F3 已有作品版本库的跟踪路径/索引审计在启动、快照、建候选前无条件执行；F4 事件日志在实例锁内初始化、在所有事件生产者停止且日志关闭后才释放锁；M2-B R1 重新点选、等待版本号期间作废旧选中对象并禁止提交（含快捷键）。建议 S1（画布尺寸带 requestId）、S2（区分操作成功与刷新失败）视工作量处理。

## M2 第三轮（依据 Pi 测试回合 2，docs/reports/M2-B-test.md / M2-A-test.md“回合 2”）
- **D3（应修，CodeBuddy，分支 fix/m2-d3）**：后端被强杀（`taskkill /T /F`）后，候选预览的 Vite 进程仍存活，端口与进程残留；与 M2-A 整改 R6“父进程异常退出后预览自动退出”不符。证据 docs/reports/artifacts/M2-B/isolation-r6.json（或 M2-A 同名证据）。同时排查后端单测偶发失败（service.test.ts、lux3d.test.ts 各出现过一次）。
- **Pi**：回归第二轮整改（F2/F3/F4/R1，master 已合并），补测上一轮未运行的界面项（STALE_SELECTION 提示、断线重连补拉与截断重载、3 个待定候选切换、单事件连接复用）。

## 接管后的收口安排（2026-11-13）

用户要求 Codex 接管并按既定角色继续：Codex 调度设计、CodeBuddy 实现、Pi 测试、Claude Code 独立审查。只收口 M2，不启动 M3。

1. 冻结已知主线 f70f046；fix/m2-review2 的 d79c467 尚未合并。两份历史审查报告保留原文，最新结论是 M2-B 实现审查通过、M2-A 有条件通过，剩 N4 与 D3。
2. `.worktrees/m2fix` 已有未提交 N4 草稿。调度/审查不覆盖、不代提交；记录其归属与内容，等待完整固定提交、测试证据后审查。CodeBuddy 只在 `.worktrees/m2d3` 修 D3 与不稳定单测，避免两个实现者同时改停机队列。
3. D3 必须验证实际进程拓扑和归属，分别强杀后端 PID/启动树，并核对 worker、Vite 与端口；重启清理要防 PID 重用及误杀其他会话。稳定性要求包括定位偶发单测根因与连续五次全量验证，不能靠延长超时或放松断言。
4. N4 验收：停止接收新作品操作，排空已接收请求/Agent/作品互斥/场景队列；所有事件生产者停止后关闭日志，最后释放实例锁。进程尚有写入能力时不能提前解锁。补真实 HTTP 排队关闭、第二实例锁竞争及重启 seq 接续用例。
5. STALE_SELECTION 暂按现有“选中文件在点选版本后是否变化”的规则，不直接改语义。Pi 必须同时记录 selection.src/baseVersion 和被改文件，覆盖同文件变化应拒绝、其他文件变化应允许。先快照本身不改变请求携带的旧 baseVersion；buy-button 位于 Button.tsx 时，仅改 App.tsx 不能证明 stale 校验失效。
6. Pi 先做上述诊断、R1 延迟/失败版本请求（含 retry）、断线补拉/截断重载、三候选切换和单事件连接的专项。未合并 d79c467 的已知失败不得算已修，也不得删断言。全部实现交付、Claude Code 审查通过后，调度才合并；再在同一冻结 HEAD 上统一跑各套回归。
7. 本轮不调用真实编码模型或 Lux3D，真实模型“10 次至少 8 次改对”仍待 mock 测试和审查都通过后再向用户确认额度。子进程任务均通过 Orbital 后台启动与完成通知接续，不轮询、不把 CLI 启动成功当作交付。

### 收口证据更新与 N4 交接（23:40 后）

- D3 两种身份明确的实际强杀对照已完成：候选 ready/实际端口 200 后，worker 在 1 秒和 30 秒均已退出；旧 Pi 全局匹配未识别这些 worker。先由独立审查和 Pi 核实归属，不盲改生产，也不直接判 D3 已修。
- N4 已由 Pi 真 HTTP 预期失败用例证实。原 m2fix 草稿已保存固定 patch+hash，原处不动；现交 CodeBuddy 在 m2d3 接手完善，取代上文“只等待原草稿交付”的安排。关闭须拒绝新操作、排空旧队列/内部重入，所有写入和事件生产者停止后才关日志放锁，不能用日志拒写掩盖晚到文件写入。
- Claude Code 提示的额度恢复时间已到，重派 d79c467、固定 N4 草稿及 D3 证据的独立审查；CodeBuddy 的 N4 成品仍须后续按固定提交审查。主工作树的 Pi 正式测试不由其他角色修改。

### 固定成品审查通过后的集成（2026-11-14）

- e468c20 已经完整 typecheck/build、每轮 235 项单测连续五轮验证，Claude Code 最终审查关闭 N4/N4-a/N4-b，无阻断/应修。按既定授权由调度合并到 master，保留原 m2fix 草稿与实现 worktree，直到 Pi 正式回归完成。
- D3 旧统计误报已纠正，Pi 在 e058442 上五场景各通过一次；以 PID+创建时间、真实监听端口与 decoy 判据为准。早先“1 秒退出”的标签不能当精确测时；启动后清理历史孤儿仍为未覆盖。
- Pi 先将 retry 与 N4 两处 test.fail 改成正常断言并提交，冻结同一集成 HEAD；六套 e2e 与一轮单测/typecheck/build 在该 HEAD 顺序运行，D3 五场景再补一轮，保留每轮独立证据。未覆盖项不得算通过，不以调超时或 retries 掩盖失败。
- 本轮不额外修审查建议，不启动 M3、不调用真实服务。mock 门槛通过后，才准备真实模型十次测试方案并向用户确认 OpenCode 额度。
