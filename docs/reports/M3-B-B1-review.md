# M3-B 任务 B1 独立只读审查（Claude Code）

- 审查对象：固定提交，**base `cbadee3865449340997f1b61c5500ddbc48a522a` → head `6e44961b6e145da9aa367e8b4ca8eaffa39c1a13`**（"B1: 内容快照、CheckRun 状态与安全协议"）。
- 范围：仅 head 中的五个文件：`apps/server/src/checks/{artifacts.ts,runner.ts,snapshot.ts,snapshot.test.ts}`、`packages/shared/src/index.ts`。源码全部用 `git show <head>:<path>` / `git diff <base> <head>` 读取。对照文档：base 内的 `docs/design/M3-B-plan.md`、`docs/design/M3-plan.md`；为核对集成假设，另读了 base 内的 `work/repo.ts`、`scene/service.ts`、`assets/atomic-file.ts`。
- **没有**读取 `.worktrees/m3b` 里未提交的 B2 草稿，也没有读 `.env`、ASKS、凭据或其他代理的会话记录。
- **没有**运行任何测试、typecheck、构建、服务、模型或网络探针。提交说明里的"27 项单测"我没有核验，本报告也没有任何测试结果。
- B2–B4（可信 worker、真实 build/浏览器、采用门禁、路由、N4 关闭）还没完成，**不能据此判定 M3-B 验收通过**。下文不把"尚未实现"算作回归；只指出已提交的接口和设计本身有什么错误、安全缺口，或与计划不相容的地方。
- 标注说明：**【已证明】**表示按源码逐行推演就能确定会触发；**【静态风险】**表示取决于运行环境或后续接线方式，还没有实测。

## 结论

**B1 不宜原样作为 B2–B4 的基础，需要先整改。** 有几处做得对：快照会遍历全部 src/public 文件（包括没改动的依赖源码，删除文件也会让摘要变化），artifacts 用固定文件名集合，重启时把未完成的 run 标成 SERVICE_RESTARTED、不自动重跑，没有 executor 时不会给出 passed。

但核心的"内容身份"没有真正绑定：run 的身份仍是调用方传入的 pendingDiff 改动摘要，实际算出的快照摘要既不入库也不比对。并发去重在 await 窗口里会失效。保存失败会让 run 永久卡在 active，或引发未处理的 rejection。超时/取消依赖 executor 自觉配合，而且会接受中止之后才返回的 passed。B4 门禁如果建立在这些接口上，会直接继承这些旁路。

---

## 高（B2 之前必须修）

### H1 内容身份没有绑定实际快照；pendingDiff 摘要冒充检查身份【已证明】
- 位置：`runner.ts:51`（`contentDigest: string; // digest from pendingDiff`）、`:116-137`（身份 = `candidateCommit:contentDigest`）、`:161`、`:242`、`:250`、`:260`。
- 触发：
  1. `computeSnapshot()`（:242）算出的 `snapshot.digest` 从来没有和 `options.contentDigest` 比较过，也没写进 `CheckRun`（共享类型里根本没有这个字段）。计划要求快照"不得只复用 pendingDiff 的改动摘要"（M3-B-plan.md:33），但去重和记录用的恰恰就是它。base 中 `repo.pendingDiff` 只对已改文件加 base 求 hash（repo.ts:250-272）。
  2. 第 242 行和第 250 行分别读了两次候选树（`copyAudited` 内部又调一次 `computeSnapshot`）。第 250 行的返回值被丢弃，所以两次之间的修改不会被发现：`ctx.snapshot`（第一次的结果）描述的内容，和 `buildRoot` 里真正被构建的内容可能不一致。
  3. 快照读的是 worktree 的工作区字节，而 run 记录的是 `candidateCommit`。如果 worktree 里有未提交或被篡改的文件，检查的内容和被记录的 commit 就不一致（计划 B1 第一项要求覆盖"未提交文件、草稿期间篡改"）。
- 后果：B4 拿 `run.contentDigest` 和 pendingDiff 比对时会认为"一致"，但实际受检字节可能是另一份。旧绿灯也可能被复用到内容相同、但依赖文件已被换掉的场景（因为 pendingDiff 不覆盖未改动的依赖文件）。
- 最小整改：`CheckRun` 增加 `snapshotDigest`（或直接让 `contentDigest` 表示完整树摘要），在 run 启动的锁内计算一次；`copyAudited` 接受期望摘要，复制后比对，然后把这一份交给 `ctx`；去重身份改用快照摘要；同时校验 worktree 与 `candidateCommit` 的树一致（或者直接从 commit 导出），不一致就失败。
- 缺少的反向用例：两次快照之间修改文件 → 必须失败；worktree 有未提交改动 → 必须失败；未改动的依赖被替换 → 不得返回旧的 completed run。

### H2 同身份并发 start 在 await 窗口内会重复执行；没有全局唯一 runner【已证明】
- 位置：`runner.ts:144-177`。`findActive` 只查 `this.active`，而 `active.set`（:174）在 `await this.save()`（:170）之后才执行；`findCompleted`（:130-137）又只匹配 completed/cancelled。
- 触发：`Promise.all([start('c'), start('c')])`。第二个调用落在第一个的 save 窗口里，此时既查不到 active，也查不到 completed，于是新建第二个 run 并执行。
- 另外：不同候选，或 `rerun` 产生的不同身份之间，没有任何全局互斥，可以同时运行多个 executor。计划要求"单后端同一时刻只跑一个检查子进程"（M3-B-plan.md:17）。
- 现有测试 `snapshot.test.ts:215-224` 是串行两次 `await`，覆盖不到这个窗口。
- 最小整改：在第一个 await 之前同步登记"进行中"（用 pending Map 或按身份的 Promise），或者把 start 放进串行队列；用一个全局信号量保证只有一个 run 处于 running，其余排队。
- 缺少的反向用例：用 `Promise.all` 并发 start 同身份 → 只产生一个 run，executor 只被调用一次；两个候选同时 start → 任一时刻最多一个 phase 在执行。

### H3 保存失败没有回滚：幽灵 queued、永久 active、未处理 rejection【已证明，进程崩溃属静态风险】
- 位置：`runner.ts:169-170`、`:211-222`、`:308-313`、`:319-333`。
- 触发与后果：
  1. 第 170 行 save 抛错时，run 已经 push 进 `this.runs`（:169），但没有执行，也没进 active。调用方收到错误，可这个 queued 记录会随下一次任何 save 落盘，重启后变成 SERVICE_RESTARTED，留下一条从未启动的"中断"记录。
  2. 第 308 行最终 save 抛错时会进入 catch，再调用 `failRun`，它会改写已经 completed 的状态（变成 RUN_ERROR，或在 aborted 时变成 cancelled）。如果 `failRun` 自己的 save（:329）也失败，`execute` 的 promise 就会 reject，而且 `active.delete`（:332）被跳过。
  3. 从此以后，这个 run 永远留在 `active` 里：`findActive` 会持续返回它，同身份的 `rerun:true` 也被第 145 行先行拦截，无法再新建。没有 executor 的分支（:219-220）也一样。
  4. `execute` 返回的 promise（:173）没有挂任何 handler，reject 时成为 unhandledRejection。Node 24 默认会让进程退出（除非服务端全局吞掉）。
- 另外：内存里先置 completed 再落盘，失败时内存与磁盘不一致。B4 如果从内存读状态发事件，就会"未持久先广播"。
- 最小整改：先构造好内存外的副本，save 成功后再提交到内存（失败则回滚 push 或状态）；`active.delete` 和计时器清理放进 `finally`；给 promise 挂上 catch 并转成持久化的失败终态（如果连失败也存不下，就标为不可用，而不是继续卡着）。
- 缺少的反向用例：注入 `writeAtomic` 失败（start 时、阶段之间、终态时三个点） → 不得出现幽灵 run、不得永久 active、不得有 unhandledRejection、不得出现 passed 终态。

### H4 超时/取消只靠 executor 自觉；会接受中止后返回的 passed；超时被记成取消【已证明】
- 位置：`runner.ts:231`、`:271-298`、`:244/253/313`（`failRun(..., controller.signal.aborted)`）、`:180-185`、`:344-348`。
- 触发与后果：
  1. 中止只在两个阶段之间检查（:273）。如果某个阶段在 abort 之后才返回 `{status:'passed'}`，第 292 行照样记为 passed，并且落盘（:293）。
  2. 整次 run 的计时器（:231）和用户取消共用同一个 controller，所以**超时最终被记为 `status:'cancelled'`/`CANCELLED`**。计划要求的是"timeout/error 使当前 failed，未启动后续 not_run"（M3-B-plan.md:63）。
  3. `buildTimeoutMs`/`browserTimeoutMs` 只是传给 executor 的数字，runner 自己不强制执行。如果 executor 忽略 signal，阶段就会无限期挂起：`cancelChecks`（:184）会一直 await，`drain`（:347）会阻塞关闭，违反 N4 关闭屏障。
  4. 第 278 行的取消分支既不设置 `finishedAt`，也不设置 `error`，终态信息不完整。
  5. `computeSnapshot`/`copyAudited` 不接受 signal，所以准备阶段不受整体截止时间约束（计划要求"schema/准备也受整体截止约束"）。
- 最小整改：每个阶段用 `Promise.race` 包裹，加上 runner 自己的阶段计时器和 abort 监听；中止后返回的结果一律丢弃，按超时/取消改写为 failed 或 not_run；区分 `TIMEOUT` 和 `CANCELLED`；设置 `finishedAt`；快照和复制都接受 signal。
- 缺少的反向用例：executor 忽略 signal 并永不 resolve → cancel/drain 在预算内返回；在 abort 之后才返回 passed 的阶段 → 不得记为 passed；整体超时 → 当前项 failed、run 不是 cancelled。

---

## 中

### M1 runner 实例绑定单一候选，candidateId 没有绑定；去重身份缺 base/main/policy；没有 STALE 检查【已证明】
- 位置：`runner.ts:46-57`、`:144-167`、`:116-137`。
- 候选路径、commit 和摘要在构造时就固定了，而 `startChecks(candidateId)` 接受任意 id。`start('cand2')` 实际检查的是构造时那个候选的路径，记录却挂在 cand2 名下。这和"一个 WorkService、最多三个候选"的形态不兼容，每次接线都容易错配。
- `identityOf` 只包含 commit 和 digest。main 前进或 policyVersion 升级之后，`findCompleted` 仍会返回旧的 completed run。同时没有校验 `mainVersion === baseVersion`（计划要求返回 409 `STALE_CANDIDATE`）。
- 整改：身份按次传入，或者从 candidate 记录现取；把 base、main、policy 和快照摘要都纳入去重键；启动时检查是否 stale。
- 用例：main 前进后再 start → 拒绝或新建 run，不能返回旧的绿灯；用 A 的 runner 去 start B → 拒绝。

### M2 可信工具身份没有纳入摘要；候选根目录本身是链接时被静默接受【已证明】
- `snapshot.ts:89-100`：摘要只覆盖 src/public 的条目。计划要求身份包含"可信入口/工具版本"（M3-B-plan.md:33、:48），比如 vite/react 插件版本、固定 index.html/main 入口、policy 等，这些都没有，也没有预留输入接口。
- `snapshot.ts:90`：先 `realpath(candidateRoot)`，再从真实路径开始遍历。如果根目录本身是 junction 或符号链接，会被静默跟随（计划要求"禁止链接（含根目录）"）。子路径的链接靠 lstat 加 realpath 比较来拒绝（:63-66），这部分设计正确。
- 整改：`computeSnapshot(root, { toolIdentity })` 把工具身份混入摘要；对根目录先 lstat，再比较 realpath 与词法路径，不一致就拒绝。
- 用例：根目录为 junction → UNSAFE_PATH；src 本身为 junction → UNSAFE_PATH（现有测试只用了文件符号链接，见 `snapshot.test.ts:76-83`，没有 junction 用例）；工具版本变化 → 摘要变化。

### M3 先完整读取再检查体积；10 MiB 单文件上限装不下约 11 MB 的拆分 GLB【前半已证明，后半静态风险】
- `snapshot.ts:78-79`：先 `readFile` 整个文件，读完才比较体积；总量检查（:95-97）则要等所有文件都读完之后才做。一个超大文件会先被完整读入内存，存在内存/DoS 风险。应该先用 `info.size` 预检（lstat 结果已经拿到了）。
- 上限 `MAX_BYTES = 10 MiB = 10,485,760`。`fallback/lux3d-split-4969889.glb` 为 11.2 MB，另一份为 13.5 MB（docs/research/lux3d-api.md:45）。模板默认资产经过处理后只有 988 KB，可以通过；但 `scene/service.ts` 允许 `webReady=false` 的模型被 `force` 采用并写入 `public/assets`。这类作品的检查会直接因为 `SNAPSHOT_LIMIT` 而 failed，而且只是笼统的"快照失败"，和真实的构建失败难以区分。
- 整改：按 size 预检；把单文件上限和资产链路的上限对齐（或者对 GLB 单独设置上限，并给出明确的超限原因）；考虑流式计算 hash。
- 用例：11.2 MB 的 GLB → 要么通过，要么给出明确、可解释的超限；超大文件 → 不整读进内存。

### M4 盲目信任 executor 的结果；没有 outcome；latestCompleted 会返回失败的 run【已证明】
- `runner.ts:285-292`：结果的 `name` 不校验（schema 槽位可以写进 `name:'occlusion'`），`status:'passed'` 也不要求带任何证据。计划要求"全部检查必须有证据才可成为 adopt 绿灯"。
- 共享类型里定义了 `CheckOutcome`，包括 blocked/cancelled（index.ts diff 中），却没有任何地方使用；`CheckResult.evidence` 只是一个字符串，没有计划要求的 MIME、bytes、hash 引用；blocked_by 只体现在 message 文案里。
- `latestCompleted`（:204-209）会返回 failed、NO_EXECUTOR 和 SERVICE_RESTARTED 的 run。B4 如果把"最新 completed"误当成"最新成功"，判断就会出错。计划已经提醒不能"混淆完成与通过"。
- 默认缺少 executor 时得到 NO_EXECUTOR，不是 passed，这一点正确。但 `executor` 是一个公开的可选构造参数，测试辅助函数默认全部 passed；B4 必须保证生产路径不能经由配置或 HTTP 注入。
- 整改：runner 强制写入 `name`；passed 必须附带 artifact 引用（含 hash），否则降为 failed；`CheckRun` 增加 `outcome`（passed/failed/cancelled/interrupted）；提供 `latestPassed(identity)`；Check 增加 `blockedBy`。

### M5 持久化格式只验证数组；check-runs.json 与计划要求的 tasks.json 分离【已证明 / 设计风险】
- `runner.ts:83-85`：只检查 `Array.isArray(saved.runs)`，元素的 status、checks、id 都不校验。测试 `snapshot.test.ts:263-295` 甚至写入并**断言保留** `checks[1].status === 'running'`，而这个值不在 `Check['status']` 的取值范围内。被篡改或损坏的记录（例如带着 passed 的 run）会被原样加载。
- 计划写的是"同一 tasks.json 中持久 runs（旧数据缺失=[]）"（M3-B-plan.md:38）。现在独立成 `check-runs.json`，`candidate.latestCheckRunId/checks` 与 run 分布在两个文件里，各自做原子写，没有跨文件一致性，重启恢复也分成两套。B4 的"先持久再广播"和 discard/trim 竞态会更难做对。
- 整改：对每条 run 做严格的 schema 校验，失败时拒绝启动（不能静默丢弃）；重启时把 running 状态的单项改写成 failed 或 not_run，并附上原因；要么合并进 tasks.json，要么在决策文档里记录偏离原因和一致性方案。

### M6 artifacts：runId 未校验可删除整个数据目录；hash 不入库、真实性为零；读取存在 TOCTOU【已证明（函数级），目前没有调用方】
- `artifacts.ts:125-129` `removeArtifacts`：不校验 runId，`removeArtifacts(base, '..')` → `path.join(base,'check-artifacts','..') === base` → 递归强制删除整个数据目录；传 `''` 则删除全部证据。`writeArtifact`（:58-61）同样不校验 runId，目录链接也不检查，写入可能穿过 junction。
- `ArtifactRef.hash` 只在写入时算出、返回给调用方，没有持久化进 run。读取时（:101、:118）对磁盘现有字节重新计算 hash。文件被替换后仍会带着"新 hash"被正常返回，所以 hash 证明不了任何事（计划："已有文件被换链接也拒绝；每份引用带 MIME/bytes/hash"）。
- `readArtifact`：`stat`（会跟随链接）→ `realpath` 比较 → `readFile`，三步之间可以被替换（TOCTOU）；读取不设体积上限。如果 baseDir 路径里本来就有链接或 8.3 短名，合法证据也会全部 403。`listArtifacts`（:106-122）完全不做链接检查，会跟随链接读取任意文件并返回它的 hash 和大小。
- MIME 只按扩展名决定，不校验 PNG 文件签名；JSON 截断后变成非法 JSON；Buffer 形式的文本证据不走 100 KB 截断；截断后再加后缀，结果仍会超过上限；没有敏感字段脱敏（后两项可以留到 B2/B3，但接口要预留）。
- 整改：所有入口统一用 `^[a-z0-9]{6,32}$` 校验 runId；写入和读取都检查 `check-artifacts` 与 run 目录不是链接；把 ref（含 hash）持久化进 run，读取时比对，不一致就拒绝；用 `open` + `fstat` 在同一个句柄上校验并读取，并设置读取上限；JSON 证据超限时直接失败或改用结构化截断。
- 用例：`removeArtifacts(base,'..')` 和 `''` → 拒绝；证据被替换成不同字节或 junction → 403 或 hash 不符；list 遇到链接 → 跳过或拒绝。

---

## 低 / 加固

- L1 `snapshot.ts:53` 用 `localeCompare` 排序，顺序依赖 ICU 和区域设置，跨环境可能导致相同内容得到不同摘要。应改为按字节或码点比较。摘要条目之间没有分隔符或长度前缀（:98），目前因为路径前缀加 64 位 hex 定长恰好没有歧义，但建议加上域标签和分隔符，并纳入 policyVersion。
- L2 `forbiddenPattern`（:21）的 `secret|credential|backup|private.?key` 必须整段名字完全匹配，`credentials.json`、`my-secret.ts` 这类名字都放行。在 src 白名单之外不构成直接泄露，但和"过滤凭据"的说法不符。另外这条规则也作用于不会遍历的根目录文件（例如根目录有 `.env.example` 或 `*.bak` 就会拒绝整个快照），这是 fail-closed，但应在报错里说明原因。
- L3 `copyAudited`（:116-119）先 `readFile` 后检查 realpath，内容可能先被读出并写进 buildRoot，之后才被复制后摘要拦下（runner 会清理，风险低）。dest 没有要求为空目录，残留的非白名单文件（例如配置文件）不会被摘要发现。目前 buildRoot 用的是随机 runId，所以暂时没问题。
- L4 `CheckContext` 把可变的 `candidateRoot`（:258）和数据目录的绝对路径交给 executor，容易诱导 B2 去读未审计的 worktree。建议只暴露 `buildRoot` 和受控的写证据函数。
- L5 `snapshot.test.ts:81` 在 Windows 上创建文件符号链接需要开发者模式或特权，可能报 EPERM 导致用例出错（静态风险，未运行）。另外有几条用例是空转的：`cross-candidate`（:438）从未启动 cand2；"同身份并发"是串行调用；"取消 completed"在 active 已清除后才调用。

## 缺少的反向用例汇总（B1 计划第一项要求但未见）

junction 作为根目录或 src 子路径；未提交文件；复制途中被篡改（两次快照之间）；快照摘要和传入摘要不一致；`Promise.all` 并发 start；全局单 runner；三个时点的保存失败；executor 忽略 signal、超时与取消的区分；中止后返回 passed；main/policy 变化后不得复用旧结果；损坏或非法的单条记录；体积/条数超限与 11 MB GLB；`removeArtifacts`/`writeArtifact` 的 runId 穿越；证据被替换后 hash 不符。

## 判定

- B1 当前提交：**需整改后复审**。H1–H4 应在 B2 接入真实子进程之前修完，否则 B2–B4 会沿着错误的身份和并发骨架继续扩展。
- 本报告没有运行任何测试，没有可核验的测试结果；B2–B4 尚未完成，**不能判定 M3-B 验收通过**。
