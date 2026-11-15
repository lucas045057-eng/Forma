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