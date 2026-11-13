# M2-B 工作台界面 · Pi 测试报告

- 日期：2026-11-13
- 被测版本：master `c93286f`（M2-B 界面 `feat/m2b-studio` + M2-A 整改 + D1/D2）
- 测试代码：`tests/e2e/m2b/`、根级 `playwright.m2b.config.ts`（复用 M2-A 的服务栈：mock 编码上游 + 独立预览源 5175 + Studio + 模板）
- 未修改实现代码；未装依赖、未改 lockfile
- 证据：`docs/reports/artifacts/M2-B/`

## 结论

**通过（3/3）**，全程 mock 模型。点选 → 指令（Ctrl+Enter）→ 步骤 → 候选/并排对比 → diff/未检查 → 采用 的主流程可用；取消与重试、越界提示都正常。有一处未覆盖（STALE_SELECTION 的界面提示，见“未运行”）。

| 用例 | 结果 | 关键断言 |
| --- | --- | --- |
| 主流程 | **通过** | 点选后 `selection.baseVersion` == `GET /version`；Ctrl+Enter 提交后 `task-status=done`、步骤含“候选目录已创建”；候选视图买按钮为“马上购买”；并排对比两 iframe 同宽（>200px）；滚主预览后候选预览同步滚动；`candidate-diff` 含 `src/App.tsx`；`candidate-checks` 四个 `data-status="not_run"` 且文案不含“通过”；采用后主预览显示“马上购买”；回退后作品恢复 |
| 越界提示 | **通过** | 选 `ul.benefits`（App.tsx）+ 新建 `src/tmp-scope.css` → `candidate-out-of-scope` 可见且含该文件；检查仍四项 `not_run` |
| 取消与重试 | **通过** | 慢上游下 `task-status=running` → `task-cancel` → `cancelled` 且出现 `task-retry`；换回正常剧本点重试 → `done` |

证据：`m2b-ui-flow.json`、`m2b-ui-out-of-scope.json`、`m2b-ui-cancel-retry.json`、`playwright-results.json`。

## 迁移与前置

- 界面用到的 iframe 现在指向独立预览源（5175）并带 `studioOrigin`；测试通过 `frameLocator` 读取候选/当前预览内容（跨源，Playwright 仍可访问）。
- 本轮跑的 `playwright.m2b.config.ts` 直接复用 M2-A 的 webServer（mock 上游 4011、后端 3001 + 预览源 5175、Studio 5173、模板 5174）。
- 所有用例结束后 `templates/product-page` 均还原（`git status` 干净），跑完端口全部释放。

## 未运行（不要当成通过）

- **STALE_SELECTION 的界面提示**：本轮实现过一版（点选后改文件再提交，断言 `task-action-error` 含“重新点选”），但提交后没有出现该提示元素，原因未定位；为避免把不确定的断言写成通过，本轮把它从套件里移除。API 层的 `STALE_SELECTION 409` 已在 `tests/e2e/m2a/03-selection` 覆盖。“重新点选”的界面文案需要下一轮补测。
- 断线重连补拉与历史截断后整体重载的**界面**行为（事件层在 M2-A 已测；界面的 `events-status`/`events-seq` 未做专项用例）。
- 最多 3 个待定候选在界面上的切换（后端已测上限；界面 `candidate-select` 未做多候选专项用例）。
- 3D 面板与指着说面板同时打开时的单连接复用、Firefox/WebKit、触屏。
- 真实模型的“10 次至少 8 次改对”。

---

# 回合 3（界面补测）

日期：2026-11-13。被测版本 `5377b52`。

| 项 | 结果 |
| --- | --- |
| 主流程 / 越界提示 / 取消与重试（回合 2 用例重跑） | **3/3 通过**（`playwright-results.json`） |
| **R1 重新点选不得提交旧对象** | **未运行**：尝试用 `page.route` 挂住 `/version` 延迟版本号，但这会把 Studio 自己的其他版本请求一起挂住，测试在中途以 `Target page/browser closed` 崩掉；断言未完成。需要更干净的接法（只拦截“第二次”`/version` 并 `abort`），本轮未做到 |
| **STALE_SELECTION 提示** | **未运行，且发现可疑行为**：点选 → 改 `src/App.tsx` → 点“生成候选版本”，**提交直接成功并产出了候选**（`round3-stale-hint.json`：`noticed:false`、`tasks:5`、页面出现候选），没有任何“请重新点选”提示。原因看起来是提交时的自动快照把改动先收进了新版本，于是 `fileChangedSince(baseVersion, 文件)` 判定为“未变化”——按这个顺序，**“点选后文件被改”这条自然路径上 STALE_SELECTION 可能永远不会触发**（API 层只在显式用旧 version 时才 409）。这更像实现语义问题而不只是用例问题，建议实现方确认快照与陈旧检查的先后 |
| 断线重连补拉、历史截断后重载、3 个待定候选的界面切换、多面板共用一条事件连接 | **未运行**（本轮时间用在 F1/R1/STALE 的排查上；事件层语义在 m2a `08-events` 已验证） |

---

# 接管后专项（M2 收口，HEAD `f70f046`）

- 日期：2026-11-13。被测 HEAD：**`f70f046`**（master）；`d79c467` 仍未合并。本轮只新增测试与本报告，未改实现/依赖/lockfile，未合并其它分支。
- 测试代码：`tests/e2e/m2b/02-takeover.spec.ts`（8 条）。命令：`node node_modules/@playwright/test/cli.js test -c playwright.m2b.config.ts`。
- 结果：**12 expected / 0 unexpected / 0 flaky**（`takeover-playwright-results.json`）——旧 3 条界面用例 + 新增 8 条中 7 条通过、1 条 `test.fail` 已知失败（retry）。旧回合的 `playwright-results.json`、`m2b-ui-*.json` 已从 git 还原，本轮跑数没有覆盖旧成功证据；新结果单独存为 `takeover-playwright-results.json`。
- 环境：假 key `mock-only` + 回环 mock 编码上游（4011）；后端 3001、Studio 5173、模板 5174、预览源 5175；Lux3D 指向无人监听的 `127.0.0.1:4019`，出站网络守卫开启；未读真实 `.env`、未调用真实模型/Lux3D。
- 端口/进程：上述 5 个端口由 Playwright 的 webServer 启停（未记录 PID）；跑完 3001/4011/5173/5174/5175 全部释放，没有 `preview-cache` 的 Vite 进程残留；每轮结束 `templates/product-page` 都由 `restoreTemplate` 还原并断言干净。

| 用例 | 结果 | 关键事实/证据 |
| --- | --- | --- |
| STALE 事实：**同一选中文件**变化 | **通过** | 点选 `buy-button` 得到 `selection.src=src/components/Button.tsx:5:5`、`cid=Button`、`baseVersion=58d7f95d…`（= 当时 `GET /version`）；只改 `Button.tsx`（按钮 hash `8868c982…`→`48d16106…`，`App.tsx` hash 不变 `6ae8610a…`）后提交：POST body 仍带旧 `baseVersion=58d7f95d…`，后端 **409 `STALE_SELECTION`**，界面出现“页面已变化，请重新点选”；快照把 HEAD 推进到 `eb0b77e0…` 但**没有改写客户端携带的 baseVersion**；重新点选拿到新 `baseVersion=eb0b77e0…` 后提交成功。`takeover-stale-same-file.json` |
| STALE 事实：**只改其他文件**（`App.tsx`，选中仍是 `Button.tsx`） | **通过（允许）** | `selection.src=src/components/Button.tsx:5:5`、`baseVersion=e9125b21…`；改 `App.tsx`（hash `6ae8610a…`→`3c69c055…`，`Button.tsx` 不变）后提交原 selection：**202**、任务 `done`、作品版本 `dd9ff939…`、候选 `610f7174…` 的 `baseVersion=dd9ff939…`、`diff=[src/App.tsx]`。`takeover-stale-different-file.json` |
| R1：第二次点选的版本请求**未返回** | **通过** | 只在页面/事件初始加载稳定后 arm，且只拦 Studio 自己的 `http://127.0.0.1:5173/version`；命中第二次点选的那一次后挂起。pending 期间旧 `selection-json` 立即消失、生成按钮禁用、Ctrl+Enter 与按钮均未发出 POST（`pendingTasksPosted=0`，任务数 5→5）；释放为合法版本后 `pick-state=ready`、生成按钮恢复。`takeover-r1-pending.json` |
| R1：第二次点选的版本请求**失败** | **通过** | 同一边界，挂起后 `abort`：`pick-state=failed`，提示“读取 … 的作品版本失败，请重新点选后再提交”，旧选中对象不显示、生成按钮禁用、快捷键 0 次 POST（任务数 5→5）；撤销拦截后重新点选恢复为 `ready` 且可提交。`takeover-r1-failed.json` |
| R1：`retry` 在 pending/failed 期间 | **已知失败（`test.fail`，32s→2s）** | master 的 retry handler 不检查 `submittable`：`retryDisabledWhilePending=false`、`retryDisabledWhileFailed=false`。修复在未合并的 `d79c467`；合并后去掉 `test.fail` 重跑，当前状态不得算“已修”。`takeover-r1-retry-known-failure.json` |
| 断线重连补拉 | **通过** | 用 `page.routeWebSocket` 只接管 `/events`（不连服务端，由测试送 `ready`），断开后期间通过 API 采用候选；重连时页面带 `since=85` 请求 `/events/history`，补到 `current=87`，`events-status=connected`、`events-seq=87`、`work-version` 变为 `9fbe850177`（断线期间的 `version.changed` 已生效）。`takeover-events-reconnect.json` |
| 历史截断后整体重载 | **通过** | 断开后新生成候选 B；重连时把 `since=101` 的 `/events/history` 应答成 `truncated:true`，界面随后重新请求 `/tasks`、`/candidates`、`/version`，候选下拉从 1 个变为 2 个（含 B 的 `c72875aa`），`events-seq=114`。`takeover-events-truncated.json` |
| 三个待定候选切换 | **通过** | 依次生成 3 个同一 base（`226d2178…`）的候选（`1cf0791c…/10debe23…/c71ed5b9…`），界面下拉显示 3 项；逐个选择后对应 iframe 文本分别为“马上购买甲/乙/丙”，`src` 指到各自 `/preview/c/<id>/`，`title` 含对应 id 前缀，详情显示“待定候选 3/3”。`takeover-candidates-switch.json` |
| 多面板共用单事件连接 | **通过** | 打开“3D 场景编辑”与“3D 资产”前后，`/events` 的 WebSocket 始终为 **1** 条（另有 Studio 的 `vite-hmr` 与预览源的 HMR 连接，均不是 `/events`）；期间 `PUT /scene` 使 `events-seq` 158→159，3D 面板的 `scene-config` 同步到新 `fov=37`；关闭两个面板后仍是 1 条。`takeover-single-connection.json` |

## STALE_SELECTION 事实核对（先核实，不改设计）

- 本轮先把事实钉死：`buy-button` 的 `selection.src` 是 **`src/components/Button.tsx:5:5`**（`cid=Button`，`ancestors` 才是 `src/App.tsx` 的容器）；回合 3 改的是 `src/App.tsx`，**是不同文件**，按现行“选中文件在点选版本后是否变化”的规则本来就应允许。回合 3 把它当作“STALE 永不触发”的推断不成立。
- 同一文件真实变化时 **409 正常触发**，界面提示与重新点选路径都可用（上方第一条用例）。
- “先快照”本身不是绕过原因：提交时的快照只是把工作区改动写成新的 HEAD，`fileChangedSince(baseVersion, 选中文件)` 仍拿**客户端携带的旧 baseVersion** 与新的 HEAD 比；若选中文件真被改过，比对结果就是“变化了”。本轮 POST body 里的 `baseVersion` 始终是点选时的旧值，可对照 `takeover-stale-same-file.json` 的 `postedSelection.baseVersion` 与 `versionAfterSnapshot`。
- 结论：**未发现 STALE 的实现缺陷**；不要按“先快照导致失效”去改语义。

## 说明与未运行（不要当成通过）

- 本轮 R1 的 `page.route` 只匹配 `http://127.0.0.1:5173/version`（Studio 自己的请求），在初始加载稳定后 arm，命中一次后 `fulfill`/`abort` 并在 `finally` 里 `unroute`；不会像回合 3 那样把预览 iframe 或其它时期的版本请求一起挂住。
- `retry` 的已知失败只代表 **master `f70f046`**；`d79c467`/`.worktrees/m2fix` 未合并前不能算通过。
- 本轮未重跑 `pnpm test`、M0-B、M0-A、M1-A、M1-B、完整 M2-A（含 D3/R6）与 F1 根 junction；D3 由 CodeBuddy 在 `.worktrees/m2d3` 修，本轮没有重复消耗 30 秒强杀的已知失败。最终各套必须在所有实现交付、审查通过并合并后的**同一冻结 HEAD** 上统一重跑，不能用不同 HEAD 的跑数拼成“全过”。
- 仍未运行：真实模型“10 次至少 8 次改对”、Firefox/WebKit、触屏。
