# Lux3D 审批热路径性能返工（起点 285ead6）

- 起点：`285ead64662f2ab17ce8dedf67c0dcf62137fba3`，树 `.worktrees/m4`
- 依据：根卡 `orbital/coordination/lux3d-increment/approval-perf-rework-285ead6.md`；诊断 `codebuddy-perf-diagnosis-285ead6.md`
- 本批只做授权内的四项（P1 / P2 / P5 / stage 批量），**不改 5 秒、不改断言、不改并发、不 retry/skip/sleep、不动任何 ledger 判定**。

## 1. 改了什么

### P1 `auditTree` 复用自己刚校验过的树列表

`apps/server/src/work/repo.ts:127-146`

- `auditTree` 原本先跑 `ls-tree -r -z --full-tree <rev>` 做 mode/type/path 校验，随后 `assertManagedTree` 又通过 `listTree` 跑一遍 `ls-tree --name-only <rev>`。
- 现在校验通过后把**完整**路径集合登记为 `ManagedBaselineListing`（`asset-ledger.ts:459-479`）并交给受管审计，不再第二次列举。
- 任一条目（mode 非 100644/100755、symlink 120000、gitlink 160000、控制字符、不在 allow-list）仍先抛 `UNSAFE_TRACKED_FILE`，顺序不变；抛错时列表不会被使用。

### P2 同次 `pendingDiff` 复用同一基线列表

`repo.ts:317-320`、`asset-ledger.ts:531`、`:598`

- `pendingDiff` 把 `auditTree(base)` 产出的列表传给 `verifyCandidateLedger`，`assertManagedBaseline` 不再列举同一提交。
- 复用有三个硬条件（`asset-ledger.ts:466-486`）：
  1. 列表必须由 `managedBaselineListing` 登记（模块私有 `WeakSet`），手写的 `{ revision, files }`、被截断的数组一律不认；
  2. `revision` 必须是 7–64 位十六进制**提交身份**——`HEAD` 这类可变引用永不复用；
  3. `listing.revision` 必须与本次 `base` 逐字符相等。
  任何一条不满足就退回 `repo.listTree(base)` 真列举。没有跨请求缓存，没有跨候选复用，没有读取候选工作区字节。
- `commitCandidate`（`:358`）、`resolveCheckCandidate`（`service.ts:302`）、`adopt`（`service.ts:735`）的整份重验保持原样，未接线复用。

### P5 每个文件只取一次完整 patch

`repo.ts:321-340`

- 旧实现先逐文件 `git diff` 生成展示 patch，再逐文件 `git diff` 一次喂摘要。
- 现在一次取回完整 patch，展示用 60 000 字符截断副本，摘要用完整副本；`Map` 只用于按 `changedFiles` 原顺序取回。
- 摘要顺序严格保持旧算法：`base` → 全部 `file/byteLength/content`（按 `changedFiles` 顺序）→ 全部**未截断** patch（同顺序）。不是逐文件交错，也没有把 60 000 字符的展示副本喂给 hash。

### stage 有界批量暂存

`repo.ts:147-178`

- 仍先 `ls-files` 校验 tracked 全部在 allow-list、仍先 `add -u` 保留删除语义。
- 目录遍历改为只**收集**已证明可暂存的路径（符号链接仍拒、仍只下钻 `src`/`public`、仍守 `permitted`），随后按 ≤64 个路径或 ≤4000 字符的批次执行 `git add -- <paths>`；单批结束仍用 `ls-files --stage` 校验 index 的 mode 与路径。
- 没有 `git add .`，没有 `-A`，没有扩大 pathspec，没有跟随链接。

## 2. 安全等价说明

| 关注点 | 结论 |
|---|---|
| 受管基线是否仍被完整检查 | 是。列表来自同一次 `ls-tree -r`，且只有校验通过才交出去；受管文件仍逐个 `fileBufferAt` 读字节并做 canonical/config/组件校验 |
| 列表能否被伪造/截断 | 外部的普通对象不在 `WeakSet` 中，直接忽略并重新列举（回归覆盖） |
| 旧列表会不会串到新基线 | 提交身份不等即弃用（回归覆盖） |
| ledger 的路径/操作/before/after/字节判定 | 一行未改，`verifyCandidateLedger` 主体（`asset-ledger.ts:531-593`）保持原顺序：路径安全 → 受管拒绝 → 普通 src 规则 → 引用审计 |
| 摘要能否被展示截断绕过 | 不能，摘要用未截断 patch；尾部变化仍改变摘要（回归覆盖） |
| 暂存是否放宽 | 否。allow-list、链接拒绝、`add -u` 删除、最终 index 校验全在 |
| 错误码/错误顺序 | 全部保持；`UNSAFE_TRACKED_FILE` 仍先于受管审计抛出 |

## 3. 新增回归（不删旧例）

`apps/server/src/work/asset-ledger.test.ts`

- `reuses only a complete listing for the same commit and never skips managed or ledger checks`
  - 同一提交的列表仍拒影子 `src/spatial-module.ts`（`INVALID_MANAGED_BASELINE`）；
  - 别的提交的列表、手写空列表都被忽略并重新列举，仍拒；
  - 正确 ledger + 列表通过；改 `afterHash` 仍 `INVALID_LEDGER`；
  - 无 ledger 时仍 `MANAGED_MODULE_DENIED`。
- `still refuses a renamed file carrying a ledger entry`：`R100` + 清单条目 → `INVALID_LEDGER`。

`apps/server/src/work/repo.test.ts`

- `rejects a shadowed managed baseline through the validated tree listing`：工作树初始就带影子渲染器时 `init()` 仍 `INVALID_MANAGED_BASELINE`（直接走 P1 的复用列表）。
- `stages additions, deletions and an empty change set through bounded add batches`：新增两个文件、删除一个 tracked 文件、无改动返回 `[]`，并核对提交内容。
- `keeps the untruncated patch in the digest and preserves the legacy hash order`：1200 行新文件 → 展示 patch 严格等于 `full.slice(0,60000) + 截断后缀`；按旧顺序独立重算摘要并比对；只改 60 000 字符之后的尾部，摘要必须变化。

## 4. 实测 / 推算的边界（如实）

- **实测**：只来自已完成的 `job_bc7f86a8` 与历史 `job_fe569815`（同机逐用例耗时、466 的阶段计时、fixture/restart/cancel-retry 的区段耗时）。
- **推算**：`~48–70 ms/进程`、每 submit 少 6 个进程、每 approve 少 4 个进程、F/466 约 −1.2 s、digest 约 −1.4 s，全部是按上述区段反推的估算，**不是逐命令实测**。历史同机对照也不能单独排除负载变化。
- 因此本报告**不承诺**新 HEAD 一定全绿；以一次有界 runner 的原始输出为准。

## 5. 静态自审

- 改动标识符：`ManagedBaselineListing`、`issuedListings`、`managedBaselineListing`、`reusableListing`（模块内）、`baseline`、`patches`、`addable`、`batch`、`size`、`flush`、`diffOf`、`full`、`expected`。无同名冲突，无隐式全局。
- 作用域：`reusableListing` 只在 `assertManagedBaseline` 使用；`patches` 只在 `pendingDiff` 内；`flush` 为 `stage` 内部箭头函数，`batch/size` 用 `let` 且已复位。
- 签名变更：`auditTree` 返回 `Promise<ManagedBaselineListing>`（旧调用点全部 `await` 后丢弃）；`assertManagedTree` / `verifyCandidateLedger` 增加可选第 3/5 参，旧调用不受影响；`LedgerRepo` 未变。
- 摘要与展示：两条路径都来自同一 `patch` 变量，截断只作用于 `diff.push`。
- 未触碰：超时、断言、并发、retry、ledger 字段、审计顺序、`commitCandidate` 的完整重验、`isCommit` 与祖先校验。

## 6. 未运行事实

本批**未**运行 typecheck、任何测试、build、safety、E2E、collect、probe、全量或云调用；未读 env/ASKS/凭据；未安装依赖；未派人；Pi 树、live 20884/39743、主线与旧证据未动。
唯一授权 runner：workspace typecheck → 九个 server 文件（原八个 + `src/work/repo.test.ts`）一次 Vitest 调用，超时/并发沿用原框架。
