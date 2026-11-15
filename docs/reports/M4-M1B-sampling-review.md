# M4 · M1-B 同窗口采样修正 · 有限只读复审

> Codex 集成记录：已完整核对本报告。验收树后续 `3c0cc27` 仍只有文档/launcher 归档变化，测试源码相对 `4d34bce`、产品相对 `ea32d48` 均无差异；本轮三条非阻断建议只记录。本报告由根单独固定，不合并 M4 产品代码到主线，也不替代待执行的完整回归。以下为复审交付内容。

- 审查者：Claude Code
- 日期：2026-11-16
- 任务卡：`orbital/coordination/m4/m1b-green-archive-review.md`（Claude 部分）
- 审查对象：验收树 `.worktrees/m4-acceptance`，`3a920c0 → 4d34bcee1eb777dda42bd3e4cfbdacda2395ebe8`。只看 `tests/e2e/m1b/` 下 6 个文件：`window-compare.ts`（新增）、`editor.ts`、`01-consistency`、`02-writeback`、`03-undo`、`06-adopt`。全部按固定的 `4d34bce`，用 `git show`/`git diff` 读取。
- 运行证据：`job_3cb0021d` 的 run `docs/reports/artifacts/M1-B/focused/2026-11-15T19-44-36-408Z-m1b-focused/`。只读其中的 `results.json`、`cleanup.json`、`fixed-additions-mapping.json` 和 8 份新增采样 JSON。
- 不在范围内：产品 `ea32d48`、之前的 watch gate 审查、旧 full 轮。
- 方式：纯只读。没有运行测试、类型检查、构建、服务、浏览器、探针或 job，没有派人，没有改受测树。本报告未提交。

## 0. 结论

| 级别 | 数量 |
|---|---|
| Blocker | **0** |
| Should-fix | **0** |
| Suggestion | **3**（只记录，不实现） |

**审查与运行是两回事**
- 本报告审的是代码。23/23 是另一份运行证据，"运行 0 失败"不能代替代码审查。
- 本次 focused 23 例与旧 full 轮也必须分开看：旧 full 轮 M1-B 失败后，**93 例没有执行**（M2-A、M2-B、M3-A、M3-B、M3-C）。两者不能合成"全量通过"。
- M4 收口仍需要授权后的完整回归。

**审查期间 HEAD 前移了，不影响结论**
- 验收树 HEAD 已从 `4d34bce` 前移到 `2b70dac`，是 Pi 的 docs 归档提交。
- `tests apps packages templates scripts` 相对 `4d34bce` 没有差异。

## 1. 代码审查（固定 `4d34bce`）

### 1.1 真实请求关联（`observeResponse`）

**在点击之前开始监听**
- 只认同源（Studio origin）、方法和路径都匹配的**第一个** `Request`。
- `response` 和 `requestfailed` 都按同一个 `Request` 对象来认，不会把别的请求算进来。

**判失败的情况**
- 状态码不是 200；
- 读取响应体失败；
- 响应体在截止时间之后才读完；
- 截止时间到了请求还没完成。

**不会挂起**
- 设了一个计时器，最晚到截止时间一定结束等待，不会无限挂住。

**调用方**
- 调用方（`runPairChange`）先等 `result`；只要有 `error` 或状态码不是 200 就抛错。
- 02 和 03 还会再断言一次状态码为 200。

### 1.2 统一截止时间

- 在点击之前只取一次 `startedAt`，`deadline = startedAt + 30_000`。点击超时、响应观察、`waitForPairChange` 都用这同一个截止时间，没有第二套预算。
- `waitForPairChange` 的循环条件是 `Date.now() <= deadline`；样本满足条件之后还会再检查一次是否已过截止时间。最后一次等待用的是 `min(间隔, 剩余时间)`，不会超出截止时间。
- `elapsedMs` 从点击前开始计时，并且包含了截图比对的耗时。02 的 `latencyMs < 10_000` 用的就是这个值，比旧版"点击返回后才开始计时"更严格。
- 阈值、预算、间隔都没改：0.02/30s/250ms，0.01/30s/100ms，以及撤回用的 `decrease` 0.002/30s/150ms。

### 1.3 同坐标窗口采样

**基线**
- 截基线前要通过门禁：场景 `data-loaded`、保存和撤回按钮都可用、没有"状态待同步"提示、`previewState=ready`、backing 有效、可见高度不低于 120。
- 截完再检查一次门禁，并要求窗口与截图前完全一致，否则判失败。

**每次采样**
1. 先把滚动归零；
2. 门禁和几何都必须与基线完全一致，没有任何容差。比较的项目有：size、start、end、visibleHeight，三个 rect，viewport，以及 backing 的宽高和 DPR。
3. 用**基线的坐标**截图；
4. 截图后再读一次门禁和几何，有变化就丢弃这个样本。

**不会出现的情况**
- 不缩放图片，也不把基线裁小。
- 尺寸不一致时，`compareAligned` 仍然会抛错，没有吞掉。

**门禁条件是真实 UI 状态**
- 在 `ea32d48` 产品中，保存和撤回按钮只在 busy、未加载完成或 `writeBlocked`（未同步、未连接或持有作品锁）时禁用，与撤回历史是否为空无关。
- 所以"两个按钮都可用"确实等于"没有在写、已同步"，不依赖测试执行顺序。

### 1.4 原有断言是否保留

| 用例 | 结论 |
|---|---|
| 01 | 写入后仍然校验 GET 配置值；之后的相机 PUT、面板读到作品配置、预览与 Studio 两侧原阈值 `ALIGNED`/`NORMALIZED` 一致性断言都没变。这部分比较仍用原 `captureCanvases`，同一次截两侧，不存在前后窗口不同的问题。 |
| 02 | 配置值、落盘与 GET 一致、`__m1bIdentity` 不变（没有整页刷新，即 HMR）、diff 路径和新值、`<10s` 延迟断言都保留。 |
| 03 | 写入后的配置值；撤回后 GET 和文件都与原始一致；画面差异恢复到 `< 0.002`；撤回接口返回 200。 |
| 06 | 采用流程的断言没变；收尾逻辑见 §1.5。 |

- `tests/e2e/m1a/visual.ts`（阈值和比较算法）没有改。
- 没有增加 retry、skip，也没有固定 sleep。只把截基线前的滚动归零等待改成了 `resetEditorScroll(page, 0)`，并由几何门禁兜底。

### 1.5 错误通道和按原状清理

**`runPairChange` 和 `captureReadyBaseline` 的错误处理**
- 主错误与写证据的错误分开收集：只有一个就原样抛出，多个就用 `AggregateError`。
- 成功和失败都会写证据，`finally` 里会停止请求观察。

**06-adopt 的收尾**
- 测试前记录 glb、parts、provenance sidecar 是否存在以及原始字节。
- `finally` 里逐项恢复：原来存在就按原字节写回，原来不存在就删掉；再用 `Buffer.equals` 和文件是否存在来校验。
- 配置文件用 `restoreSceneFile().matches` 校验。
- 每一步都单独 try/catch，主错误排在前面，其余收尾错误一起汇总。
- 不删除历史文件。

### 1.6 会不会误绿

- **写入或撤回的请求失败**：直接判红。
- **样本属于同步过渡期**：门禁和几何都不满足，这个样本不会被采用。
- **截图过程中布局变了**：截图后的复核会丢弃这个样本。
- **画面只是短暂符合阈值**：
  - `increase` 模式要求差异大于阈值；`decrease` 模式要求与基线差异小于 0.002。
  - 之后还有配置和落盘断言做双重核对。
  - 只有在门禁就绪时采到的、确实满足阈值的画面才会被接受；接受的是"同步完成后的真实画面"，不是巧合。

**结论：没有发现误绿路径。** 剩下的风险都是可能误红，例如几何完全相等的要求在浮点或布局抖动下可能过严。这类问题会让测试失败，不会让测试假通过。

## 2. 运行证据核对（`job_3cb0021d`，只读）

**总体**
- `results.json`：expected 23、unexpected 0、skipped 0、flaky 0，errors 为 0。
- `cleanup.json`：head `4d34bce`，锁 `67af36b7…18960`，身份稳定（identityStable 为 true），结束时没有端口在监听，也没有自有的 node 或 chrome 进程。

**8 份新增 JSON 的归档**
- 已从固定 artifact 目录搬到 run 内的 `fixed-additions/`。我按 `fixed-additions-mapping.json` 逐个重算 SHA256：**8/8 与映射一致，字节数一致**；固定目录里的副本已经不存在（`problems=[]`）。

**四个操作**

| 操作 | HTTP | 请求发出 / 完成（距点击前） | 达成耗时 | 差异比 | 采样过程 |
|---|---|---|---|---|---|
| 01 保存 | 200 | +29 / +74ms | 1242ms | 0.0833 | 4 次：341,341,341 → 378 |
| 02 保存 | 200 | +22 / +69ms | 1200ms | 0.0819 | 7 次：341×6 → 378 |
| 03 保存 | 200 | +29 / +78ms | 1240ms | 0.1009 | 7 次：341×6 → 378 |
| 03 撤回 | 200 | +22 / +61ms | 1253ms | 0 | 6 次：341×5 → 378 |

- 所有被拒绝的样本，原因都是"同步/写回尚未就绪"。
- 被采用的样本：截图前后的门禁都就绪，没有提示，backing 与基线一致，可见高度与基线相同（378）。
- 三份基线 JSON：截图前后可见高度都是 378，没有提示，`previewState=ready`，`errors=[]`。
- 06：`sceneRestored=true`、`sidecarBytesMatch=true`；原来不存在 sidecar，结束后也不存在；`errors=[]`。

**这些证据说明了什么**
- 本轮直接证明：写入后约 1.2 秒内，同步提示会让预览公共可见高度暂时变为 341，随后自然恢复到 378，测试只在恢复后采样。
- 这是本轮新采集的时序，**不能倒推到旧 full 轮**，旧轮没有这类采样记录。
- 真实的 Windows 控制台 Ctrl+C、真实服务、真人 A/B 和彩排都不在本轮范围内。

## 3. 建议（只记录，不实现）

- **N1（06 去掉了一条绝对断言）**：旧的收尾断言 `readFileSync(SCENE_CONFIG).toContain('diffuser-4969889')` 改成了"与快照一致"（`restoreSceneFile().matches`）。如果快照本身已经被前一个用例弄脏，只校验与快照一致就发现不了。目前 runner 在结束时会核对模板字节（identityStable 为 true），可以兜住这个缺口。以后需要的话，可以把这条绝对断言加回来。
- **N2（门禁依赖保存按钮可用）**：保存按钮在 `fieldset disabled={…compare…}` 里面。如果以后在对照模式下调用 `runPairChange` 或 `captureReadyBaseline`，门禁永远不会就绪，结果只会是误红，不会误绿。现有调用都不在对照模式下。
- **N3（只截预览窗口，样本数有限）**：`captureWithWindow` 也会截 Studio 一侧，但前后变化只比较预览。这和旧版行为一致，不是缺陷。另外，本轮四个操作每个只有一次运行样本，修复对时序抖动有多稳，还需要在完整回归中继续观察。
