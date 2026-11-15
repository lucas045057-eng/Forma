# M4 独立 E2E（Pi 侧）返工记录：修三个确认缺陷 + 关闭分支诊断边界

日期：2026-11-16。仅改 `tests/e2e/m4/**`（独立套件）与文档；**生产代码、实现侧测试、依赖锁、模板、runner 均未改**。
本轮**没有运行**任何测试/collect/build/服务/full；下面所有"修好了"都只是静态性质，未验证。

## 0. 上一轮（job_e585899e）归档事实

run `docs/reports/artifacts/M4/regression/2026-11-15T16-52-32-677Z-full/`，受测 `280e282`（产品 `f9e21f5`）：

- typecheck / build **通过**；单测 **614/614 通过**；`demo-safety` **12/12 通过**（exit 0）；
- **M4 独立套件 19 例：4 过 / 8 败 / 7 跳过**（`stats.expected=4, unexpected=8, skipped=7`）：
  - 失败：`01-speech` 4 例 + F1 + F2（共 6）、`02-fallback` 的 preset 哈希核对 1 例、`04-demo` 的 SIGINT 1 例；
  - 跳过：串行文件在首个失败后的后续用例；
  - 通过：权限晚到取消、preset 列表/导入/空对象 POST/坏 sidecar、3 个布局视口、候选 HMR、5175 占用、硬杀回收；
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
  启动器禁止 `NODE_OPTIONS`/`execArgv` 注入，无法在子进程内装 SIGINT 观察器，只能由 exit/close + manifest 间接判断处理器是否执行。
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