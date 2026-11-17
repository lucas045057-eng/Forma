# Lux3D approvals 超时：O1 清单复用 + O2 去重 add（635cb68）

基于产品 `635cb68dc8c02b8a2ec5d1f66de932acbc3c0c08`（`feat/lux3d-workbench`）的实现批次。
只改 `apps/server` 的 work 层与对应单测；未运行任何测试/Node/服务/job，typecheck 未执行，见 §7。

## 1. 改了什么

| 位置 | 改动 |
| --- | --- |
| `asset-ledger.ts:470-505` | 清单签发改为**按 repo 实例绑定**的 `WeakMap<object, WeakSet<object>>`；`managedBaselineListing(repo, revision, files)`；新增 `FULL_COMMIT`（40/64 位 hex）与只读谓词 `reusableBaselineListing(repo, revision, listing)` |
| `asset-ledger.ts:514` | `assertManagedBaseline` 用 `reusableListing(repo, base, listing)` |
| `repo.ts:127-156` | `auditTree(revision='HEAD', reusable?)`：命中则跳过枚举直接做受管审计；否则原样 `ls-tree` + 逐条校验 + 签发 |
| `repo.ts:228-250` | `snapshotInternal()` 先解析 HEAD 再 `auditTree(version)`，返回 `{version, listing}`；`snapshot()` 仍返回字符串；新增 `snapshotWithListing()` |
| `repo.ts:299-313` | `createCandidate(id, base, listing?)`：复用清单，返回 `{directory, listing}` |
| `repo.ts:345-370` | `pendingDiff(id, base, ledger?, listing?)`：复用清单，返回值增加 `baseline` |
| `repo.ts:397-411` | `commitCandidate(..., listing?)`：把清单传给 `verifyCandidateLedger` |
| `repo.ts:169-190` | **O2**：`add -u` 之后只对**未跟踪的新文件**做批量 `add --`；64 路径/4000 字符界不变 |
| `service.ts:442-448` | `snapshotWithListing()`（发 version.changed）与 `snapshot()`（返回字符串） |
| `service.ts:483-503` | `createModuleTask`：snapshot → createCandidate → pendingDiff → commitCandidate 全链传清单 |
| `service.ts:541-583` | `submit`：同上 |
| `service.ts:639-655` | `answerApproval`：snapshot 的清单传第一次 `pendingDiff`；`pending.baseline` 传 `recoverApprovalIntent` |
| `service.ts:194-198, 229-250` | `recoverApprovalIntent(listing?)` / `finalizeApprovedTask(taskId, listing?)`；第二次 `pendingDiff` **保留**，并把它的 `baseline` 传给 `commitCandidate` |

## 2. 安全论证（为什么复用不可变清单不降低门槛）

1. **归属绑定**：`issuedListings` 是 `WeakMap`，键就是 repo 对象本身。另一个 `WorkRepo`/`LedgerRepo` 即使持有同一提交的清单，`reusableListing` 也取不到集合 → 回退真枚举。弱键随 repo 回收，无跨请求生命周期、无全局字符串键。
2. **全 SHA 绑定**：`FULL_COMMIT` 只接受 40 或 64 位 hex。`HEAD`、缩写、tag、空串一律回退。签发时不做特殊处理，复用入口统一判定。
3. **不可伪造**：清单只由 `managedBaselineListing` 创建，`Object.freeze`（含 files 数组）；手写对象、浅拷贝、截断副本都不在 WeakSet 里。`reusableBaselineListing` 只是只读谓词，**不能签发**任何东西。
4. **复用只跳过"重复枚举 + 逐条 mode/type/path 校验"**：这两步对同一不可变 commit 是幂等的，且该 commit 的清单只能由一次成功的 `auditTree` 产生。`assertManagedTree` 仍然对每个受管文件 `fileBufferAt` 读字节并校验 canonical/实例格式。
5. **候选侧不缓存**：`verifyCandidateLedger` 仍然 `diffNameStatus` + 逐文件重读候选字节 + 重算 before/after hash + 核 ledger operation/anchor/refs；`commitCandidate` 仍 `isCommit(trusted)` + `merge-base === trusted` + 全量 verify，再 commit。审批意图落盘后的**第二次 pendingDiff 保留**。
6. **O2 不扩路径集**：`add -u` 仍先执行（覆盖所有已跟踪修改/删除）；批量 `add --` 只收 `!tracked` 的新文件，仍以 `--` 结尾，仍无 `add .`/`-A`；结束的 `ls-files --stage` 全量复查（links/mode/permitted）不变。
7. **snapshot 顺序**：`snapshot` 在构造器里属于 `exclusive` 包装队列，同一 repo 的操作串行；新实现只 `rev-parse` 一次，`auditTree(version)` 审计的就是返回的 `version`，两者同一个字符串。旧实现先 `auditTree('HEAD')` 再 `head()`，若 HEAD 在两步之间移动，会返回一个**没被审计过**的 commit；新顺序消除这个 TOCTOU，而不是引入新窗口。受外部 git 写入影响的面在两种顺序下相同（都无外部锁）。附带效果：旧顺序的符号 revision 过不了 hex 判定，`assertManagedTree` 会在同一次审计里再枚举一遍；新顺序审计 full SHA，只枚举一次。`init()` 仍用默认 `HEAD`，保持原样（启动期这一次双重枚举未改）。

## 3. 进程消减（估算，未实测）

单价取本轮 C 环境由 `fixture-init` 反推的 **≈56ms/进程**（§1 已标注为估算）。approvals 的典型链路是 2 次 submit + 1 次 approve + 1 次 commit。

先说明一个**原先被忽略的重复**：改前 `snapshot()` 审计的是符号 `HEAD`，`managedBaselineListing('HEAD', …)` 过不了 hex 判定，于是 `assertManagedTree` 会退回 `listTree('HEAD')` —— 一次 `auditTree('HEAD')` 实际跑 **2 次 ls-tree**。把 snapshot 改成审计已解析的 SHA 之后，它自己那份清单也能在 `assertManagedTree` 里复用，单次审计从 2 降到 1。

| 路径 | 改前 ls-tree | 改后 | 说明 |
| --- | --- | --- | --- |
| submit（snapshot 2 + createCandidate 1 + pendingDiff 1） | 4 | 1 | 全部复用 snapshot 的清单 |
| approve（snapshot 2 + pendingDiff#1 1 + pendingDiff#2 1 + commit verify 1） | 5 | 1 | 同一 full SHA |
| commit 的批量 `add --` | 1 | 0（无新文件时） | `add -u` 已覆盖修改/删除 |

估算：每例 **−10 次 ls-tree − 1 次 add ≈ −11 个进程 ≈ −560~−620ms**（C 环境）；A 环境（42ms/进程）约 −440~−490ms。
**不承诺 4 例必绿**：按 C 的实测体时间推算，terminal-save 约落到 4.8–5.0s，仍在边界附近；机器再慢一档仍可能贴边。

## 4. 新增/保留的回归（有区分力）

`asset-ledger.test.ts`：
- **同 repo 同 full SHA**：复用清单（`listTree` 调用数 0），但影子渲染器仍被 `INVALID_MANAGED_BASELINE` 拒绝——证明"跳过枚举但不跳过受管检查"。
- **异 repo 同 revision**：`listTree` 1 次，回退后仍拒绝。
- **异 commit / 缩写 revision / 手写空列表 / 截断副本**：各 1 次回退。
- **两次验证间改候选字节**：第一次通过，篡改后同一 ledger 第二次 `INVALID_LEDGER`，`listTree` 仍 0——证明没有缓存候选字节。
- 原有 correct ledger / wrongBytes / wrongBase / rename / shadow 断言全部保留（只把工厂调用改成新签名并绑定同一 repo）。

`repo.test.ts`：
- **snapshot → createCandidate → pendingDiff → commitCandidate 全链复用**：把 `repo.main` 包一层，`ls-tree` 出现即抛错；全链成功后断言 `lsTree === 0`。
- **混合暂存**：新增（普通点号名）+ 修改 + 删除一次提交，断言 changed 集合、`fileAt` 新文件存在、旧文件为 undefined、修改生效（覆盖 O2 的三种路径）。
- **空格路径**：`permitted()` 的既有 allow-list 本来就不接受空格，O2 不放宽；新增用例断言它不会被提交、同批的普通改动仍照常提交。
- 原有 additions/deletions/empty、digest 顺序、junction、F3/N1/N2 等用例未动。

`checks/scheduler.test.ts`：`createCandidate` 返回值改为 `{directory, listing}` 后取 `directory`（唯一一处使用返回值的地方）。

## 5. 明确未做

- 不做 O3（合并 `diff --name-only` 与 `--name-status`）。
- 不移除 `isCommit` / `merge-base`，不放宽 ledger/refs/anchor 校验。
- 不改审批模型、5s 预算、worker/retry/skip/断言、并发。
- 不碰 Pi 树、live `20884`/`39743`、主线、历史 run/manifest/SHA 原件。

## 6. 风险与自查

- **typecheck 未运行**（本卡禁止）。手工核对了签名变更的全部调用点：
  `managedBaselineListing` 4 处测试 + 1 处 repo；`createCandidate` 返回值只有 `scheduler.test.ts` 使用；`pendingDiff` 返回值新增字段不破坏旧用法；`snapshot()` 仍返回字符串，`scene/modules.ts` 与各测试不受影响。
- 未发现残留的 `created.listing`（已改名 `prepared`），`created` 布尔语义保留。
- `snapshotWithListing` 已加入 `exclusive` 包装列表；`snapshot()` 调用未包装的 `snapshotInternal`，无重复入队。
- 新增测试的 `main` 包装只在测试内、只对 `ls-tree` 抛错；不改产品行为。

## 7. 待执行（等根静态复核后另行授权）

1. `pnpm -r --no-bail typecheck`（workspace）。
2. `apps/server` 四个文件一次：`src/work/repo.test.ts`、`src/work/asset-ledger.test.ts`、`src/work/approvals.test.ts`、`src/checks/scheduler.test.ts`。
3. 若上面绿，再考虑整包 `apps/server`（含 `work/service.test.ts`、`checks/*`）以捕捉间接回归。
4. S1/S2/S3 与 E2E 不在本批授权内。

本批不宣称修复完成，也不宣称那 4 例会转绿；只交付可复核的源码、回归与估算。
