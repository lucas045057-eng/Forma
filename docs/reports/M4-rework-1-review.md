# M4 统一返工一 · 独立只读修后复审（Claude Code）

- 日期：2026-11-15。审查人：Claude Code（只做独立审查：不实现、不提交、不合并，也不派实现者）。
- 审查对象：`.worktrees/m4`，分支 `feat/m4-demo`。
  - 审查时核对 HEAD 为 **`01c85fe18ebcb24c0a010621e53f71f475e7320f`**。tracked 干净，只有未跟踪的 `fallback/`。
  - 基线为我上次终审的 `9d717fc`（完整实现 `fd38840`）。
- 范围：`git diff 9d717fc..01c85fe`，共 33 个文件（+521/−61）。
  - 【本人只读核对】`tests/`、`playwright*.ts`、`package.json`、`pnpm-lock.yaml`、`templates/` 零差异，即依赖、锁、Pi 独立 E2E、默认 GLB 和 sidecar 都没有改动。
- 已全文阅读：
  - 本树的 `docs/reports/M4-rework-1-impl.md`；
  - 根目录的 `orbital/coordination/m4/unified-rework-1.md`；
  - 原 `docs/reports/M4-final-review.md`（原文未改）；
  - Pi 验收树 `.worktrees/m4-acceptance/docs/reports/M4-test.md`。
- 只读边界：没有运行任何 build、typecheck、测试、服务、探针或浏览器；没有新建工作树，也没有修改冻结的实现和测试；没有读 `.env`、ASKS 或秘密；没有调用阿里、浏览器厂商、编码模型或 Lux3D。

| 标记 | 含义 |
|---|---|
| **【代码核查】** | 我逐行读冻结源码与 diff 得出的结论。 |
| **【本人只读核对】** | git diff、grep 一类的只读核对，没有执行被测代码。 |
| **【未执行】** | 当前新字节完全没有运行过。不能借用 D1 的 547 例、旧的 174 例或任何静态报告。 |

## 结论

**原 2 个 blocker 和 6 个 should-fix 在代码层面全部有对应修正，我判定“代码层关闭、待 Pi 运行确认”。本轮没有新的 blocker 或 should-fix，另有 9 条建议，其中第 1 条是对我原报告的一处更正。**

- 这不是验收结论。新字节的类型检查、构建、单测、脚本测试、真实 App 和组件 Chromium 测试、M4 独立套件以及旧 174 例**全部未执行**。
- 下文每一项都写明了“需要 Pi 用运行结果证明的负例”。Pi 在新冻结字节上的实际运行结果优先于本复审。

---

## B1/B2、F1–F6 逐项核对

### B1 Buffer 泛型：代码层关闭【代码核查】
- `apps/server/src/scene/service.ts:163` 改为 `let provenanceBytes:Buffer=...`。
- `@types/node` 中 `Buffer` 的泛型默认就是 `ArrayBufferLike`，所以 `:169`（原 `:168`）把 `readPlainFile` 的返回值赋给它时类型兼容。
- 没有用 `as` 断言绕过，读取和冲突判断的逻辑也没有改。下游 `writeAtomic` 的参数是 `string | Uint8Array`（`assets/atomic-file.ts:4`），同样兼容。
- **需 Pi 证明**：在新冻结 HEAD 上从头执行 `pnpm -r typecheck`，8 个项目全部完成，Studio 也要真正执行（上一轮 `Scope: 7 of 8`，Studio 没跑到）。之后再跑 build 和全量单测。

### B2 候选预览 HMR 端口：代码层关闭【代码核查】
- `scripts/demo/launch.mjs:13` 在生成端口后设置 `backendEnv.PREVIEW_ORIGIN_PORT=String(ports.preview)`，mock 与 real 都走这一行。
- 后端 `PreviewManager` 在 spawn 候选 Vite 时读取这个值（`apps/server/src/work/preview.ts:42`），模板的 `hmr.clientPort` 随之一致，不会再退回 5175。
- 前端子进程仍然只拿到 `systemEnvironment()`，不含任何 key。
- 测试边界：`scripts/demo/body.test.mjs:110-118` 用替身角色只断言环境变量的传递，不能证明 HMR 已经接通。实现报告也这样写明了。
- **需 Pi 证明**：
  - 在真实 mock demo 中生成候选，HMR WS 的目标端口等于 `plan.ports.preview`；
  - 候选 iframe 10 秒内没有重复导航；
  - 5175 被另一个实例占用时，不会连到那个实例。

### F1 review 在真实点选拓扑下保留：代码层关闭【代码核查】
- **状态区分**：新增 `speechInflight`，只包含 permission、recording、transcribing 三个阶段（`apps/studio/src/speech-input.ts:20`）。
  - `SpeechInput.tsx:21`：门禁或 blocked 变化时，只取消在途请求；
  - `:23`：`window` 的 blur 也只取消在途请求；
  - `:23` 的 `visibilitychange→hidden` 和卸载时的 `dispose()` 仍会放弃 review。这与修改后的设计 §4（`docs/design/M4-plan.md:47` 起的段落）和 runbook 一致。
- **门禁没有被削弱**：
  - review 期间 `reviewDecision` 仍把 `ready=submittable&&!busy` 计入所有确认按钮。断线或 pending 时 `speech-use` 禁用，`speech-use-current` 不渲染；
  - `useReview`（`PointSpeak.tsx:42-49`）在点击时用 `latestContext` 再判一次；
  - 录音按钮的 `recordDisabled` 仍包含 `!allowed`；
  - 没有任何路径会把 review 自动套到 B 或自动 POST。
- **在途取消没有回退**：权限晚到时停止 tracks、DELETE、token 作废的逻辑都没改。原有的 `it.each(['visibility','blur','gate','unmount'])`（`speech-browser.test.ts:128` 一带）仍然断言录音中会释放资源。
- **新增回归的可靠性**：
  - 组件夹具 `test-support/speech-harness.tsx` 新增一个 sandbox 跨源 iframe（与父页面不同源），点选时先进入 `pending`。用例 `speech-browser.test.ts:93-104` **显式断言了 `parentBlurs` 增加**，确认真的触发了父窗口失焦。
  - 新增的 `speech-app.browser.test.ts` 加载真实的 `App` 和 `EventCenter`、真实 pick 消息的来源校验（`App.tsx:135-141` 会先设为 `pending`，再等 `/version`），预览页来自不同 loopback 端口，并真实关闭和重连 WS。
  - 它用 `holdVersion` 确定性地停在 pending，所以这个拓扑比旧夹具可信。
  - 局限一：预览页是替身，不是真实模板加 bridge；HTTP、WS、麦克风也是替身（报告已写明）。
  - 局限二：这个真实 App 用例**没有断言父窗口 blur 确实发生**，见建议 3。
- **需 Pi 证明**（在真实模板和 bridge 下）：录音得到 review → 在 iframe 点选 B → pending 期间 review 仍在，按钮禁用 → ready 后出现冲突提示 → 明确“用于当前对象 B”后才能生成，任务的 selection 是 B。另需：SSE 断线重连期间 review 不丢；页面真正隐藏时 review 被放弃。

### F2 提交后释放绑定：代码层关闭【代码核查】
- `PointSpeak.tsx:65`：只有在 `/tasks` POST 返回成功、拿到 task 之后，才执行 `latestBinding.current=null;setBinding(null)`。
  - 失败或网络未知走 catch，绑定保持；
  - 之后 reload 失败不影响已经清掉的绑定。
- 放弃按钮（`:105`）：只有当前输入仍等于当初确认的语音文字（`boundText`）时才清空，后来手动改过的文字会保留。确认后再改选，仍然由 `submit()` 内的 `bindingMatches` 加上 `voiceGate` 阻断（`:54-56`、`:108`），没有绕过。
- 新测试：
  - `speech-browser.test.ts`：提交后版本变化，新文字可以直接生成；失败提交后绑定保持；放弃绑定后保留手输文字；
  - 真实 App 用例的最后一段：版本刷新后纯文字可以提交。

  这些都能区分修复前后的行为。
- 剩余语义（建议 6）：成功提交后输入框仍保留语音文字（沿用原有“提交不清空输入”的行为）。用户改选对象后再次点生成，这段文字会作为普通文字指令提交到新对象，不再要求语音确认。属于明确的用户动作，但建议写进设计。
- **需 Pi 证明**：在真实 App 中，语音提交 → 采用导致版本变化 → 键入新文字，可以直接生成，不出现 `speech-binding-conflict`；POST 返回 500 或断网时冲突提示仍然出现。

### F3 父进程断开后的有界回收：代码层关闭，有运行限制【代码核查】
`scripts/demo/runtime.mjs:47-63`：
- **父进程 IPC 断开**（`parentGone`）：立即把 `exitCode` 设为 1，启动一个 50 秒、`unref` 的 watchdog，再尝试正常 `close`。
  - 断开状态下 watchdog 不会被清除（`:57`）：close 成功且没有残留句柄时进程自然退出，`exitCode` 为 1；仍有残留句柄时，50 秒后强制回收。我认为这符合“父进程死亡不算正常停止”的约束。
  - 启动时已经失去 IPC 的情况由 `:61` 兜底。
- **身份校验与回收顺序**：
  - `descendants()`（`:31-37`）从本进程出发，按父 PID 做广度遍历；
  - 子进程的创建时间早于父进程的会被排除，能防住 Windows 上 PID 复用导致的误认；
  - 结果按深度从深到浅排序；
  - `terminateOwnedDescendants()`（`:38-45`）先重新扫一次，PID 与创建时间都对得上才 kill，最后再扫一次确认剩余。
  - 最多 3 次 PowerShell CIM 查询，每次 5 秒上限；任何一步失败都写入 `errors`，并以 exit 1 退出。
  - 没有按进程名、端口或全局 taskkill 广杀，也没有只靠 `process.exit` 冒充成功。`orphan-cleanup-<pid>.json` 写进本轮 run 目录。
- **Ctrl+C 竞态**：
  - 子进程收到信号后先发送 `shutdown-intent`（`:58`）；
  - 启动器收到后设置 `interruptRequested`，正常关闭后状态记为 `stopped`；
  - `launch.mjs:22` 新增“非零退出或信号退出一律记为问题”，强杀或清理失败仍然是 `cleanup_failed` 加 exit 1。
- **生产链的覆盖面**（基于既有代码）：
  - 资产 worker：`process-worker.ts` 在加载重型模块前就注册了 `disconnect` 时退出；
  - 预览 worker：`work/preview-worker.ts:5` 在 `disconnect` 时退出；
  - 检查 worker：`checks/worker-entry.ts:31` 在 `disconnect` 时走 shutdown。

  因此即使 watchdog 不触发，孙进程也有各自的退出路径。
- **局限**（建议 4、5）：
  - Windows 不会给孤儿进程重设父进程，中间层已经先死的孙进程不在遍历范围内；
  - 正常 Ctrl+C 路径中，启动器等 45 秒后 SIGKILL 子进程，这时没有 watchdog，回收完全依赖孙进程自身的 disconnect 处理。
- 测试边界：
  - `body.test.mjs:120-130` 用硬杀父进程触发真实 IPC 断开，配 4 个替身孙进程和一个无关进程作对照；
  - 关闭测试中 SIGINT 是通过 IPC 触发 `process.emit('SIGINT')`，**不是 Windows 控制台的真实 Ctrl+C**，子进程没有收到信号，所以 intent 竞态这条路径没有被测到。实现报告如实写明了这一点。
- **需 Pi 证明**：
  - 真实 mock demo 中硬杀启动器后，backend、frontends 以及预览 Vite、检查 worker、Chromium、资产 worker 按 PID 加创建时间在 55 秒内全部消失，端口释放；
  - 在 backend 关闭被挂起的情况下，能看到 `orphan-cleanup-<pid>.json`，其中 `errors` 为空；
  - 真实控制台 Ctrl+C 后 manifest 为 `status:'stopped'`、全部 `forced:false`、`exit:0`。

### F4 坏来源记录统一返回 409：代码层关闭【代码核查】
- `scene/service.ts`：JSON 解析失败映射为 `ASSET_NAME_CONFLICT 409`（`:166`）；
- `:165`：超过 16KiB 时，`readPlainFile` 的 tooLarge 回调同样返回 409；
- `:168`：合法但来源不同，返回 409；链接仍是 403。

全部校验都发生在写 GLB、parts、sidecar 和提交 scene 之前（同名内容比对在 `:174`，写入在其后，sidecar 写入在 `:181`）。`scene/service.test.ts:107-129` 通过 HTTP 覆盖了三类情况：
- 第三类改成 `kind:'lux3d'`、`sourceTaskId:'123'`，能通过 `parseProvenance`，确实走到“合法但来源不同”的分支；
- 断言了 409 和错误码，响应体不回显 `schemaVersion`，config、GLB、parts、sidecar 四份字节不变。
- **需 Pi 证明**：实际运行这三例。

### F5 资产边界、父死与持锁：代码层关闭【代码核查】
- **空对象正例**：`fallbacks.test.ts:65` 用真实的 `'{}'` 和 JSON content-type 请求，断言 202 且 provenance 为 fallback。
- **大小与 GLB 头**：恰好 32MiB 通过，多 1 字节返回 `FALLBACK_TOO_LARGE`，`version=1` 或声明长度加 1 返回 `INVALID_GLB`（`:41-46`）。
- **旧数据**：没有 fingerprint 时返回 `ASSET_EXISTS`；带 fingerprint 的 `LOCAL_IMPORT_INTERRUPTED` 记录可以明确重新导入（`:47-53`）。
- **持久化失败**：`service.ts:92` 现在把索引写入失败也记入粘性的 `jobFailure`。`idle()` 和 `close()` 都抛出，锁不释放，第二个实例拿到 `INSTANCE_LOCKED`（`:54-60`）。这与 `app.ts` 中“生产者失败就保留所有权”的约定一致。副作用见建议 7。
- **worker 父进程死亡**：
  - `process-worker.ts:1-3` 先注册 `disconnect`，再检查是否已失联，最后才 `await import('./process-model.ts')`，启动阶段的孤儿窗口缩短了；
  - 生产的 `process-isolated.ts:31-32` 用 `execArgv: []` 来 fork，测试 loader **无法**被注入生产 worker，生产路径里没有暂停开关；
  - 测试夹具 `test-support/asset-parent.ts` 自己 fork 真实的 process-worker，用 `--import` loader 只把模型模块挂起。它证明了 worker 的 IPC 退出和重启时的 staging 清理，但**没有经过** `process-isolated.ts` 本身的接线（建议 8）。
- **staging 清理**：`cleanup.ts:16-18` 只清理名字精确为 `.model-stage-*` 的目录。`Dirent.isDirectory()` 对联接点返回 false，不会跟随链接。清理在 `init()` 拿到实例锁之后执行（`service.ts:56-57`）。与生产的 staging 位置一致（`process-isolated.ts:20`）。
- **`AppOptions.presetDigests`**：只是 `createApp` 的内部参数（`app.ts:32`、`:97`）。`index.ts`、`scripts/demo/backend.mjs`、HTTP 和环境变量都不会设置它；grep 只在测试中找到使用。不构成生产旁路。
- **需 Pi 证明**：实际运行这些用例。父死用例依赖 Windows 的 PowerShell CIM，需要记录真实 PID 和创建时间。

### F6 脚本本体测试与接入：代码层关闭【代码核查】
- 被测入口的新参数（`prepareDemo(mode,{repositoryRoot})`、`readPlan(file,root)`、`launch(...,{repositoryRoot,prepare})`、`ownedLifetime(...,{hardTimeoutMs})`）都只在代码内部使用。`mock.mjs` 和 `real.mjs` 仍然只传 argv，不存在 CLI、HTTP 或环境变量形式的覆盖。
- `body.test.mjs` 覆盖了：
  - 只复制 Git 跟踪的文件，诱饵 `.env` 被跳过，旧 run 保留；
  - 目标路径祖先中的联接点被拒绝，且外部目录为空；
  - plan 越界、端口重复或越界、多出的端口名都被拒绝；
  - 网络守卫在原生 DNS、TCP、fetch 之前就拒绝外部请求，纯 IP 的本地 lookup 和 loopback 正例可用；
  - 两种模式的端口传递和 SIGINT 控制流；
  - watchdog 只回收自有后代，不碰无关进程。

  这些测试打的是真实的边界函数。
- 接入方式：`safety.test.mjs:4` 用 `import './body.test.mjs'`，因此 Pi 既有的第 4 步 `node --test scripts/demo/safety.test.mjs` 会一并执行。
- 区分：这些都是替身角色或替身进程。生产链的父进程死亡回收和真实 Ctrl+C 仍需要 Pi 用真实 demo 证明（见 F3）。

---

## 原 10 条建议的处置复核

| 建议 | 结论 |
|---|---|
| S1 高度 | `style.css:4` 改为 `.studio{display:flex;flex-direction:column;height:100dvh}`，`:29` 改为 `.workspace{flex:1;min-height:0}`，去掉了硬编码的 `-97px`，横幅和 `.state-sync` 改为 `flex:none`。修正方向正确，没有回退。注意：旧布局中 `.state-sync` 那一行其实没有计入 97px（会溢出），新布局计入后 iframe 会比 M1 时期更矮，而 `.studio min-height:560px` 也让短屏下的 workspace 可以缩到 560 以下。**M1-B 23 例（含并排滚动和开盖关键帧）必须在新 HEAD 上重跑**，并截 1440×900 的 demo 图。 |
| S2 手柄 | `scene-editor.css:15` 的 `overflow-y` 改为 `auto`，不再裁掉手柄，没有缩放。需要截图确认。 |
| S3 装饰与焦点 | 没有改动，原结论仍成立。 |
| S4 来源去重 | `model-provenance.tsx` 去掉了 `state.version` 依赖，同一微任务内的多个事件合并为一次刷新，每次仍真实哈希，没有用 mtime 或 size 缓存来掩盖篡改。`version.changed`、`scene.changed`、`state.reload` 仍会触发刷新。成立。 |
| S5 配置重读 | `SpeechInput.tsx:15-20` 依赖 `connected`，重连后只重新 GET 一次配置，不会开始录音或上传。用例断言了 `configReads` 为 2、`posts` 为 0。成立。 |
| S6 空识别 | 本地新增 `SPEECH_EMPTY`，显示“未识别到语音”（`speech-input.ts:95`、`speech-api.ts:3`），有单测。成立。 |
| S7 资产提示 | `AssetPanel.tsx:6` 的白名单 7 个码与 `fallbacks.ts:15-18`、`service.ts:97/185` 的实际错误码一一对应，未知码仍显示“结果未确认”，不回显原始 message。400 映射保留为已知限制。成立。 |
| S8 默认来源 | 模板 GLB 和 sidecar 零差异，没有杜撰。成立。 |
| S9 Ctrl+C | 已与 F3 合并处理（见上）。真实控制台信号的运行证据待 Pi。 |
| S10 D1 | D1 代码没有再改。需要新的全仓运行覆盖。 |

---

## 新建议（suggestion，非阻断；新 blocker 0、新 should-fix 0）

1. **更正我原终审中的一句话**【本人只读核对】。原 `M4-final-review.md` 的“D5 隔离与密钥”一节说“资产 worker 通过 fork 继承 `execArgv`”，这是错的。
   - 生产的 `process-isolated.ts:32` 显式设置 `execArgv: []`；
   - 候选预览 worker（`preview.ts` 用 spawn 启动，没有 `--require`）和检查 worker 也不会加载 mock 网络守卫；
   - 也就是说，mock 守卫只覆盖 backend 和 frontends 两个主进程。

   这些孙进程只做本地处理，不需要联网，风险低。建议 runbook 写明守卫只作用于主进程，避免对外夸大 mock 的离线保证。原报告保持原文不改，以本条为准。
2. **真实 App 用例补断言**（`speech-app.browser.test.ts:43`）：组件用例已经断言了 `parentBlurs`，真实 App 用例却没有。可以在页面上挂一个 blur 计数器，断言点 B 后计数增加，证明真的走了失焦路径，而不只是 pending。
3. **watchdog 测试的进程数断言偏脆**：`body.test.mjs:126` 断言 `workers.length===4`。如果测试环境没有控制台，Windows 可能给子进程挂 `conhost.exe` 后代，导致计数不符。建议按命令行中的 role 过滤。生产的 `descendants()` 把 conhost 一并回收没有问题。
4. **Windows 不重设孤儿的父进程**（`runtime.mjs:31-37`）：中间层先死的孙进程，其 `ParentProcessId` 指向已死的 PID，遍历时会漏掉。目前靠孙进程各自的 disconnect 处理兜底。建议在 runbook 中写明，并请 Pi 的父死用例专门核对 Chromium 这一层。
5. **正常 Ctrl+C 但子进程挂起的情况**：启动器等 45 秒后只 SIGKILL 直接子进程（`launch.mjs:21`），这时子进程的 watchdog 不会启动，孙进程只能靠自己的 disconnect 退出。可以在 SIGKILL 之前先请子进程自行回收（例如 IPC 发送 `force-cleanup`），也可以记录为已知限制，由 Pi 实测。
6. **F2 的剩余语义**写进设计：提交成功后输入框里仍是语音文字，改选对象后再次生成会按普通文字提交，不再要求语音确认。如果希望更保守，可以在成功后同时清空输入框，或在冲突区提示“这段文字来自已提交的语音”。
7. **粘性的 `jobFailure` 覆盖了所有索引写入失败**（`service.ts:92`）：Windows 上杀毒软件或索引器造成的瞬时 `EPERM` 重命名失败，也会让本次运行的关闭始终报失败、锁不释放（进程退出后由过期锁接管）。这符合不丢所有权的设计，但 demo 会因此记为 `cleanup_failed`。建议 runbook 写明处理办法，或者对 `writeAtomic` 的 rename 做有界重试（只针对 EPERM 和 EBUSY）。
8. **父死测试没有经过生产接线**：`fallback-process-lifecycle.test.ts` 通过 `asset-parent.ts` 自己 fork worker，复现了 staging，但没有经过 `process-isolated.ts` 的 spawn、超时和 finally。建议 Pi 在真实 demo 中处理一次真实的 split GLB 时硬杀 backend，核对 worker 退出，且重启后 `.model-stage-*` 被清除。另外，这个用例只能在 Windows 上跑（PowerShell CIM），可以加 `skipIf(process.platform!=='win32')`，避免跨平台时误报失败。
9. **联接点清理的稳健性**：`body.test.mjs:90` 的 finally 用 `rm(junction,{force:true})`，没有加 recursive。Windows 上删联接点通常可行，但若失败，会连带后面清理根目录的 `rm` 一起失败。可以改用 `fs.unlink` 或 `rmdir` 删除联接点，避免测试清理出现假红。

## 交 Codex 与 Pi

- 本复审认为原 2 个 blocker 和 6 个 should-fix 都**不需要返工代码**。上面 9 条建议是否吸收由 Codex 统一决定，不需要为此单独开一轮。
- Pi 在新冻结字节上从头执行：
  1. 8 个项目全部 typecheck，然后 build、全量单测（含 `speech-app.browser.test.ts`、`speech-browser.test.ts`、`fallback-process-lifecycle.test.ts`、`scene/service.test.ts`）；
  2. `node --test scripts/demo/safety.test.mjs`（含 body）；
  3. M4 独立 E2E；
  4. 旧 174 例（含 M1-B 23 例）。

  另需专门补齐 B2、F1、F2、F3 中标出的真实拓扑负例：候选 HMR 端口与 5175 占用对照、真实模板 iframe 点选 B 与重连、提交后的新文字、真实 demo 的父死整链回收与 Windows 真实 Ctrl+C。
- 真实阿里识别、真人 A/B、三次完整彩排仍是外部条件，单列为“未执行”。

**本复审不是 M4 验收结论。**
