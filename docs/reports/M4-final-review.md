# M4 统一独立只读终审（Claude Code）

- 日期：2026-11-15。审查人：Claude Code（只做独立审查：不实现、不提交、不合并，也不派实现者）。
- 审查对象：`.worktrees/m4`，分支 `feat/m4-demo`。
  - 审查时核对 HEAD 为 **`9d717fc396cc4315f6ffcc636510868e8147dc82`**。tracked 干净，只有未跟踪的 `fallback/`（未触碰）。
  - 完整实现提交为 `fd38840d5171ad0651a66daa79a1528b0d522b42`。
  - 对比基线为 `2eadea59a16fb894b31f7f585a93d48460b30554`，其中已含 D1（D1 已在 `docs/reports/M4-D1-review.md` 审过，原文未改）。
- 范围：`git diff 2eadea5..fd38840`，49 个文件（+1424/−40），覆盖 D1 显式字段改写、D2–D5 全部产品代码、脚本、测试与文档。
- 依据文档：`docs/design/M4-plan.md`、我此前的 `M4-design-review.md`（S1–S8）和 `M4-D1-review.md`、`docs/reports/M4-development-handoff.md`，以及 Pi 首轮集中测试的结论（P1）。
- 只读边界：
  - 没有运行任何 typecheck、build、测试、服务、探针或浏览器；没有创建或修改工作树。
  - 没有读 `.env`、ASKS 或凭据；没有调用阿里、厂商、编码模型或 Lux3D。
  - `real.env.example` 只读了占位符。
  - 唯一的计算是对模板 GLB 做 `sha256sum`，用来核对 sidecar。

| 标记 | 含义 |
|---|---|
| **【代码核查】** | 我逐行读冻结源码得出的结论。 |
| **【本人只读核对】** | 我做的只读计算（rev-parse、文件 SHA256、grep），没有执行被测代码。 |
| **【引用 Pi 结果】** | Pi 首轮集中测试的结论。我没有重跑。 |
| **【未执行】** | 本轮没有任何人运行过的项。开发交接说明不能当作通过证据。 |

## 结论

**blocker 2，should-fix 6，建议 10 条。M4 现在不能进入验收。**

- **B1**：Pi 已发现的 TS2322，导致 server 类型检查失败。
- **B2**：我新发现的问题。演示脚本没有把预览源端口传给后端，demo 中候选预览的 HMR 会连到固定的 5175 端口，候选对照这一核心演示环节会失效。
- 两项都是一到两行的小修，但修完后必须重新跑完整验证。
- 6 条 should-fix 集中在三处：
  - D2 的“改选后明确确认”在真实 iframe 点选拓扑下走不到，组件测试的夹具形成假绿；
  - 语音绑定在提交后残留；
  - demo 子进程在父进程死亡后没有硬期限退出。

### 已执行与未执行

| 项 | 状态 |
|---|---|
| Server typecheck | **失败（exit 2）**【引用 Pi 结果】：`apps/server/src/scene/service.ts:168` TS2322 |
| Studio typecheck、build、全部单测、`scripts/demo/safety.test.mjs`、Pi 新增 13 例 M4 E2E、旧 174 例回归 | **【未执行】**（被 P1 阻断） |
| D2 新组件测试（`speech-browser.test.ts` 真实 Chromium） | **【未执行】**。开发方只有更早的 RED 和 TS2322 记录，修复后没有复跑 |
| demo 启动、关闭，SIGINT 正常关闭路径，父进程死亡后回收，PID 与端口清理 | **【未执行】**。Pi 的硬杀父进程只是观察，SIGINT 正常路径没有执行 |
| 真实阿里调用、浏览器厂商识别、真人 A/B、三次 mock 彩排、三次真实完整彩排 | **【未执行】**。文档中均如实标为未执行（`docs/demo/*` 已核对） |
| D1 显式字段改写 | 【代码核查】语义等价，但没有原生导入或运行证据 |

---

## Blocker

### B1 server 类型检查失败（P1）【引用 Pi 结果 + 代码核查】

- **位置**：`apps/server/src/scene/service.ts:163` `let provenanceBytes=Buffer.from(...)` 推断为 `Buffer<ArrayBuffer>`；`:168` `provenanceBytes=existingBytes` 赋入的是 `readPlainFile` 返回的 `Buffer<ArrayBufferLike>`。
- **触发**：`pnpm --filter @spatial/server typecheck`，或任何依赖它的全仓命令。
- **最小修复**：`:163` 改为 `let provenanceBytes: Buffer = Buffer.from(...)`。只改类型标注，不改逻辑。
- **验证要求**：在新的冻结 HEAD 上，从头完整执行：
  1. 全仓 typecheck（server 与 studio）；
  2. build；
  3. 标准 `pnpm test`；
  4. 单独运行 `node --test scripts/demo/safety.test.mjs`（它不在 `package.json:13` 的 test 过滤里）；
  5. D2 的 Chromium 组件测试；
  6. Pi 新增 13 例 M4 E2E；
  7. 旧 174 例回归。

  不能沿用 D1 时期的 547 例结果。

### B2 demo 候选预览的 HMR 端口错位【代码核查 + 本人只读核对】

- **位置**：
  - `apps/server/src/work/preview.ts:42`：候选 Vite 子进程的环境写死为 `PREVIEW_ORIGIN_PORT: process.env.PREVIEW_ORIGIN_PORT ?? '5175'`；
  - `templates/product-page/vite.config.ts:33`：据此设置 `hmr.clientPort`；
  - `scripts/demo/launch.mjs:11`：两种模式的 `backendEnv` 都没有设置 `PREVIEW_ORIGIN_PORT`，`systemEnvironment()` 也会把它过滤掉；
  - `scripts/demo/backend.mjs:25-28`：预览源实际监听在随机的 `ports.preview` 上。
- **触发**：`node scripts/demo/mock.mjs`，按 runbook 第 0:30–2:30 段生成候选并对照。候选页面的 Vite 客户端会去连 `ws://127.0.0.1:5175/preview/c/<id>/hmr`。
  - 若 5175 没有监听：按 `M2-A-fix-impl.md` 第 89 行与模板注释的结论，Vite 客户端连不上时会循环刷新页面。
  - 若本机正好运行着常规开发栈：WS 会连到另一个实例的预览源，因为候选未知而被断开，仍然循环刷新，而且会跨实例访问。
  - 主作品不受影响，因为 `frontends.mjs:19` 自己设置了 `clientPort:ports.preview`。
- **最小修复**（二选一）：
  - 在 `launch.mjs` 的 `backendEnv` 中两种模式都加 `PREVIEW_ORIGIN_PORT:String(ports.preview)`，这要求先生成 ports 再构造 env；
  - 或者给 `PreviewManager` 增加显式的 `previewOriginPort` 选项，由 `createApp` 传入（更好，可以去掉对全局 env 的依赖）。
- **验证要求**：Pi 在 mock demo 中实际生成一个候选，并断言：
  - 候选 iframe 在 10 秒内没有重复 navigation；
  - HMR WS 的目标端口等于本轮 `plan.json` 的 `ports.preview`；
  - 另外在 5175 被占用时再验证一次，不能连到另一个实例。

---

## Should-fix

### F1 D2：“改选后明确确认”在真实点选拓扑下走不到，测试夹具形成假绿【代码核查】

- **位置**：
  - `apps/studio/src/SpeechInput.tsx:20`：`useLayoutEffect(()=>{if(!allowed)cancel(...)})`；
  - `SpeechInput.tsx:22`：`window` 的 `blur` 处理会调用 `cancel`；
  - `apps/studio/src/speech-input.ts:101-102`：`cancel()` 在 `hadReview` 时也会丢弃 review；
  - `PointSpeak.tsx:19`：`submittable` 依赖 `canSubmit(pick)`，而 `pick-state.ts:22` 只对 `none` 和 `ready` 返回真。
- **触发**：真实 Studio 中，录音转写后进入 review 阶段，用户去预览 iframe 点选对象 B。
  1. 焦点进入跨源 iframe，父窗口触发 `blur`，`cancel('窗口已失焦')`；
  2. 即使没有 blur，点选过程中 `pick.kind` 会经过 `pending`，`allowed` 变为假，同样 `cancel`。

  结果 review 被丢弃，设计 S6 要求的“A→B 显示冲突，并可明确用于当前对象”的界面根本不会出现。用户只能重录，而一次阿里调用可能已经计费。

  同理，SSE 短暂重连（`status!=='connected'`）、`locked(['task:create'])`，或在 review 期间取消旧任务（`busy`），都会丢弃 review。
- **为什么测试是绿的**：`test-support/speech-harness.tsx` 用同文档内的 `fixture-B` 按钮直接把 `ready(A)` 切到 `ready(B)`，既没有 iframe 失焦，也没有 `pending`。`speech-browser.test.ts:85` 因此通过，但它没有覆盖真实拓扑。
- **最小修复**：
  - 只有 `permission`、`recording`、`transcribing` 三个阶段需要在 blur、门禁或 blocked 时取消；
  - `review` 阶段改为保留（`reviewDecision` 已经把 `ready` 计入按钮可用性，门禁不满足时按钮自然禁用）；
  - 进入场景模式时，可以保留现有的“隐藏即放弃 review”，也可以改为保留，但要在设计里写明。
- **验证要求**：Pi 在真实 App 中（不是 harness）执行：录音 → 进入 review → 在 iframe 点选 B，断言：
  - review 仍在；
  - `speech-selection-conflict` 和 `speech-use-current` 可见；
  - 采用后提交的 selection 是 B；
  - 同时补 SSE 断线重连期间 review 不丢的用例。

### F2 D2：语音绑定在成功提交后残留，阻断后续文字指令【代码核查】

- **位置**：`PointSpeak.tsx:51-70`。`submit` 成功后不清除 `binding`。`changeInstruction`（`:36-40`）只有在文本为空或显式要求时才清除。
- **触发**（演示主路径）：语音指令确认 → 生成候选 → 采用（主版本变化）。之后用户全选输入框并键入新的文字指令，一次 onChange 文本非空，`binding` 仍在。
  - `bindingMatches` 因为 `version` 不同而失败，`generate-candidate` 被禁用；
  - 冲突区只提供“放弃此语音指令”，点了会把刚输入的文字清空。
  - 主版本不变但重新点选了对象时，也需要多点一次“确认用于当前对象”。
- **最小修复**：`submit` 在 `succeeded` 后 `latestBinding.current=null; setBinding(null)`。另外可以考虑：手动编辑后的文本若与 `binding` 时的文本不同，就清除绑定。
- **验证要求**：组件和真实 App 各补一例：语音提交 → 版本变化或改选 → 键入新文字可直接生成，不出现 `speech-binding-conflict`。

### F3 D5：子进程在父进程死亡后没有硬期限【代码核查】

- **位置**：`scripts/demo/runtime.mjs:16-18`。`disconnect` 会触发 `stop()` 并等待 `close()`，但没有超时。父进程正常关闭时的 45 秒加 SIGKILL 兜底（`launch.mjs:20`）在父进程被硬杀后不存在。
- **触发**：启动器被任务管理器结束或终端被直接关闭，而 backend 的 `app.close()` 正在等一个在途检查、资产处理或上游请求。backend 会无限期存活，持有实例锁和端口，成为孤儿。
- **最小修复**：在 `ownedLifetime` 的 `disconnect` 分支设置一个 `unref` 的硬定时器（例如 50 秒），超时就 `process.exit(1)`。退出前写一条安全的 stderr 码。资产 process-worker 已经有同类处理（`process-worker.ts` 的 `disconnect` 时退出）。
- **验证要求**：Pi 硬杀启动器后，按 PID 加创建时间确认 backend、frontends 以及检查与预览的孙进程都在期限内退出；另外需要独立执行 SIGINT 正常关闭路径，核对 manifest 中 `status:'stopped'`、`forced:false`。

### F4 D3：损坏的作品 sidecar 让采用返回 500【代码核查】

- **位置**：`apps/server/src/scene/service.ts:166`。`JSON.parse(existingBytes...)` 抛出的 `SyntaxError` 没有被映射。`:165` 的 `readPlainFile` 已经把过大映射为 409，但坏 JSON 会冒成 500。
- **触发**：作品 `public/assets/<id>.provenance.json` 被手工改坏或截断，然后重新采用同名资产。
- **最小修复**：`try{JSON.parse}catch{throw new SceneError('ASSET_NAME_CONFLICT','已有来源记录无效',409)}`。读取侧 `modelProvenance` 已经 catch 后返回 unknown，与它保持一致。
- **验证要求**：补单测，坏 JSON、过大、合法但字段不同三种情况都返回 409，且作品字节不变。

### F5 D3：缺少关键正例和负例，现有测试不能证明边界【代码核查】

`assets/fallbacks.test.ts` 的 6 例方向正确，但还缺：
- **HTTP 正例**：UI 实际发送的 `body:'{}'`（`AssetPanel.tsx:68`）应得到 202 或 200。现有 `:44` 只测了三个 400 负例。路由 `app.ts:228` 的“空对象允许”没有被固定下来。
- **32MiB 边界**：恰好 32MiB 与多 1 字节；GLB 头的 `version≠2`、声明长度≠实际长度。
- **父进程死亡回收**：kill 正在处理时的 server 进程，断言 process-worker 退出且没有留下 `raw.glb` 半成品（`process-worker.ts` 的 `disconnect` 分支目前没有负例）。
- **旧索引**：没有 `fingerprint` 的同 ID 记录走 `ASSET_EXISTS`（`service.ts:185`），以及 `LOCAL_IMPORT_INTERRUPTED` 记录可以重新导入。
- **持久化失败**：`update` 写失败时 `idle()` 和 `close()` 抛出，锁不释放（这正是 `app.ts:73-75` 的设计意图），应有测试固定。

### F6 D5：启动脚本本体没有任何测试【代码核查】

`scripts/demo/safety.test.mjs` 只测了四个纯函数：
- `launch`、`prepare`、`runtime` 没有测试，包括 plan 路径越界、端口 plan 篡改、`.data` 联接点祖先、模板中诱饵 `.env` 被跳过等；
- `network-guard.cjs` 没有测试，包括非 loopback 的 DNS、TCP、fetch 被拒，纯 IP 字面量的 lookup 放行后 connect 仍被拒；
- 这些测试也没有接入标准测试命令。

**最小修复**：
- 至少补 `prepareDemo` 的隔离、白名单负例（临时仓库夹具）和 `network-guard` 的三类拒绝测试；
- 在根 `package.json` 增加 `test:demo`，或纳入 Pi 的集中清单。

---

## 建议（suggestion，非阻断）

1. **D4 像素合同需要重跑**【代码核查】。`App.tsx:204` 在预览面板内新增 `.preview-source` 一行（约 30px），使作品 iframe 的高度变小；`App.tsx:194-195` 的 demo 横幅会让 `.workspace{height:calc(100vh - 97px)}`（`style.css:29`）溢出视口，页面出现纵向滚动。旧 M1-B 的 23 例必须在新 HEAD 上实际重跑，并另截 demo 模式 1440×900 的图核对。
2. **D4 超宽画布**。`SceneEditor.tsx` 改为横向滚动加提示，没有缩放（回应了我在 M3-C 复审中的建议 2）。`.scene-canvas-scroll{overflow-y:hidden}` 会裁掉越出 viewport 的子元素（例如主光手柄若有外溢）。建议 Pi 截图时核对手柄完整可见。
3. **D4 装饰层**【代码核查】。`.studio::before` 设置了 `pointer-events:none`、`z-index:-1`，`.studio` 设置了 `isolation:isolate`，`.asset-dialog` 的 inset 阴影也不拦截点击，结论成立。`:where(...[tabindex])` 会给 `tabindex=-1` 的程序化焦点目标也画轮廓，属于可接受的副作用。审批卡的左右留白已补（回应 M3-C 复审建议 1）。
4. **来源接口开销**【代码核查】。`app.ts:242` 在 `work.repo.exclusive` 内读取并哈希最大 100MiB 的模型。`model-provenance.tsx:22-24` 在 `state.version` 变化时会刷新，又订阅了 `version.changed`、`scene.changed`、`state.reload`，一次版本变化至少触发两次请求（后一次 abort 前一次，但服务端仍会完成哈希）。另外 `listFallbacks`（`assets/service.ts:161-166`）每次打开面板都会哈希三个 GLB。建议按 `(mtime,size,ino)` 缓存哈希，或去掉重复的依赖项。
5. **D2 配置只读一次**。`SpeechInput.tsx:17` 在挂载时读取一次配置，5 秒超时；后端晚就绪或重启后，语音会一直不可用，直到刷新页面。建议在 `status` 回到 `connected` 时重新读取。
6. **D2 文案**。浏览器识别没有结果就结束时，`review(session,'')` 落到 `SPEECH_UPSTREAM` 的“语音识别服务暂不可用”，容易误导。建议改为“未识别到语音”。
7. **D3 错误码**。`AssetPanel.tsx:69` 吞掉了服务端的具体错误码（如 `ASSET_EXISTS`、`UNKNOWN_PRESET`），一律显示“无法确认导入结果”。备用导入错误码目前一律映射为 400，`UNKNOWN_PRESET` 更适合 404。
8. **D3 默认来源**【本人只读核对】。`templates/product-page/public/assets/diffuser-4969889.provenance.json`：
   - `presetId: diffuser-split`，`sourceHash` 等于 preset 固定值 `239b77d7…`；
   - `outputHash` 等于模板 GLB 实测 SHA256 `ebb71417…`；
   - `note` 为固定的“时间未记录”文案，没有虚构生成时间或任务号。

   与 runbook 和交接说明一致。“由 split 处理得到”这一链条只有文档依据，没有重放验证，这一点已在 runbook 中写明。
9. **D5 Windows 下的 Ctrl+C**。父进程与子进程在同一控制台，会同时收到 Ctrl+C。子进程如果先关闭，启动器可能把它记为 `interruption`，manifest 写成 `interrupted` 而不是 `stopped`。这不影响安全，但会误报。建议启动器在 SIGINT 时先设置 `shutting`，或忽略此时的 close。需要 Pi 实测。
10. **D1 显式字段改写**【代码核查】。`SpeechError` 先 `super(messages[code])`，再赋值 `code` 和 `status`；`SpeechService` 在构造器里赋值 `client`。原有预算、错误码和取消逻辑没有改，语义等价。只有 B1 修复后的全量运行能确认。

## D2–D5 其余合同核对结论【代码核查】

- **D2 录音和权限**：
  - 权限晚到会停掉 tracks（`speech-input.ts` 的 `start` 中 `getStream` 之后有 token 检查）；
  - 权限阶段松开按钮即取消；
  - 60 秒或 4MiB 上限，MIME 取交集，每次新 UUID；
  - 499 按 `code` 判断；
  - 先在本地释放资源，再发有界的 DELETE；
  - 迟到结果由 token 加 `current()` 丢弃；
  - review 可编辑，使用转写需要显式点击；
  - 指令被编辑过时要求明确替换；
  - A→B→A 由 selectionEpoch 保守阻断；
  - 版本变化只能放弃重录；
  - 真实提交入口（按钮与 Ctrl+Enter）在 `submit()` 内再次检查；
  - 重试保留原 selection。

  除 F1 和 F2 外，都满足设计 S5、S6 以及 D1 建议 6、7。
- **D3 来源**：
  - provenance 只由服务端写入，路由拒绝 body、query 中的来源字段；
  - sidecar 绑定 `outputHash`，跟随作品采用与撤回；
  - 模拟上游的资产记为 unknown；
  - 旧数据显示为 unknown；
  - 同名但来源或内容不同时拒绝覆盖；
  - 并发导入的幂等性由 `exclusive` 加 jobs 保证；
  - `close` 等待已准入的处理。
- **D5 隔离与密钥**：
  - 每次运行使用新的 UUID 目录，只复制 Git 跟踪文件加白名单名称，链接视为路径错误；
  - 不删除、不 reset 任何内容；
  - 子进程环境按白名单重建；
  - 前端 Vite 设置 `configFile:false`、`envFile:false`，只 define 两个公开值，前端子进程的环境里没有任何 key；
  - mock 端点只允许 `127.0.0.1` 的 http，backend 和 frontends 都预加载网络守卫，资产 worker 通过 fork 继承 `execArgv`；
  - real 模式需要 `--allow-real-services`，而且不会自动 POST 任何请求；
  - manifest 只记录布尔值，stderr 只提取错误码。

## 交 Codex 的返工清单（建议一次完成）

1. 修 B1、B2（必须）。
2. 修 F1、F2、F3、F4，测试补齐 F5、F6（应修）。
3. 冻结新 HEAD 后由 Pi 集中执行：上面 B1 列出的完整验证；F1、F2 的真实 App 用例；B2 的候选 HMR 用例；F3 的 SIGINT 正常关闭和父进程死亡回收；建议 1 的 M1-B 23 例与 demo 截图。
4. 真实阿里调用、真人 A/B 和三次完整彩排仍是外部条件，验收结论中必须单列为“未执行”。

**本报告不是 M4 验收结论。**
