# M4 统一返工二 · 有限差异只读复审（Claude Code）

- 日期：2026-11-15。审查人：Claude Code（独立只读审查，不实现、不提交、不合并，也不派实现者）。
- 审查对象：`.worktrees/m4`，分支 `feat/m4-demo`。
  - HEAD **`1aa54500ebab4efd5cd457b94c145e71880990df`**，审查开始和结束时各核对一次，tracked 干净，只有未跟踪的 `fallback/`。
  - 对比基线是 `01c85fe`。
- 范围：`git diff 01c85fe..1aa5450`，恰好 6 个文件（+81/−10）：
  - `apps/server/src/assets/process-worker.ts`
  - `apps/studio/src/speech-app.browser.test.ts`
  - `scripts/demo/body.test.mjs`
  - `docs/demo/runbook.md`
  - `docs/design/M4-plan.md`
  - `docs/reports/M4-rework-2-impl.md`
- 已阅读：根目录的 `orbital/coordination/m4/unified-rework-2.md`、我上一轮的 `docs/reports/M4-rework-1-review.md`（原文未改）、实现报告 `M4-rework-2-impl.md` 全文。
- 只读边界：没有运行 typecheck、build、测试、浏览器、服务或探针；没有读 `.env`、ASKS 或凭据；没有发出任何真实请求；没有改动实现树。
- **运行事实**：
  - 上一轮集中 `job_9415a4a3` 在 typecheck 就失败了（TS1375，Pi 已归档为 `d8e6cc6`），**0 个测试被执行**；
  - 本批新字节也完全没有运行过，193 只是收集到的用例数；
  - 本复审只是代码层面的判断，不能当作运行通过。

## 结论

**blocker 0，should-fix 0，建议 3 条。** 6 个文件的改动都在任务卡范围内，没有删减任何门禁或断言，语义和上一轮一致。TS1375 的修正**从静态看是充分的**，但必须由 Pi 实际跑一遍 typecheck 才能确认。

### 自我更正

上一轮我在 `M4-rework-1-review.md` 中把 F5 判为“代码层关闭”，却**漏看了**一个问题：`process-worker.ts` 去掉静态 `import` 之后，文件不再是模块，而它仍然使用顶层 `await`，因此触发 TS1375。这说明“代码层关闭”的判断不能代替真实编译。今后凡是删除文件的最后一个静态 `import` 或 `export`，我都会核对它是否依赖模块语义。原报告保持原文不改，以本条为准。

---

## 逐项核对【代码核查】

### 1. TS1375 修正（`process-worker.ts`）
- 第 1 行新增 `export {};`。
- 相关配置【本人只读核对】：
  - `apps/server/package.json` 的 `"type":"module"`；
  - 根 `tsconfig.json` 为 `module: ESNext`、`target: ES2022`，没有设置 `moduleDetection: force`。

  有了显式导出，TS 就把这个文件当作模块，顶层 `await` 合法，可以消除 TS1375。运行时 Node 的类型剥离会原样保留 `export {}`，ESM 语义不变。
- 执行顺序没有回退，依次是：
  1. 注册 `disconnect`（`:4`）；
  2. 检查启动时是否已失联（`:5`）；
  3. 校验参数（`:8-9`）；
  4. 动态 `import('./process-model.ts')`（`:10`）。

  动态导入用的是字符串字面量，`build` 脚本的 `--rewriteRelativeImportExtensions` 会改写它的扩展名。没有 `ts-ignore`，也没有 `any`。
- **同类问题扫描**【本人只读核对】：我逐个检查了 `apps/` 与 `packages/` 下所有被跟踪的 `.ts` 和 `.tsx` 文件，**每个文件都至少有一行静态 import 或 export**，没有第二个“脚本态顶层 await”的候选。这只是静态扫描。上一轮 Studio 的 typecheck（8 个项目中的第 8 个）**从未执行**，Studio 侧的其它类型错误只能靠 Pi 实际运行暴露。

### 2. 真实 App 的父窗口 blur 证据（`speech-app.browser.test.ts`）
- 用 `page.addInitScript` 在父页面挂一个原生 `blur` 计数器。点 B 之前记录基线，点击后用 `expect.poll` 断言计数增加。原有的 pending、review 保留、确认按钮禁用、WS 重连、明确确认 B、成功提交后输入新文字等断言**一条都没删**。
- 计数逻辑正确：
  - 点 A 后焦点在 iframe 里；
  - 随后在父页面按下录音按钮，焦点回到父文档；
  - 再点 B，父窗口会再次触发 blur。
- 计数器只在事件发生时才读取 `window.__speechTest`，所以和 `context.addInitScript(installSpeechFakes)` 谁先执行都没有关系（Playwright 不保证二者顺序）。
- 如果无头 Chromium 不触发父窗口 blur，这条用例会**变红**，不会假绿。组件用例里同样的断言也会一起暴露这个问题。

### 3. watchdog 测试（`body.test.mjs:76-84`）
- 现在从 orphan 出发，按“父 PID + 子进程创建时间不早于父进程”做广度遍历，找出**全部**后代。
- 四个 role 各要求**恰好一个**命中：命令行中必须同时包含本次的入口路径和对应的 role 参数。
- **所有**发现的后代（包括可能出现的 conhost）都要按 PID 加创建时间确认已退出；无关进程必须存活；`orphan-cleanup` 的 `errors` 为空。这些断言都还在。
- 结论：消除了“总数恰好为 4”造成的假红，同时没有放宽回收断言。

### 4. 联接点清理（`body.test.mjs:33-42`）
- 先核对链接路径确实是本夹具的 `.data`，两个根目录的 realpath 没有被替换，`lstat` 确认是链接，且它的 realpath 指向本夹具的 outside 目录。全部通过后才 `unlink`。
- 任何一步失败都抛出 AggregateError，并**保留现场**，不会递归删除链接的目标；只有成功删掉链接后，才清理普通目录。逻辑正确。

### 5. runbook 与设计文档
- `runbook.md` 现在写明：
  - mock 守卫只覆盖 backend 和 frontends 两个主进程；
  - 两条回收限制：中间父进程先死时会漏遍历；正常 Ctrl+C 45 秒后强杀，不会先触发子进程的 watchdog；
  - 资产父死测试使用的是夹具，没有经过生产的启动接线，而且只能在 Windows 上跑；
  - 保存失败时持锁、记为 `cleanup_failed` 的处理办法。

  内容与上一轮复审建议 1、4、5、7、8 一致，没有夸大。
- `M4-plan.md` 写清了：成功提交后输入框里保留的文字是普通草稿，再次提交时仍受当前选择、版本和同步门禁控制；提交失败或结果未知时，语音绑定的保守保护不变（建议 6）。
- 上一轮的 9 条建议，实现报告逐条给出了处置（处理、保留为限制、或待运行确认），与本次 diff 一致，没有扩大范围。

---

## 建议（suggestion，非阻断）

1. **realpath 比较可能误报失败**（`body.test.mjs:35`）：如果 `TEMP` 用的是 8.3 短路径（如 `ADMINI~1`），或者盘符大小写与 realpath 返回的不同，`realpath(root)===resolve(root)` 会不成立，清理按“保留现场”报错，测试显示为失败（假红，不会假绿）。如果 Pi 遇到这种情况，可以在比较前先对 `mkdtemp` 的返回值做一次 `realpath`，作为基准。
2. **role 匹配依赖命令行格式**（`body.test.mjs:80`）：`rolePart` 按空白拆分命令行。如果临时目录路径里含空格，入口路径会被拆开，但 `includes(entry)` 是对整行判断的，role 参数本身也不含空格，所以目前没问题。将来改动夹具路径时要留意。
3. **TS 模块判定可以更省心**（可选）：在根 `tsconfig` 中设置 `"moduleDetection": "force"`，所有文件都会被当作模块，同类 TS1375 不会再出现。这会影响全仓，本轮不必改，可以留待以后统一考虑。

## 需要 Pi 用运行结果证明的边界（本批一项都未执行）

1. `pnpm -r typecheck`：8 个项目全部完成，包括**首次实际执行**的 Studio；B1（Buffer）和 TS1375 都不再出现。之后依次是 build、全量单测、`node --test scripts/demo/safety.test.mjs`（含 body）、M4 19 例、旧 174 例（含 M1-B 23 例，按原像素阈值）。
2. 真实 App 用例中，点 B 后父窗口 blur 计数实际增加，并且 pending、重连期间 review 都保留。
3. watchdog 用例中，四个 role 都识别到，全部后代（含 conhost）退出，无关进程存活。联接点清理没有误报失败。
4. 上一轮复审中仍然有效的真实拓扑负例：
   - 候选 HMR 连到 `plan.ports.preview`，5175 被占用时不串到别的实例；
   - 真实模板 iframe 点选 B，以及 SSE 重连期间 review 保留；
   - 语音提交后输入新文字可以直接生成；
   - 真实 demo 硬杀启动器后整条进程链回收（含真实 split GLB 处理中硬杀 backend、staging 被清理）；
   - Windows 真实 Ctrl+C 后为 `stopped` 且全部 `forced:false`。
5. 外部条件仍单列为“未执行”：真实阿里识别、真人 A/B、三次完整彩排。

**本复审不是 M4 验收结论。两方结果齐备后由 Codex 统一决定，不为上述建议单独开一轮。**
