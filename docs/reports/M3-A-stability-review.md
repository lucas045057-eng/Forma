# M3-A 集成测试稳定性修正 · Claude Code 独立审查

- 日期：2026-11-14。角色：独立审查，只读，未改实现、测试、配置、依赖或锁文件，未提交。
- 固定提交：**`c2f79f8227466e908d064c81e49d530cc264756e`**（feat/m3a-approvals）；基线 **`012d9a65b4242cad2407a40c34614b2d162c8032`**。审查范围 `git diff 012d9a6 c2f79f8`。`.worktrees/m3a` 在开始和结束时都是 HEAD=c2f79f8、工作树干净。
- 依据：c2f79f8 的 `docs/reports/M3-A-stability-impl.md`、归档 `docs/reports/artifacts/M3-A/stability-20261114/`、Pi 失败原件 `docs/reports/artifacts/M3-A/run-20261114-m3a-1/`、主线 `M3-A-review.md` 最后的 RR1 复核，以及本地 Vitest 3.2.7 源码。

## 1. 结论

**通过：这次测试稳定性修正可以集成。** 没有阻断或应修项，只有 3 条建议。

这只说明测试预算与并发配置的修正是合理的，并有可核对的一次标准全量证据。不代表 M3-A 已完成正式验收：合并后仍需 Pi 在新冻结的主线上跑完整回归（含 Studio 与 E2E）；M3-B/M3-C 尚未开始。

## 2. 改动核对

`git diff --stat 012d9a6 c2f79f8` 中，代码和配置只有三个文件，其余全是 `docs/` 下的报告和证据：
- `apps/server/vitest.config.ts`（新增，第 1–9 行）：只设置 `minWorkers: 1`、`maxWorkers: 2`，**没有**全局 `testTimeout`、retry、bail 或 include/exclude。
- `apps/server/src/work/service.test.ts:137`：“keeps at most three pending candidates…”的结尾由 `});` 改为 `}, 15_000);`。
- `apps/server/src/work/approvals.test.ts:161`（三卡上限）和 `:553`（`it.each(['draft','main'])` 的 stale 用例）同样只改了结尾预算。三处定义，共 4 个用例。
- 断言、任务数量、fixture、skip/only/todo/fails、产品源码、业务超时、依赖和 lockfile 都**没有**改动。

### 配置确实生效
- 基线 `apps/server` 下没有任何 vitest/vite 配置（`git ls-tree 012d9a6 apps/server/`），新文件不会覆盖已有设置。`apps/server/tsconfig.json` 只包含 `src`，这个配置不会进入 tsc 构建产物。
- 根目录 `pnpm test` 通过 `--filter @spatial/server` 执行该包的 `vitest run`，工作目录是 `apps/server`，因此会加载这份配置。
- Vitest 3.2.7（`dist/chunks/coverage.*.js`）中，threads/forks 池使用 `poolOptions.max* ?? config.maxWorkers` 和 `poolOptions.min* ?? config.minWorkers`，确认这两个顶层选项会生效。
- 其他测试仍使用默认的 5000ms。

## 3. 15 秒预算是否站得住

- **对准了实际失败的用例**：Pi 在 a947f9f 的失败日志中，超时的正是三卡上限、stale main、四候选清理三项（`Test timed out in 5000ms`），都在这次放宽的 4 个用例之内。第 4 个（stale draft）和 stale main 是同一个 `it.each` 定义，预算只能一起设置；它在标准全量中耗时 4763ms，也已接近 5 秒。
- **只降并发不够**：controlled-original-budget 的 `vitest.json` 记录了 1–2 个 worker、原 5 秒预算下 179 项中 178 过，**唯一失败**是四候选用例，耗时 5005ms。
- **在 15 秒内能正常完成**：completion-diagnostic 只运行了三个指定用例，`numPendingTests=176`，没有被当作全量结果，三项都通过（4353/5082/5691ms）。
- **标准全量**（job_9123ecc1）：typecheck、build、test 三步均 exit 0、signal null，每一步前后 HEAD、lock、diff 和三个文件的 SHA 都一致。`test.log` 中：shared 68、plugin 20、scene-renderer 5、bridge 1（skipped 0、todo 0）、server 179（30 个文件）、Studio 7，**合计 280，没有失败或跳过**。4 个用例耗时 4435/4763/5281/5710ms，其中两项超过 5 秒，说明新预算确实被用上了。
- **不会掩盖死锁或业务时限**：15 秒约为观测最大值（5.7s）的 2.6 倍。真正挂起时，这些用例最多晚 10 秒失败，但仍会失败；产品中的模型、预览、请求超时都没有改动。这与报告中说明的代价一致，报告也没有承诺产品性能或在其他硬件上一定稳定。
- **根因表述如实**：报告只把主要耗时归因于四次串行的真实 Git 工作流，并说明队列和关闭过程没有观察到挂起，没有声称已找到唯一根因。这与此前 RR1 复核中“146ms 优化只是单次改善”的结论一致。

## 4. 证据能否对应到提交内容

- 验证是在 012d9a6 加三个未提交路径上运行的，没有在 c2f79f8 上运行，报告与证据都**明确如此说明**，没有冒充。
- 对照结果：
  - `vitest.config.ts` 与 `approvals.test.ts`：证据中记录的 SHA256 与 `git show c2f79f8:<path>` 的字节**完全一致**（`76737654…`、`dc85b797…`）。
  - `service.test.ts`：证据为 `3d3cc48b…`，提交 blob 为 `2517c097…`。核对后发现，物理文件就是该 blob 在 `core.autocrlf=true` 下按 CRLF 检出的结果（blob 转成 CRLF 后的 SHA 正是 `3d3cc48b…`），工作树也是干净的。所以**内容一致，只是换行符不同**；Vitest 运行时读取的就是这份物理文件。
- 两次诊断和 Pi 的失败原件都保留在各自目录，没有被覆盖，也没有被计为通过。

## 5. 建议

| 编号 | 位置 | 内容 |
| --- | --- | --- |
| S1 | `apps/server/src/work/approvals.test.ts` 及相关 m2/adopt 用例 | 在默认 5 秒预算下，还有 6 个真实 Git 多步用例耗时 3.4–3.7 秒：“recovers a committed adoption…” 3661ms、“binds answers to the exact draft digest…” 3578ms、“isolates preview Error…” 3574ms、“recovers another card before cancel…” 3479/3419ms、“isolates preview AbortError…” 3443ms，余量只有约 1.3 秒。机器负载更高时，它们可能是下一批超时。建议在 Pi 回归中关注这些用例的耗时；如果再次超时，先查 Git 工作量再逐项处理，不要改全局 testTimeout。 |
| S2 | `stability-20261114/*/evidence.json`、`manifest.json` | 证据只记录了物理文件（CRLF）的 SHA256，与 `git show` 得到的 blob SHA 不同，复核时容易误判为内容不一致。建议今后同时记录 git blob id（`git hash-object`）或说明 autocrlf 状态。 |
| S3 | `apps/server/vitest.config.ts:6`–`:7` | 在 28 核机器上把 worker 上限设为 2，会让 server 套件变成近乎串行，标准全量 test 步骤约 93.5 秒。这是可以接受的取舍；如果日后套件扩大，可以考虑只让 Git 重的文件串行（例如通过 `poolMatchGlobs` 或单独的 project），其余文件恢复并行。 |

## 6. 验证范围与限制

- 静态核对了 diff、Vitest 3.2.7 源码、三份证据 JSON 和日志，以及 Pi 的失败日志，对照了文件的 SHA256 和换行符。没有运行构建、单测、E2E 或任何服务，没有创建临时数据或进程。
- 证据只来自一台机器（28 核，Windows，Node 24.14.1）上的一次标准全量；不能证明在其他硬件上或多次运行下都稳定。
- 合并后 Pi 仍需完成完整回归，包括 Studio 与七套 E2E。这些在 a947f9f 的验收中没有运行，这次修正也没有覆盖。
