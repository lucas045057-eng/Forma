# M3-A 实现全量验证核验

日期：2026-11-14。Codex 调度核验 CodeBuddy 实现验证原件；不是 Pi 独立验收或 Claude Code 审查结论。

固定提交：`7fad918c93108d3a2f385ac1b0d836ede614a380`，分支 `feat/m3a-approvals`。后台作业 `job_049bdc52` 退出 0，约 52 秒。锁文件 SHA256：`48263def62ed2028e6f747ea1b08be9b4d77435f1b8c0bd52e3db7ef4a3a527f`。

## 结果

核验 `evidence.json` 的全部 20 个步骤：退出码均为 0、signal 均为 null，各步骤前后 HEAD 与锁文件摘要一致、工作树状态为空；最终 HEAD、锁摘要及干净状态也一致。

| 范围 | 结果 |
| --- | --- |
| 七包 typecheck | 全部通过 |
| 七包 build | 全部通过 |
| shared 单测 | 68 通过 |
| source-tag 插件单测 | 20 通过 |
| bridge 单测（node:test） | 1 通过，0 failed/cancelled/skipped/todo |
| scene-renderer 单测 | 5 通过 |
| server 单测 | 160 通过 |
| studio 单测 | 7 通过 |
| 单测总数 | **261 通过** |

原始验证入口是固定提交中的 `apps/server/scripts/m3a-full-validation.mjs`。按包的现有脚本解析本地 TypeScript/Vite/Vitest/Node 入口，顺序执行类型检查、构建和单测，首败即停；不是重新运行后的替代结果。构建仍有既有 Three 分包体积警告；本轮未将提高警告阈值当作修复。

## 证据

原件位于 `.worktrees/m3a/.data/m3a-validation-1794636746586/`。调度另存独立归档 [implementation-7fad918/evidence.json](artifacts/M3-A/implementation-7fad918/evidence.json)，保留 20 份步骤日志、作业原输出和 SHA256 清单 [manifest.json](artifacts/M3-A/implementation-7fad918/manifest.json)。未覆盖 M2 或 Pi 的历史证据，也未修改被验证的 worktree。

## 当前边界

本轮为 fake/mock 实现验证，不包含正式 E2E、真实模型调用或 Lux3D 付费调用。M3-A 独立审查作业 `job_f1c79be9` 已启动，报告待返回；尚未合并 master、尚未交 Pi 独立验收。M3-B 检查运行器与 M3-C 界面尚未实现，不能据本结果宣布 M3 整体过关。测试后的当前进程/端口是否残留需另行核查，脚本退出本身不等同于该项通过。

## 首轮整改后的全量结果：失败

固定提交 `25c33a83877bff173ffa5635c52ef5cb7b526cd7`，作业 `job_c2efd2aa` 退出 1，约 73 秒。锁摘要与上轮一致；全部已执行步骤前后 HEAD、锁摘要和干净状态一致，排除运行中代码被修改。

七包类型检查、七包构建及 shared 68 / plugin 20 / bridge 1 / renderer 5 单测通过。后端 176 项中 175 项通过、1 项失败：`apps/server/src/work/service.test.ts:118` 的四候选上限及最早候选清理用例在 5012ms 时触发默认 5000ms 超时，未有候选数量或清理断言失败的证据。入口按首败即停退出，后续 Studio 单测未运行，不能用上一轮 Studio 结果补成全量通过，也不能由单次超时直接归因为环境或逻辑死锁。

独立归档 [implementation-25c33a8-failed/evidence.json](artifacts/M3-A/implementation-25c33a8-failed/evidence.json) 保留原证据、19 份已执行步骤日志、作业输出及 SHA256 清单。前一轮 `implementation-7fad918` 通过证据未改。

Claude Code 已另完成对固定 `25c33a8` 的复核（`job_391aa28d`），见 [M3-A-review.md](M3-A-review.md) 的“复核（首轮整改）”：原 B1/R1/R2 关闭，新增 RR1 应修，取消操作可覆盖另一卡尚未完成的持久清理意图。当前 CodeBuddy 只读诊断超时，RR1 补修任务已准备；没有合并或正式 Pi 验收。最终需在补修后的新固定提交上再次全量验证及复核。

## RR1与读取优化后的最终实现全量：通过

固定提交 `012d9a65b4242cad2407a40c34614b2d162c8032`，作业 `job_d6233862` 退出 0，约 80 秒。包含 RR1 修复 `50a13b6`、基线读取优化 `6fe015c` 及报告更新。调度核验全部 20 步骤均 exitCode=0、signal=null，各步骤及最终 HEAD、锁摘要、干净状态一致，锁 SHA256 仍为 `48263def62ed2028e6f747ea1b08be9b4d77435f1b8c0bd52e3db7ef4a3a527f`。

| 范围 | 当前固定提交的结果 |
| --- | --- |
| 七包 typecheck / 七包 build | 全部通过 |
| shared / source-tag / bridge / scene-renderer | 68 / 20 / 1 / 5 通过 |
| server / studio | 179 / 7 通过 |
| 完整单测合计 | **280 通过** |

此前超时的四候选清理用例本轮通过，耗时 **4961ms**，未调整其 5000ms 预算、四候选/清理断言、retry 或 skip。本轮成功不能证明将来不会超时，余量较小仍作为 Pi 验收注意项保留；两次单独探针对照仅证明减少八次 Git 查询及当次约146ms阶段耗时，不能外推唯一历史根因或稳定性。

原件 `.worktrees/m3a/.data/m3a-validation-1794641716227/` 另存归档 [implementation-012d9a6/evidence.json](artifacts/M3-A/implementation-012d9a6/evidence.json)，包括20份步骤日志、作业输出和SHA256清单。原261项通过、25c33a8失败的两个归档保留，没有覆盖或将跳过步骤补成通过。

Claude Code 最终复核作业 `job_25d6d6c0` 尚待交回，范围是 RR1 与基线读取优化；Pi 尚未在合并后独立验收。未使用真实模型或 Lux3D，本结果不是 M3 整体过关；M3-B/C 尚未实现。进程清理与正式浏览器回归由后续验收按身份核对，不能仅由 exit0推断。

## 集成门禁核对

随后 Claude Code 的 `job_25d6d6c0` 交回：固定 `012d9a6` 的 RR1 关闭、基线读取优化可接受，代码审查转为通过，没有新阻断或应修；建议 S1–S6、RS1、RS2 保留。独立报告已在 `844cf97` 提交。结合本页核验的完整全量证据，两项集成门禁满足。

调度本地合并 `feat/m3a-approvals`，合并提交 **`4310ffb77295a14a5a27f304d4671aa061beeb4d`**，无冲突。核对 `git diff --exit-code 012d9a6 HEAD -- apps packages templates pnpm-lock.yaml` 为空，合并产品树和锁与被验证/审查版本一致，主线 tracked 工作树干净。没有在合并时删除实现 worktree 或覆盖未入库诊断。

接下来由 Pi 在主线冻结版本做独立 M3-A 验收与旧套件审批语义迁移/回归。正式通过以其实际报告为准，不将本次本地合并或源码一致核对当成合并后 E2E 通过；M3-B/C仍未实现。
