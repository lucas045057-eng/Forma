# M3-C 场景视口 CSS 回归修复 · 独立只读复审（Claude Code）

- 日期：2026-11-15。复审人：Claude Code（独立审查，不实现、不合并、不替代 Pi 验收）。
- 对象：`.worktrees/m3c`，分支 `feat/m3c-approval`，冻结 HEAD **`393fe9f98c64822593591301518e246df8aa45e2`**。复审前后核对：HEAD 不变，tracked 干净，仅 `fallback/` 未跟踪（未触碰）。主线仍为 `11e74c9`（先前合入 `0860fbb`），本复审未改主线，也没有碰 Pi 的 `.worktrees/m3c-acceptance`。
- 依据：根 `orbital/PROJECT_STATE.md`、`orbital/instructions/project_goals.md`、`docs/design/M3-C-plan.md`、既有 `docs/reports/M3-C-review.md`（未修改），以及 worktree 内 `docs/reports/M3-C-impl.md` 第 363 行起的本批说明。
- 未读 `.env`、ASKS 或任何凭据；没有调用付费模型或 Lux3D；没有运行 agent CLI；没有启动服务、浏览器或测试，也没有重跑 M1-B 23 例或全仓单测。

## 证据类别

| 标记 | 含义 |
|---|---|
| **【代码核查】** | 我读冻结源码与 diff 得出的结论。 |
| **【本人只读核对】** | 我对冻结 HEAD 和归档原件做的只读计算（git diff/rev-parse、文件 SHA256、解析 RED/GREEN `results.json`、读取像素诊断 JSON）。没有执行任何被测代码。 |
| **【引用实现证据】** | CodeBuddy 的作业结果（`job_72b0a612` RED、`job_8b19c345` GREEN）与报告叙述。我只核对了原件与叙述一致，没有重跑。 |

## 结论

**blocker 0，should-fix 0，建议 4 条。** 这一行 CSS 修复的因果链成立，作用域限定在场景编辑模式，原有的保护和门禁一行未动。在下列“进入正式验收的条件”满足后，可以合并冻结并交 Pi 做正式验收。**本复审不是 M3-C 验收结论。**

`job_e6488103`（固定 HEAD 上的 Studio typecheck → build）**已返回且通过**（【引用已返回验证】，见文末“补充”）。我没有重跑它。

---

## 1. 受测身份与改动范围【本人只读核对】

- `git diff 0860fbb 393fe9f -- tests playwright.config.ts playwright.m1b.config.ts package.json pnpm-lock.yaml apps packages templates`：**只有 `apps/studio/src/scene-editor.css` 一处、新增 1 行**（第 2 行 `.workspace.scene-editing > .inspector { padding: 0; border: 0; }`）。测试、阈值、Playwright 配置、依赖和锁文件均为零差异。
- 当前 CSS 的 SHA256 是 `18f9e413956f6b332067a62d7cede878e93e7afe1ebd9856ce50bd9eb346b8eb`，与报告里 GREEN 实际受测的 CSS 字节一致。
- `HEAD:apps` 为 `8df06a9b…`，`0860fbb:apps` 为 `66e7ec77…`。两者不同正是这一行 CSS 造成的，符合报告所说“GREEN 运行身份 = `0860fbb` + 未提交 CSS 草稿”。本 HEAD 上**没有**重新执行过 23 例，报告也没有这样声称。
- 解析归档的 `red/results.json` 与 `green/results.json`，逐条检查四个条件：`expectedStatus='passed'`、`test.status='expected'`、恰好一个 result、`status='passed'` 且 `retry=0`。
  - RED：共 23 例，统计为 expected 18 / unexpected 5 / skipped 0 / flaky 0。不满足条件的 5 例正是三个一致性用例、关键帧用例、R2 出厂模型用例。
  - GREEN：共 23 例，expected 23 / unexpected 0 / skipped 0 / flaky 0，顶层 errors 为空，**23 例全部满足四个条件**。耗时 108839.961 ms。

## 2. 因果证据【本人只读核对 + 代码核查】

- 像素诊断原件 `diagnosis/m1b-clipping-evidence.json`：画布左上角 (1020,304)，边长 378；第 372–375 列整列 378 行都是画布背景色 (239,232,220)；**第 376 列整列为 (52,66,77)，第 377 列整列为 (23,35,45)**。两列贯穿全高，预测差异率与实测都等于 2/378 = 0.005291005291，与 RED 三例 `changedRatio` 完全吻合。
- 几何推算：在 1440 宽的测试视口下，`.workspace` 左右 padding 各 20，第二列为 `minmax(360px,440px)`，取到 440。
  - 修前：inspector 的 border 1 + padding 22 加上 SceneEditor 的 border 1 + padding 16，内容宽只剩 440 − 46 − 34 = **360px**，比 378px 的对照画布窄 18px。SceneEditor 是 `overflow:auto`，会在 padding 边裁剪；其 16px 右 padding 吸收了 16px 溢出，**剩 2px 被裁**，与诊断恰好一致。
  - 修后：内容宽为 440 − 34 = **406px ≥ 378px**，不再裁剪。这与 M3-C 之前、SceneEditor 单独占这一列时的内宽相同，等于恢复了 M1 时期的几何。
- 轮廓算法以背景色找包围盒，两列贯穿全高的非背景色会让测得的模型高度固定为 378、minY 固定为 0，于是关键帧和开盖位移被量成 0。GREEN 中这两项分别恢复为 11px（期望 12.0327px）和 32px（期望 32.16px），fake 模型仍为 0，与报告一致（GREEN 指标属【引用实现证据】，原件 JSON 在归档中）。
- 相机回调和草稿保护（dirty）的假说没有证据，代码也没有因此改动。我认同这一处理。

## 3. CSS 作用域与布局边界【代码核查】

- 选择器 `.workspace.scene-editing > .inspector` 只在 `showScene` 为真时命中（`App.tsx:198` 给 workspace 加 `scene-editing` 类；`App.tsx:206` 的 `<aside className="inspector">` 是它的直接子元素）。任务、选取、候选对比、影响位置等非场景模式，仍用 `style.css:15` 原样式（padding 22、border），不受影响。
- 特异性 (0,3,0) 高于 `.inspector`（0,1,0）和 `@media (max-width:900px) .inspector { padding:14px }`（`style.css:74`），所以窄屏下的场景模式也同样去掉 padding。这是预期效果，不会出现窄屏重新裁剪的反转。
- 场景模式下 inspector 里还有：SceneEditor（自带背景、边框、padding、`overflow:auto`，`scene-editor.css:3`）；`hidden={showScene}` 的选取/指着说区块（`App.tsx:208`）；以及始终渲染的 `ApprovalPanel`（`App.tsx:220`）。inspector 自身的 `overflow:auto`、背景和圆角保留，只去掉了 padding 和 border。

## 4. 原保护与门禁是否被删【本人只读核对 + 代码核查】

产品 diff 只有上述一行 CSS。以下内容均未改动：
- `SceneEditor.tsx` 的姿态、scrollAt、相机回调、对照模式和尺寸匹配；
- `SceneDraftGuard` 未保存草稿保护；
- 请示、检查、采用门禁（前端面板与后端）；
- 模板、后端、依赖、锁文件；
- 原 E2E 用例、阈值、skip/retry 配置。

`App.tsx:218` 在场景模式下仍以 `blocked={... || showScene}` 阻止“指着说”提交，审批面板也照常渲染。

---

## 建议（suggestion，非阻断）

1. **场景模式下审批面板失去水平内边距**。`ApprovalPanel` 在场景模式下仍渲染在 inspector 里（`App.tsx:220`），而 `.approval-panel`、`.approval-card` 只有上下 padding（`style.css:66-67`）。inspector 的 padding 归零后，场景编辑期间若有请示卡，卡片文字和按钮会紧贴面板左右边缘，属于纯视觉问题，不影响功能与测试。建议加作用域规则，例如 `.workspace.scene-editing > .inspector > .approval-panel { padding: 0 16px 16px; }`，与 SceneEditor 内边距对齐。演示重视观感，建议在 M4 打磨前处理。
2. **对照画布超过 406px 时仍会被裁**。修复恢复的是 M1 时期 440 宽列的几何：对照画布 ≤ 406px 时不裁。若在更宽的屏幕上“匹配作品画布尺寸”得到的宽度大于 406px（`App.tsx:165` 的 `previewSize`），或手动设置了较大的 `scene-size`（`SceneEditor.tsx:168` 允许到 1600），画布仍会被 SceneEditor 的 `overflow:auto` 裁剪或出现滚动条。这是 M1 起就存在的限制，不是本批引入的回归，且 M1-B 测试固定在 1440 视口。建议对照模式下画布宽度超过可用宽度时给出提示或改为缩放，避免现场演示时出现同类“差几像素”的误判。
3. **报告用词的小更正**。第 376 列的颜色 (52,66,77) = `#34424d`，是 **SceneEditor 自身的边框**（`scene-editor.css:3`），不是外层 inspector 的边框（`#2c3c48`，即 (44,60,72)，`style.css:15`）。第 377 列 (23,35,45) = `#17232d`，是 inspector 的 padding 区背景。机制结论不受影响：外层 inspector 的 padding 和 border 挤窄了 SceneEditor，使画布溢出其 padding 盒。仅建议 `M3-C-impl.md` 第 367 行附近的表述按此更正，便于日后排查。
4. **可选的回归护栏**。这次 2px 裁剪是靠像素阈值间接暴露的。可以考虑由 Pi 在 M1-B 对照用例前加一个直接的布局断言：对照画布的 `getBoundingClientRect()` 必须完全落在 SceneEditor 的 padding 盒之内。这样同类问题会直接报“画布被容器裁剪”，而不是表现成姿态或开盖位移为 0。不改原断言和阈值，是否采纳由测试方决定。

## 进入正式验收的条件

1. ~~`job_e6488103` 实际 exit 0~~ **已满足**（【引用已返回验证】，见文末“补充”）。
2. Codex 按流程合并并冻结，合并后的产品树与 `393fe9f:apps` 一致。
3. Pi 在合并冻结的 HEAD 上执行 12 步 174 例正式回归，其中原 M1-B 23 例必须在**该冻结 HEAD** 上重新实际通过（GREEN 跑在“`0860fbb` + 草稿”上，不能替代）。M3-C 是否过关以 Pi 的正式结论为准。

建议 1–4 都不阻断进入正式验收。

---

## 补充（2026-11-15）：固定提交上的 typecheck/build 已返回【引用已返回验证 + 本人只读核对】

- 来源：主线归档 `docs/reports/artifacts/M3-C/viewport-css-fixed-commit-check-20261115/`（Codex 归档；原件同时保留在 `.worktrees/m3c/.data/css-commit-check-2026-11-15T02-39-05.336Z/`）。
- 我只读核对了其中的原始文件，**没有重跑任何命令**：
  - `manifest.json` 两个步骤 `pnpm --filter @spatial/studio typecheck`、`pnpm --filter @spatial/studio build` 均为 `exit: 0`、`signal: null`、`identityUnchanged: true`。各步前后都是 HEAD `393fe9f98c64822593591301518e246df8aa45e2`，`trackedStatus` 为空，CSS SHA256 为 `18f9e413956f6b332067a62d7cede878e93e7afe1ebd9856ce50bd9eb346b8eb`；整轮 `identityUnchanged: true`。
  - `launcher/exit` 内容为 `0 0`；`build.log` 末尾为 `✓ built in 5.65s`；`typecheck.log` 为 `tsc` 正常结束。
  - 构建输出里有一个超过 500 kB 的 chunk 体积警告（`scene-config-*.js` 约 1.0 MB），这是既有的 Three 分包警告，不影响结论。
- 这组只是 Studio 的窄检查，**不是正式 M3-C 验收**；原 M1-B 23 例的 GREEN 也不是。

**最终结论不变：blocker 0，should-fix 0，建议 4 条（不阻断）。** 进入正式验收的第 1 个条件已满足。剩下两步：Codex 合并冻结（合并后的产品树应与 `393fe9f:apps` 一致）；Pi 在冻结 HEAD 上执行 12 步 174 例正式回归，其中原 M1-B 23 例必须在该 HEAD 上重新实际通过。M3-C 是否过关以 Pi 的正式结论为准。
