# M4 独立 E2E（Pi 侧）返工记录：修三个确认缺陷 + 关闭分支诊断边界

日期：2026-11-16。仅改 `tests/e2e/m4/**`（独立套件）与文档；**生产代码、实现侧测试、依赖锁、模板、runner 均未改**。
本轮**没有运行**任何测试/collect/build/服务/full；下面所有"修好了"都只是静态性质，未验证。

## 0. 上一轮（job_e585899e）归档事实

run `docs/reports/artifacts/M4/regression/2026-11-15T16-52-32-677Z-full/`，受测 `280e282`（产品 `f9e21f5`）：

- typecheck / build **通过**；单测 **614/614 通过**；`demo-safety` **12/12 通过**（exit 0）；
- **M4 独立套件 19 例：4 过 / 8 败 / 7 未执行（serial skipped）**（原始 JSON：`stats.expected=4, unexpected=8, skipped=7`）：
  - **只有 4 条是 `expected`（真实通过）**；**7 条是 `skipped`（串行文件首个失败后未执行），不是 passed**；
  - 8 条失败：`01-speech` 4 例 + F1 + F2（共 6）、`02-fallback` 的 preset 哈希核对 1 例、`04-demo` 的 SIGINT 1 例；
  - 上一版报告把「preset 列表/导入/F4/F5、布局、HMR、5175、硬杀」等一并写成「通过」是**错的**——它们在原始 JSON 里是 `skipped`；
    **更正**：除原始 JSON 标记 `expected` 的那 4 条以外，本套件本轮没有任何「通过」结论；
  - **也不再把**「6 条失败都跑到 UUID 校验」当结论：日志只能证明这几例失败，具体停在哪一步以各例首条断言为准，未逐条复现。
- **旧九套 174 例全部未执行**（`failure.notExecuted` 已记）。
- 归档：launcher + 242 个载荷（含脚本持久证据 `.data/demo-script-evidence/<pid>-<time>/orphan/<branch>` **三分支** 与 `demo-runs` 真实 run 目录，共 154 个证据文件）；
  清单排除自身、静态复算 **0 mismatch**；原始证据未改写。

## 1. 三个已确认的测试缺陷（本批已修，未运行）

### 1.1 FakeRecorder 的 `addEventListener` 是空实现（`01-speech.spec.ts`）

- 生产 `speech-input.ts:129` 真实调用 `recorder.addEventListener('dataavailable'|'stop'|'error')` 并用 `removeEventListener` detach；
  旧替身把 `addEventListener/removeEventListener` 写成 no-op、只在 `stop()` 里调 `ondataavailable/onstop`，
  导致**生产的三条真实路径（数据、终态、错误）根本没被走到**：录音没有真正上传、资源释放与取消证据都是"假绿"。
- 修：替身实现真实监听表与派发；`stop()` 先派发最后一包 `dataavailable` 再派发 `stop`；暴露 `fireError()` 供错误路径使用；
  测试断言 `recorderStarts>=1`、`timeslice===250`（生产时间片）、`recorderStops>=1`、`stops>=1`（轨道释放）。

### 1.2 转写响应写死 `requestId`（`01-speech.spec.ts`）

- 生产 `speech-api.ts:24` 校验 `result.requestId === 本次 UUID`；旧替身返回 `'stub'`/`'x'` → 真实校验抛 `SPEECH_UPSTREAM`，
  于是"结果无效"被误当成产品问题（旧 4 例 + F1/F2 全挂在这里）。
- 修：替身回显**真实请求头** `X-Speech-Request-Id`；499 仍走安全文案分支；重试用例断言两次 id 不同且形如 UUID。

### 1.3 用 `.click()` 代替按住说话（`01-speech.spec.ts`）

- 按钮是 `onPointerDown` 开始、`onPointerUp` 结束；`.click()` 在同一 tick 按下并松开，等不到录音真正开始。
- 修：统一 `pressRecord()`：`hover → mouse.down → 等 __speechProbe.recorderStarts>=1（录音真正开始）→ 再 mouse.up`；
  取消分支（hidden / 权限未返回）也在"按下后"才触发，并断言"隐藏取消不上传"、"权限未返回不启动 recorder"。

### 1.4 preset 哈希手抄错（`02-fallback.spec.ts`）

- 旧版把 `…e5d05253a…` 抄成 `…e5d05352a…`，直接导致该用例失败。
- 修：**不再手写 literal**——从产品声明 `apps/server/src/assets/fallbacks.ts` 解析 `file/hash`，
  再用**真实 GLB 字节**算 SHA256 比对（"文件字节 vs 产品声明"，不拿产品 helper 当行为 oracle）。
  静态复核：三份文件全部 OK（`239b77d7…`、`7770579b…`、`09f90858…`）。

## 2. 硬杀分支：判定口径修正（`04-demo.spec.ts`）

- 退出判定从"只 `alive(pid)`"改为 `stillOwn(pid, created)` 三态：`gone` / `alive`（创建时间一致）/ `reused`（创建时间不同）。
  PID 复用一律记 `reused`，不当作自有残留、也不误判为回收成功。
- 用例 note 原文声称"由子进程 IPC 断开处理回收"——**已删**，改为：这里只断言"本次受测 PID（按创建时间核对）全部消失"，
  **不能证明** IPC 断开处理器或 watchdog 执行；Windows 上无 detached 子进程可能由系统直接终止（推断，未泛化证实）；
  watchdog 的因果证据只来自 fixture 角色主动断开 IPC + close 挂起那条分支（复审 S1 的结论）。

## 3. SIGINT 关闭分支：不改断言，交给有界诊断

- 现状：`04-demo` 用 `child.kill('SIGINT')` 并期望 manifest `stopped` + `forced` 全 false + 端口释放；本轮该例失败。
- **不能**只用 `signalCode`/`exitCode` 或"进程没了"来判定正常停止；也不为了变绿放宽断言。
- 已准备一次性有界诊断 `tests/e2e/m4/diagnose-demo-sigint.mjs`：真实 mock demo，A=SIGINT、B=SIGTERM，
  记录 spawn/ready/exit(code,signal)/close、PID+创建时间、manifest 前后（status/cleanup.problems/forced）、端口前后、后代三态。
  边界如实：这是 `ChildProcess.kill()` 的**信号模拟**，不是真实 Windows 控制台 Ctrl+C；
  启动器禁止的是 `NODE_OPTIONS`/`execArgv` **注入**；这**不等于**不能建测试 driver（见 §7 的普通文件入口方案）。上一版报告把“不能注入”写成“无法在子进程内观察 SIGINT”是**过度限定**，此处更正。
  诊断结果交 Codex 后再决定一次 M4 专项。

## 4. 未执行路径的静态审计（第 5 条）

| 路径 | 现状 |
| --- | --- |
| 候选 HMR 必须连 `plan.preview` | 已有用例且本轮**通过**（断言 websocket 端口 + 10s 导航 ≤1） |
| 5175 被占用不串实例 | 已有用例且本轮**通过** |
| 硬杀必须证明 watchdog marker | **未证明**：改为三态归属 + 明确"不等同 IPC 回收"；信号模拟由诊断覆盖，真实控制台仍缺 |
| fallback/demo 的未执行分支 | `02-fallback` 的 F4/F5 本轮通过；坏 sidecar 的三类与写失败持锁在实现侧单测覆盖（614 内），不在本套件重复 |
| 「按住说话」的用户→系统路径 | 修好后**未运行**，需 M4 专项实测 |

## 5. 明确未执行 / 边界

- 本轮**没有**跑：full、collect、614 单测、12 脚本测试、M4 19、旧九套 174。
- 真实 Windows 控制台 Ctrl+C、生产资产 worker 整链（真实 optimize/publish）、真实阿里语音/厂商识别/编码/Lux3D、
  真人 A/B、完整彩排：**均未执行**。
- 独立审查状态：Claude 正式复审已完成 —— **0 blocker / 1 仅文档 should-fix（S1，已由 `70e82ca` 修正）/ 6 条建议**；
  不再写"欠审查"。复审建议本轮**不要求**改单测/E2E。
## 6. 关闭分支诊断结论（job_376fbf57，已结束 exit 0）

归档：`docs/reports/artifacts/M4/regression/2026-11-15T17-09-31-768Z-sigint-diagnostic/`（`scenario-SIGINT.json`、`scenario-SIGTERM.json`、`diagnostic.json`、SHA 清单）。

| 场景 | exit | close | manifest 最终 status | cleanup.problems | forced | 端口 | 后代（按本诊断口径） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SIGINT | code=null / signal=SIGINT（7ms） | 同（7ms） | **running** | null | 0 | 全部关闭 | 无存活 |
| SIGTERM | code=null / signal=SIGTERM（6ms） | 同（6ms） | **running** | null | 0 | 全部关闭 | 无存活 |

结论（有证据）：在本机 **`ChildProcess.kill('SIGINT')` 与 `kill('SIGTERM')` 走的是同一条"直接终止"路径**——
6–7ms 内进程以 signal 结束，启动器自己的 `process.once('SIGINT'|'SIGTERM')` 处理器**没有写出任何东西**
（manifest 停在 `running`、没有 `cleanup` 记录），端口与后代是靠进程整体消失才没的，**不是** graceful 关闭逻辑跑完的结果。

因此：

- **不能**用 `child.kill('SIGINT')` 在 Windows 上验证"正常 Ctrl+C → `stopped` / `forced=false`"；
  `04-demo` 那条断言在当前实现方式下**不可达**，本轮**没有**为了变绿而放宽它，也没有拿 `signalCode` 当正常停止。
- **边界**：这是 `ChildProcess.kill()` 的**信号模拟**，**不是**真实 Windows 控制台 Ctrl+C（CTRL_C_EVENT 是另一条投递路径，未测）；
  启动器禁止 `NODE_OPTIONS`/`execArgv` 注入，无法在子进程内装 SIGINT 观察器，只能由 exit/close + manifest 间接判断。
- **本诊断自身的口径缺陷（如实记录）**：它的 `processCreated` 把"查询失败"也当成 `gone`，
  所以表中"后代无存活"只是"没查到还活着"，**不构成**归属/回收证明；真正的三态（present/absent/unknown/error）判定已写进
  `04-demo.spec.ts` 的 `probeProcess/stillOwn`，待下一次运行验证。本诊断**不重跑、不改写**。

需要真实控制台 Ctrl+C 语义的验证，只能在有真实控制台的会话里做（或由产品提供显式关闭命令），本轮不做、也不宣称。
## 7. 关闭分支的测试驱动（本轮已建，未运行）

`tests/e2e/m4/support/demo-launch-driver.mjs` 是**测试专用普通文件入口**（不是产品入口、不是后门）：

- `import { launch } from '../../../../scripts/demo/launch.mjs'`（file URL 直接引用产品实现），**不替换任何 options**；
- 强制 `execArgv` 为空、`NODE_OPTIONS` 未设置（launch 自身也校验），所以是“不注入”，不是“改产品”；
- 真实的 prepare/backend/frontends 全走产品代码（无替身）；
- 只在父进程发来 IPC 消息 `{type:'sigint'}` 后执行 `process.emit('SIGINT')`，让 **launch 自己注册的** `once('SIGINT')` 处理器跑 graceful shutdown；
- 只在实际 ready（stdout 出现 `Demo mode=mock`、manifest 为 `running`）之后才发消息。

对应用例（`04-demo.spec.ts` 第一条）保留原断言并补强判据：

- 不在“进程消失/只看 exitCode”上判通过——必须等到 **manifest 由 launch 写成 `stopped`**、`cleanup.problems=[]`、`forced` 全 false；
- 端口必须全部关闭；受测后代逐 PID+创建时间判定 **gone**，`alive` 与**查询未知**都单独失败；
- 记录 exit(code,signal)、**真实 close 事件**耗时、manifest 前后、driver 与后代归属；
- 主错误、清理错误、证据写入分别保留，互不覆盖。

**边界**：该用例只能命名为“**进程内 SIGINT 处理模拟**”；`process.emit('SIGINT')` **不是**真实 Windows 控制台 Ctrl+C（CTRL_C_EVENT 投递路径仍未执行），也不伪造 handler 结果或 native close。
## 8. 按 Codex 静态复核的第二批修正（本轮已改，未运行）

1. **driver 事件循环**：`demo-launch-driver.mjs` 在 `finally` 里 `removeListener('message')` 并**由子进程侧** `process.disconnect()`；
   不使用父侧 `child.disconnect()`（旧版 Node 已知问题）。否则 launch 返回后监听 + IPC 会挂住事件循环。
2. **speech probe 类型**：统一为 `SpeechProbe { stops, recorderStarts, recorderStops, errors, timeslice, liveTracks, streams, events }`，
   消除"返回类型缺字段但后文使用"的 TS 错误；`track.stop()` 幂等（重复 stop 不再重复计数）。
3. **权限 barrier**：改成**真正分配**流与轨道（`streams+1/liveTracks+1`）后才 resolve；断言 gate 已建立且 pending=1；
   Escape 后必须是**取消终态**（不是"状态非空"）；放行后等 **stops 增量 ≥1**，再断言 `liveTracks=0`、`recorderStarts=0`、
   无 POST、无 review；不再有 `stops>=1 || streams===0` 这种可空过的等待。
4. **499**：先等**真实 POST 发生**（并用其 header UUID 断言格式），再等取消/错误终态（`speech-status` 含"取消"或出现 `speech-error`），
   确认安全文案里没有内部细节，之后才发起第二次录音；不再以"status 非空"作为就绪判据。
5. **进程判定**：改为**一次 CIM 批量快照**（`snapshotProcesses()`），失败/超时返回 `null` → 一律 `unknown`（**不算 gone**）；
   `stillOwn(pid, created, snapshot)` 要求**两边创建时间都有效**（NaN/≤0/epoch0 → `unknown`），一致（≤2s）才算 `alive`，
   否则 `reused`；`unknown` 在用例里单独判失败，不自动补杀。避免"每个 PID 同步起一次 PowerShell"阻塞测试 worker。
6. **失败安全**：`01-speech` 增加 `afterEach` 兜底 `mouse.up()`（按住途中抛错也不会让后续用例继承按住状态）；主错/清理错/证据分开保留。
7. **措辞**：用例标题不再写"发送 DELETE"——录音阶段取消**从未上传**，断言是"**不应发送 DELETE**"，不伪造该路径。
## 9. M4 专项（501ea9e）实际结果与三个夹具前提修正

run `docs/reports/artifacts/M4/regression/2026-11-15T17-21-00-912Z-m4-special/`，`job_07aabc4e`，49s：

- **19 例 = 13 通过 / 3 失败 / 3 条 serial 未执行（skipped）**（`expected=13, unexpected=3, skipped=3, flaky=0`）。
  **3 条 skipped 不是通过**；`614` 单测、`12` 脚本、旧九套 `174` 本轮**均未执行**。
- 通过含：6 条语音（按住录音/确认、hidden 取消、499+新 UUID、权限取消、F1、F2）、3 个布局、2 条 fallback 前置（字节哈希、列表/非法输入）、
  2 条 demo（进程内 SIGINT 模拟、候选 HMR 连 plan.preview 且 10s 无循环导航）。
- 失败 3 条，全部定位为**夹具前提错误**（不是产品缺陷）：

### 9.1 `01-speech` A/B 用了同一个共享组件

- 现象：`second.src != first.src` 失败——`buy-button` 与 `save-button` 都来自共享 `Button`，
  `data-src` 都是 `src/components/Button.tsx:5:5`，所以"两个对象不同"这个前提本身不成立；F1 里重复点选同理。
- 修：换**真实不同来源**的 DOM 目标（`benefits` → `src/App.tsx`；必要时 `product-placeholder`），
  **保留** `notEqual`、冲突提示、`speech-use` 禁用、显式确认、确认后再改选仍拦等全部原断言；
  F1 用不同来源目标制造真实的 selection（epoch）变化。

### 9.2 `02-fallback` 用错了还原接口

- 现象：采用后调用 `POST /version/revert` → `409 NO_ADOPTION`。该路由走 `WorkService.revert`，只回退**候选采用**；
  资产的采用走 `SceneService.adopt`（压的是 scene history 栈），还原必须 `POST /scene/undo`（`app.ts:247`）。
- 修：采用前记录**完整场景 + 来源**；采用后核对 `model` 的 provenance/`outputHash` 与**实际 model.glb 字节 SHA256** 一致；
  再调 `POST /scene/undo`，断言场景与来源精确回到采用前的快照（不再拿"采用后的 sceneAfter"当基准，也不把 409 当通过）。

### 9.3 `04-demo` 5175 已被 M4 主验收后端占用

- 现象：夹具自己 `net.listen(5175)` → `EADDRINUSE`。M4 主验收后端的预览源本就用 `PREVIEW_ORIGIN_PORT=5175`，
  所以 5175 在本轮内**本来就是自有服务在监听**。
- 修：先查"谁在监听 5175"（PID + 创建时间，作为证据）：
  已被占用 → **复用它**作为冲突对照（记录归属），**不**再自己 listen、**不杀**任何进程；
  未占用 → 才建自己的 server，并只在 finally 关闭自己这个句柄。断言仍为：demo 的 `plan.preview ≠ 5175`、
  Studio/API 可达、demo 预览源在自己的随机端口真实应答；**不吞 EADDRINUSE**、不抢端口。

### 9.4 归档与边界

- 专项原件 + launcher + 真实 demo run 证据（827 个文件）+ `counts.json` 已归档，SHA 清单 **857 载荷、排除自身、0 mismatch**；
  60 个文件因运行中已消失/是链接而记录为 skipped，不伪造。
- `F4`（坏 sidecar 三类 409）与**硬杀**本轮因 serial 未执行，下一轮专项覆盖；这两个用例的前提**未**改动。
- 关闭路径仍只称“**进程内 SIGINT 处理模拟**”；真实 Windows 控制台 Ctrl+C、真实阿里/厂商/编码/Lux3D、真人 A/B、完整彩排均未执行。
## 10. 入口 EISDIR（gitlink）修复与只读预检

### 10.1 现象与根因（有具体 gitlink，不是猜测）

`job_fe46b6a4` 在 **spawnAndAwait 之前**就 exit 1 / 2s，**0 用例执行**。原因：

- `fc5caf5` 归档里包含一个 **Git gitlink（mode 160000）**：
  `docs/reports/artifacts/M4/regression/2026-11-15T17-21-00-912Z-m4-special/demo-runs/…/work-data/candidates/ffac7609daff433f8ceb5942c706182f`
  在 index/HEAD 里是 `160000 commit e4f8738d53abdad4a640a8705cb723b9ba51be12`，磁盘上是**真实目录**。
- 旧的证据枚举用 `git ls-files` + `readFileSync`，把目录当文件读 → `EISDIR`，入口在启动前崩掉。
  `.data/m4-special-run.mjs` 与 `tests/e2e/m4/full-regression.mjs`（第 88 行 `evidenceHashes`）**同源**。

### 10.2 修复（测试侧，产品 6aecd30 字节未动）

新增 `tests/e2e/m4/evidence-index.mjs`：**类型感知**枚举

- `git ls-files --stage -z` 取 **mode + OID + path**，按 `100644/100755`（普通文件）、`120000`（符号链接）、
  `160000`（gitlink）、其它（未知 mode）分开；
- 普通文件：`lstat` 确认是普通文件再读字节算 SHA256；读不到/不存在 → 显式 `missing`（**不静默过滤目录**）；
- 符号链接：只记 `linkTarget`，不跟随；
- gitlink：记 index OID + 磁盘类型（missing/link/directory/file），目录存在时产**容器摘要**（逐文件 SHA256，跳过 `.git` 与链接），
  **不把 OID 当载荷内容**；
- `planRestore` 明确：非普通文件**不得**走普通文件还原。

两个入口都用它：`.data/m4-special-run.mjs`（gitlink 记为 `gitlink:<oid>:<containerDigest>`，还原阶段拒绝非普通文件）、
`tests/e2e/m4/full-regression.mjs`（同规则；**full 仍不启动**，等这张卡批准后的恢复条件）。

### 10.3 归档与审计

- 失败 run `2026-11-15T17-30-00-022Z-m4-special` 已保全：launcher（`job_fe46b6a4` 的 cmd/exit/job.json/output.log）+ `gitlink-evidence.json`
  （`gitlinkCount=1`、完整 `ls-files --stage` 记录、`ls-tree HEAD` 证据、历史提交 `fc5caf5`），**未改写任何历史 JSON、未删原始嵌套 `.git` 指针**。
- 只读预检 `precheck.json`（`bg-root.cmd` 单次 job）：枚举 mode、原问题路径、完整载荷摘要、缺失/链接/未知 mode 清单，
  并对上一轮 **857 载荷**逐条对照"磁盘字节 vs 归档清单"、统计其中落在 gitlink 容器内的条目数。
- **禁止**再对验收归档 `git add` 嵌套仓库；gitlink 载荷变化**不得**套普通 `git checkout` 还原；
  报告与清单里不把 gitlink 冒充普通文件，也不因为 Git 表示差异就抹掉实际载荷。
## 11. 只读预检失败原因、Codex 直接修正、以及我补齐的普通证据容器

### 11.1 上一轮预检为什么也失败（0 测试）

`job_a7ab82b5`（exit 1 / 2s）不是用例问题，而是预检工具本身两处错误：

1. **HEAD 读法错**：读的是 worktree 的 `.git/HEAD` 文件（工作树里 `.git` 是文件而非目录），应 `git rev-parse --verify HEAD`；
2. **857 清单路径根错**：`sha256-manifest.json` 里的 `path` 是**相对 run 目录**的，旧代码 `join(ROOT, entry.path)` 必然全部 absent。

Codex 已直接修好并**保全旧入口**为 `.data/m4-gitlink-precheck.failed-head.mjs`（SHA256 `58114a1b5c96035a6308b6fd2b5aa8b7db22232c7c1b904e1f350010f0094fb1`），
当前工具 SHA256 记在 `tool-identity.json`；失败预检的 launcher 也归档到 `launcher-precheck/`。

### 11.2 本轮补齐（7dd269d 未做完的部分）

- **普通证据容器**：`materializeContainer()` 把 gitlink 目录**只复制普通文件**（不跟随链接、不复制 `.git`）到
  `gitlink-container/`，并写 `gitlink-container-mapping.json`：**originalPath / mode / sha256 / bytes / containerPath**。
  原 gitlink 与 857 清单**保持不动**；将来可把这些普通文件正常 `git add`，**不需要**再提交嵌套仓库。
- **目录摘要更完整**：容器摘要覆盖 **文件字节 + 链接目标文本**（`file\0path\0sha` 与 `link\0path\0target`）；
  `links`（符号链接/junction，只记目标不跟随）、`gitPointers`（`.git` 目录/文件指针）、`errors`（真实 I/O 异常）**分开记录**。
  `.git` 指针若指向容器外部 → 物化直接失败（不跟随、不静默）。
- **失败门禁收紧**：普通文件 `missing`/不可读、未知 mode、容器内 `errors`、审计 mismatch/absent、物化失败 → **入口失败（exit 1）**；
  「正常跳过链接」只计入 `links`，不当错误、也不当绿。**不再把 stable missing 当通过**。
- 审计口径：磁盘 857 载荷匹配 **不等于**"全部已正确入库"——其中落在 gitlink 容器内的条目，Git 记录形式是 `160000` 而不是普通文件，
  报告会把"磁盘匹配数"与"Git 表示差异（gitlink 容器内条目数）"分别列出。

### 11.3 边界

- 本轮只允许**一次无服务只读预检重试**：不跑 M4/19 例、不 full、不 collect、614/12/旧 174 均未执行；不启动 Playwright/browser/server。
- 产品与 19 例字节保持 `6aecd30` 不动；失败原件（含失败预检 launcher、工具身份）已保全，历史 JSON 未改写。
- 入口失败与运行失败在报告里分开记录；真实 Windows 控制台 Ctrl+C、真实阿里/厂商/编码/Lux3D、真人 A/B、完整彩排仍未执行。
## 12. 第二次预检失败（外部 .git 指针被误拒）与 Codex 修正

`job_73d69e30` exit 1 / 3s，**仍未进入任何测试**。失败点是**我的物化逻辑**，不是载荷真的坏了：

- 当时扫描结果：**4839 个普通文件、missing 0**；旧 857 清单 **match 857 / mismatch 0 / absent 0**；其中 **15 条**落在历史 gitlink 容器内。
- 我的 `materializeContainer()` 把容器里那个 **worktree 正常的外部 `.git` 指针**当成错误直接拒绝 → 入口失败。
  "外部 gitdir" 对 worktree 是正常元数据，不能因此判定一般 payload 失败。

Codex 已直接修 helper 并固定 `f803d94`（读 `docs/reports/M4-container-static-integration.md` + `git show`）：

- `.git` **指针文件自身的字节与 SHA** 被读入并纳入容器摘要，作为**惰性 `payload-NNNNNN.bin`** 保存；**绝不解析/跟随**它指向的仓库目标；
- `directoryDigest` 的 `path` 相对 **root**，物化时改为 `resolve(root, path)` 并校验 source 边界，修复"再拼一次 source"的双拼问题；复制前后 SHA 必须一致，已有不同目标拒绝覆盖；
- 普通文件 + 指针全部写进映射；真正的 **`.git` 目录**（不是指针文件）仍明确拒绝（需单独完整枚举）。

### 12.1 本轮我只做的两件事（不动 helper 语义）

1. 保全失败原件：`job_73d69e30` 的 launcher 归档到 `launcher-precheck-73d69e30/`；
   旧 `precheck.json` **不覆盖**，另存为 `precheck-failed-materialize.json`，并记 `precheck-73d69e30-notes.json`（含工具 SHA 与失败原因）。
2. 把 `.data` 预检的 **OUT 改成唯一新 run 目录**（`<时间戳>-gitlink-precheck/`），开跑前先 `mkdir`，失败也一定留 result；容器与映射也放在该新 run 下。
   857 清单审计仍**以其自身目录为根**（`dirname(MANIFEST)`），不改成 ROOT。

### 12.2 预检通过后的核对项

- 平面容器里每个 `payload-*.bin` 的 **raw bytes** 与原件逐字节一致；
- 映射里 `originalPath / mode / sha256 / containerPath` 完整（含 `.git` 指针作为惰性 payload）；
- 归档后**不再新增 `160000`**（容器是普通文件），Git 能看到这些普通文件实际入库；
- **保留原 gitlink 的旧 SHA 清单不变**。

边界：只跑预检（无服务、0 用例）；不 M4/full/collect/614/12/旧 174；产品与 19 例字节保持 `6aecd30`；入口失败与运行失败继续分开记录。
## 13. M4 专项第三轮（62ea1c8）：16 过 / 2 败 / 1 未执行

run `docs/reports/artifacts/M4/regression/2026-11-15T17-41-59-337Z-m4-special/`，`job_d91528ad`，exit 1 / 1m40s：
**16 passed / 2 unexpected / 1 skipped**（`flaky=0`）。归档 launcher、`counts.json`、3 个真实 demo run 目录（含失败那次）与 518 个证据文件；
SHA 清单 554 载荷、排除自身、0 mismatch；`git ls-files --stage` 复核归档仍为普通 `100644`，**没有新增 gitlink**（历史 1 条保留）。

### 13.1 失败一：`helpers.pickElement` 读到了上一次的选择（A）

- 现象：A/B 用例 `second.src != first.src` 失败——两次都拿到 `src/components/Button.tsx:5:5`。
- 根因（静态可确认）：旧 `pickElement` 点击后只 `waitFor(selection-json 可见)`。该面板在**上一次**选择后**一直可见**，
  于是立刻返回并读到 A；`App.tsx:135` 的收消息 `pending`、异步 `/version`、`ready` 都会让"可见即完成"变成假前提。
- 修（`helpers.ts`）：改为对"**这一次**"的屏障与真实事件证据，**不删除任何 notEqual/冲突断言、不换目标、不造假消息**：
  1. 观测父窗口真实收到的 `pick:result`（只记录，不伪造）；
  2. 点前记录 `{panelText, messages}` 基线；
  3. 点击后用**实际坐标**在 iframe 内做 `elementFromPoint` 审计，记录命中元素与其 `data-src`；
  4. 屏障要求 **新 `pick:result` 出现 + 面板文本与点前不同**，并核对该 message 的 `src` 与面板 `selection.src` 一致；
  5. 返回 `{selection, hit, message, before}`，用例把坐标/命中/message 序列写进证据。
- 边界：坐标命中与因果只在**本轮证据**里记录，不凭静态把所有原因写死；同一对象重复点选也要求"本次选择已完成"的证据。

### 13.2 失败二：5175 冲突对照用例 `stopHandle` 失败（frontends 45s forced）

- 已确证：5175 由**自有** 3001 API 进程持有（PID 与 guard loaded 一致），demo 自己的 preview 端口实际 200；
  失败发生在收尾：`manifest.status=cleanup_failed`，`frontends` PID 45s 后被 **forced SIGKILL**，`backend` exit 0，
  且该角色没有 close 阶段日志。
- 这**不是**"端口占用"前提错误，也**不是**可以把 45s 预算调大就能解决的问题：确证的是 **frontends 关闭路径**。
  该路径由 CodeBuddy 独立诊断（本报告只保全原件：失败 demo run 的 manifest/plan 与 main/studio cache 已按原字节归档）。
- 本轮我**没有**改 runtime、没有提高预算、也没有重试该用例。

### 13.3 未执行

`1` 条 serial skipped（硬杀用例，因前一条失败未执行）；旧九套 `174`、`614` 单测、`12` 脚本本轮均未执行；
真实 Windows 控制台 Ctrl+C、真实阿里/厂商/编码/Lux3D、真人 A/B、完整彩排仍未执行。
### 13.4 归档里的嵌套 candidates 仓库（不产生新 gitlink）

本轮专项的 demo run 目录里含 **嵌套 git 仓库**（`work-data/candidates/<id>`，`.git` 为指针文件）。归档时我：

1. 先用同一套 `materializeContainer()` 把它物化成 **`gitlink-container/` 的普通 `payload-*.bin`** + `mapping.json`（originalPath / mode / sha256 / bytes / containerPath），
   其中包含 1 份**惰性 `.git` 指针原始字节**（不解析、不跟随）；
2. 只有在 mapping 能覆盖该嵌套路径之后，才删除**归档副本**里的这个嵌套仓库目录（原始 `.data/demo-runs` 不动）；
3. `git ls-files --stage` 复核：新 run 归档 **572 条全部 `100644`，0 条 `160000`**；`docs/reports/artifacts` 下仍**只有 1 条历史 gitlink**（旧原件保留）。

因此"普通平面容器不产生新 gitlink"这一条是**按 stage 实际验证**的，不是口头声明。
## 14. M4 专项第四轮（merge 6161e86，产品 ea32d48）：19/19 全过

run `docs/reports/artifacts/M4/regression/2026-11-15T18-57-35-050Z-m4-special/`，`job_f17f54bb`，**exit 0 / 67s**：

- `stats`：**expected=19 / unexpected=0 / skipped=0 / flaky=0**；`errors=[]`；每条用例**单 result、retry=0**。
- 入口 `manifest`：`code=0`、`ok=true`、`problems=[]`、`identityStable=true`；`cleanup`：端口空、自有 node/chrome 空。
- 硬杀用例：`remaining / reused / unknown / ports` **全为空**（按"存在 + 创建时间"三态+unknown 判定，没把查询失败当 gone）。
- 关闭路径：仍只称"**进程内 SIGINT 处理模拟**"；**真实 Windows 控制台 Ctrl+C 未执行**。

### 14.1 归档

- launcher（`job_f17f54bb` 的 cmd/exit/job.json/output.log）、`counts.json`（19 条逐例状态）、本轮 **4 个真实 demo run**（`7a9a6130`/`d9c45372`/`2fc54982`/`50784724`，最后一个是被硬杀的，manifest 停 `running` 属预期）、656 个证据文件。
- demo run 内的**嵌套 candidates 仓库**（2 个）先物化为 `gitlink-container/01|02` 的普通 `payload-*.bin`（各 15 个，含惰性 `.git` 指针字节）+ `mapping.json`，**覆盖后才从归档副本删除**；
  `git ls-files --stage` 复核：新 run 归档 **694 条全部 `100644`、0 条 `160000`**，`docs/reports/artifacts` 下仍**只有 1 条历史 gitlink**。
- SHA 清单 **693 载荷、排除自身、0 mismatch**；本轮之前的失败轮（16/2/1、7/8 等）与原件**一律保留**。

### 14.2 身份区分

- **受测 merge HEAD**：`6161e86f79bbf82ca887d3fffefaef1492495bfe`；**产品实现**：`ea32d48`（`apps/packages/templates/scripts/package/lock` 与 `ea32d48` 零差异）。
- **本文档归档 HEAD** 是紧随其后的 docs-only 提交；**归档提交不是在测身份**，报告与证据都会写明这一点。

### 14.3 静态准备：完整回归入口（本轮不启动）

- `tests/e2e/m4/full-regression.mjs` 的证据枚举已换成类型感知的 `scanEvidence()`（gitlink/链接/未知 mode 不再 readFileSync）；
  脚本步骤仍是 `node --test scripts/demo/safety.test.mjs`。
- `scripts/demo/safety.test.mjs` 现在还会 **import** `body.test.mjs`、`frontend-watch-gate.test.mjs`（5 例）、`retained-response.test.mjs`（6 例）。
  所以"脚本套件 = 12 例"的说法**已过时**：**实际数必须在完整轮里运行得出**（预计 12+5+6，但**不预填、不沿用作成绩**）。
- 旧 **614 单测 / 12 脚本**成绩**不能抵新生产字节**（本轮生产确有 `c8f35b0` 的 watcher 门禁与 `ea32d48` 接线变化）；完整回归待 Codex 整合审查后另行安排。
- M1-B 23 例仍按**原像素阈值**，不在本轮执行。
## 15. 集中完整回归第一轮（受测 c846e03 / 产品 ea32d48）：停在 M1-B

run `docs/reports/artifacts/M4/regression/2026-11-15T19-02-35-094Z-full/`，`job_5324e1fd`：**首败在 `e2e-m1b`，后面全部未执行**。

| 步骤 | 实际结果 |
| --- | --- |
| typecheck | exit 0 / 9s |
| build | exit 0 / 10s |
| pnpm test | **exit 0 / 215s：614/614**（新生产字节上的真实计数） |
| demo-safety | **exit 0 / 23s：23/23**（12 基础 + gate 5 + response 6，本轮实测，未沿用旧 12） |
| M4 E2E | **19/19** |
| M0-B | 24/24 |
| M0-A | 27/27 |
| M1-A | 7/7 |
| **M1-B** | **20/23**：`expected=20, unexpected=3, skipped=0, flaky=0` |
| M2-A / M2-B / M3-A / M3-B / M3-C | **未执行（合计 93 例）** |

因此本轮计数是 **614 单测 + 23 脚本 + 19 M4 + 58 旧套（24+27+7）+ M1-B 20/23**，**不是**"旧九套全过"。

### 15.1 三条 M1-B 失败：同一个尺寸不一致（原文）

三条失败都抛在 `compareAligned`（`tests/e2e/m1a/visual.ts:75`）：

```
Error: 尺寸不一致：378x378 vs 378x341
```

对应用例：① `② 经 Studio 改动并经 PUT /scene 写入明显不同的相机后，两边仍然一致`（`01-consistency.spec.ts:67`）；
② `设为首屏后作品页在秒级内更新，iframe 不整页刷新…`（`02-writeback.spec.ts:34`）；
③ `界面写入 → 撤回：配置与网页画面都恢复`（`03-undo.spec.ts:22`）。

**静态定位（可确认的事实，不是结论）**：
- `captureCanvases()`（`tests/e2e/m1b/editor.ts`）分别截取预览 iframe 与 Studio 的 canvas 元素；两侧像素尺寸差 **37px（378→341，只有高度差）**，
  宽度完全一致 → 不是缩放，而是**某一侧 canvas 的可视高度被压掉 37px**。
- 与已知 M4 变更吻合：作品预览上方新增**来源标签行**（复审 S1 提到"预览 iframe 会变矮"），
  且 `resetEditorScroll()` 只在**截图前**把容器滚到顶；若 canvas 高度由容器剩余高度决定而非由 `aspectRatio` 撑开，就会出现这种"宽度不变、高度少 37px"。
- **尚不能确认**是产品尺寸缺陷还是测试夹具在"写入/撤回后的过渡态"截图（本机 M4 studio 布局在过渡期可能短暂变高/变矮）。
  需要下一步用**同一时刻记录** canvas `getBoundingClientRect`、容器高度、来源标签存在性、当前 `data-state` 的证据来判定——本轮只做定位，未改测试或产品。

### 15.2 旧采用清理遗漏（已确证，并按归属清理）

- 静态确认：`tests/e2e/m1b/06-adopt.spec.ts` 的 `finally`（125–128 行）只删 `adoptedFile`（`.glb`）与 `adoptedParts`（`.parts.json`），
  **没有删新增的 `.provenance.json` sidecar** → 作品目录残留 `templates/product-page/public/assets/lux3d-8400001.provenance.json`。
- 处理：先把该文件**按原字节**保存到本 run 的 `residue/lux3d-8400001.provenance.json`（285B，sha256 `b084c100eb4b…`），
  再只删除**本轮产生**的这一份；`templates` 工作区现为干净（脏项 0）。历史证据与其他 sidecar **未动**，未新增 gitlink。

### 15.3 归档（含嵌套仓库物化）

launcher（`job_5324e1fd`）、M1-B 三份 `error-context.md`/`test-failed-1.png`、本轮 4 个真实 demo run、脚本三分支持久证据、
`counts.json`（逐步实际计数 + 未执行清单）、`residue/` 原字节副本。
demo run 内的 **2 个嵌套 candidates 仓库**物化为 `gitlink-container/01|02` 的普通 payload（各 15 个，含惰性 `.git` 指针字节）+ `mapping.json`；
`git ls-files --stage` 复核：本 run **1070 条全部 `100644`、0 条 `160000`**，`artifacts` 下仍**只有 1 条历史 gitlink**。

### 15.4 清理与环境（实测）

- 端口 3001/4011/5173/5174/5175 **无监听**；无自有 node/chrome；`.data` 下无 `.model-stage-*` 残留；`templates` 脏项 0。
- 说明：`full-regression.mjs` 本身**不产出 `cleanup.json`**（那是 `.data` 专项入口的产物）；本轮端口/进程证据是运行结束后实测记录的，不代表逐套件回收断言。
- 未执行任何 kill；`unknown` 查询不当 gone。

### 15.5 边界

真实 Windows 控制台 Ctrl+C、真实服务/真人 A/B/完整彩排仍未验证；本轮未改测试/helper/runner/产品，未启动任何新验证。