# Lux3D 增量：自动化验收归属与候选整合结论

本文件记录 Lux3D 增量在候选整合树上的**源码整合事实**与**既有自动化结果的归属**，不新增运行、不改变任何原始证据。候选树只做 Git 合并与文档/配置收尾；合并后的 HEAD 没有重新安装、构建或跑测试。

## 1. 身份

| 对象 | 提交 |
| --- | --- |
| 产品实现 | `037eda164ed307b118bb1933231dde327f6e606b` |
| 验收测试（current46 / Studio152 / package77） | `273a349d0d3d7818d4cb3d17bc85877354d0b5dc` |
| legacy 测试（42 例） | `7f64b25af4469d521306cdcd76107186a27d4f46`（相对 `273a349d` 只改 `tests/e2e/m1b/env.ts`，+3/−1） |
| 设计文档 | `439d0fd2c577542f37e154f576b10166924632ab` 中的 `docs/design/Lux3D-workbench-increment.md`、`docs/design/Lux3D-workbench-implementation.md` |
| 候选分支 | `integration/lux3d-final`（工作树 `.worktrees/m4-final`） |
| 合并提交 | `63e435e`，`--no-ff`，父 `439d0fd`（主线文档）与 `7f64b25a`（增量源码+测试） |

未推送、未改主工作区、未生成发行包。

## 2. 自动化结果与归属

| 门禁 | 运行 | 受测身份 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 当前 46 例（Lux3D 验收，8 spec） | `job_aef5ec6c` | 产品 `037eda1` / 测试 `273a349d`，本地隔离树 | **46/46**，0 skip/flaky/retry；schema/build/smoke/occlusion 全通过 | run 清单 `a48717a1…`；88 项产物 + 6 份模块检查文件 SHA 0 差异；Root 记录 `root-current46-green-aef5ec6c.json`（`c75b064b…`） |
| 旧 42 例（M1-B 23 + M4 mock 19） | `job_5ba702ed` | 产品 `037eda1` / 测试 `7f64b25a` | **23/23 + 19/19**，0 skip/flaky/retry | control manifest `58b45ac4…`（36 项 SHA）、e2e manifest `e25c41a5…`（115 项 SHA），均 0 mismatch；Root 记录 `root-legacy42-green-5ba702ed.json`（`2806d596…`） |
| Studio 类型检查/构建 + 152 单测 + 受影响 9 例 | `job_90503ec8` | 产品 `037eda1` / 测试 `273a349d` | typecheck/build 0；21 文件 **152/152**；9 例 E2E 单 result 全过 | manifest `76c55c19…`；29 项载荷 0 mismatch；输入身份 `3a8da5b8…` |
| server 482 单测 + safety | `job_5463da39` | 产品 `f909` / 测试 `b3d` | **482/482**（61 文件）+ safety 通过 | manifest `2f2c80a9…`；本轮按字节不变继承 |
| package 77 单测 | `job_0e08bf18` | 产品 `037eda1` / 测试 `273a349d` | **77/77**（5 文件：shared 71 + scene-renderer 5 + bridge 1） | manifest `587a6768…`；入口 `8ae05f0b…`；92 项载荷 0 mismatch；输入摘要 `c1a22782…` |
| 历史 46/46 | `job_5463da39` | 产品 `f909` / 测试 `b3d` | 历史全绿 | **不是**当前 46；不得标成“当前 46/49” |

`current9` 指 `job_90503ec8` 中的 9 例受影响 E2E（browser 5 + placement-native 4），不是 46/49 的子集改名。

## 3. 字节继承原则

一条结果只属于它实际运行的 HEAD。可以继承的前提是**产品字节可证相同**，而不是“看起来没改”：

- 本候选树产品对 `037eda1` 的 diff 为 **0**：
  `git diff 037eda164ed307b118bb1933231dde327f6e606b HEAD -- apps packages templates scripts package.json pnpm-lock.yaml tsconfig.json` 无输出。
- `7f64b25a` 相对 `273a349d` 只改 `tests/e2e/m1b/env.ts`（+3/−1），这是 legacy 42 例的受测测试身份，不倒推为产品变化。
- `f909` → `037eda1` 只改 4 个 Studio 文件（`App.tsx`、`Lux3DWorkbench.tsx`、`drag-session.ts`、`drag-session.test.ts`），server 字节未变，因此 server 482 与 safety 可按字节继承；这 4 个文件恰好是 Studio 152 与受影响 9 例在 `037eda1` 上新跑的原因。
- 设计文档与主线 `439d0fd` 一致：`git diff 439d0fd HEAD -- docs/design` 为空。
- Lux3D 用例与 `273a349d` 一致：`git diff 273a349d HEAD -- tests/e2e/lux3d playwright.lux3d.config.ts` 为空。

禁止的做法：把旧 46 当成本轮结果、把 mock 说成真实云、用 skip/放宽断言换取绿色、或把未跑过的 HEAD 标成已验证。原始 run、清单与 JSON 均未改写。

## 4. 测试发现边界

- 默认 `playwright.config.ts` 的 `testIgnore` 增加了 `**/lux3d/**`。默认脚本的服务栈不提供 Lux3D 依赖（Lux3D base、fake provider、placement 会话），若不排除会把 49 例用错误服务栈收集进来。
- Lux3D 的 49 例（含 pointer 3 例）只由 `playwright.lux3d.config.ts` 与其 runner 执行；本增量未删除任何 spec、未 skip 任何用例、未改断言或超时。
- 该改动只影响默认收集范围，不改变任何既有配置的用例集合或结果。

## 5. 合并事实

- 合并方式：`git merge --no-ff 7f64b25a`，未 fast-forward，保留主线两篇更新版设计文档。
- 冲突：0；两侧改动文件无交集（主线只有 `docs/design/Lux3D-workbench-*.md`，增量只有源码/测试/报告）。
- 合并带入的 `docs/reports/Lux3D-*.md` 是增量分支自身的历史报告，属于该分支内容，不是本轮新造的归档；本轮没有添加任何测试产物或 JSON。
- 本报告与 runbook/config 改动位于合并提交之后的独立收尾提交，只含 3 个文件。

## 6. 覆盖边界（仍未验证）

- **真实 Lux3D 云端 10 类**：未执行；自动化只覆盖 loopback fake，mock 通过不等于云端通过。
- **OS 原生拖拽 3 例**（baseline / 滚动 / DPR2）：0/3，桌面控制通道未打通，`nativePass` 保持 null。
- **真人 A/B 与完整彩排**：未执行；runbook 已补新链路步骤与核对项，但没有任何真人观察记录。
- **Windows 真实控制台 Ctrl+C**：未验证；进程内 SIGINT 模拟与 fixture 断链不能替代。
- **合并后 HEAD 的重新验证**：本轮没有在 `63e435e` 上安装、构建、跑测试；按计划由 Root 只跑受影响的 test-discovery，不重跑已通过的整套。

以上任何一项都不能由本文或上面的既有结果外推。

## 7. 结论

候选树完成了“产品源码 + 增量测试 + 最新设计文档”的 Git 级整合，且产品字节与 `037eda1` 完全一致；两组自动化门禁（当前 46/46，旧 42/42）都有明确 HEAD 归属与 SHA 记录。这不构成发行或演示验收：真实云、原生拖拽、真人彩排、Ctrl+C 仍未闭环，发行包与主分支落地由 Root 后续决定。
