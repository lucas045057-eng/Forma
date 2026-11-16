# init 恢复门禁：干净重启跳过两个无效 abort（父 `b914a5e`）

基于 `b914a5ef6be5deb38df147c5f61b297de0e4c82e` 的静态批次，只做 Claude 复审 §5 的 **P-a**。未运行 Node/测试/服务/job。

## 1. 改动

`repo.ts` `init()` 的"仓库已存在"分支：

```ts
await this.assertNoLinks();                       // 先于任何标记读取
const filesBacked = await this.filesBackedRefLayout();
if (!filesBacked || await this.mergeInProgress()) await this.main(['merge', '--abort'], true);
if (!filesBacked || await this.revertInProgress()) await this.main(['revert', '--abort'], true);   // 标记在 merge abort 之后重新读
await this.main(['worktree', 'prune'], true);     // 无变
```

新增私有辅助：

- `filesBackedRefLayout()`：保守判定 `work.git` 是否为普通文件后端。
  - `gitDir/reftable` 必须**明确 ENOENT**；存在或读取异常 → false。
  - `gitDir/config` 必须是普通文件（`lstat` 不跟随链接）、≤64 KiB 可读。
  - 文本含 `include`/`includeIf`/`refStorage`/`objectFormat`，或 `repositoryformatversion` 不是 0/1 → false。
  - 任何读取/解析异常 → false。**不手写完整 Git config 解析，也不替代现有 `config core.worktree` 归属检查。**
- `markerState(file)`：只有 `lstat` 返回 ENOENT 才是 `absent`；其他任何错误是 `unknown`。
- `mergeInProgress()`：只看 `MERGE_HEAD`。
- `revertInProgress()`：`REVERT_HEAD`、`CHERRY_PICK_HEAD`、`sequencer/` 三者都 absent 才返回 false。

## 2. 等价性证明

- **merge**：`git merge --abort` 在 `MERGE_HEAD` 不存在时报 "There is no merge to abort" 并非零退出，不改动任何状态；原代码以 `allowFailure` 静默忽略。因此"`MERGE_HEAD` 明确不存在才跳过"与现状等价。产品 merge 不使用 `--autostash`，`MERGE_AUTOSTASH` 只在 `MERGE_HEAD` 存在时才被处理。
- **revert**：`revert --abort` 走 `sequencer_rollback`：有 `sequencer/head` 回滚多提交序列；否则 `REVERT_HEAD` 或 `CHERRY_PICK_HEAD` 存在时回滚单次操作（`rollback_single_pick` 同时检查这两个 ref）；都不存在时报错且不改状态。因此三者全 absent 才可跳过；**漏查 `CHERRY_PICK_HEAD` 会改变"abort 会中止 cherry-pick"的恢复合同**，已一并检查。
- **顺序**：`assertNoLinks` 仍在最前；`merge` 判定→执行后才读 `revert` 标记，不用合并前的旧快照。跳过只决定"是否调用 git"，真正回滚仍由 git 完成，不用标记推断恢复结果。
- **不确定性一律回退**：非 files 后端、配置有 include/refStorage/objectFormat、配置是链接或读不了、标记 `lstat` 非 ENOENT —— 全部执行原 abort。
- **进程数**：不新增任何 git 调用（无 `rev-parse`）；新增的只是 `lstat` 与一次小文件读取。

## 3. 状态覆盖（`repo.test.ts`，全部真实 Git 构造，除注明注入）

| # | 状态 | 用例 | 断言 |
| --- | --- | --- | --- |
| a | 干净重启 | `skips the two no-op aborts …` | 包装 `main`：无 merge/revert，仍有 `worktree prune` 与 `ls-tree` |
| b | 真实 merge 冲突 | `aborts a real interrupted merge …` | `MERGE_HEAD` 消失、文件回到 HEAD 侧、`status` 干净 |
| c | 单次 revert 冲突 | `aborts a real interrupted single revert …` | `REVERT_HEAD` 消失、内容为 C、`status` 干净 |
| d | 多提交 revert 序列 | `aborts an interrupted multi-commit revert …` | `sequencer/` 消失、内容为 C、`status` 干净 |
| e | cherry-pick 冲突 | `aborts an interrupted cherry-pick …` | `CHERRY_PICK_HEAD` 消失、内容为 HEAD 侧、`status` 干净 |
| f | merge 与 revert 标记共存 | `runs both aborts when merge and revert markers …` | 两个 abort 均被调用；`MERGE_HEAD` 消失 |
| g | 标记读取非 ENOENT | `keeps the aborts when a marker cannot be read …`（`vi.spyOn(markerState)` 注入 `unknown`） | 两个 abort 均被调用 |
| h | 非 files 后端 | `keeps the aborts when the ref backend is not proven …`（`work.git/reftable` 目录存在） | 两个 abort 均被调用，`prune` 仍在 |
| i | 作品含链接 | `refuses before touching a conflicted work tree …` | 抛 `UNSAFE_WORK_TREE`；`MERGE_HEAD` 与冲突标记**原样保留** |
| j | 残留 `index.lock` | `leaves a stale index.lock alone …` | 跳过两个 abort，`prune`/`ls-tree` 仍执行，lock 未被改 |

说明：g/h 用窄注入/文件系统状态证明"回退会发出原命令"；其余均为真实 Git 状态并检查 HEAD/index/worktree 结果。`index.lock` 一项只验证"跳过与旧行为的净效果一致（都不改状态）"。

## 4. 预期收益（估算，未实测）

- 干净重启：每次 `init()` 少 **2 个 git 子进程**（merge/revert abort），按本机 56ms/进程估算约 **−100ms**；`restart-init` 实测区间 257–302ms，占比可见但不足以单独改变 5s 余量。
- 有冲突状态时：进程数与原实现相同，只多几次 `lstat`。
- 不改变 `prune`、`auditTree`、`isCommit`、`merge-base`、ledger 复核、第二次 `pendingDiff` 与 5s 预算。

## 5. 待验证（等根统一一次）

1. `pnpm -r --no-bail typecheck`
2. `apps/server/src/work/repo.test.ts`：两个 junction 用例 + 十个 init 状态用例
3. 若绿，再跑 `asset-ledger.test.ts`、`approvals.test.ts`、`scheduler.test.ts` 或整包（由根决定）

新用例沿用默认 5s（每例约 10–20 个 git 子进程，估算 <2s）；**未给原审批 4 例加时，也未改动其断言**。若某项超出默认预算，按既有 test-budget 原则单独处理，不在本批调。

## 6. 边界

未运行 typecheck/测试/E2E/服务/probe；未安装；未读 `.env`/ASKS/凭据；未碰 Pi 产品字节、live、主线、旧 probe；未派子代理；P-b/P-c/P-d、`removeCandidate` 的 prune 优化均未授权、未实施。
