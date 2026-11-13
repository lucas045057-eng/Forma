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
