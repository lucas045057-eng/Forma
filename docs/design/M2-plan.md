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
