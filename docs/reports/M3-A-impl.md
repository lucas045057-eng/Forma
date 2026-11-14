# M3-A 后端请示状态机实现报告

- 日期：2026-11-14
- 分支：`feat/m3a-approvals`
- 范围：只实现 M3-A。M3-B 检查运行器、M3-C 工作台界面、正式 E2E 与真实模型验收均未实现/未运行。
- 实现提交：`5357cbc`（实际 diff 风险策略）、`b236ac3`（基线/草稿独立分析）、`43e86fc`（私有草稿、状态机与 API）、`b8f815c`（恢复/关闭边界与运行时依赖）。A4 验证入口及本报告见后续交付提交。

## 1. 实际 diff 风险策略

`apps/server/src/approvals/policy.ts` 的 `evaluateApproval({ root, baseVersion, changedFiles, selection })` 只接收后端版本库实际读出的改动，不信模型声明。

- `shared_component`：使用 TypeScript 5.9.3 AST 分析基线和草稿两侧；支持同文件多次 JSX、import 别名、default/命名导出、直接 re-export 与 barrel。模块有至少两个使用方，或导出组件有至少两次 JSX 使用时请示。UI `instances` 只在实际改动的选中文件上作保守辅助证据，较小值不会压低静态结论。
- `global_style`：任何非 `.module.css` 的 CSS，以及 `scene.config.json`/主题配置均请示；MVP 不做选择器级精确影响分析。
- `out_of_scope`：实际改动不在规范化 `selection.src` 与 ancestors 内时请示；无 selection 的非空改动按范围未知请示。
- `analysis_uncertain`：语法解析失败、动态模块加载、无法解析的本地引用、基线读取/版本库错误等保守请示。基线失败不会抹掉草稿已知共享证据；草稿失败也不会抹掉基线证据。有效基线中真实不存在的新文件与读取错误分开处理。
- App 自身单处文案不会因引用共享 Button 而误报为 Button 修改。审批不能授权依赖、构建配置、任意命令或发布；`pendingDiff` 对非允许 `src/` 源码改动硬失败。

## 2. 私有 staging 与公开边界

模型 finish 后，`WorkRepo.pendingDiff` 在私有 worktree 上审计链接和基线树，以 intent-to-add 让新增文件进入完整 diff，但不提交。摘要绑定基线、每个改动文件的精确字节/删除状态及完整未截断 patch；公开 diff 仍有既有的 60 KB 显示上限。

风险改动只保存卡片与 `awaiting_approval`：

- 不调用 `commitCandidate`，不写公开 Candidate，不启动预览，不发 `candidate.ready`。
- `GET /candidates`、详情和 adopt 看不到私有 staging；预览来源没有对应运行端口。
- 等待回复不保留模型 Promise，不占 `taskQueue` 或 `repo.exclusive`；后续安全局部任务可继续。
- 批准只提交并发布绑定摘要的现有草稿，不再次构造或调用模型。主作品 HEAD 或草稿摘要变化返回 409 `STALE_APPROVAL`。
- 最多 3 张 pending 卡；新风险任务超限以 `APPROVAL_LIMIT` 失败并清理自己的 staging，不驱逐旧卡。

## 3. API、类型与事件

- `GET /approvals`：列出规范卡片，不返回内部提交摘要、绝对磁盘路径或源码凭据。
- `GET /approvals/:id`：返回卡片状态、任务关联、规则、理由、affected/evidence、基线和内容摘要。
- `POST /approvals/:id`：请求体只能含原始 JSON 数字 `option: 0 | 1`。本路由 preValidation 在 Ajv 清理前拒绝额外字段；字符串、小数、null 和越界值均 400。
- `POST /tasks/:id/cancel`：扩展支持 `awaiting_approval`，使卡片失效并清理自己的 staging。
- 新增 `approval.requested`、`approval.resolved`；沿用全局事件 seq、先持久后广播和历史补拉。批准成功后仍只发一次 `candidate.ready`。
- 共享 `ApprovalCard` 增加 `status/ruleCodes/ruleVersion/baseVersion/contentDigest/evidence/时间戳`，回答 option 为 `0 | 1`。

重复同一回答返回现有卡片/任务，不重复 commit、preview 或事件；相反回答返回 409 `APPROVAL_ALREADY_ANSWERED`。approve/reject/cancel 经同一作品互斥队列，只有一个终局。拒绝与取消无公开 Candidate。

## 4. 持久化、迁移与恢复

- 旧 M2 `tasks.json` 缺 `approvals` 时迁移为空数组；字段损坏、等待任务缺卡等情况拒绝启动，不静默重置。
- 回答先持久化 answer 与 approve/reject/cancel 意图，再提交发布或清理，最后保存终态并广播。
- 重启保留合法等待卡和 staging，不自动批准，也不被旧的未知候选清理误删。
- 批准恢复会重新验证主版本、pending diff 和卡片摘要。已提交但终态未落盘时，Git 提交保持同一身份，不创建第二个提交；完成预览/状态后继续一次发布。
- 回答保存失败会回滚内存回答/意图，不广播批准或候选；卡片首次保存失败会移除内存卡片，避免 outer cleanup 后留下指向已删除 staging 的 pending 卡。
- 失效或恢复时内容变化的卡片标为 stale，不能继续发布。

## 5. 关闭、来源与权限

`answerApproval` 与既有 submit/cancel 一样同步纳入 `inFlight` 准入。close 拒绝新回答，排空已接受回答及其嵌套作品操作，再执行 `repo.drain`、停止预览、等待写入；Fastify 的 onClose 之后才关事件日志并释放实例锁。等待用户答复本身不阻塞 close。

保留既有 Host/Origin、分源预览、作品互斥、链接检查、原子写和事件日志合同。真实 HTTP 关闭用例使用 `Connection: close`，只替换 `CodingAgent.run`；没有替换 app/work 的关停主体。原生 Node 导入探针只导入 `app.ts`，不启动服务、不读 `.env`。

`typescript` 已从仅根 devDependency 可用改为 `apps/server` 的精确运行时依赖 `5.9.3`；`pnpm-lock.yaml` 只增加该 importer 记录。离线 frozen 安装显示 Already up to date，没有新增或升级其他包。

## 6. 实际实现验证

以下均为 fake key、loopback 和 mock Agent；没有调用真实模型或 Lux3D，没有修改 `tests/e2e`。

| 作业 | 实际命令/范围 | 结果 |
| --- | --- | --- |
| `job_34f1b5ab` | `pnpm --filter @spatial/server exec vitest run src/approvals/policy.test.ts` | 8/8 通过；对应随后 `5357cbc` 的策略文件 |
| `job_5ab987da` | 同一 policy 定向命令 | 11/11 通过；含基线读取失败、真实新文件和草稿解析失败对照，对应随后 `b236ac3` |
| `job_0c9f19ff` | server typecheck，随后 `vitest run src/work/approvals.test.ts src/approvals/routes.test.ts` | typecheck 通过；审批 10 + 路由 1 全过，对应随后 `43e86fc`。此前 `job_d67e6fbf` 已实际通过 repo 8 项与原 service 8 项，但该轮另有 2 项失败，不记作整轮通过 |
| `job_db61e679` | `node apps/server/scripts/m3a-verify.mjs`：离线 frozen 安装 → server tsc → 原生 Node 导入 → `approvals.test.ts` + `events-lock.test.ts` | 各步骤 exit 0；审批 12 + events-lock 9 = 21 项全过，对应随后 `b8f815c` |

覆盖包括共享三处/别名/default/re-export、App 反例、全局 CSS、越范围/无选择、不确定分析、新增文件 diff、未批准不可见、批准不增加模型调用、拒绝/取消、队列释放、多规则单卡、三卡上限、摘要/主版本过期、硬拒绝 package、跨重启等待、已提交意图恢复、首次/回答写盘失败、同答/反答、并发终局、直接回答与真实 HTTP close 排空。

### 全仓 A4 验证

待后台结果。冻结交付提交后由 `node apps/server/scripts/m3a-full-validation.mjs` 顺序执行七包 typecheck → 七包 build → 六个有测试包的完整单测，首败即停。脚本逐步记录命令、PID、日志、开始/结束 HEAD、锁文件 SHA256、exit/signal 和工作树状态。结果未返回前不宣称全量通过。

## 7. Pi 接点与未运行项

- Pi 可直接使用上述 approvals API 与 cancel；等待卡存在时 candidates/adopt/预览必须仍不可见。
- 批准后 `candidate.ready`、候选 diff/checks 沿用现有结构；M3-A 不启动检查运行器，checks 仍为 `not_run`，不能据此采用门禁宣称 M3-B 已完成。
- UI 可消费 `affected` 中的 `file:line:column`、`evidence`、卡片 status 和事件；ApprovalPanel、高亮与检查证据界面属于 M3-C，本轮未做。
- 未运行正式 Playwright/E2E、真实模型十题或任何付费服务；未做 M3-B 的 schema/build/smoke/occlusion 证据与 adopt 检查门禁。
- 本报告不是 Claude Code 独立审查或 Pi 验收结论，M3 整体不能据此称为过关。

## 后续核验与审查整改说明

上方 A4“待后台结果”保留为原 7fad918 交付时的历史状态。调度后续已核验 job_049bdc52：固定 7fad918 的七包 typecheck、七包 build、六测试包 261 项单测全部通过，20 步 HEAD/锁摘要/工作树不变；详见主工作树 [M3-A-validation.md](E:/空间化AI工作台/docs/reports/M3-A-validation.md)。原证据不改写。

独立审查随后发现 B1/R1/R2，已作实现整改，参见 [M3-A-fix-impl.md](M3-A-fix-impl.md)。该报告记录新增状态与失败/过期恢复合同、红绿证据及建议保留项；整改最终全量仍待后台，原基线通过不等于整改复审通过。

## 8. 自启进程与清理

实现方没有启动常驻后端、预览或外部服务。边界测试中的 loopback HTTP 服务均由测试关闭；`job_db61e679` 的启动 PID 63688 已由调度确认退出。原生 Node 探针不监听端口。全仓验证的 job、PID、证据目录和最终清理核对在结果返回后补记；不会按端口盲杀其他会话。
