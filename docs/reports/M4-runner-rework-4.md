# M4 测试入口返工四（Pi 范围：只改集中 runner 的 D2_RUN_DIR 前置）

日期：2026-11-15。基线 `test/m4-acceptance` @ `60d37241d5310251dab02d9ba4c78e2ac0c6fe6d`。
**本轮只做静态修改与静态检查，没有运行任何自验/collect/build/test/服务/full，也没有创建 job。**
产品、实现侧单测、独立 E2E 断言、历史原件、ignore 规则均未改动。

## 1. 修的入口缺陷（第四轮 C3-1 的直接原因）

第四轮 `job_7e0bfabc` 里 `fallback-process-lifecycle.test.ts:73` 报：

```
Error: ENOENT: no such file or directory, open '...\2026-11-15T13-06-44-442Z-full\d2-browser\asset-parent-cleanup-38104.json'
```

- 能确认的事实：失败发生在用例 `finally` 写"清理诊断"这一步；目标目录 `<run>/d2-browser` **根本不存在**（该轮归档 `cleanup.json` 已记 `d2RunDir.exists=false`）。
- 归属：`D2_RUN_DIR` 是**我的 runner** 传给 unit 阶段的环境变量，但 runner 只写值、从未创建目录 → 属**测试入口缺陷**，不是产品问题，也不是实现侧测试的判断错误。
- 后果：诊断写入抛 ENOENT 后，原始断言/子进程错误/loader 阶段事件被覆盖，**无法据该轮日志回溯真正的失败点**。
- 另一侧（finally 里"原失败 + 清理失败 + 写证据失败"的聚合语义）由 CodeBuddy 的实现测试范围处理，**本轮不动**。

## 2. 修改（仅 `tests/e2e/m4/full-regression.mjs`，+39 / −2）

1. **unit 步骤声明前置目录**：
   ```js
   { name: 'unit', env: { D2_RUN_DIR: join(OUT, 'd2-browser') }, shell: true,
     prepare: [{ label: 'D2_RUN_DIR', dir: join(OUT, 'd2-browser') }] }
   ```
2. **新增 `prepareDirs(step)`**：对每个 `prepare` 目标 `mkdirSync(dir, { recursive: true })`，再用 `statSync().isDirectory()` 复核；
   成功/失败都记录 `{label, dir(相对路径), ok, error?}`。
3. **子进程启动前拦截**：主循环在 `runStep` 之前调用 `prepareDirs`；
   任一目标创建失败 → 写 `manifest.entryFailure = { kind: 'entry', abort: 'prepareDir', exitCode: 3, step, failures, prepared, executed, notExecuted }`，
   追加 `manifest.log` 的 `entry-failure prepareDir …` 行，**exit 3，且绝不启动该步子进程**（与既有"证据目录已脏即中止"同属入口失败，不算产品失败）。
4. **成功时留证**：`preparedDirs` 写进该步的 manifest 记录，便于事后核对"目录确实在子进程之前建好"。

## 3. 明确未改动的部分（保持既有规则）

- 步骤顺序：`typecheck → build → unit → demo-safety → M4 19 → 旧九套 174`；`--collect` 仍只跑 `--list`。
- 计数规则：每套 `verifyPlaywrightReport` 三层状态（`expectedStatus='passed'` / `test.status='expected'` / `results[0].status='passed'`）、恰好一条 result、`retry=0`、拒绝 skip/flaky/errors、递归嵌套并以 `stats.expected` 对数。
- 身份门禁：产品/脚本/`tests/e2e`/Playwright 配置/锁的真实字节 baseline，每步前后对照，偏离即失败；git 全部 `-c core.longpaths=true`。
- 证据：本步刷新的 tracked 证据**先归档新字节**再按 blob 还原并用对象 id + `status` 校验；步骤前已脏则不覆盖；SHA 清单排除自身并静态复算。
- 环境白名单、首败即停与 `failure.notExecuted` 记账、`--output`/JSON 定向、`PLAYWRIGHT_BROWSERS_PATH` 默认值等一仍其旧。
- 未改：`apps/`、`packages/`、`templates/`、`scripts/`、`tests/e2e/m4/01–04` 与 `helpers/env`、依赖、锁、`.gitignore`/`.git/info/exclude`、任何历史归档原件。

## 4. 静态检查

- `node --check tests/e2e/m4/full-regression.mjs` → **通过**。
- `git status`：仅 `tests/e2e/m4/full-regression.mjs` 被修改；`fallback/` 仍未跟踪（不入库）。
- `git diff --stat`：`1 file changed, 39 insertions(+), 2 deletions(-)`；人工核对 diff 只包含上述四处（import 增加 `statSync`、`prepareDirs`、unit 步骤 `prepare` 声明、主循环前置校验与 `preparedDirs` 记账）。

## 5. 未验证 / 边界（如实）

- 本轮**没有运行**：自验、collect、build、typecheck、单测、服务、浏览器、full 轮。因此"目录创建确实在子进程前发生""ENOENT 不再遮蔽原始错误"都只是**静态成立**，需集中轮实测确认。
- 实现测试侧：`recovery.ts:96` owner identity、`approvals.test.ts:452` 5s 超时、以及 finally 聚合语义，均属 CodeBuddy 的返工四范围；本轮不碰、不预判。
- 独立复审仍未完成（Claude 两次外部 ECONNRESET 无结论），本轮不据此宣称任何缺陷已关闭。
- 依赖/锁未变；Pi 独立用例数仍为 **193（M4 19 + 旧 174）仅收集数**，不是通过数。
- 真实边界不变：真实 Windows 控制台 Ctrl+C、生产资产 worker 整链回收、真实模板 iframe 点选与候选 HMR 端口、真实阿里/厂商识别/编码/Lux3D、真人 A/B、完整彩排均**未执行**。

## 6. 下一步

Codex 把本 runner 提交与 CodeBuddy 的返工四一起冻结后，再安排我从头跑同一 `tests/e2e/m4/full-regression.mjs`。
本轮不 merge 主线、不派实现者、不自动启动 full。