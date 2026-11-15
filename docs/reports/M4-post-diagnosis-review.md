# M4 诊断后测试修正 · 独立只读复审

- 审查者：Claude Code（新会话；此前同一复审 3 次 ECONNRESET 未产出报告，本次连接正常完成）
- 日期：2026-11-16
- 实现树：`.worktrees/m4` / `feat/m4-demo`
- 受审固定提交：`f9e21f56697e24d126fd8e98ecc4aa57597acbb0`；正式已审基线 `1aa5450`（`docs/reports/M4-rework-2-review.md`）
- 方式：只读 `git diff 1aa5450 f9e21f5`、相关报告和少量运行证据 JSON。**未运行** type/build/test/browser/服务/探针，未改两树源码，未读 `.env`/ASKS/代理/凭据，未提交、未合并、未派实现者。

## 0. 结论

| 级别 | 数量 |
|---|---|
| Blocker | **0** |
| Should-fix | **1**（只改文档和证据标签，不改生产代码，不阻断 Pi 完整轮） |
| Suggestion | 6 |

- 相对 `1aa5450` 的 16 个代码文件全部是测试、专用夹具或 test-support，**生产源码零改动**。
- 没有发现安全断言被删除或放宽；有几处断言比原来更严格。
- 生产代码不引用任何 test-support、`registerHooks` 或夹具钩子，没有测试后门进入生产。
- 清理统一按"PID＋创建时间"和"目录 dev/ino/realpath 身份"归属，失败时保留现场。

这份结论是独立审查意见，不能替代运行结果。Pi 运行事实如下：
- 已有：614 单测全过（上一完整轮），脚本安全套件 12/12（`job_deb351c9`）。
- 尚未执行：**193 例 E2E**（M4 19 例＋旧 174 例），需以 Pi 正在进行的完整轮为准。

### 身份核对
- 开始时 `HEAD = f9e21f5`，tracked 干净，仅 `fallback/` 未跟踪。
- **审查期间 HEAD 前移到 `189c3b1`**（2026-11-16 00:54 +0800，`docs(m4): archive successful IPC shutdown script confirmation`）。
- 这个提交只改了 `docs/reports/M4-orphan-ipc-close-fix.md` 并新增归档证据。`apps packages templates scripts package.json pnpm-lock.yaml` 相对 `f9e21f5` **零差异**，所以本报告对受测源码的结论仍然成立。
- 我没有动这个提交。

## 1. 审查范围划分

- **A. 原返工三复审未完成的部分**：返工三、四（资产屏障、持久化失败接管、审批计时）。
- **B. 后续差异**：返工五、六、七（URL 接线、Studio 浏览器夹具、指针捕获前提），以及 orphan 两轮诊断后的修正（`eb00eec`、`f9e21f5`）。

## 2. A 部分：apps/server

### 2.1 资产模型屏障（`fallback-process-lifecycle.test.ts` / `asset-parent.ts` / `asset-loader-register.mjs` / `asset-model-loader.mjs`）

**加载钩子**
- 改用同步 `registerHooks({resolve})`，先让 Node 正常解析，再按 URL 精确匹配 `assets/process-model.ts`，替换为一个 `data:` 模块。裸包名、内置模块和其他文件都不受影响。
- 替身模块在执行时先检查 IPC，再上报带 pid 的 `fixtureModelBlocked`。只有模块真正被求值，才会触发"屏障就绪"，原来那种"没走到屏障就超时"的歧义消除了。
- `--import` 改为 `.href`（返工五），只有测试的 fork 带这个参数。生产 `process-isolated.ts` 未改，仍是空 execArgv。

**断言对比旧版（无删减）**
- 保留：`raw.glb` 字节等于输入、`model.glb` 不存在、重启后 `LOCAL_IMPORT_INTERRUPTED`、无 `.model-stage-*` 残留、原 worker（PID＋创建时间）已退出。
- 新增：`worker-spawned` 早于屏障上报，用于确认归属；worker 命令行必须包含 `process-worker`；屏障就绪的 pid 必须属于已归属的 worker；父进程 PID 被复用时直接报错。

**清理**
- 主错误、清理错误、写证据错误分别聚合。
- 补杀前先核对 PID＋创建时间，并记录 `cleanupKills`。
- 只有成功时才删目录，且删除前要求目录 dev/ino/realpath 与创建时一致。

**未覆盖**
- 测试走的是注入的 `process:` 处理器加真实 `process-worker.ts`，绕开了生产 `process-isolated.ts` 的启动代码。
- 屏障是替身模块，生产的 optimize/publish 链没有跑到。
- "worker 自主退出"的含义需要更正，见 §4 S1。

### 2.2 持久化失败与真实死 PID 接管（`recovery.test.ts` / `asset-persistence-parent.ts` / `asset-persistence-register.mjs`）

**为什么要改**
- 旧测试在同一进程里 `first.close()` 后直接重启。但现行合同规定持久化失败时 close 必须拒绝并保留锁，旧测试的前提与合同冲突。
- 新测试改用真实子进程：持锁失败 → 被 SIGKILL → 生产 init 按死 PID 接管。

**wrapper 实现**
- 在子进程里，把 `atomic-file.ts` 解析到一个 `data:` 包装模块。包装模块通过 `?fixture-original=1` 导入原模块，只对"写入含 taskId 的 index.json"注入 `disk full`。
- `atomic-file.ts` 只有 `writeAtomic` 一个导出，生产所有引用方也只导入这一个名字，所以包装不会造成链接缺口。
- 包装只在测试进程通过 `--import` 安装，生产不可达。

**断言（比原版多，原有的全部保留）**
- 子进程内：submit、idle、close 三者都以 `disk full` 拒绝；同目录再起一个服务被 `INSTANCE_LOCKED` 拒绝；锁文件 pid 等于本进程；index 状态为 `submitting`。
- 父侧：再次验证活锁被拒，创建计数为 1。
- 杀掉子进程后：原身份确实消失，锁文件仍指向死 PID。
- 重启：`submit_unknown`，计数仍为 1；`importTask` 后 ready，计数仍为 1。
- 原有的"不重复付费、未知结果不重提、显式导入恢复"均保留。
- 注入点要求 loopback http＋显式端口，不连外网。

### 2.3 `fallbacks.test.ts` 202 来源断言
- 旧断言要求 202 响应就带 `kind:'fallback'`，但这条断言写于返工一，之后一直没被真正执行过（前几轮都卡在类型检查）。按生产合同，没有 outputHash 的来源只能是 `unknown`。
- 新测试改为：202 时为 `processing`、来源 `unknown`、没有 modelUrl；ready 后来源为 `fallback`，`sourceHash` 和 `outputHash` 都对得上，outputHash 等于实际 `model.glb` 字节的 SHA256，且 HTTP 下载的字节与之一致。
- 新增断言：三个 Lux3D 上游方法都没被调用。
- 危险字段返回 400、`/assets` 为空这两条仍保留。整体是**更正并加严**，不是放宽。

### 2.4 `approvals.test.ts`
- 只加了阶段计时和错误聚合，5 秒预算不变，事务和恢复断言一条未改。
- 历史上的 5 秒超时没有被定性。之后几轮该用例都通过了，但计时数据只能作为观测，不能倒推当时的原因。

## 3. B 部分：Studio 与 demo 脚本

### 3.1 Studio 浏览器夹具（`speech-browser-fixture.ts`、两个 browser test）

**开发依赖**
- `speechBrowserVite()` 明确设置 development 模式和 `jsxDev`，预构建列表补齐 `react-dom`、`react/jsx-dev-runtime`。
- 没有伪造 `jsxDEV` 导出，没有切到生产模式，也不改生产 Vite 配置。

**原 ready 判定保留**
- 组件套件仍以 record 按钮出现且可用为就绪；真实 App 仍以 `events-status=connected` 为就绪。
- `observeSpeechBootstrap` 只是额外捕获 pageerror、页面崩溃，以及 script/document 请求失败或 ≥400，然后让启动立即失败并带上阶段和 URL。

**afterEach 断言没有减**
- 用例正常运行时，仍要求 pageErrors 为空、denied 为空、卸载后 liveTracks 为 0。
- 新增 `bootstrap.assertHealthy()`。
- 只有启动已失败时，才不再重复报同一个 pageerror，此时 beforeEach 已经抛出原始错误。

**真实 App 交互断言全部保留**
- parentBlur 计数增长、pending 状态、WS 重连期间 review 保留、需显式确认当前对象、确认后再提交、提交后可输入新文字。

### 3.2 原生指针捕获前提（`speech-browser.test.ts`）
- 先用真实鼠标移动，要求出现一次 trusted 的 `gotpointercapture`（buttons=1），且 `hasPointerCapture` 为真。
- 释放后要求出现同一 pointerId 的 trusted `lostpointercapture`（仍按住，此前没有 pointerup）。
- 然后才断言：轨道数归零、`recorderStops=1`、显示捕获丢失文案、零上传、没有 review、没有任务。
- 正常 pointerup 对照新增一条 trusted pointerup 记录，仍要求只上传一次。
- 运行证据显示序列完整，前提成立。
- 边界：丢失是由脚本调用 `releasePointerCapture` 触发的，浏览器产生的事件是 trusted，但不等同于系统切窗、触摸取消等真实丢失；`pointercancel` 分支未覆盖（见 S4）。

### 3.3 demo 脚本三分支（`body.test.mjs`、`test-support/orphan-case.mjs`、`orphan-role.mjs`）

**整体结构**
- 拓扑：parent → orphan → 四个 worker，外加一个无关进程。
- 动作前，四个 worker 必须真实就绪，且就绪记录与 CIM 身份一致（pid、parent、创建时间不晚于就绪时间）。
- 每个角色必须恰好一个，按命令行和角色参数匹配。所有已发现后代，包括 conhost 这类辅助进程，都要退出。

**disconnect-hung 分支**（比旧用例更严格）
- 事件顺序：专用消息 → 角色自己调用 `process.disconnect()` → disconnect → 挂起的 close → exit 1。
- 父侧观察到原生 disconnect 和 close，stderr 中有 `DEMO_ORPHAN_TIMEOUT`。
- cleanup JSON 中 `parentPid=orphan`、`forced=true`、`errors=[]`、`remaining=[]`，并逐个按 PID＋创建时间绑定四个 worker。

**normal-close 分支**
- close 完成且 `forced=false`，没有超时 marker，没有 cleanup 文件，退出码为 0。

**IPC 关闭修正**
- 改由角色自己断开 IPC，绕开了 Node 24.14.1 父侧主动 `child.disconnect()` 后少计一次关闭、导致 `close` 不触发的问题。
- 我核对过：生产代码没有父侧 `child.disconnect()`。`runtime.mjs:57` 是子侧断开，`launch.mjs` 等待的是子进程 close。所以这个 Node 计数问题不影响生产等待逻辑。

**hard-kill 分支**
- 只断言原进程链全部退出、无关进程存活，不再要求 watchdog marker。这是诊断后的正确更正，但该分支证明的机制需要写清楚，见 S1。

**清理**
- finally 中的补杀会核对身份，`fallbackKills` 写明原因（成功时只停止无关测试进程）。
- 只有在目录身份不变时才删除，证据先复制到运行目录。

**测试后门检查**
- `ownedLifetime` 的 `hardTimeoutMs` 只是函数参数，生产调用方（`backend.mjs`、`frontends.mjs`）都不传，也不能从环境变量设置。没有后门。

## 4. 发现

### Should-fix

**S1 Windows 上硬杀父进程后，子进程链大概率由操作系统直接终止，而不是 IPC 断开处理或 watchdog 回收。文档和证据标签说多了。**

证据：
- 最新脚本确认 run 的 `.data/orphan-safety-confirm-2026-11-15T16-49-57.239Z/orphan/hard-kill/`：
  - `orphan-23408.events.jsonl` 只有 spawned-child 和 ready，**没有 disconnect、close-called，也没有 exit 事件**。角色用同步 `appendFileSync` 在 `process.on('exit')` 中记录，只要进程自行退出（包括 watchdog 的 exit 1）就一定会留下这条。
  - `orphan.stderr.log` 为空，没有 `orphan-cleanup-*.json`。
  - 但整个进程链在 fallback 之前就全部消失了（`familyGoneBeforeFallback=true`，fallbackKills 只停了无关进程）。
  - 对照 disconnect-hung 分支：disconnect、close-called、exit 1 和 cleanup JSON 都齐全。
- 这说明 orphan 是被外部直接终止的。
- 机制推断（未运行验证）：Node 官方文档写明 Windows 上非 `detached` 的子进程会在父进程退出时被结束。libuv 把非 detached 子进程放进 kill-on-close 的 job object，链上每个 Node 都会对自己的子进程这样做，所以硬杀会逐层传下去。生产 `launch.mjs`、`process-isolated.ts`、`preview.ts` 都是非 detached 的 `fork`/`spawn`。`checks/worker.ts` 只在非 Windows 上 detached，因此也适用。

影响（不是生产缺陷，结果反而比文档描述更强）：
- `docs/demo/runbook.md:70` 写"父 IPC 意外断开时……50 秒后有界强制回收"，`:72` 写"依赖各 worker 自身的 disconnect 处理"。但在 Windows 硬杀启动器这个最常见的场景里，这两条路径实际上都没执行，cleanup JSON 也不会出现。
- watchdog 只在"父进程还活着但 IPC 断开"的合成场景下被证明过。
- 资产夹具的 `autonomousWorkerExit` 和"worker IPC-disconnect exit"标签同样分不清是操作系统终止还是 worker 自己处理 disconnect：`asset-parent` 用非 detached 的 fork 启动 worker。
- Pi 的 `tests/e2e/m4/04-demo.spec.ts`（验收树）硬杀用例写着"由子进程 IPC 断开处理回收"。我看到它只断言 PID 全部退出和端口释放，没有强制要求 orphan-cleanup 文件，所以不会因此误红，但说明文字同样说多了。

建议：
- 修正 runbook 和报告措辞：Windows 硬杀启动器时，后代通常由操作系统随父进程一起结束，不写 cleanup JSON，manifest 不会更新；watchdog 只覆盖父进程存活但 IPC 断开的情况，以及非 Windows 平台。
- hard-kill 分支和资产夹具把"进程有没有自己的 exit 事件"作为机制记录下来。不必强制要求某种机制，但不能再标成"自主/IPC 断开退出"。
- runbook `:72` 写的"中间层先死，孙进程会漏掉"这条限制，在全 Node、非 detached 的链上大概率被这一机制缓解。但这是推断，不能写成已经证明。
- 不需要改生产代码，也不阻断 Pi 完整轮。

### Suggestions

- **S2 无关进程这个对照偏弱。** `unrelated` 是测试另起的兄弟进程，watchdog 按父子链遍历时本来就碰不到它。更有力的对照是让它与 worker 用同一命令行、同一角色名，或者是 orphan 之外另一条链上的同名进程，这样才能证明"不按名称广杀"。
- **S3 Studio 启动观察器在交互期间仍然生效。** script/document 请求失败（包括 `ERR_ABORTED`）会让用例失败。真实 App 里如果预览 iframe 因版本刷新而中途重新导航，可能出现假红。最近几轮没有发生，可以考虑在 `ready()` 之后只记录 document 级别的中止，不直接判失败。
- **S4 指针捕获只覆盖了"脚本释放"这一种触发方式。** 建议在设计或报告里写明，`pointercancel`、元素移除、系统切窗等真实丢失路径没有覆盖。
- **S5 Pi 的 04-demo 硬杀用例用的是只看 PID 的 `alive(pid)`**（启动器记录的创建时间是 epoch 0）。PID 被复用只会导致假红，不会假绿，但和"按 PID＋创建时间"的口径不一致。这在 Pi 的范围内，仅作提示。
- **S6 进程快照只用 CIM 的 `ParentProcessId` 递归。** 对 S1 机制下的孙进程来说足够，但如果中间层先退出，遍历会断开（runbook 已经写明）。现在 hard-kill 是在动作前就拍好家族快照，没有这个问题，保持即可。
- **S7（延续返工二的建议，未处理也不阻断）** 目录身份用 realpath 比较时，临时目录如果是 Windows 短文件名可能误报；按命令行匹配角色依赖路径格式。

## 5. 安全断言、后门与清理归属核对

| 项 | 结论 |
|---|---|
| 生产源码改动（相对 1aa5450） | 0 个文件；16 个代码文件全部是 test / test-support |
| 生产引用 test-support、registerHooks、夹具标记 | 无 |
| 生产 worker 的 execArgv | 未改，测试钩子注入不了生产 |
| 安全断言 | 无删减、无放宽；202 来源断言按生产合同更正后加严；5 秒等预算不变 |
| 失败遮蔽 | 主错误、清理错误、证据错误三路聚合，失败保留现场 |
| 清理归属 | PID＋创建时间；目录 dev/ino/realpath；补杀前核对身份并记录原因；没有按名称或端口广杀 |
| 外部调用 | 全部是 loopback 替身或 `127.0.0.1:9`；Lux3D 上游被 spy 断言为零调用 |

## 6. 未覆盖边界（不能用替身冒充）

- **193 例 E2E 尚未执行**（M4 19 例＋旧 174 例，含 M1-B 23 例原像素阈值），以 Pi 完整轮为准。
- Windows 真实控制台 Ctrl+C：只用信号模拟过。
- 真实启动器硬杀后，是哪种机制回收了生产进程链（见 S1）。
- 生产 `process-isolated` 的完整 optimize/publish 链。
- 真实模板 iframe 点选和候选 HMR 端口，需要等 Pi 的 E2E 结果。
- 真实阿里语音、厂商识别、编码、Lux3D，以及真人 A/B 和 3 次完整彩排，均未执行。

本复审结束时，实现树源码与 `f9e21f5` 一致（HEAD 已因 docs-only 归档提交 `189c3b1` 前移）。我没有提交、合并或派实现者。
