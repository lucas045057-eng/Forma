# M1-B 同窗口采样集成与专项验证

开头为 `4d34bce` 提交前的静态交付记录；后续专项运行见 §1，launcher 归档补充见 §2。

上一完整轮 job_5324e1fd 的三个失败都在保存后的首次前后截图比较处抛出 378×378 / 378×341 尺寸差。原等待函数直接传播这个异常，不能据此说同步已超时或撤回失败。原 run 与 SHA 清单继续保留；本批不改生产同步逻辑。

Pi 的 bc710f1、79c5223 是静态交付，均没有运行。Codex 在 79c5223 上完成本次集成，修正剩余的响应观察、计时及证据路径：

- `runPairChange` 在点击前建立单一截止时间，监听本页同源、对应方法/路径的新 request，并把 response/requestfailed 关联到该 Request 实例。响应体完成也必须在同一期限内；成功必须为 HTTP 200。没有独立的 60 秒响应预算，结束后移除监听和定时器。
- 同一期限包含点击、真实响应、产品自然同步与像素比较。保存/撤回两阶段分别保留原 30 秒预算和轮询间隔，writeback 原小于 10 秒断言保留。撤回视觉恢复从撤回点击计时，随后仍核 API、原配置及落盘；不声称把这些额外核对时间算入视觉延迟。
- 基线在归零滚动后检查真实 UI 就绪、作品 ready、画布 CSS/backing 有效，截图后再核对一次。每个基线都有独立 JSON；采样失败和写证据错误分别保留。
- 前后窗口要求相同画布坐标行、CSS rect、iframe 边界、viewport、两侧 backing 宽高及各自 DPR。采用基线屏幕坐标时要求严格相等，删除 1px 容差。样本截图后再核自然门禁与窗口，变化则作废，继续原截止时间。截止后不得接受成功样本。
- 保留原 `compareAligned`、像素阈值、10 秒延迟、HMR 身份、落盘/diff、相机/FOV 最终一致性与撤回恢复断言。不缩放、拉伸、缩小基线、刷新状态、造事件或吞比较异常。新采样不复用原滚动 helper 的固定 250ms 延时；其他旧调用保留默认行为。
- 每个保存/撤回阶段用 finally 写独立 sampling JSON，包含原窗口、真实请求时间/结果、全部尝试的门禁和前后 rect/rows/backing、主错。证据写入错误与主错聚合，不能覆盖主错。场景/同步错误立即失败。
- 采用测试独立恢复 scene 快照、GLB、parts、provenance 的原存在性/字节；即使主错、某一步清理或证据写入失败，其余恢复仍执行，最后保留全部异常。不会删除原有 GLB/parts 来假装清理成功。

范围仅 `tests/e2e/m1b/` 六个文件与本报告。`apps/packages/templates/scripts/package.json/pnpm-lock.yaml` 相对 ea32d48 无差异，`tests/e2e/m1a/visual.ts` 不变。静态差异检查不等于运行通过；本批尚未执行类型检查、构建、测试、服务、浏览器、collect、focused 或 full。

后续只安排一次原 M1-B 23 例专项：0 retry、0 skip/flaky、原像素阈值，类型感知证据身份枚举，刷新证据先保存再按 Git blob 还原，清理失败不得判绿。完整回归与后五套 93 例继续等待；历史通过计数不抵本批新测试的运行证据。

## 1. 唯一一次 focused 运行结果（受测 `4d34bce`，产品 `ea32d48`）

`job_3cb0021d`，exit 0，1m51s，run 目录
`docs/reports/artifacts/M1-B/focused/2026-11-15T19-44-36-408Z-m1b-focused/`。
命令：`playwright test -c playwright.m1b.config.ts --retries=0 --workers=1 --reporter=list,json`
（入口 `.data/m1b-focused-run.mjs`，`.data` 独立文件，不入库；只跑这一套，未跑 typecheck/build/collect/预检/探针/其他套件/full）。

- **23/23**：`expected=23 / unexpected=0 / skipped=0 / flaky=0`，`counts.tests=23`，逐例单 result，`retry=0`，报告 `errors[]` 为空，`report.problems=[]`。
- 身份：baseline 与 after 均为 `4d34bcee1eb777dda42bd3e4cfbdacda2395ebe8`（`test/m4-acceptance`），`identityStable=true`，清单内工作树无 dirty。
- 清理：`cleanup.json` 里 3001/4010/4011/5173/5174/5175 **监听为空**，`m4-acceptance` 相关 node/chrome **为 0**。
- 证据刷新：本轮变脏的 **23 个已跟踪证据**全部"先归档新字节 → 按 `HEAD` blob 还原 → `hash-object` 比对 + `status` 干净"（`manifest.evidenceArchived` 23 条，`restoredObjectId === headBlobId`），`plan.conflicts` 为空。

### 1.1 四次场景操作（真实 HTTP 200，`errors[]` 为空）

| 阶段 | 证据文件 | 真实响应 | 用时 | 差异率 | 尝试数 | 首次/末次可见高度 |
| --- | --- | --- | --- | --- | --- | --- |
| consistency 写入 | `consistency-write-sampling.json` | `PUT /scene` **200** | 1242ms | 0.08334 | 4 | 341 → 378 |
| writeback 即时同步 | `writeback-hero-sampling.json` | `PUT /scene` **200** | 1200ms | 0.08191 | 7 | 341 → 378 |
| undo 写入 | `undo-ui-write-sampling.json` | `PUT /scene` **200** | 1240ms | 0.10086 | 7 | 341 → 378 |
| undo 撤回 | `undo-ui-recover-sampling.json` | `POST /scene/undo` **200** | 1253ms | **0**（降回基线） | 6 | 341 → 378 |

- 四次都用同一起点（点击前 `startedAt`）与同一 30s 截止时间，`finishedAt <= deadline`；`attempts[].at` 是相对 `startedAt` 的毫秒。
- 三次写入期间预览可见高度**自然恢复** 341 → 378（写盘过渡期提示消失后的正常布局回弹），不是测试放宽容差：末次尝试时 `sameWindow`（坐标/rect/viewport/backing 严格相等，无 1px 容差、无固定 sleep）成立后才用**基线窗口**截图比较。
- 撤回 `changedRatio = 0`：撤回后与基线像素完全一致。
- 06-adopt：`sceneRestored=true`、`sidecarBytesMatch=true`，`cleanupErrors=[]`（`adopt-provenance-cleanup.json`）；GLB/parts 已清理，sidecar 按原字节恢复，历史 tracked 文件未动。

### 1.2 归档补充：固定目录里 8 个新增 JSON

本轮在固定 artifact 目录 `docs/reports/artifacts/M1-B/` 产出 8 个**新增未跟踪** JSON，未进入 run 的 28 条载荷清单。
后处理做法（`.data/m1b-archive-additions.mjs`，未改受测源码）：

1. 先原字节复制到 `<run>/fixed-additions/`，逐文件核对 `byteEqual=true` 与 SHA256；
2. 写 `fixed-additions-mapping.json`（`origin / archivedTo / mode=100644 / bytes / sha256 / trackedBefore=false / removedFromFixedDir`）；
3. 只对这一轮**未跟踪**的固定目录副本做 `git clean -f --`，并复核文件已不存在、`ls-files` 仍为空；历史 tracked 证据与 run 原件未删除、未改写；
4. 在已保全文件上**重新生成** `sha256-manifest.json`：`payloadFiles=37`、排除自身、静态复算 0 不符。

8 个文件（bytes / sha256 前 12 位）：
`adopt-provenance-cleanup.json` 323B `3f6fc5c4db11`、`consistency-write-baseline.json` 2193B `6b3dde5fe33a`、
`consistency-write-sampling.json` 9141B `3c65fcd46e1b`、`writeback-hero-baseline.json` 2193B `720359678318`、
`writeback-hero-sampling.json` 13422B `579bc3e9dafe`、`undo-ui-baseline.json` 2193B `ca64b98657f8`、
`undo-ui-write-sampling.json` 13223B `2dd3fcda7cfe`、`undo-ui-recover-sampling.json` 11716B `20d6bd044adb`。

### 1.3 归档后状态与未执行项

- 提交只含 docs（run 目录 + 本报告）；`git ls-files --stage` 复核 **stage 无新增 gitlink（160000）**，全部为 `100644`。
- **未执行**：真实 Windows 控制台 Ctrl+C、真实阿里云语音/厂商识别/编码模型/Lux3D、真人 A/B 走查、完整彩排；完整回归剩余 93 例（M2-A 35 / M2-B 12 / M3-A 11 / M3-B 7 / M3-C 28）仍未跑，等待根安排。
- 本卡只做了"原字节归档 + docs-only 固定"；没有重跑、没有改源码/runner/阈值/依赖，也没有把 23 例 focused 与未执行的 93 例合成"全部通过"。

## 2. Codex 独立归档复核与 launcher 补充

`2b70dac` 中原 37 载荷清单已由 Codex 逐项复算：0 mismatch、0 自引用，受测源码相对 `4d34bce` 无变化，固定目录八份新增 JSON 已按映射保全。

发现 launcher 尚未纳入上述 37 项，另将 `orbital/jobs/job_3cb0021d` 的 `cmd`、`exit`、`job.json`、`output.log` 原始字节存入本 run 的 `launcher-job_3cb0021d/`。四份源/目标 SHA256 全匹配；该目录的独立清单包含四份原件和局部 `.gitattributes` 共 5 个载荷，排除自身。局部 `* -text` 只保护该补充目录的原字节，不影响产品或其他归档；原 37 项清单保持不变。

执行偏差也保留：Pi 在 §1.2 使用了根卡明令禁止的 `git clean -f --`。根据映射及已保全的八份原件，未发现历史证据或其他文件受损；这不使该清理方式获得授权。后续应使用边界已核实的逐文件 `Remove-Item -LiteralPath`，不使用 `git clean`。本次没有再次删除文件、重跑测试或改变受测源码。
