# SF1/SF2：收回清单签发 + 新文件提交回归（父 `657fb1c`）

基于 `657fb1ca064006522f355ab67e8b688721427796` 的静态修补。**未运行** Node/`--check`/import/测试/服务/job；产品行为除"谁能签发清单"外不变。

## 1. SF1：清单只能由真实仓库读取后签发

`asset-ledger.ts`：

- 删除导出 `managedBaselineListing(repo, revision, files)` 与 `reusableBaselineListing(...)`；签发函数改为**模块私有** `issueListing`。
- 新增 `TreeSource { readTree(revision): Promise<readonly string[] }`（原始 `<mode> <type> <oid>\t<path>` 记录）。
- 新增**唯一**签发入口：

```ts
export async function auditManagedBaseline(
  repo: LedgerRepo & TreeSource,
  revision: string,
  reusable?: ManagedBaselineListing,
): Promise<ManagedBaselineListing>
```

  1. 若 `reusable` 是本 repo、本 full commit 的已签发清单 → 做受管字节审计后原样返回；
  2. 否则 `repo.readTree(revision)` 读取**真实树**，按原先逐条规则校验（mode 必须六位且非 `120000/160000`、type 限 `blob|tree|commit`、路径无控制字符、`permittedWorkPath` 允许），有坏项抛 `UNSAFE_TRACKED_FILE`；
  3. 校验通过后才 `issueListing(repo, revision, files)`（`Object.freeze`，登记到 `WeakMap<repo, WeakSet>`），再做受管审计并返回。

`repo.ts`：`auditTree` 变成一行委托；新增 `readTree`（一次 `ls-tree -r -z --full-tree`，与原实现同一进程）；`permitted` 改为调用共享谓词。

`path-policy.ts`（新）：把原 `WorkRepo.permitted` 的规则**原样**抽出，供 repo 与 ledger 共用；不新增/放宽任何规则。

### 为什么调用方不能签发空或截断清单

- **没有任何导出函数接收文件数组**。签发所需的文件列表只能来自 `repo.readTree(revision)`；要对某个 repo 得到空/截断清单，必须让**那个 repo 的 `readTree`** 返回空/截断，这等价于替换该 repo 的实现——已经超出"调用公开 API"的信任边界（同样的能力可以直接调 `repo.main` 改仓库）。
- 清单 **绑定到 repo 对象**（WeakMap 键就是对象本身）且要求**完整 40/64 位 hex**；异 repo、异提交、缩写、手写对象、截断副本都不在集合里，消费端 `reusableListing` 返回 `undefined`，`assertManagedBaseline` 立刻回退 `repo.listTree` 真枚举。
- 没有"全局 bindIssuer / 先到先得"：签发发生在同一个函数内、校验之后，不存在可被其他 import 抢占的注册步骤。
- 冻结：签发对象与 files 数组都是 `Object.freeze`，签发后不可改。

### 仍然保留的安全检查

受管文件字节逐次重读（`assertManagedTree`）；`verifyCandidateLedger` 重读候选 diff/字节、重算 hash、核 ledger/anchor/refs；`commitCandidate` 仍 `isCommit` + `merge-base` + 全量 verify 后 commit；审批意图落盘后的第二次 `pendingDiff` 保留；无跨操作缓存。

## 2. SF2：`pendingDiff(add -N) → commitCandidate` 的真实 Git 回归

`repo.test.ts` 新增两例（旧的直接 commit、混合、空格路径用例都保留）：

1. **新文件走 service 顺序**：写 `src/New.ts` → `pendingDiff`（内部 `add -N`）→ `commitCandidate` → `candidateCommit` ≠ base → `fileAt(commit,'src/New.ts')` 含内容 → `listTree(commit)` 含该路径。这是"新文件确实进入提交"的独立证明（show + read-tree），不只看返回值。
2. **混合新/改/删同序**：`Old.ts` 先入基线；candidate 内新增 `New.ts`、改 `App.tsx`、删 `Old.ts` → `pendingDiff` → `commitCandidate` → 断言 changed 集合、`fileAt` 新文件存在/旧文件不存在/修改生效、`listTree` 同结论。

触发点：若 `add -u` 不覆盖 `add -N` 条目，第一例会在 `commitCandidate` 的返回值或提交内容上直接失败，不会静默通过。O2 逻辑未改。

## 3. 测试改动（`asset-ledger.test.ts`）

- 测试不再有工厂：`fakeRepo` 增加 `readTree`（返回 `100644 blob …\t<path>` 记录），签发一律走 `auditManagedBaseline`。
- 覆盖：
  - **签发只读真实树**：`readTree` 1 次、`listTree` 0 次；
  - **同 repo/同 full SHA 复用**：`listTree` 0 次；**篡改基线的受管字节**后用同一清单再验，仍 `INVALID_MANAGED_BASELINE`（证明复用只省枚举、不省字节审计）；
  - **异 repo / 异提交 / 缩写 revision**：各回退真枚举（`listTree` 1）；
  - **手写空清单 / 截断副本**：在含影子渲染器的树上回退并拒绝；
  - **ledger 正例/错字节/wrongBase**、**两次验证之间改候选字节**：原断言保留。
- 旧的 shadow、rename、afterHash、import 审计、DOM/glob 正例全部保留。

## 4. 对 Claude 建议的处理

- **S1（`isCommit` 的 7 位缩写）不采用**：`isCommit` 用于"版本是否存在"的历史输入，复用判定用于"清单能否代表某个提交"，用途不同；本卡不收紧其行为、错误码或祖先语义。
- **S2**：报告里的 −560~−620ms 已标注为"估算，未实测"。
- **S3**：`auditTree` 注释已写明"锁外调用应传完整 commit id，并用同一提交作为 base"。

## 5. 待执行（等根复核后另行授权，本卡未跑）

1. `pnpm -r --no-bail typecheck`
2. `apps/server`：`work/asset-ledger.test.ts`、`work/repo.test.ts`、`work/approvals.test.ts`、`checks/scheduler.test.ts`
3. 若绿，整包 `apps/server`（含 `work/service.test.ts`、`checks/*`）捕捉间接回归
4. 4 个审批 5s 用例的实测耗时仍需单独采样；本批不承诺转绿

## 6. 风险与边界

- 未运行 typecheck；`auditManagedBaseline` 的参数是 `LedgerRepo & TreeSource`，`WorkRepo` 已实现全部方法；测试 fake 已补 `readTree`。
- 旧接口 `managedBaselineListing` / `reusableBaselineListing` 已移除，全仓无残留引用（grep 为空）。
- 未改 `packageAssetModule`/`linkDependencies`/`writeAtomic`（legacy 500 的候选落点）；legacy 诊断是单独报告，不与本批混为同一运行证据。
- 未读 `.env`/ASKS/凭据；未碰 Pi 树、live、主线、历史 run。
