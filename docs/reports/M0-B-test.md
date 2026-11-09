# M0-B 点选 → 源码定位 · Pi 测试报告

- 日期：2026-11-09
- 被测版本：M0-B 实现交付 `92fc0ea`；最后一次全量运行在 `d6bd268`（并行 M0-A 接入）之后的树上，M0-B 相关源文件（`apps/studio/src`、`templates/`、`packages/bridge`、`packages/shared`）在运行前后哈希一致。连续三次全量运行全部通过。
- 测试代码：`tests/e2e/`（`lib.ts` 工具、`source-model.ts` AST oracle、`checks.ts` 判定逻辑、4 个 spec）、根级 `playwright.config.ts`、根 `package.json` 的 `test:e2e` / `test:e2e:headed` 脚本；`packages/vite-plugin-source-tag/src/reserved-jsx-r2.test.ts`（R2 插件层回归，只新增测试文件）
- 未修改 `apps/`、`packages/`、`templates/` 的任何实现代码

## 结论

**首轮（验收 7 项）：过关。** 用例 1 的 20 个随机元素全部定位正确；用例 2–7 全部通过。未发现实现缺陷。有 3 条非阻塞观察（见文末），都属于实现方已声明的已知限制。

**整改回合 1（按 Codex 审查 R1/R2/R3/S4 补测试）：新增 11 个 e2e 用例全部工作正常 —— 19 项通过、2 项按预期失败（R1 待修）、0 项意外失败；插件层 9 项中 7 项通过、2 项按预期失败（R2 待修）。M0-B 最终过关仍等 CodeBuddy 修完 R1/R2。** 详情见文末“整改回合 1”。

**整改回合 2（fix/m0b-review 合并后回归）：全部通过 —— 单元 30 项、M0-B e2e 24 项、M0-A e2e 22 项，共 76 项，** 0 失败、0 预期失败、0 跳过。R1/R2 的“预期失败”标记已删除并转为永久回归；新增右键/双击/Space 激活、悬停与滚动不被误伤、S3 组件名归属用例。详情见文末“整改回合 2”。

**整改回合 3（Codex 复核后）：S3 的修法带出一项应修 N1（`memo` 具名默认导出、`as`/`satisfies` 包装的组件 cid 退化为 Anonymous）——已用 3 条 `it.fails` 预写回归；同时更正了变异 C 的列号偏移（原实现实际偏两列）。当前单元 35 项中 3 项按预期失败，其余全过。M0-B 仍待 N1 修复 + Codex 复核。** 详情见文末“整改回合 3”。

## 环境与命令

| 项 | 值 |
| --- | --- |
| Node / pnpm | v24.14.1 / 11.17.0 |
| Playwright | @playwright/test 1.65.0，Chromium 158.0.8127.18（headless shell） |
| 浏览器视口 | 1440×900，单 worker，无重试 |
| 服务 | 由 Playwright `webServer` 自动执行 `pnpm dev` 启动；测试结束后 5173/5174/3001 均已释放 |

```powershell
pnpm install
$env:PLAYWRIGHT_BROWSERS_PATH="C:\Users\Admin\AppData\Local\ms-playwright"  # 见下
pnpm test:e2e
```

两点环境注意（都不是被测代码的问题）：

1. 本机 Orbital 把 `PLAYWRIGHT_BROWSERS_PATH` 指向 `C:\Users\Admin\AppData\Roaming\Orbital\browsers`，而浏览器实际装在 `%LOCALAPPDATA%\ms-playwright`。所以本次运行前显式设置了该变量；若不想每次设置，执行 `pnpm exec playwright install chromium` 装到 Orbital 目录即可。
2. 运行期间另一个并行任务（M0-A）正在改 `pnpm-workspace.yaml` / 装依赖，一度让 `pnpm` 无法解析 workspace 配置。为此 `playwright.config.ts` 提供逃生口 `E2E_DIRECT_WEBSERVER=1`：直接用 `node node_modules/vite/bin/vite.js` 起两个 Vite 开发服务，绕开 pnpm。**最终验收用的是默认路径 `pnpm dev`**，未使用该逃生口。

## 随机抽样

- 种子：**20261109**
- 算法：`mulberry32(seed)` + Fisher–Yates 洗牌，候选集是预览页 DOM 顺序的全部 46 个带 `data-src` 的元素，取前 20 个
- 抽样与逐条结果：`docs/reports/artifacts/M0-B/case1-random-sample.json`（含每个元素的期望 `src`、实际 `Selection.src`、源文件该行列的字符与标签名）

## 用例结果

| # | 用例 | 结果 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 随机 20 个 `data-src` 元素，点选后 `src` 的 文件:行:列 指向该元素 JSX 开标签 `<`，标签名一致 | **通过（20/20）** | `case1-random-sample.json`；46 个候选元素 |
| 2 | 选取模式下点击不触发原行为；退出选取后恢复 | **通过** | `data-purchases` 保持 `0`、页面反馈为空；退出后点击变 `1` 且显示“已加入购物袋” |
| 3 | 共享 Button 的 `instances` 等于页面实例数（≥3），高亮框数量一致 | **通过** | `src/components/Button.tsx:5:5`，DOM 3 处 / `instances=3` / 高亮框 3 个；`case3-shared-button.json` |
| 4 | map 生成的卖点列表项被标注为多实例，`instances` 正确 | **通过** | 3 个 `li` 共享 `src/App.tsx:42:13`，`instances=3`；点第 1、2 项结果一致；`case4-map-list.json` |
| 5 | 无 `data-src` 的子元素归到最近标记外层并带 `note: "outer-container"` | **通过** | 页面所有原生元素都被标记，故注入 `<span id="unmarked-probe">` 到卖点 `li` 内；真实鼠标点击后 `src=src/App.tsx:42:13`、`note=outer-container`、面板显示“已选中外层容器”；`case5-outer-container.json` |
| 6 | `ancestors` 最多 3 层且每项都是合法 `data-src` | **通过** | 买按钮的 `ancestors` = `[src/App.tsx:25:11, src/App.tsx:20:9, src/App.tsx:19:7]`，与 DOM 上溯 3 层计算出的期望完全一致，且每项在源文件中都指向 `<` 并解析出标签名；`case6-ancestors.json` |
| 7 | 错误 origin 的 `pick:result` 被 Studio 忽略 | **通过** | 伪造 `origin: http://evil.example`、`source` 指向真预览 iframe → Selection 面板完全不变；同一 payload 换正确 origin → 被接受（`src=src/App.tsx:1:1`、Studio 补上 `baseVersion`），证明被忽略确实来自 origin 校验；错误 `source` 的同类消息也被忽略；bridge 侧伪造 `pick:stop` 后点击仍被拦截（`data-purchases` 仍为 0）；`case7-origin-check.json` |
| — | 校验器自检（非验收用例）：`readSourceAt` 对列号 +1 会判错 | 通过 | 防止断言空转，见下节 |

无失败用例，因此没有失败复现步骤；`docs/reports/artifacts/M0-B/output/` 下也没有失败截图。

### 用例 1 的点击方式说明（如实记录）

20 个抽样元素中 **17 个用真实鼠标事件**（`page.mouse.click`，坐标由“元素内某点 `document.elementFromPoint` 正好命中该元素本身”搜索得到，再换算 iframe 在 Studio 中的位置）。另外 3 个是 `main` 和两个 `br`：`main` 的所有像素都被后代覆盖、`br` 尺寸为零，物理鼠标永远命不中——真实用户也点不到它们。对这 3 个改为在元素自身上派发冒泡 `click`，仍走 bridge 的 `window` capture 拦截路径。逐条记录里的 `clickMode` 字段区分了 `mouse` / `dom-dispatch`，统计见 `clickModeCounts`。

## 断言灵敏度验证（变异测试）

为避免“测试自己空转”，做了一次临时变异：把 `packages/vite-plugin-source-tag/src/index.ts` 里的 `loc.start.column + 1` 改成 `+ 2`（列号整体偏一位），重跑用例 1：

```
Error: 随机 20 个元素中存在定位错误
  +   "#3 src/App.tsx:16:46 处字符是 \"s\"，不是 '<'",
  +   "#0 src/App.tsx:14:6 处字符是 \"m\"，不是 '<'",
  +   "#43 src/components/Button.tsx:5:6 处字符是 \"b\"，不是 '<'",
  ... 共 20 条全部失败
```

20 个全部被抓出。变异已还原（`git status packages/` 干净），还原后再次全量运行通过。仓库内保留了一个常驻自检用例（`readSourceAt 能识别列号偏移`），用同样的思路守住这一点。

## 未运行（不要当成通过）

- 只跑了 Chromium；Firefox / WebKit 未运行。
- 生产构建（`pnpm build` 产物）未测——插件与 bridge 只在 dev/serve 下启用，属设计如此。
- `auxclick`（中键/右键）拦截、`scroll:progress` 滚动进度、悬停高亮颜色、`ready` 重连、`error` 上报未单独设用例。
- Shadow DOM、跨域内嵌页、第三方脚本、触屏/真机未覆盖。
- `baseVersion` 与脏工作区/提交后的一致性校验未覆盖（M0 不做版本管理）。
- 未做视觉回归（高亮框位置只在用例 3 里数了数量，没有逐像素比对）。

## 观察与残余风险（非阻塞，未按缺陷计）

1. **容器类元素点不到**：`main`、`section`、`ul` 这类被后代完全覆盖的容器，鼠标无法直接命中，只能通过点中后代后看 `ancestors` 反推。`br` 等零尺寸元素同理。行为符合“向上找最近带标记元素”的规格，但演示时若想展示“点中容器”，需要换一种说法（例如点中容器内文字）。
2. **只拦截 `click`/`auxclick`**：页面若自行监听 `pointerdown`/`mousedown` 并触发副作用，选取模式下仍会触发。当前模板没有这种写法，M1 引入 3D 交互后需要补测。
3. **`instances` 是 DOM 计数**：共享组件和循环列表项用同一个字段表达，语义靠文案区分（“修改将影响全部实例”）。M2 做“会影响几处”时如果要区分“共享组件”和“列表项”，需要额外字段。

## 产物

- `docs/reports/artifacts/M0-B/playwright-results.json` — Playwright 原始结果
- `docs/reports/artifacts/M0-B/case1-random-sample.json` — 抽样与 20 条定位明细
- `docs/reports/artifacts/M0-B/case3-shared-button.json`、`case4-map-list.json`、`case5-outer-container.json`、`case6-ancestors.json`、`case7-origin-check.json`
- 运行说明：`tests/e2e/README.md`

提交说明：本次只提交测试与测试配置。`pnpm-lock.yaml` 里 `@playwright/test` 的条目已随并行任务 M0-A 的提交 `d6bd268` 一起入库，因此本提交不再动锁文件。

---

# 整改回合 1（依据 `docs/reports/M0-B-review.md`）

日期：2026-11-09。整改任务卡：`docs/design/M0-plan.md` 的 “M0-B-fix”，本轮只做其中 **Pi（先做，只改 tests/）** 部分：R3 的测试判定重建、R1/R2 的回归用例预写、S4 的消息安全回归。

## 本轮约束与执行环境

- **没有安装或升级任何依赖，没有改 `pnpm-workspace.yaml` / `pnpm-lock.yaml`，没有改 `apps/`、`packages/`、`templates/` 的实现代码。** 唯一落到 `packages/` 下的改动是新增插件层测试文件 `src/reserved-jsx-r2.test.ts`（任务卡允许“只新增测试文件”）。
- CodeBuddy 正在同一工作树做 M0-A，它的 `pnpm dev` 一直占着 5173/5174/3001。所以本轮用新加的 `E2E_REUSE_SERVER=1` 复用它的开发服务，并在运行前后比对了 `apps/studio/src`、`templates/product-page/src`、`packages/bridge/src`、`packages/shared/src` 的文件哈希：**哈希一致**，且 `git status` 里这些目录无改动，因此测的就是当前工作树的代码。
- `PLAYWRIGHT_BROWSERS_PATH` 指向 `%LOCALAPPDATA%\ms-playwright`（原因见首轮“环境与命令”）。

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH="$env:LOCALAPPDATA\ms-playwright"
$env:E2E_REUSE_SERVER="1"      # 5173/5174 被并行任务的 pnpm dev 占用时
pnpm test:e2e
pnpm test                        # 插件层 vitest
```

## 计数总览

| 套件 | 通过 | 按预期失败（待修） | 意外失败 | 合计 |
| --- | --- | --- | --- | --- |
| Playwright `pnpm test:e2e` | **19** | **2**（R1a、R1b） | **0** | 21 |
| Vitest `pnpm test` | **7** | **2**（R2 两条 `it.fails`） | **0** | 9 |

两个套件退出码均为 0：Playwright 的 `test.fail()` 与 Vitest 的 `it.fails` 把“已知待修”计为预期失败；一旦 CodeBuddy 修好，这两处会变成“意外通过”并让套件**失败**，提醒把标记改回去。

## R3：判定依据重建（关键整改）

| 新增 | 文件 | 说明 | 结果 |
| --- | --- | --- | --- |
| AST oracle | `tests/e2e/source-model.ts` | 用 Babel 解析 `templates/product-page/src` 下全部 `.tsx`，得出原生小写 JSX 开标签的 1 基行列——**完全不经过插件、不读 DOM 的 data-src**。`@babel/core` 按插件包路径 `createRequire` 解析，没有给根包新增依赖。 | — |
| 用例 8 | `m0b-pick.spec.ts` | 6 个确定性锚点，期望位置全部来自 AST：同一文件里三个位置不同的 `span`（16:45 / 24:40 / 34:11）+ `small` + `h2` + `a`。逐个真实点选，断言上报的 `src` 等于 AST 位置。另含 oracle 自检（该位置确实是 `<` 且标签名一致）。 | **通过** |
| 用例 9 | `m0b-pick.spec.ts` | 应标记节点完整性：AST 位置集合 ↔ 运行时 DOM 标记集合**双向对照**（DOM 有而 AST 无 = 幽灵位置；AST 有而 DOM 无 = 漏标/未渲染），并要求 `#root` 渲染树里每个元素都带 `data-src`。**没有把候选总数写死**：只记录规模（本轮 AST 36 个唯一位置 / DOM 36 个唯一 src / 46 个元素）并断言两侧集合相等。 | **通过** |
| 判定共用 | `tests/e2e/checks.ts` | 用例 8/9 与变异验证用同一份判定逻辑，避免两套逻辑漂移。 | — |

### 变异验证（证明判定不空转）

| 变异 | 做法 | 期望 | 实际结果 |
| --- | --- | --- | --- |
| A 同名标签错标 | 把渲染树里全部 7 个 `span` 的 `data-src` 统一改成第一个 `span` 的位置 `src/App.tsx:16:45`（等价于插件把同名标签标到同一处源码）。bridge 上报的 src 就直接来自这些属性，所以从 Studio 一侧看与真改插件完全一致。 | 用例 8 的判定必须报错；而“以 data-src 为期望值”的旧判定仍然全过（即 R3 指出的盲点） | **抓到 2 条**：`<span>「/ 100 mL · 雪松与佛手柑」期望 24:40，实际 16:45`、`<span>「静静陪伴 · 慢慢散香」期望 34:11，实际 16:45`；旧判定 6/6 全过 |
| B 漏标一类元素 | 移除全部 3 个 `li` 的 `data-src`（等价于插件不再给 `li` 注入） | 用例 9 必须报出缺失位置与未标记元素；用例 8 不受影响 | **报出** `missing = [src/App.tsx:42:13]`、`unmarked` 3 个 `li`；用例 8 仍全过 |
| C 列号偏一位 | 纯内存：把 AST 期望位置整体右移**一列**（`column + 1`，列号本身就是 1 基），走同一套 oracle 自检 | 6 个锚点全部被判定为“该处不是 `<`” | **6/6 全部被抓出**（原实现误写成 `+ 2`，即实际偏两列，回合 3 已更正） |

产物：`case-mutation-same-tag.json`、`case-mutation-missing-tag.json`、`case-mutation-column-offset.json`。

为什么 A/B 用“改插件产物”而不是“改插件源码再重启”：插件是 Vite 的**配置期依赖**，不在模块图里，改源码不会让运行中的 dev server 重新加载。本轮 5173/5174 被并行任务的 `pnpm dev` 占着，我既不能重启它、也没有空闲端口另起一套。作为对照，上一轮已经用“真改插件源码 + 还原”的方式验证过列号 +1 会被抓到（见上文“断言灵敏度验证”）。本轮确实尝试过真改插件（`span` 错标），确认运行中的服务没有重新加载插件后立刻还原：`git status packages/` 除新增的 R2 测试文件外干净，`index.ts` 无 diff。

## R1：预先写好的回归（待 CodeBuddy 修复）

文件 `tests/e2e/m0b-known-issues.spec.ts`。业务监听器全部由测试在预览页内注入，不改模板。

| 用例 | 内容 | 期望 | 当前实际 |
| --- | --- | --- | --- |
| R1a | 选取模式下真实鼠标点击按钮，元素上的 `pointerdown`/`mousedown`/`mouseup`/`click` 监听器都不应被触发 | 修复后通过 | **按预期失败**：`{pointerdown:1, mousedown:1, mouseup:1, click:0}`（与 Codex 探针数字一致） |
| R1b | 选取模式下聚焦单输入框按 Enter，隐式 `submit` 不应触发 | 修复后通过 | **按预期失败**：`{submit:1}` |
| R1c | 选取模式下点链接不改变 hash；退出选取后链接恢复可跳转 | 通过 | **通过**（退出后 hash 变成 `#details`） |
| R1d | 退出选取后 `pointerdown`/`mousedown`/`click` 完全恢复 | 通过 | **通过**（`{pointerdown:2, mousedown:2, click:1}`） |

R1a/R1b 用 `test.fail(true, '…修复后删除本条 test.fail。')` 标注。**CodeBuddy 修完 R1 后要删掉这两处标记**，并把用例 2 的“点击不触发原行为”与 R1 一起跑。

## R2：插件层回归（待 CodeBuddy 修复）

文件 `packages/vite-plugin-source-tag/src/reserved-jsx-r2.test.ts`（只新增测试文件，不改实现）。

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| `data-src={<span/>}` 时外层 `<div>` 必须标记自己的位置 | 期望 `src/Page.tsx:1:17`、只留一个 `data-src`/`data-cid`、输出可被 Babel 解析 | **按预期失败**（`it.fails`）：当前实际输出 `src/Page.tsx:1:32`，即属性内部 `<span>` 的位置 |
| `data-cid={<i/>}` 时同样不得把外层标成内层 | 同上 | **按预期失败**：当前实际 `1:36` |
| 字符串保留属性 + spread 的既有行为（对照） | 外层仍为 `1:17`、不残留 `old` | **通过** |

实测输出（本机直接调用 `tagSource`）：

```tsx
// 输入
const Page=()=> <div data-src={<span/>}/>;
// 当前输出（错：指向属性内部的 <span>）
const Page=()=> <div  data-src={"src/Page.tsx:1:32"} data-cid={"Page"}/>;
```

## S4：消息安全回归（当前全部通过）

文件 `tests/e2e/m0b-message-guard.spec.ts`。

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| S4a | bridge 忽略 `source` 不是 `parent` 的 `pick:start`（origin 正确）→ 点击照常触发业务 | **通过** |
| S4b | 对照：`source` 正确时 bridge 进入选取模式并拦截点击、画出同源高亮 | **通过** |
| S4c | Studio 拒绝 12 种形状非法的 `pick:result`：缺 payload、payload 非对象、bbox 3 项、bbox 含 NaN、instances 为 0 / 非整数、ancestors 4 层、styles 缺字段、note 取值非法、src 非字符串、未知类型、`scroll:progress` 越界 | **通过**（12/12 一条都没被接受），且同一通道的合法 payload 会被接受（证明不是通道没通），无 pageerror |
| S4d | bridge 忽略畸形 `highlight`（`src` 非字符串）与未知 Studio 消息，选取状态不受影响 | **通过**（覆盖框数量保持 3） |

## 本轮结论

- 原验收 7 项 + 行号自检：**全部仍通过**。
- R3：判定依据已换成 AST oracle，确定性锚点 6/6 对应正确，完整性双向对照无差集；三种变异都被抓到。**整改完成。**
- R1：2 条回归已预写且按预期失败，2 条（链接、退出恢复）已通过。**等 CodeBuddy 修 pointerdown/mousedown/mouseup/Enter 隐式提交。**
- R2：插件层 2 条回归已预写且按预期失败，对照用例通过。**等 CodeBuddy 修“删除保留属性时跳过其子树注入”。**
- S4：4 条消息安全回归全部通过，未发现新缺陷。
- 本轮未发现新的实现缺陷；也没有做任何实现侧修改。

### 仍未运行

同首轮“未运行”清单，另外补两点：

- 修复 R1/R2 后的“预期失败转为通过”这次没有跑（实现尚未修）。修完后需重跑全量：R1a/R1b 应转成真实通过（此时必须删 `test.fail`），R2 两条应转成真实通过（删 `it.fails`）。
- 未做真实跨窗口 `postMessage`（真浏览器发送、非合成事件）验证；S4 的 origin/source 分支用合成 `MessageEvent` 覆盖，这一点与 Codex 审查报告的表述一致。

---

# 整改回合 2（回归）

日期：2026-11-09。前置：调度已把 CodeBuddy 的修复分支 `fix/m0b-review` 合并到 master（合并提交 `59824d5`），修复内容见 `docs/reports/M0-B-fix-impl.md`：R1 在 capture 阶段拦截 pointer/mouse 按下抬起、`dblclick`、`contextmenu`、`submit` 与 Enter/Space 激活（选取仍在 `click` 上报）；R2 插件跳过保留属性子树；S1 observer 忽略覆盖层自身 mutation；S3 `cid` 不再认保存 JSX 的大写变量。

## 本轮改动（只动测试）

1. **删掉“预期失败”标记**：`tests/e2e/m0b-known-issues.spec.ts` 的 R1a/R1b 去掉 `test.fail(...)`；`packages/vite-plugin-source-tag/src/reserved-jsx-r2.test.ts` 的两条 `it.fails` 改回 `it`。现在它们是永久回归，通过就是通过。
2. **R1 补测三项**（e2e）：
   - `R1e` 选取模式下右键菜单与双击被拦截；退出后两者都恢复。
   - `R1f` 选取模式下 Space 激活被拦截（`keydown`/`keyup` 不触达业务监听器、不产生 `click`、购买计数不变）；退出后按钮可被 Space 激活。
   - `R1g` 选取期间悬停高亮与滚动**没有被误伤**：悬停出橙色高亮框，页面能真的滚动，Studio 的滚动百分比从 0% 变到 100%。
3. **S3 单测**（新增 `packages/vite-plugin-source-tag/src/component-name.test.ts`）：`const Heading=<h1/>` 这类保存 JSX 的大写变量不再抢归属（`cid` 为 `Page`）；`memo` / `React.forwardRef` / 类组件 / 命名函数表达式 / 嵌套组件仍正确归属最近组件。
4. **修了一个测试配置缺陷**（见下“一次判断为测试问题的失败”）：`playwright.config.ts` 加 `testIgnore: ['**/m0a/**']`。

## 结果

| 套件 | 结果 |
| --- | --- |
| `pnpm test`（全部单测） | **30 通过**：插件 15（本轮新增 3）、资产 14、bridge 浏览器探针 1 |
| `pnpm test:e2e`（M0-B） | **24 通过**：原验收 9 项 + R1 七项 + S4 四项 + 变异三项 + 校验器自检 1 项 |
| `pnpm test:e2e:m0a`（M0-A） | **22 通过**（合并后重跑，未受影响） |
| `pnpm typecheck` | 通过 |

共 **76 项**，0 失败、0 预期失败、0 跳过。

## R1：修复前后对照（同一个探针，同一组事件）

| 用例 | 回合 1（修复前） | 本轮（修复后） |
| --- | --- | --- |
| R1a 左键点击 | `pointerdown/mousedown/mouseup = 1/1/1` | **0/0/0**，`click` 仍为 0 |
| R1b 单输入框 Enter | `submit = 1` | **submit = 0** |
| R1e 右键 / 双击 | 未测 | 选取中 `contextmenu = 0`、`dblclick = 0`；退出后 **1 / 1** |
| R1f Space 激活 | 未测 | 选取中 `keydown = 0`、`keyup = 0`、`click = 0`、`data-purchases = 0`；退出后 **1/1/1** 且 `data-purchases = 1` |
| R1g 悬停 / 滚动 | 未测 | 悬停框 **1** 个；`scrollY = 472`；滚动百分比 **0% → 100%** |
| R1d 退出恢复 | `afterStop` 已恢复 | 仍然恢复（`pointerdown/mousedown/click` 各 +1） |

证据：`docs/reports/artifacts/M0-B/case-r1a-pointer-events.json`、`case-r1b-form-submit.json`、`case-r1d-restore.json`、`case-r1e-contextmenu-dblclick.json`、`case-r1f-space.json`、`case-r1g-hover-scroll.json`。

## 一次判断为测试问题的失败（如实记录）

第一次跑 `pnpm test:e2e` 时有 12 项失败，全部是 `tests/e2e/m0a/*`（主链路、幂等、导入、安全、视口）。原因不是实现：`playwright.config.ts` 的 `testDir` 是 `./tests/e2e`，而 M0-A 用例放在 `tests/e2e/m0a/` 子目录里，默认配置把它们也收了进来——它需要的是 m0a 专属的 mock/后端 webServer，默认配置里没有，所以连不上。

- **判断**：测试配置缺陷（我上一轮引入的），不是实现缺陷。
- **修复**：`playwright.config.ts` 增加 `testIgnore: ['**/m0a/**']`，两个套件各跑各的。
- **说明**：上一轮没有暴露这个问题，是因为 M0-A 一直用 `-c playwright.m0a.config.ts` 单独跑。

`R1g` 也在第一次落败：`scrollIntoView` 已经把页面滚到底，滚动百分比基线就是 100%，我原来的“滚动后百分比变大”断言不成立。改为先回到顶部取 0% 基线，再往下滚。同样属于测试问题，实现正常。

## 本轮未运行 / 限制

- 右键菜单：headless 环境看不到浏览器原生菜单，断言的是“业务 `contextmenu` 监听器没被触达”（选取中 0，退出后 1），不是“菜单没弹出来”。
- 双击：断言业务 `dblclick` 未触达；选取期间两次 `click` 仍会各上报一次 `pick:result`（沿用的既定行为），**没有**验证去抖。
- Space：`keydown`/`keypress`/`keyup` 只在可激活元素/表单内拦截，**普通页面文字上的空格没测**。
- S3 只有插件层单测，没有 e2e；模板里没有“大写变量存 JSX”的写法。
- S2（大页面高亮性能）按要求未做，测试侧也没有对应的性能用例；S4 的后端版本/路径校验仍留给 M2。
- bridge 安装前已注册的 window capture 业务监听器仍不保证被拦（实现方已声明）。
- 未做真实跨窗口 `postMessage`（同回合 1）。

## 回合 2 结论

R1、R2、R3、S4 的回归全部通过，原验收 7 项仍全部通过，M0-A 22 项不受影响。**M0-B 可以最终过关**，待 Codex 复核 R1–R3。

---

# 整改回合 3（N1 预写回归 / N2 变异描述更正）

日期：2026-11-09。依据：Codex 对整改回合 2 的复核（`docs/reports/M0-B-review.md` 末尾）。本轮只改测试文件，不碰实现。

## N1：S3 修法引入的退化（待 CodeBuddy 修）

`packages/vite-plugin-source-tag/src/component-name.test.ts` 新增 3 条 `it.fails`（修好后会变成意外通过，提醒删标记）+ 2 条正常断言（必须保持）：

| 写法 | 应得 cid | 当前实测 | 标记 |
| --- | --- | --- | --- |
| `export default memo(function Card(){return <div/>});` | `Card` | **`Anonymous`** | `it.fails` |
| `const Page = (() => <main/>) satisfies React.FC;` | `Page` | **`Anonymous`** | `it.fails` |
| `const Page = (() => <main/>) as React.FC;` | `Page` | **`Anonymous`** | `it.fails` |
| `const Page=()=>{const Heading=<h1/>;return Heading;}` | `Page` | `Page` | 正常断言 |
| `const Page = function PageView(){ return <main/> };` | `Page`（优先公开绑定名） | `Page` | 正常断言 |

当前退化已复现：三个 `Anonymous` 的 `data-src` 位置都是对的（`1:44` / `1:21` / `1:21`），只有组件名掉了——所以只是归属问题，不是定位问题。

## N2：变异 C 实际偏了两列

`tests/e2e/m0b-mutation-check.spec.ts` 的变异 C 原来写的是 `column + 2`，而 `column` 本身已是 1 基、正是 `<` 所在列，所以实际是**向右偏两列**，与“偏一位”的标题不符。已改为 `column + 1`（真正偏一列），并重跑确认：6 个锚点仍然全部被抓出（偏移后该位置是标签名的首字母，不是 `<`）。产物 `case-mutation-column-offset.json` 已刷新。

## N3：暂不改

用例 9 的“AST 位置集合 ↔ DOM 标记集合”相等检查依赖“所有原生 JSX 节点都会被渲染”。当前模板没有条件渲染，所以成立；M1 引入条件渲染后这条会误报，处理方式已写进 M1 的测试要求（按条件渲染分组或白名单）。

## 回合 3 结果

- `pnpm test`：插件 20（含 **3 项按预期失败**，等 N1）＋ 资产 14 ＋ bridge 探针 1，共 35 项，**除 3 个预期失败外全部通过**。
- 变异 C 专项重跑：通过（6/6 被抓出）。
- **M0-B 仍未最终过关**：等 CodeBuddy 修 N1，届时把 3 条 `it.fails` 改回 `it` 并重跑全量，再由 Codex 复核。

