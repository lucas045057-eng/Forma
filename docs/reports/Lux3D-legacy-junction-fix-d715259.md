# legacy 500 最小修复：junction 下的相对依赖链接（父 `d715259`）

基于 `d715259364da649e624870bfa74bdc1deeac5a25` 的静态最小修复。**未运行** Node/`--check`/import/测试/服务/job。

## 1. 根因（来自已结束的 native probe `job_37b326d4`）

- A0（work 根**无** `node_modules`）：`init/head/createCandidate` 全成功 → `git worktree add` 本身没问题。
- A1（与原 legacy 相同的 `work/node_modules` → `templates/product-page/node_modules` junction）：`createCandidate` 323ms 失败，
  `ENOENT realpath '<A1>/work/node_modules/@spatial/bridge'`（`errno=-4058, syscall=realpath`），
  stack：`repo.ts linkDependencies` ← `createCandidate`；候选目录为空、无 ledger。
- 模板里的 `@spatial/*` 是**相对**链接（`../../../../packages/bridge`）。经 junction 访问时，相对目标按 junction 的**逻辑**父链解析，落到不存在的目录；`linkDependencies` 的 `realpath` 因此 ENOENT，且未捕获 → 被 500 兜底。

与 legacy E2E 的对应：`legacy-work.spec.ts` 用同样的 junction 拓扑；第一次 confirm 在受管审计 409（未到 createCandidate），第二次走到 createCandidate → 同一 ENOENT；task 451ms 失败、候选/ledger 皆空的现场与 probe 一致。

## 2. 修法（`repo.ts` `linkDependencies`）

遍历前先把链接来源规范到**真实物理位置**，scoped 子目录同样处理：

```ts
const link = async (from, to) => {
  const physical = await realpath(from);      // junction → 真实目录
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(physical)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) { await link(path.join(physical, entry), path.join(to, entry)); continue; }
    await symlink(await realpath(path.join(physical, entry)), path.join(to, entry), 'junction');
  }
};
```

语义：

- 相对 workspace 链接从**真实父目录**解析，指向 `packages/*` 的链接不再断；
- 仍然遍历**全部**依赖，不跳过任何包；未知的真 broken 链接继续 `ENOENT` 失败（不静默、不吞异常）；
- 候选侧仍是指向真实包的 junction；`removeCandidate` 只删除候选自己拥有的链接（`unlinkDependencies` 不跟随源），不删真实依赖；
- 未改 `createApp`/错误信封，`task.error` 仍是原泛化消息，不把内部路径泄露到 API；
- 未改源码/附件链接审计（`assertNoLinks`、`permittedWorkPath`）或候选门禁。

## 3. 新增真实 Git 回归（`repo.test.ts`）

1. **junction 拓扑**：私有临时根下构造 `templates/product-page/node_modules/@spatial/bridge -> ../../../../packages/bridge`（相对链接，与 pnpm 同形），`work/node_modules` 做 junction 指向它；`WorkRepo.init/head/createCandidate` 成功 → 候选内 `@spatial/bridge` 的 `realpath` 等于私有 `packages/bridge` → 源文件字节未变 → `removeCandidate` 后真实包仍在。
2. **普通 modules + broken link**：`work/node_modules` 为真实目录时链路照常；另一私有 work 根的 `node_modules` 放一个指向已删除目标的 junction，`createCandidate` 必须 `ENOENT` 拒绝且候选未留下。
3. 清理前对私有根做 `realpath` 边界校验（父目录必须是系统临时目录），不触碰真实 workspace 依赖或旧 probe 目录；不使用安装 tsx 或重做 probe 作为回归。

## 4. 剩余固定成本（只读计划，未实施任何优化）

以本轮 S1 的原 marks（Error 体 4778ms；Abort：fixture 626 / first 2262 / second 3565 / answerA 4690 / answerB 4814 / restart 4815，returned 5083 已被超时污染）与原命令数看，仍可安全评估的候选：

| # | 位置 | 现状 | 候选方向 | 预计省进程 | 语义证明 | 风险 |
| --- | --- | --- | --- | --- | --- | --- |
| P-a | `repo.init()` 已存在分支 | 无条件 `merge --abort`、`revert --abort`、`worktree prune` | 先 `git rev-parse --git-path MERGE_HEAD/REVERT_HEAD` + `lstat` 判存在，再决定是否 abort；`prune` 仅在 `worktrees/` 非空时跑 | 干净时 −1（3→2 次检查 + 0 次 abort），有中断时 +2 | abort 对"无进行中操作"是 no-op，跳过不改变结果 | 需要覆盖 4 种状态（merge/revert/clean/都无）的回归 |
| P-b | `createCandidate` | `show-ref --verify` 后 `worktree add -b` | 去掉 `show-ref`，用 `worktree add` 失败码映射 `CANDIDATE_EXISTS` | 每次 submit −1 | 分支已存在时 `add -b` 必然失败，错误码语义可保持 | 依赖 git stderr 文案，需固定版本断言 |
| P-c | `repo.init()` 已存在分支 | 每次启动 `git config core.worktree` | 读 `work.git/config` 文本（fs）取 `worktree=` | 每次启动 −1 | 只读同一个键，解析可回退到 git 命令 | 手写解析 git config 的转义，风险高于收益 |
| P-d | `snapshot()` 脏工作区 | `status --porcelain` 后再 `diff --cached --name-only` | 从 porcelain 首列判暂存态 | 脏快照 −1 | porcelain 已含 index 状态 | 需要覆盖重命名/未跟踪/仅工作区改动 |

均未实施。另注：本轮 `linkDependencies` 改动只增加 `realpath` 文件系统调用，不增加 git 进程。最大的剩余项仍是审批路径里的第二次 `pendingDiff`（冻结，不在候选内）。**不声称除它之外没有别的安全优化，也不建议改预算。**

## 5. 未执行 / 边界

未跑 typecheck/测试/E2E/服务/probe；未安装；未读 `.env`/ASKS/凭据；未碰 Pi 产品字节、live、主线、旧 probe run 原件；未派子代理；未改 5s/断言/并发/retry/skip/`isCommit`/`merge-base`/ledger mutable 复核/第二次 `pendingDiff`。
