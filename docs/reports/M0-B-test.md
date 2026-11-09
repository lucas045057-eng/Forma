# M0-B 点选 → 源码定位 · Pi 测试报告

- 日期：2026-11-09
- 被测版本：M0-B 实现交付 `92fc0ea`；最后一次全量运行在 `d6bd268`（并行 M0-A 接入）之后的树上，M0-B 相关源文件（`apps/studio/src`、`templates/`、`packages/bridge`、`packages/shared`）在运行前后哈希一致。连续三次全量运行全部通过。
- 测试代码：`tests/e2e/`（`lib.ts` 工具、`m0b-pick.spec.ts` 用例）、根级 `playwright.config.ts`、根 `package.json` 的 `test:e2e` / `test:e2e:headed` 脚本
- 未修改 `apps/`、`packages/`、`templates/` 的任何实现代码

## 结论

**过关。** 用例 1 的 20 个随机元素全部定位正确；用例 2–7 全部通过。未发现实现缺陷。有 3 条非阻塞观察（见文末），都属于实现方已声明的已知限制。

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
