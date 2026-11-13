# M2 独立审查 · Claude Code

- 日期：2026-11-13（Asia/Shanghai，额度提示 23:40 之后重派的本轮）。审查者：Claude Code（只读，不实现、不合并、不提交）。
- 固定审查快照：**`d79c467e0f72188c81fd21f12c203e30bb4c05a9`**（fix/m2-review2，未合并 master）。下文 `d79c467` 行号均对应该提交本身（用 `git show d79c467:<path>` 读取，不是变动中的工作树）。
- N4 草稿：仅审 `orbital/coordination/m2-takeover/n4-draft.patch`（sha256 `f04f997f…6fab`）对应的固定快照；行号对应 `.worktrees/m2fix` 中与该快照一致的文件（hash 见第 4 节）。
- D3：读取 `.worktrees/m2d3` HEAD `4bfc4c1` 的诊断脚本和 `.data/d3-diagnostic-1794584112672/evidence.json`，没有改动或运行该 worktree。

## 1. 结论

| 项 | 结论 |
| --- | --- |
| N1 启动恢复先查链接 | **关闭**（独立复现） |
| N2 ls-tree 完整路径 | **关闭**（独立复现） |
| N3 初始化异常的资源所有权 | **关闭**（静态核对；“关闭失败时仍解锁”并入 N4） |
| M2-B R1 公共提交 / retry 门禁 | **关闭**（静态核对） |
| **N4 停机排空** | **未关闭（应修）**。`d79c467` 本身未修，Pi 的真实 HTTP 证据成立。草稿方向正确，但**仍有已接收的提交在 `work.close()` 返回后写 `tasks.json` / 发事件**（本轮用临时数据跑探针确认），并且关闭失败时仍会无条件解锁。 |
| D3 / R6 强杀残留 | **维持未关闭，但原失败证据作废**：Pi 的计数器会匹配到它自己的查询进程（固定为 2），不能证明有残留。新诊断在单进程强杀场景得到一次正面结果，还需在冻结 HEAD 上用按身份判定的正式用例重测。 |
| STALE_SELECTION | **不是缺陷**：回合 3 点的是 Button.tsx、改的是 App.tsx，两者不是同一个对象；产品语义不应改。 |

M2-A：**有条件通过，不能转为“通过”**（N4 应修，D3 待正式回归）。M2-B：同意 Codex 的“通过”。本轮没有新增阻断。

## 2. 已关闭项的证据

### N1 · 关闭
- `apps/server/src/work/repo.ts:89`（d79c467）：`assertNoLinks()` 在 `:90` `merge --abort`、`:91` `revert --abort` 之前执行。新仓库分支 `:73`–`:80` 只写版本库/索引，不恢复作品文件。
- 独立探针：用 `git archive d79c467` 把 `repo.ts` 解到系统临时目录，导入真实 `WorkRepo`；在临时作品目录里做出真实合并冲突（`MERGE_HEAD` 存在），把 `src` 换成指向空外部目录的 junction，再调用 `init()`。结果为 **`UNSAFE_WORK_TREE`、外部目录 `[]`、`MERGE_HEAD` 仍在**。用完后移除 junction 并删除临时目录，没有触碰项目作品仓库。

### N2 · 关闭
- `repo.ts:106`–`:116`：只按第一个 tab 切分，用 `^(\d{6}) (blob|tree|commit) [0-9a-f]{40,64}$` 校验元数据，含控制字符一律拒绝，报错时用 JSON 转义后的完整路径。
- 同一探针中用 `git mktree -z` 造树：`src/ok.ts` 通过；`src/ok.ts\tevil.pem`、`src/ok.ts\nevil.pem`、`src/ok ts.ts`、120000 链接、160000 子模块都返回 **`UNSAFE_TRACKED_FILE`**，报错显示完整的转义名称。空格路径是被现有允许清单拒绝的，不代表支持该名字。

### N3 · 关闭（初始化路径）
- `apps/server/src/app.ts:51`–`:58`：先登记锁的所有权，并提供逐个关闭的 `closeAll`（单个关闭失败不会跳过其余项，最后抛出首个错误）。`:59`–`:201` 的 try 覆盖 EventLog 构造与初始化、Scene/Asset/Lux3DClient/Work 构造、`work.init`/`service.init`、websocket 注册和全部路由；每个对象创建后立即登记（`:61`、`:70`、`:77`、`:88`）。catch `:198`–`:200` 会清理并保留原错误。
- 新增单测 `events-lock.test.ts:31`–`:41` 覆盖了 Lux3D 构造失败后立即重试。本轮没有重跑该单测，以 Codex 的内存注入探针和静态核对为准。
- 遗留问题：`closeAll` 遇到任何一项关闭失败仍会执行 `releaseWorkLock`（`:55` 吞掉错误后继续）。这正是 Codex 在 N3 修法里要求的“无法确认生产者已停止就不能解锁”，现归入 N4 跟踪。

### M2-B R1 · 关闭
- `apps/studio/src/PointSpeak.tsx:22`：所有入口共用的 `submit()` 都检查 `!submittable`；`:53` 生成按钮、`:36` 快捷键、`:64` 重试按钮的禁用条件都包含 `!submittable`。`pick-state.ts:14` 只在 none/ready 状态下允许提交。合法重试（ready/none）没有被关掉。
- Pi 在 master `f70f046` 上的 `takeover-r1-retry-known-failure.json` 只证明 master 未修。合并后去掉 `test.fail` 重跑才算界面回归通过。

## 3. N4（应修，未关闭）

### 3.1 d79c467 本身
- `app.ts:196` 把 `closeAll` 挂在 preClose。Fastify 5.12.8 的 `fastify.js:410`–`:445` 先设 closing、关闭路由（新请求返回 503），然后执行 preClose，**最后才 `server.close()`**。所以 preClose 执行时，已接收的 handler 可能仍在运行或排队。
- `work/service.ts:299`–`:307`（d79c467）只等 `taskQueue`、预览和 `writes`，不等 `repo.exclusive` 队列。`version/adopt/discard/revert/trimCandidates/validateSelection`（`:54`–`:57`）以及 `/scene*`、`/assets/:id/adopt`（`app.ts:187`–`:195`）都在这个队列里。`events.ts:55` 的 close 只清订阅者，关闭后仍可 `publish`。
- Pi 的真实 HTTP 证据 `docs/reports/artifacts/M2-A/takeover-n4-shutdown.json`（master 上跑）：操作阻塞期间 `lockHeldWhileBlocked=false`，`secondWhileBlocked.started=true`。解锁时 `head` 不含标记、`eventBytes=0`；放行后旧实例才提交快照，并写入 `version.changed`（seq 1），即 `writesBeforeUnlock=false`、`eventsAfterUnlock.hasVersionChanged=true`。该证据与代码一致，**缺陷成立**。

### 3.2 草稿（n4-draft.patch）评估
做对的部分：`repo.ts:38` 关闭后拒绝新的外层作品操作；`:70` `drain()` 等待已排队的操作；`service.ts:305` 在关预览、解锁之前排空；`events.ts:36`/`:57` 关闭后拒绝 `publish`，把晚到的写入从“静默写进别人的日志”变成显式失败。草稿自带的测试覆盖了“已排队操作先完成，再关日志、放锁”。

仍不足的部分：

**N4-a · 应修：`submit` 可在 `taskQueue` 已被等待之后再挂上新任务，`work.close()` 返回后仍有写入**
- 位置（草稿）：`work/service.ts:140`–`:147` 与 `:299`–`:307`。
- 过程：`submit` 在 `:141` 通过 closing 检查后，在 `:142` 把 `validateSelection` 排进作品队列（即使没有选中对象，包装器也会走 `exclusive`）。`close()` 先在 `:302` 等待**当时的** `taskQueue`，然后才在 `:305` 排空作品队列。排空过程中 `submit` 继续执行：`:146` 保存并发送“已排队”，`:147` 把 `execute` 接到 `taskQueue` 上，而 close 已经不会再等它。随后 `execute` 走到 `:168`–`:171` 的 closing 分支，保存 `tasks.json` 并 emit。
- 实证（临时目录、存储/事件用记录替身，导入草稿中真实的 `WorkService`/`WorkRepo`）：先用一个外层作品操作阻塞队列，再 `submit('改按钮')`，然后调用 `close()` 并放行。记录顺序为：`saved` → `task.updated(queued)` → `submitResolved` → **`workClosed`** → **`saved (afterUnlock)`** → **`task.updated(failed, afterUnlock)`**。在真实 `closeAll` 里，`work.close` 之后还会关资产、等场景，所以这次写入落在解锁前还是解锁后取决于时序。无论落在哪边，`work.close()` 返回时都还有活的生产者：`tasks.json` 可能在第二个实例接管后被改写，事件要么写进别人的日志（未加草稿时），要么在 `publish` 抛错（加草稿后）。
- 修法：close 先让 `repo` 停止接收新操作（或统一一个 closing 闸门），再**循环**等待 `taskQueue` 与作品队列直到二者都不再增长；同时 `submit` 在 `validateSelection` 之后、写入任务之前重新检查 closing，并拒绝（`SERVICE_STOPPED`）。回归：用真实 HTTP `POST /tasks`（带或不带 selection）卡在作品队列后启动 `app.close()`，断言 close 返回后 `tasks.json` 字节与事件日志不再变化。

**N4-b · 应修：关闭任一步失败后仍无条件放锁**
- 位置：`app.ts:52`–`:58`（d79c467，草稿未改）、草稿 `service.ts:299`–`:307`。
- 例如 `previews.stopAll()` 抛错时，`:307` 的 `await this.writes` 会被跳过，`closeAll` 继续关日志并释放 work-data 锁，而预览进程或未完成的写入可能仍然活着。草稿没有处理这一点。
- 修法：任何生产者无法确认已停止时，保持锁、记录错误并让进程以失败退出（下次启动靠死 PID 接管），不要在当前仍存活的进程里释放锁；或者至少等所有关闭项都确认完成之后才释放锁。回归：注入 `work.close`/`stopAll` 失败，断言锁仍在、第二实例返回 `INSTANCE_LOCKED`。

**N4-c · 建议：未进入作品队列的变更 handler 不在任何屏障内**
- `POST /tasks/:id/cancel`（d79c467 `service.ts:236`–`:244`）不检查 closing，也不进 `exclusive`，会直接保存并 emit。preClose 之前已接收的这类请求可能晚于解锁写入（窗口很小）。建议统一统计在途的变更请求（onRequest/onResponse 计数），在 close 中等待计数归零后再关日志。

**N4-d · 建议：错误码与测试面**
- 草稿 `repo.ts:38` 返回 `SERVICE_CLOSING`/503，`service.ts:141` 返回 `SERVICE_STOPPED`/409，同一语义用了两个码，建议统一。
- 草稿测试 `events-lock.test.ts:55`–`:64` 直接调用 `work.repo.exclusive`，没有经过 HTTP，也没有覆盖 submit 和取消路径。成品须重跑 Pi 的 `15-n4-shutdown.spec.ts`（真实 HTTP + 第二实例），并加上 N4-a/N4-b 两条回归。草稿测试通过不等于 N4 关闭。

## 4. N4 草稿状态与 hash

草稿只是未提交的工作树改动，**没有作为提交交付，也没有通过审查**；CodeBuddy 在 m2d3 的成品需另行审查。

| 文件（.worktrees/m2fix，HEAD `d79c467`） | 开始 sha256 | 结束 sha256 |
| --- | --- | --- |
| apps/server/src/events-lock.test.ts | `857810381c1d…1f93` | 见下 |
| apps/server/src/events.ts | `a778bbeb4c49…3b82` | 见下 |
| apps/server/src/work/repo.ts | `332bdaa826da…ff99` | 见下 |
| apps/server/src/work/service.ts | `eee7fd1303ce…0025` | 见下 |
| `git diff` 整体 | `f04f997f2d1a…6fab`（= n4-draft.patch） | 见下 |

开始时四个文件和 diff 与 `n4-draft-snapshot.json` 完全一致。结束时的核对结果追加在本报告末尾的“结束核对”。

## 5. D3 / R6

**原失败证据作废，缺陷既未确认也未关闭。**

1. **Pi 的计数器会匹配它自己的查询进程。** 见 `tests/e2e/m2a/zz-kill.spec.ts:11`–`:16`：`execSync("powershell … Where-Object { $_.CommandLine -match 'vite.js' -and $_.CommandLine -match 'preview-cache' } …")`。`execSync` 启动的 `cmd.exe` 和它拉起的 `powershell.exe`，命令行里本身就含这两个字符串，所以计数永远 ≥2。`isolation-r6.json` 中 `viteBefore=2, viteAfter=2` 正好是这个常数。本轮用同样的命令只读探测，匹配到的是 `cmd.exe` 和 `powershell.exe`（以及本机含该字符串的祖先 shell），没有任何 Vite 进程。
2. **它也匹配不到真实的 worker。** 见 d79c467 `work/preview.ts:42`、`:47`：worker 的命令行是 `node preview-worker.ts <…/vite/bin/vite.js>`，`preview-cache` 只出现在环境变量 `PREVIEW_CACHE_DIR` 和 cwd 中，不在命令行里。诊断中真实 worker 的 `piMatch=false` 与此一致。
3. **原用例用的是 `taskkill /T`**（`zz-kill.spec.ts:36`），会把 worker 当作后代直接杀掉，测不到 `preview-worker.ts:5` 的“IPC 断开后自退”。
4. **新诊断（`4bfc4c1`，只加了 `apps/server/d3-diagnostic.mjs`；`git diff d79c467 4bfc4c1 -- apps/` 只有这一个文件，生产生命周期没有变化）的判据是合理的**：`owned` 取 launcher 的后代，以 PID + CreationDate + 命令行摘要判定为同一进程（`:59`–`:66`）；先验证 worker 自己的端口返回 HTTP 200（`:146`–`:151`），再按身份强杀（`:69`–`:72`）；以同一身份判定 survivors（`:165`）；全局的 `previewWorker` 标记只用作旁证。evidence 中：
   - `backend-pid`（只杀后端，不带 /T）：worker 66948 在两次快照中均已消失，`survivors=[]`。**只有这个场景真正验证了 IPC 自退。**
   - `launcher-tree`（/T）：`survivors=[]`，但这一项只说明树杀有效，不说明 worker 会自退。
   - 时间标注不精确：`kill.at` 记录在杀进程前的快照之前，“after1s”实际在 kill.at 之后 +5.5s 和 +4.9s，“after30s”在 +36.3s 和 +35.6s。这不影响 30 秒的结论，但不能称为“1 秒内退出”。
   - 诊断期间本机另有一个后端（PID 69500，占用 3001/5175）的 worker 在启停，这再次说明全局计数会被并行实例污染，应按身份判定。
5. **判断**：D3 不能据 IPC 接线或一次正面诊断关闭，也**不应为了让旧的全局计数归零去改生产代码**。应修的是测试：Pi 把 `zz-kill.spec.ts` 改成按身份判定（后端后代 + PID/CreationDate，排除查询进程本身），并区分“仅杀后端 PID”和“树杀”两个场景。至少覆盖 3 个待定候选，以及预览启动中途被杀；在冻结 HEAD 上重复多次都没有残留，才能关闭 R6。

## 6. STALE_SELECTION

- 代码：d79c467 `work/service.ts:155` 先快照，`:156` 校验 baseVersion，`:158` 调 `repo.fileChangedSince(selection.baseVersion, file)`，即 `repo.ts:197`–`:198` 的 `git diff --quiet <客户端 baseVersion> HEAD -- <选中文件>`。baseVersion 来自浏览器，只在点选时由 `App.tsx:81`–`:83` 通过 `/version` 取一次，之后快照不会改写它。所以“先快照”不会让选中文件的变化漏检。
- 回合 3 的 `buy-button` 选中的是 `src/components/Button.tsx:5:5`，改的却是 `src/App.tsx`。按现行“只比较选中文件”的规则，这次提交本来就应放行。Pi 接管后的 `takeover-stale-same-file.json`（同一文件改动返回 409）和 `takeover-stale-different-file.json`（改其他文件返回 202）证实了这个语义。**这是测试对象不一致，不是缺陷，不改语义。**
- 建议（产品层面，可不改）：`selection.ancestors`（如 `App.tsx:行:列`）会进入允许改动的范围（`service.ts:194`），但不参与陈旧检查。祖先文件改动后，传给 Agent 的祖先行号可能已经偏移。是否要把祖先也纳入检查或给出提示，由设计决定，不在本轮作为缺陷。

## 7. 问题汇总

| 级别 | 编号 | 位置 | 摘要 |
| --- | --- | --- | --- |
| 阻断 | — | — | 无 |
| 应修 | N4（原） | d79c467 `app.ts:196`；`work/service.ts:299`–`:307`；`events.ts:55` | preClose 未排空作品队列就关日志、放锁；Pi 已用真实 HTTP 证实 |
| 应修 | N4-a | 草稿 `work/service.ts:140`–`:147`、`:299`–`:307` | submit 在 taskQueue 被等待后才挂上任务，close 返回后仍写 tasks.json / 发事件（探针确认） |
| 应修 | N4-b | d79c467 `app.ts:52`–`:58`；草稿 `service.ts:306`–`:307` | 关闭失败时仍无条件放锁 |
| 应修（测试） | D3-t | master `tests/e2e/m2a/zz-kill.spec.ts:11`–`:16`、`:36` | R6 计数器自匹配、用了树杀；须按身份判定重写后重测 |
| 建议 | N4-c | d79c467 `work/service.ts:236`–`:244` | cancel 等变更 handler 不在关闭屏障内 |
| 建议 | N4-d | 草稿 `repo.ts:38` vs `service.ts:141`；`events-lock.test.ts:55`–`:64` | 关闭错误码不统一；草稿测试没有经过 HTTP |
| 建议 | D3-d | m2d3 `apps/server/d3-diagnostic.mjs:159`–`:164` | kill.at 与快照时间标注不精确；缺多候选 / 启动中途被杀场景 |
| 建议 | S-ancestor | d79c467 `work/service.ts:158`、`:194` | 祖先文件不参与陈旧检查（产品决策） |

## 8. 验证边界

- 只写了本报告：没有改实现、测试、历史审查报告、项目记忆，也没有提交；没有改动、恢复或提交 m2fix 草稿，也没有改 m2d3。
- 运行过的内容：三个只读微型探针，全部使用系统临时目录、临时 Git 仓库和替身，用完即删。①从 `git archive d79c467` 解出的 `WorkRepo` 跑 N1/N2；②从 m2fix 工作树导入草稿的 `WorkService`/`WorkRepo`，跑 submit 与 close 的竞态（存储写到临时目录，emit 用记录替身）；③重放 Pi 的 PowerShell 计数命令，观察它匹配到哪些进程。没有调用项目接口、模型或 Lux3D，没有读 `.env`。
- 没有运行构建、整套单测或 E2E，也没有启动项目服务；N3/R1 是静态核对。M2 的最终结论需要在所有实现合并后的同一冻结 HEAD 上由 Pi 统一回归，然后再复核。

## 结束核对

2026-11-13 23:50:53 +0800 重新核对：m2fix HEAD 仍为 `d79c467`；四个文件的 sha256 与开始时一致（`857810…1f93`、`a778bb…3b82`、`332bda…ff99`、`eee7fd…0025`），`git diff` 仍为 `f04f997f…6fab`，与 `n4-draft.patch` 相同。本轮期间草稿没有变化，本报告对草稿的诊断截止于该 hash。临时探针目录已全部删除。
