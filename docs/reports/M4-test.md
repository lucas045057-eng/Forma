# M4 集中验收报告（第一轮：停在 typecheck，未进入任何测试）

> 结论先行：本轮集中回归在**第 1 步 `pnpm -r typecheck`** 就失败，`exit 2`，用时 7s。
> 这是**冻结产品的编译错误**，不是独立套件故障。**没有任何测试被执行**：0 单测、0 脚本安全测试、0 E2E。
> 因此本文不写"测试失败 1 项"，也不声称全仓已验证；M4 未验收，项目未完成。

## 1. 受测身份

| 项 | 值 |
| --- | --- |
| 验收树 | `.worktrees/m4-acceptance`，分支 `test/m4-acceptance` |
| 受测 HEAD（测试侧） | `ed53e14944b70c8c6e48bb07abcf3da825f9de44` |
| 冻结产品 HEAD | `9d717fc396cc4315f6ffcc636510868e8147dc82`（完整实现 `fd38840`） |
| 基线 | `2eadea59a16fb894b31f7f585a93d48460b30554`（D1 已有 547 标准验证 + Claude 0 阻断/0 应修） |
| 身份摘要 / 锁 | `0e6edcc3b5d0…` / SHA256 `67af36b7a1b8a8ace1f03aa0ca9addf979f3842bdab3ff3dc4f56901b7d18960` |
| 产品/脚本/锁差异 | 相对 `9d717fc`：`apps packages templates scripts pnpm-lock.yaml package.json` **0 差异**（本轮只新增测试侧文件） |
| 依赖 | offline frozen：248 包全部命中缓存、0 下载 |
| 证据目录起跑前 | `docs/reports/artifacts` 脏项 **0**（入口未触发 exit 3） |

## 2. 失败原件（完整错误）

`job_6fd1b6c2`，run `docs/reports/artifacts/M4/regression/2026-11-15T09-15-07-076Z-full/`：

```
Scope: 7 of 8 workspace projects
packages/shared typecheck: Done
packages/vite-plugin-source-tag typecheck: Done
packages/bridge typecheck: Done
packages/scene-renderer typecheck: Done
apps/server typecheck: src/scene/service.ts(168,9): error TS2322: Type 'Buffer<ArrayBufferLike>' is not assignable to type 'Buffer<ArrayBuffer>'.
apps/server typecheck:   Type 'ArrayBufferLike' is not assignable to type 'ArrayBuffer'.
apps/server typecheck:     Type 'SharedArrayBuffer' is not assignable to type 'ArrayBuffer'.
apps/server typecheck:       Types of property '[Symbol.toStringTag]' are incompatible.
apps/server typecheck:         Type '"SharedArrayBuffer"' is not assignable to type '"ArrayBuffer"'.
apps/server typecheck: Failed
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @spatial/server@ typecheck: `tsc`
Exit status 2
```

- 位置：`apps/server/src/scene/service.ts:168`，语句 `provenanceBytes = existingBytes;`
- 成因（静态判断）：`provenanceBytes` 由 `Buffer.from(JSON.stringify(...))` 推断为 `Buffer<ArrayBuffer>`，
  而 `readPlainFile(...)` 返回的是 `Buffer<ArrayBufferLike>`；把后者赋给前者在 `@types/node` 的严格 Buffer 泛型下不兼容。
- 归属：**冻结产品代码**（`9d717fc` / 实现 `fd38840`），与本次新增的测试侧文件无关。
- 影响面：`apps/server` typecheck 失败使 pnpm 递归首败即停，**Studio typecheck 也未执行**（`Scope: 7 of 8`）。

## 3. 执行 / 未执行（精确）

| 步骤 | 状态 |
| --- | --- |
| 1. `pnpm -r typecheck` | **执行，失败**（exit 2，7s） |
| 2. `pnpm build` | 未执行 |
| 3. `pnpm test`（全量单测） | 未执行 |
| 4. `node --test scripts/demo/safety.test.mjs` | 未执行 |
| 5. M4 独立 E2E（`playwright.m4.config.ts`） | 未执行 |
| 6–14. 旧九套 E2E（M0-B/M0-A/M1-A/M1-B/M2-A/M2-B/M3-A/M3-B/M3-C） | 未执行 |

因此本轮的可核验计数只有一条：**typecheck 失败 1 步**；E2E 0 例（不是 0/174 通过）、单测 0 项、脚本安全 0 项。
`manifest.json` 的 `failure.notExecuted` 已逐条记录上述 13 个未执行步骤。

## 4. 已写未跑的独立 M4 套件（**不等于覆盖**）

`tests/e2e/m4/` 共 **13 个用例**已写好，但本轮**未收集、未执行**，下列一律标注"未验证"：

| 文件 | 例数 | 覆盖意图 |
| --- | --- | --- |
| `01-speech.spec.ts` | 5 | D2：录音→可编辑 review→确认只写入指令（监听 `/tasks` 为 0）；录音指 A 后改点 B → 冲突提示 + `speech-use` 禁用 + 显式选择；页面 hidden → 取消并释放轨道；转写 499 → 安全文案 + 重试**新 request id**；权限晚到取消不残留 review（转写/提交均为浏览器替身） |
| `02-fallback.spec.ts` | 3 | D3：三份素材按 preset SHA256 核对；列表与非法输入被拒；导入→来源绑定真实 GLB 哈希→采用→回退 |
| `03-layout.spec.ts` | 3 | D4：1440×900 / 1280×800 / 390×844，画布原尺寸不被裁切 + 溢出提示 + 键盘焦点 + 整页无意外横向溢出 + 截图 |
| `04-demo.spec.ts` | 2 | D5：仅 mock 启动、凭据全 false、SIGINT 后自有子进程/端口释放；硬杀父进程只做观测（不作通过证据） |
| `full-regression.mjs` | — | 14 步顺序入口：typecheck → build → unit（`D2_RUN_DIR` 定向）→ demo 安全测试 → M4 E2E → 旧九套；真实字节身份 baseline、报告三层判据、证据先归档再按 blob 还原、首败即停并写未执行清单 |

静态核对（仅语法层面，不代表行为）：4 份 spec + helpers/env + `playwright.m4.config.ts` 经 TypeScript `transpileModule` **0 syntax error**；`full-regression.mjs` `node --check` 通过。
`scripts/demo/safety.test.mjs` 已显式纳入入口第 4 步（它不在 workspace `pnpm test` 过滤范围内）。

## 5. 清理与证据

- 本轮只跑 typecheck，**没有启动任何服务或浏览器**：3001/4011/5173/5174/5175 无监听，本工作树无自有 node/chrome 进程，未执行任何 kill。
- `templates`/`apps`/`packages`/`scripts` 工作区脏项 **0**；`pnpm-lock.yaml` 未变。
- 本步没有刷新任何 tracked 证据（`evidenceArchived: []`），历史证据未被改写。
- 归档：`manifest.json`、`manifest.log`、`typecheck.log`、`cleanup.json`、`launcher/`（job 的 `cmd`/`exit`/`job.json`/`output.log`），
  `sha256-manifest.json` **登记 8 个载荷文件、排除自身，静态复算 0 mismatch**。

## 6. 统一问题清单（本轮唯一阻断项）

1. **P1（阻断，产品编译错误）** `apps/server/src/scene/service.ts:168` TS2322：
   `Buffer<ArrayBufferLike>` 不能赋给推断为 `Buffer<ArrayBuffer>` 的 `provenanceBytes`。
   修复归 CodeBuddy（实现方），测试侧不改产品或类型注解；修复后需从头重跑同一集中入口。
2. **P2（流程/计数，非缺陷）** 第 3 步 `pnpm test` 从未执行，M4 新增单测数与 Studio 的
   `speech-browser.test.ts`（真实 Chromium 组件测试）本轮都没有结果；实际计数只能等修复后的完整轮次给出，
   本文不预填、不拿 D1 的 547 或旧 174 抵扣。
3. **P3（覆盖边界，如实保留）** 本轮没有任何 E2E 结果，旧九套 174 例（含 M1-B 23 像素）在 M4 冻结身份上**尚未重跑**。
4. **P4（测试侧待验证项）** 我新增的 13 例从未运行，若集中轮出现失败，属"未验证→需修测试或暴露产品问题"，
   不得直接当作产品缺陷；届时按证据归因。
5. **P5（D5 语义边界）** 硬杀父进程的清理只能观测、不能证明"自主回收"；D5 的通过证据只来自 SIGINT graceful 路径。

## 7. 未覆盖 / 未执行（不得冒称）

- **真实阿里语音、真实厂商识别、真实编码模型、真实 Lux3D**：全部未调用（本轮没有任何服务启动）。
- **真人 3–5 人 A/B、3 次完整真实彩排**：未执行。
- **跨浏览器**：仅 Chromium；浏览器覆盖不跨内核。
- 未读取真实 `apps/server/.env`、`orbital/ASKS.md` 或任何凭据。

## 8. 下一步

Codex 汇总 Claude 统一只读审查（限额 19:10 后）与本清单 → **一次返工**（P1 由实现方修）→ 我在修复后的固定提交上
从头跑同一 `tests/e2e/m4/full-regression.mjs`，不拆轮、不跳过、不预写通过。M4 与整个项目仍未验收。
---

# 附录：集中第二轮（返工一后）—— 仍停在 typecheck，未进入任何测试

> 本轮同样**没有执行任何测试**：0 单测、0 脚本安全测试、0 E2E。193 只是**收集数**，不是通过数。
> 产品侧 `01c85fe` 未改，问题归实现方统一返工批次处理。

## A1. 受测身份

| 项 | 值 |
| --- | --- |
| 验收树 | `.worktrees/m4-acceptance`，分支 `test/m4-acceptance` |
| 受测 HEAD（测试侧） | `eece9e100a2c4a0bcf0e6ff84667d0a2bcea4cdd` |
| 冻结产品 | `01c85fe18ebcb24c0a010621e53f71f475e7320f`（返工一起点 `9d717fc`） |
| 身份摘要 / 锁 | `ef0fe1a11e44…` / SHA256 `67af36b7a1b8a8ace1f03aa0ca9addf979f3842bdab3ff3dc4f56901b7d18960` |
| 产品/脚本/锁差异 | 相对 `01c85fe` **0 差异**；`HEAD:apps = 01:apps = 1f106d347c8c0bc0258f215f2516e69393295d60` |
| 证据目录起跑前 | 脏项 **0**（未触发入口守卫） |

## A2. 失败原件（与上一轮**不是**同一个错误）

`job_9415a4a3`，run `docs/reports/artifacts/M4/regression/2026-11-15T12-35-07-124Z-full/`，整体 `exit 1`，14s；`typecheck` 子步骤 `exit 2`、11.757s：

```
packages/shared typecheck: Done
packages/vite-plugin-source-tag typecheck: Done
packages/bridge typecheck: Done
apps/server typecheck: src/assets/process-worker.ts(8,28): error TS1375: 'await' expressions are only allowed at the top level of a file when that file is a module, but this file has no imports or exports. Consider adding an empty 'export {}' to make this file a module.
apps/server typecheck: src/assets/process-worker.ts(9,18): error TS1375: (同上)
apps/server typecheck: Failed
[ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL] @spatial/server@ typecheck: `tsc`
Exit status 2
```

- **不是**上一轮的 `scene/service.ts` Buffer 泛型错误复发：那一处已消除（本轮 typecheck 没再报它）。
- 成因（静态）：`process-worker.ts` 现在只有语句（`process.once('disconnect', ...)`）与**动态** `await import('./process-model.ts')`，
  没有任何静态 `import`/`export`，因此从"模块"退化成"脚本"，顶层 `await` 非法（TS1375）。
- 归属：冻结产品代码（`01c85fe` 的返工改动），与测试侧文件无关；`apps/server` 首败即停，**Studio typecheck 也未执行**。

## A3. 执行 / 未执行（与命令失败分开记录）

- **命令失败**：`pnpm -r typecheck` 退出码 2（子步骤），因 `apps/server` 类型错误；`signal=null`，不是超时或被信号打断。
- **身份漂移**：**无**。`manifest` 里该步 `problems` 只有 `退出码 2（signal=null）` 一条；起跑前 `evidenceDirtyAtStart=[]`；
  产品/脚本/锁与本轮起点 `01c85fe` 字节一致（`productDiffVsAccepted=[]`）。所以这是**命令失败**，不是"身份漂移"（runner 把两者写在同一个 problems 数组里，这里按事实分开）。
- **未执行 13 步**：`build`、`unit`、`demo-safety`、`e2e-m4`、`e2e-m0b`、`e2e-m0a`、`e2e-m1a`、`e2e-m1b`、`e2e-m2a`、`e2e-m2b`、`e2e-m3a`、`e2e-m3b`、`e2e-m3c`。
- **计数**：E2E 执行 0 例；单测 0 项；脚本安全 0 项。**193（M4 19 + 旧九套 174）仅为本轮收集数**，不代表执行或通过。

## A4. 清理与证据

- 只跑 typecheck：3001/4011/5173/5174/5175 无监听，本树无自有 node/chrome，模板/产品脏项 0，未执行任何 kill。
- 本步未刷新任何 tracked 证据（`evidenceArchived: []`），历史证据未改写。
- 归档：`manifest.json`、`manifest.log`、`typecheck.log`、`cleanup.json`、`launcher/`（job 的 cmd/exit/job.json/output.log）；
  `sha256-manifest.json` 登记 **8 个载荷文件、排除自身，静态复算 0 mismatch**。

## A5. 统一问题清单（合并 Claude 返工一复审）

1. **Q1（阻断，产品编译错误，新）** `apps/server/src/assets/process-worker.ts` 顶层 `await` + 无静态 import/export → TS1375（两处）。归实现方下一批统一修。
2. **Q2（已代码层关闭，待运行确认）** 上一轮 `scene/service.ts` Buffer 泛型（B1）在本轮 typecheck 中未再出现；仍需在修复后的版本上真正跑过 typecheck 才能关闭。
3. **Q3（Claude 复审：0 blocker / 0 should-fix，但零运行）** 返工一 8 项均为"代码层关闭"，运行证据为零；本轮又因 Q1 停在第 1 步，仍然没有任何运行结论。
4. **Q4（Claude 建议，交 Codex 决定是否吸收）** 真实 App 测试补"父窗口确实失焦"断言；回收测试"恰好 4 个子进程"易受 conhost 干扰；中间层先死的孙进程与正常 Ctrl+C 下 45s 强杀两个回收缺口需实测；语音提交成功后输入框保留旧文案；保存失败持锁在 Windows 偶发占用会记为清理失败；父死测试绕开生产启动代码且仅 Windows；测试收尾删除 junction 可能导致清理假失败。
5. **Q5（本机覆盖边界）** 真实阿里语音/厂商识别/编码/Lux3D、真人 A/B、完整彩排仍未执行；Windows 真实控制台 Ctrl+C 只能以信号模拟，不能冒称实测。

## A6. 下一步

实现方在下一批统一返工里修 Q1（并处理 Q4 中决定吸收的建议）→ 冻结新提交 → 我从头再跑同一 `full-regression.mjs`。
本轮不改产品、不改测试、不自行派实现者、不 merge、不自动重跑。
---

# 附录：集中第三轮（返工二后）—— 编译已过，单测 3 失败，E2E 全部未执行

> 本轮**不是全仓单测通过**：server 实际 **375 passed / 3 failed（378）**；Studio 单测未启动；
> `demo-safety` 与全部 E2E（11 步）未执行。193（M4 19 + 旧 174）仍然只是**收集数**。

## B1. 受测身份

| 项 | 值 |
| --- | --- |
| 验收树 | `.worktrees/m4-acceptance`，分支 `test/m4-acceptance` |
| 受测 HEAD（测试侧） | `e863f261e0263e857c71cefd785bbed7c42e6f3d`（merge 返工二 `1aa5450`） |
| 冻结产品 | `1aa54500ebab4efd5cd457b94c145e71880990df` |
| 身份摘要 / 锁 | `453d220d74df…` / SHA256 `67af36b7a1b8a8ace1f03aa0ca9addf979f3842bdab3ff3dc4f56901b7d18960` |
| 产品/脚本/锁差异 | 相对 `1aa5450` **0 差异**（`productDiffVsAccepted=[]`） |
| 证据目录起跑前 | 脏项 **0** |

## B2. 实际执行与结果（命令失败与身份漂移分开）

| 步骤 | 结果 |
| --- | --- |
| typecheck | **exit 0 / 9s**：`7 of 8` 项目全 Done，**含 `apps/studio` 与 `templates/product-page`（Studio 类型检查首次实际执行）** |
| build | **exit 0 / 17s** |
| unit（`pnpm test`） | **exit 1 / 269s**：server **375 passed / 3 failed（378）** |
| demo-safety | 未执行 |
| M4 E2E（19） | 未执行 |
| 旧九套（174） | 未执行 |

- **命令失败**：`pnpm test` 退出码 1（`signal=null`）。
- **身份漂移：无**。该步 `problems` 只有退出码一条；起跑前 `evidenceDirtyAtStart=[]`；产品/脚本/锁与 `1aa5450` 字节一致。
- **单测分包（实际日志）**：shared 68、vite-plugin-source-tag 20、scene-renderer 5、bridge 1、**server 375 通过 / 3 失败 = 378**；**`apps/studio` 未启动**（server 首败即停）。
- 因此**不能**写"全仓单测通过"；也不改写成"测试失败 1 项"。

## B3. 三条失败（原文）

1. `src/assets/fallback-process-lifecycle.test.ts` › **a hard-killed asset parent loses its worker, preserves complete raw input and cleans owned staging on restart**
   `Error: Timed out waiting for deterministic model import barrier`（`fallback-process-lifecycle.test.ts:29`）
   —— 测试夹具的确定性"模型加载屏障"没有被触发（超时），属**测试侧/夹具**问题，产品语义未被证伪。
2. `src/assets/fallbacks.test.ts` › **fallback HTTP refuses client paths, URLs and provenance fields without creating work**
   `AssertionError: expected { kind: 'unknown' } to match object { kind: 'fallback', …(1) }`
   —— 期望 `kind: 'fallback'`，实际得到 `kind: 'unknown'`：需要判定是实现回归（采用/来源写回）还是断言已过时。
3. `src/assets/recovery.test.ts` › **does not resubmit after taskId persistence fails, even after restart**
   `Error: disk full`（`recovery.test.ts:85`）
   —— 注入的"磁盘已满"故障没有被用例自身吞掉，以未捕获错误抛出。

## B4. 清理与证据

- 静态核对时：3001/4011/5173/5174/5175 无监听；本树无自有 node/chrome；`templates`/`apps`/`packages`/`scripts` 脏项 0；无 `.model-stage-*` 残留；未执行任何 kill（没有需要回收的自有残留，也没有对未知归属进程动手）。
- 本步**未刷新任何 tracked 证据**（`evidenceArchived: []`）。
- 归档：`manifest.json`、`manifest.log`、`typecheck.log`、`build.log`、`unit.log`、`cleanup.json`、`launcher/`（job 的 cmd/exit/job.json/output.log）；
  `sha256-manifest.json` 登记 **10 个载荷、排除自身、静态复算 0 mismatch**。

## B5. 统一问题清单（合并返工二复审 0 必修 / 3 建议）

1. **R1（阻断，测试夹具）** `fallback-process-lifecycle` 的确定性加载屏障超时：需要修夹具（或让屏障在真实 worker 上可观测），不能放宽断言。
2. **R2（阻断，需定性）** `fallbacks.test.ts` 期望 `kind: 'fallback'` 实得 `kind: 'unknown'`：先判定是产品回归还是断言过时；不得为了变绿改产品语义。
3. **R3（阻断，测试侧）** `recovery.test.ts` 的 `disk full` 注入未收敛：需在用例内明确捕获/恢复，不能靠重试。
4. **R4（覆盖缺口）** `apps/studio` 单测、`demo-safety`、M4 19 例、旧九套 174（含 M1-B 23 像素）本轮**全未执行**；编译已确认通过（含 Studio），但"运行通过"仍无证据。
5. **R5（边界）** 真实 Windows 控制台 Ctrl+C、整链进程回收（backend/frontends/preview/check-Chromium/asset worker）、真实模板 iframe 点选与 HMR 端口仍需实测；本轮一条都没跑到。
6. **R6（未执行外部项）** 真实阿里语音/厂商识别/编码/Lux3D、真人 A/B、完整彩排未执行。

## B6. 下一步

实现/测试双方由 Codex 统一返工三（根 `17a9249`）处理 R1–R3；修复后我再从头跑同一 `full-regression.mjs`。
本轮不改产品、不改测试、不自行派实现者、不 merge、不自动补跑。
---

# 附录：集中第四轮（返工三后）—— 编译通过，单测换了一批 3 失败

> 仍然**不是全仓单测通过**：server **375 passed / 3 failed（378）**；Studio 单测未启动；`demo-safety` 与全部 E2E（11 步）未执行；193 仍只是收集数。
> 本轮三条失败与上一轮**不同**，其中第 1 条的日志被我的 runner 缺陷遮蔽，无法据现有原件回溯根因。

## C1. 受测身份

| 项 | 值 |
| --- | --- |
| 验收树 | `.worktrees/m4-acceptance`，分支 `test/m4-acceptance` |
| 受测 HEAD（测试侧） | `047cae7913dd2fbe15b43ba40186a7e06e232fee`（merge 返工三 `6fc11de`） |
| 冻结产品 | `6fc11de8d6e6fb67fdac8bbc5d9d8bfea3d446df` |
| 身份摘要 / 锁 | `f2c1184e1fd6…` / SHA256 `67af36b7a1b8a8ace1f03aa0ca9addf979f3842bdab3ff3dc4f56901b7d18960` |
| 产品/脚本/锁差异 | 相对 `6fc11de` **0 差异** |
| 证据目录起跑前 | 脏项 **0** |

## C2. 执行与结果（命令失败 / 身份漂移分开）

| 步骤 | 结果 |
| --- | --- |
| typecheck | exit 0 / 9s（含 `apps/studio`、`templates/product-page`） |
| build | exit 0 / 10s |
| unit | **exit 1 / 253s**：server 375 通过 / 3 失败（378） |
| demo-safety、M4 19、旧九套 174 | 未执行 |

- **命令失败**：`pnpm test` 退出码 1（`signal=null`）。
- **身份漂移：无**（`problems` 仅退出码；起跑 `evidenceDirtyAtStart=[]`；产品/脚本/锁与 `6fc11de` 字节一致）。
- 逐包实际数：shared 68、plugin 20、scene-renderer 5、bridge 1、server 375/378；**`apps/studio` 未启动**（server 首败即停）。不沿用历史通过数。

## C3. 三条失败与"能确认 / 无法回溯"

1. **`asset/fallback-process-lifecycle.test.ts:73`**
   `Error: ENOENT ... 2026-11-15T13-06-44-442Z-full\d2-browser\asset-parent-cleanup-38104.json`
   - **能确认**：失败发生在用例 `finally` 里写"清理诊断"这一步；目标目录 `d2-browser` 不存在（`cleanup.json` 里 `d2RunDir.exists=false` 已留证）。
     这个路径来自我的 runner：它把 `D2_RUN_DIR` 指向 `<run>/d2-browser` 却没有 `mkdir`，**属测试侧（我的入口）缺陷**。
   - **无法回溯**：诊断写入抛 ENOENT 后，原始断言/子进程错误/loader 阶段事件被覆盖，现有日志不足以判定该 fixture 究竟卡在屏障、IPC 还是早退。**不据此定性产品**。
2. **`asset/recovery.test.ts:96`** `AssertionError: expected undefined to be defined`（owner identity undefined）
   - 能确认：断言处拿到的"子进程所有者身份"是 `undefined`。
   - 无法回溯：本轮日志没有保留该子进程的早退/stderr 原始诊断，**不能先定性为 CIM 查询失败或产品缺陷**。
3. **`work/approvals.test.ts:452`**（`it.each(['cleanup','terminal-save'])('recovers another card before cancel, including repeated terminal-save failure')`）`Error: Test timed out in 5000ms.`
   - 能确认：5s 默认预算内未完成；上一轮该用例通过。
   - 无法回溯：新旧源码差异、并发负载只能静态核对；**不加超时、不重试重跑**（那会掩盖问题）。

## C4. 清理与证据

- 静态核对：3001/4011/5173/5174/5175 无监听；无自有 node/chrome；`templates`/`apps`/`packages`/`scripts` 脏项 0；**无 `.model-stage-*` 残留**；未执行任何 kill。
- 本步未刷新任何 tracked 证据（`evidenceArchived: []`）。
- 归档：`manifest.json`、`manifest.log`、`typecheck.log`、`build.log`、`unit.log`、`cleanup.json`（含 d2RunDir 证据）、`launcher/`；
  `sha256-manifest.json` **10 载荷、排除自身、0 mismatch**。

## C5. 统一问题清单（第四轮）

1. **S1（阻断，测试侧=我的入口）** runner 未创建 `D2_RUN_DIR`，导致 fixture 的清理诊断 ENOENT 并**遮蔽原始错误**。下一轮我需要：创建该目录、并让该 fixture 的失败诊断在目录不可写时也不覆盖原始断言（保留阶段事件/stdout/stderr/loader 字节）。
2. **S2（阻断，待诊断）** `recovery.test.ts:96` owner identity `undefined`：需先保存该子进程早退/错误原始诊断，再判定是测试夹具（CIM 早退）还是产品。
3. **S3（阻断，待诊断）** `approvals.test.ts:452` 5s 超时：需要静态 diff + 计时证据判定是新增真实子进程负载还是竞态；**不加超时/不重试**。
4. **S4（覆盖缺口）** Studio 单测、`demo-safety`、M4 19、旧九套 174（含 M1-B 23 像素）**全未执行**。
5. **S5（边界）** 真实 Windows 控制台 Ctrl+C、生产资产 worker 整链回收、真实模板 iframe 点选与 HMR 端口仍未跑到。
6. **S6（未执行外部项）** 真实阿里语音/厂商识别/编码/Lux3D、真人 A/B、完整彩排未执行。

## C6. 下一步

S1 由我（测试侧）在下一轮修入口；S2/S3 与实现/夹具问题一起进 Codex 的统一返工批次；修复后我仍从头跑同一集中入口。
本轮不改产品、不改测试、不自行派实现者、不 merge、不自动补跑。
---

# 附录：集中第五轮（返工四后）—— 编译通过，2 失败已定位到测试接线

> 仍然**不是全仓单测通过**：server **376 passed / 2 failed（378）**；Studio 单测、`demo-safety`、全部 E2E（11 步）未执行。
> 本轮两条失败都有**明确、可验证的测试接线根因**，不是产品合同被判坏。

## D1. 受测身份

| 项 | 值 |
| --- | --- |
| 验收树 | `.worktrees/m4-acceptance`，分支 `test/m4-acceptance` |
| 受测 HEAD（测试侧） | `d6d46e6e70c8876a0ef31861a83eb84ecdae957e`（merge 返工四 `c79fbfc`，Pi runner 修正在位） |
| 冻结产品 | `c79fbfca89e8a04161be42b4b0f9ee4943ab2da5` |
| 身份摘要 / 锁 | `3615ef0f8f5f…` / SHA256 `67af36b7a1b8a8ace1f03aa0ca9addf979f3842bdab3ff3dc4f56901b7d18960` |
| 产品/脚本/锁差异 | 相对 `c79fbfc` **0 差异**（`HEAD:apps = c79:apps = 18a5fd66…`） |
| 证据目录起跑前 | 脏项 **0** |

## D2. 执行与结果（命令失败 / 身份漂移分开）

| 步骤 | 结果 |
| --- | --- |
| typecheck | exit 0 / 9s（含 `apps/studio`、`templates/product-page`） |
| build | exit 0 / 10s |
| unit | **exit 1 / 243s**：server **376 passed / 2 failed（378）** |
| demo-safety、M4 19、旧九套 174 | 未执行 |

- **命令失败**：`pnpm test` 退出码 1（`signal=null`）。
- **身份漂移：无**（`problems` 仅退出码；起跑 `evidenceDirtyAtStart=[]`；产品/脚本/锁与 `c79fbfc` 字节一致）。
- 逐包实际数：shared 68、plugin 20、scene-renderer 5、bridge 1、server 376/378；**`apps/studio` 未启动**（server 首败即停）。不沿用历史通过数。
- **runner 修复生效（实测）**：unit 步骤 `preparedDirs = [{ label: 'D2_RUN_DIR', dir: '…/d2-browser', ok: true }]`，两份诊断文件真的写成了：
  `d2-browser/asset-lifecycle/cleanup-25608.json`（5990B）、`d2-browser/asset-recovery/persistence-25920.json`（5811B）。
- **`approvals.test.ts` 的 terminal-save 分支本轮通过**（失败数从 3 降到 2，总数 376 通过）；新增的阶段计时保留，但**不用它反推历史超时根因**。

## D3. 两条失败：根因已确认（测试接线，不是产品）

两条都是 `ERR_UNSUPPORTED_ESM_URL_SCHEME`：

```
Error [ERR_UNSUPPORTED_ESM_URL_SCHEME]: Only URLs with a scheme in: file, data, and node are supported
by the default ESM loader. On Windows, absolute paths must be valid file:// URLs. Received protocol 'e:'
```

1. **`fallback-process-lifecycle.test.ts`**（worker 在屏障前退出）
   - 阶段：`spawn 7.4ms → identity 124.5ms → cleanup 728.4ms`；事件 `ready(60372)` → `worker-spawned(23100)` → `worker-closed(23100, code 1, signal null)`，**exit 0 / signal null**；
   - 即：worker 启动后立刻因 **`--import` 收到裸 Windows 路径**（`E:\…`）被 ESM loader 拒绝，**根本没走到模型加载屏障**；
   - 失败现场按测试约定保留：`C:\Users\Admin\AppData\Local\Temp\fallback-parent-death-PxCzE3`（4 个文件，含 `assets/.instance.lock` 指向已退出 PID 60372、`index.json` 记录 `failed` + preset 来源）。
2. **`recovery.test.ts`**（persistence 在 entry 前退出）
   - 阶段：`spawn 5.6 → spawned 5.6 → preload 30.5 → IPC-disconnected 37.7 → exit:1 42.1 → closed:1 42.1 → cleanup 61.3ms`；
   - `exit 1`、`ipcDisconnected=true`、`messages=[]`、`stdout=""`，**stderr 同样是 `ERR_UNSUPPORTED_ESM_URL_SCHEME`** → 子进程在 preload 阶段就崩了，没进入被测的写盘失败路径；
   - 失败现场保留：`.data/recovery-test-z3E6cB`（0 文件，空目录）。

**结论（有证据）**：两处失败都发生在 **preload/`--import` 的 URL 形式**上（Windows 绝对路径需为 `file://`），归测试接线；**不能据此说产品的 asset 合同、实例锁或 worker 回收被跑坏**。根任务卡 `a4b545a` 返工五正是只修这两处 `--import` URL 接线。

## D4. 清理与证据

- 3001/4011/5173/5174/5175 无监听；本树无自有 node/chrome；`templates`/`apps`/`packages`/`scripts` 脏项 0；无 `.model-stage-*` 残留。
- 记录在诊断里的 PID 23100 / 25920 / 25608 / 60372 **全部 gone**；未执行任何 kill（没有活跃自有进程，历史现场按证据保留、不擅删）。
- 两处失败现场按**原字节**复制到本轮归档：`retained/fallback-parent-death/`、`retained/recovery-test/`，清单见 `retained-evidence.json`；原目录未删未改。
- 本步未刷新任何 tracked 证据（`evidenceArchived: []`）。
- 归档：`manifest.json`、`manifest.log`、`typecheck.log`、`build.log`、`unit.log`、`cleanup.json`、`retained-evidence.json`、`launcher/`、`d2-browser/`（两份诊断原文）；
  `sha256-manifest.json` **17 载荷、排除自身、静态复算 0 mismatch**。

## D5. 统一问题清单（第五轮）

1. **T1（阻断，测试接线，已定位）** 两处 `--import` 传裸 Windows 路径 → `ERR_UNSUPPORTED_ESM_URL_SCHEME`（协议 `e:`）：生命周期 worker 在屏障前退出、recovery 子进程在 entry 前退出。归返工五（`a4b545a`），**不改产品**。
2. **T2（已通过，保留观察）** `approvals.test.ts` terminal-save 本轮通过；阶段计时保留，不据此推断历史 5s 超时的根因。
3. **T3（覆盖缺口）** Studio 单测、`demo-safety`、M4 19、旧九套 174（含 M1-B 23 像素）本轮全部未执行。
4. **T4（保留现场）** 两处失败现场（temp 4 文件 / `.data` 空目录）按其自身约定保留，未清理；待 T1 修复后由集中轮重新产生"干净"证据再评估是否可清。
5. **T5（边界）** 真实 Windows 控制台 Ctrl+C、生产资产 worker 整链回收、真实模板 iframe 点选与候选 HMR 端口仍未跑到；真实阿里/厂商识别/编码/Lux3D、真人 A/B、完整彩排未执行。
6. **T6（审查缺口）** Claude 独立复审因三次外部 ECONNRESET 仍无报告；本轮的"运行到但失败"**不构成**审查通过。

## D6. 下一步

返工五（`a4b545a`，仅两处 `--import` URL）冻结后，我仍从头跑同一 `full-regression.mjs`。
本轮不改产品/测试、不派实现者、不 merge 主线、不自动补跑。
---

# 附录：集中第六轮（返工五后）—— server 全过，Studio 首次运行 118/142

> 仍然**不是全仓通过**：shared/plugin/renderer/bridge/server 全过（server **378/378**），
> **`apps/studio` 首次实际运行：118 passed / 24 failed（142）**；`demo-safety`、M4 19、旧九套 174 **全部未执行**。

## E1. 受测身份

| 项 | 值 |
| --- | --- |
| 验收树 | `.worktrees/m4-acceptance`，分支 `test/m4-acceptance` |
| 受测 HEAD（测试侧） | `2463dd15015fbba89f4868fe4ebda27e49ec7ee8`（merge 返工五 `1722861`） |
| 冻结产品 | `17228617b46acb66f1e1d4999328f755fc084aaf` |
| 身份摘要 / 锁 | `d19da6319be6…` / SHA256 `67af36b7a1b8a8ace1f03aa0ca9addf979f3842bdab3ff3dc4f56901b7d18960` |
| 产品/脚本/锁差异 | 相对 `1722861` **0 差异**（`HEAD:apps = 172:apps = 48e15880…`） |
| 证据目录起跑前 | 脏项 **0**；unit 步骤 `preparedDirs = D2_RUN_DIR ok=true` |

## E2. 逐包实际计数（命令失败 ≠ 身份漂移）

| 包 | 结果 |
| --- | --- |
| shared | 68 passed（2 files） |
| vite-plugin-source-tag | 20 passed（3 files） |
| scene-renderer | 5 passed（1 file） |
| bridge | 1 passed |
| **server** | **378 passed / 378（49 files 全过）** |
| **apps/studio** | **118 passed / 24 failed（142，19 files 中 2 文件失败）** |
| demo-safety / M4 19 / 旧 174 | 未执行 |

- **命令失败**：`pnpm test` 退出码 1（`signal=null`）。
- **身份漂移：无**（`problems` 仅退出码；`evidenceDirtyAtStart=[]`；产品/脚本/锁与 `1722861` 字节一致）。
- **首次实际执行的两条资产夹具通过**（按真实诊断 JSON，不是推断）：
  - `asset-lifecycle/cleanup-12216.json`：`spawn 7.7 → identity 128.6 → barrier 794.8 → kill-parent 795.0 → autonomous-worker-exit 826.8 → restart 1397.5 → assertions-complete 1964.1ms`，
    `primary: null`、`autonomousWorkerExit: true`、`cleanupKills: []`、stderr 为空 → 自主退出、raw 保留、重启清理 staging 的断言均通过。
  - `asset-recovery/persistence-27380.json`：`preload 36.2 → entry-imported 67.3 → identity 123.9 → held 752.1 → kill 754.4 → IPC-disconnected 756.5 → exit SIGKILL → restart 1315.8 → assertions-complete 1564.2ms`，`primary: null` → 写盘失败持锁 + 死亡 PID 接管断言通过。
  - **边界**：这是**测试替身链路**（模型加载用替身屏障、父进程 preload 注入），**不等于**生产 `process-isolated` 的完整优化/发布链已被验证。
- **审批 `terminal-save` 本轮通过**（上轮已通过），阶段计时保留；不据此反推历史 5s 超时根因。

## E3. Studio 24 条失败（原文与映射，不普遍同因）

- 失败文件：`src/speech-browser.test.ts`（**23 failed**）、`src/speech-app.browser.test.ts`（**1 failed**）。
- **日志里 47 段 `FAIL` 不是 47 个测试**：实际失败测试 = 24，日志把同一批又以摘要形式重复打印了一次（24 + 23 = 47 段）。
- `speech-browser.test.ts` 的 23 例**共用同一个页面错误 + 前置钩子超时**：
  ```
  → Hook timed out in 10000ms.
  +  "The requested module '/@fs/…/node_modules/.pnpm/react@19.3.1/node_modules/react/jsx-dev-runtime.js?v=78e592dc'
      does not provide an export named 'jsxDEV'"
  ```
  即该 fixture 的 Vite 依赖预构建/模块解析把 `react/jsx-dev-runtime` 解析成了 dev runtime 但未提供 `jsxDEV`，`beforeEach` 起页即失败；`afterEach` 再重复报错。**能确认**的是"起页阶段模块解析失败 + 钩子 10s 超时"；**不能**逐例断言这 23 条都是同一个独立产品缺陷——它们共享同一前置失败。
- `speech-app.browser.test.ts` 的 1 例**另有原文**，不要一概同因：
  ```
  × real App keeps review across cross-origin iframe pick pending and WS reconnect, then frees the submitted binding 5708ms
  → expect(locator).toHaveAttribute(expected) failed
  Locator: getByTestId('events-status')  Expected: "connected"  Timeout: 5000ms
  Error: element(s) not found
  ```
  能确认：该用例里 `events-status` 元素**始终没有出现**（连元素都没有，不是状态值不同）。它是否由 `jsxDEV` 那条页面错误导致，**现有日志无法证明**，因此**不合并归因**。

## E4. 清理与证据

- 3001/4011/5173/5174/5175 无监听；本树无自有 node/chrome；`templates`/`apps`/`packages`/`scripts` 脏项 0；无 `.model-stage-*` 残留；未执行任何 kill。
- 诊断记录里的 PID 51932 / 51412 / 25896 / 12216 / 27380 **全部 gone**。
- **本轮两条资产夹具成功并自行清理了自己新建的现场**（无新 `fallback-parent-death-*` 目录）；历史保留现场按"不擅删"原则保留，并把上一轮未归档的 `fallback-parent-death-1Z4Qum`（创建于 `2026-11-15T13:07:08Z`，第四轮）按原字节补档；`retained-evidence.json` 记录三个现场的存在、归属、逐文件 SHA256。
- 归档内容：`manifest.json`、`manifest.log`、`typecheck.log`、`build.log`、`unit.log`、`cleanup.json`、`retained-evidence.json`、`launcher/`、
  `d2-browser/`（**23 组 component JSON+PNG**、`component-cleanup.json`、`real-app-cleanup.json`、`asset-lifecycle/cleanup-12216.json`、`asset-recovery/persistence-27380.json`）；
  `sha256-manifest.json` **65 载荷、排除自身、静态复算 0 mismatch**。

## E5. 统一问题清单（第六轮）

1. **U1（阻断，测试夹具）** `speech-browser.test.ts` 起页模块解析失败：`react/jsx-dev-runtime.js` 未提供 `jsxDEV`，导致 `beforeEach` 10s 超时（23 例共享）。归根任务卡 `6bfd58b` 返工六（浏览器 fixture 加载/启动诊断），**不动生产**。
2. **U2（阻断，需单独诊断）** `speech-app.browser.test.ts` 唯一失败：`events-status` 元素从未出现；与 `jsxDEV` 的因果关系**未证明**，需独立证据（返工六同批）。
3. **U3（已通过，保留观察）** 两条资产夹具（自主退出 / 死 PID 接管）本轮首次真实通过，但仅证明**替身链路**，生产完整 optimize/publish 链仍未覆盖。
4. **U4（覆盖缺口）** `demo-safety`、M4 独立 19、旧九套 174（含 M1-B 23 像素）**全部未执行**。
5. **U5（边界）** 真实 Windows 控制台 Ctrl+C、生产资产 worker 整链回收、真实模板 iframe 点选与候选 HMR 端口仍未跑到；真实阿里/厂商识别/编码/Lux3D、真人 A/B、完整彩排未执行。
6. **U6（审查缺口）** Claude 独立复审仍无正式报告；server 全过**不等于** M4 收口。

## E6. 下一步

返工六（`6bfd58b`，仅浏览器 fixture 加载/启动诊断）冻结后，我仍从头跑同一 `full-regression.mjs`。
本轮不改产品/测试、不派实现者、不 merge 主线、不自动补跑。
---

# 附录：集中第七轮（返工六后）—— server 全过，Studio 141/142，仅剩 1 例

> 仍**不是全仓通过**：shared/plugin/renderer/bridge/server 全过（server **378/378**），
> **Studio 141 passed / 1 failed（142）**；`demo-safety`、M4 19、旧九套 174 **全部未执行**。
> 上一轮的 `jsxDEV` 与真实 App 启动失败**本轮未再出现**（有 ready 证据），但**不等于产品全部通过**。

## F1. 受测身份

| 项 | 值 |
| --- | --- |
| 验收树 | `.worktrees/m4-acceptance`，分支 `test/m4-acceptance` |
| 受测 HEAD（测试侧） | `eba163282b744efe0d9550def18a7b3d1b3767f9`（merge 返工六 `7f300f1`） |
| 冻结产品 | `7f300f120c7b7e8947979f008bb19923d36077f3` |
| 身份摘要 / 锁 | `1d74f3853a52…` / SHA256 `67af36b7a1b8a8ace1f03aa0ca9addf979f3842bdab3ff3dc4f56901b7d18960` |
| 产品/脚本/锁差异 | 相对 `7f300f1` **0 差异**（`HEAD:apps = 7f3:apps = e47ebc1e…`） |
| 证据目录起跑前 | 脏项 **0**；unit 前 `preparedDirs = D2_RUN_DIR ok=true` |

## F2. 逐包实际计数（命令失败 ≠ 身份漂移）

| 包 | 结果 |
| --- | --- |
| shared / plugin / renderer / bridge | 68 / 20 / 5 / 1 全过 |
| server | **378 passed / 378（49 files 全过）** |
| **apps/studio** | **141 passed / 1 failed（142；1 file 失败）** |
| demo-safety / M4 19 / 旧 174 | 未执行 |

- **命令失败**：`pnpm test` 退出码 1（`signal=null`）。
- **身份漂移：无**（`problems` 仅退出码；`evidenceDirtyAtStart=[]`；产品/脚本/锁与 `7f300f1` 字节一致）。
- **回退的进展（有原件）**：`component-cleanup.json` 的 `vite.optimizeDeps` 已含 `react/jsx-dev-runtime`，`errors: []`、`remaining: []`、`serverListening:false`；
  `real-app-cleanup.json`：`stage=interaction`、`bootstrap.ready=true`（`navigate 14.5 → event-center-ready 188.0 → interaction 333.9ms`）、`pageErrors: []`、`denied: []`、`chromium exit 0`
  → 上一轮的 `jsxDEV` 23 例与真实 App 起页失败本轮**均已消失**。

## F3. 唯一剩余失败（原文 + 互动证据）

`src/speech-browser.test.ts` › **abnormal native pointer-capture loss cancels without uploading**

```
Error: Matcher did not succeed in time.
 ❯ src/speech-browser.test.ts:140:104
Caused by: AssertionError: expected 1 to be +0   // Object.is equality
- Expected 0  + Received 1
```

- 该断言轮询的是 `window.__speechTest.liveTracks`：**`liveTracks` 在 30s 内始终为 1**（期望 0）。
  即：`releasePointerCapture(...)` + `mouse.move(20,20)` 这条"异常丢失指针捕获"路径**没有触发停止录音**。
- 对应诊断 `d2-browser/component/6.json`（按 test 名匹配）：
  - `posts: []`、`deletes: []` → **全程没有上传、没有 DELETE**（没有网络/计费泄漏）；
  - `pageErrors: []`、`denied: []`；
  - 交互期 `beforeUnmount = { streams:1, liveTracks:1, recorderStarts:1, recorderStops:0 }`，
    卸载后 `afterUnmount = { liveTracks:0, recorderStops:1 }` → **只有卸载才停**，异常路径本身没停；
  - `bootstrap.ready=true`（`navigate-component 0.4 → react-component-mounted 68.7 → speech-config-ready 133.4ms`）。
- **能确认**：该用例的页面已就绪、无 pageerror、无网络请求，失败点是**异常指针捕获丢失未触发取消/停录**。
- **不能确认**：这是产品取消路径缺陷，还是"合成 `releasePointerCapture` 在无头 Chromium 下不等价于真实指针捕获丢失"。归返工七静态定位（CodeBuddy 正在做），**本轮不预判**。

## F4. 清理与证据

- 3001/4011/5173/5174/5175 无监听；本树无自有 node/chrome；`templates`/`apps`/`packages`/`scripts` 脏项 0；无 `.model-stage-*` 残留。
- 三个夹具的自清理证据：`component-cleanup.json`（chrome 39652 + 3 子进程、`remaining: []`、端口关闭、`errors: []`）、
  `real-app-cleanup.json`（chromium 64020 exit 0、两个端口均 `Listening:false`）、`asset-lifecycle/cleanup-18956.json`（`primary:null`、`autonomousWorkerExit:true`、`cleanupKills:[]`）、
  `asset-recovery/persistence-56468.json`（`primary:null`、SIGKILL 后 restart 断言完成）。
- **PID 复用如实记录**：逐 PID 复核时 18956 一度被 `conhost.exe` 复用（随后自行消失）——它不是我们的进程，**未做任何处理**；这也说明"按 PID + 创建时间"归属必须继续保留。
- 本轮 fixture 目录 `fallback-parent-death-NmrcM3` **成功路径已自清**；历史两个现场（`1Z4Qum` 第四轮、`PxCzE3` 第五轮）继续保留，不删不改。
- 归档：`manifest/log/typecheck/build/unit`、`cleanup.json`、`launcher/`、`d2-browser/`（**23 组 component JSON+PNG**、三个 cleanup/asset 诊断）；
  `sha256-manifest.json` **62 载荷、排除自身、静态复算 0 mismatch**。

## F5. 统一问题清单（第七轮）

1. **V1（阻断，待定位）** `pointer-capture loss` 异常路径未停录（`liveTracks` 1≠0），但无上传/无 pageerror。需判定"产品取消路径缺陷"还是"无头环境下合成 pointer 事件的等价性问题"（返工七静态定位）。
2. **V2（已消除）** 上一轮 `jsxDEV` 23 例与真实 App 起页失败本轮未再出现，且有 `ready`/`optimizeDeps` 证据；仍需后续完整轮确认不是偶然。
3. **V3（覆盖缺口）** `demo-safety`、M4 独立 19、旧九套 174（含 M1-B 23 像素）**全部未执行**。
4. **V4（边界）** 真实 Windows 控制台 Ctrl+C、生产资产 worker 整链、真实模板 iframe 点选与候选 HMR 端口未跑到；真实阿里/厂商识别/编码/Lux3D、真人 A/B、完整彩排未执行。
5. **V5（审查缺口）** Claude 独立复审仍无正式报告；141/142 **不是** M4 验收结论。

## F6. 下一步

返工七（静态定位 V1）冻结后，我仍从头跑同一 `full-regression.mjs`。
本轮不改产品/测试、不派实现者、不 merge 主线、不自动补跑。
---

# 附录：集中第八轮（返工七后）—— **614 单测全过**，停在 demo-safety 的 1 项

> 首次做到 **单测全绿**：shared 68 + plugin 20 + scene-renderer 5 + bridge 1 + server 378 + **Studio 142/142** = **614**。
> 但 `demo-safety` 10 项中 **9 过 1 败**；M4 独立 19 与旧九套 174（合计 193）**全部未执行**。
> 因此本轮**不是**"全仓通过"，也没有任何 E2E 结论。

## G1. 受测身份

| 项 | 值 |
| --- | --- |
| 验收树 | `.worktrees/m4-acceptance`，分支 `test/m4-acceptance` |
| 受测 HEAD（测试侧） | `ba3e61bd0e32ac8b51a44b04c7a52a8af0b04690`（merge 返工七 `97bd686`） |
| 冻结产品 | `97bd68652108b808b8f5de9117ceefd8a8c888f9` |
| 身份摘要 / 锁 | `dad99fd6ba1c…` / SHA256 `67af36b7a1b8a8ace1f03aa0ca9addf979f3842bdab3ff3dc4f56901b7d18960` |
| 产品/脚本/锁差异 | 相对 `97bd686` **0 差异**（`HEAD:apps = 97b:apps = 017d26c1…`） |
| 证据目录起跑前 | 脏项 **0** |

## G2. 执行与计数（命令失败 ≠ 身份漂移）

| 步骤 | 结果 |
| --- | --- |
| typecheck | exit 0 / 7s（含 `apps/studio`、`templates`） |
| build | exit 0 / 8s |
| unit | **exit 0 / 218s：614/614 全过**（68+20+5+1+378+142） |
| **demo-safety** | **exit 1 / 11s：10 项 9 过 1 败** |
| M4 19 / 旧九套 174 | 未执行 |

- **身份漂移：无**（`evidenceDirtyAtStart=[]`；产品/脚本/锁与 `97bd686` 字节一致）。
- **上一轮 V1 的 pointer-capture 用例本轮通过，且有原生事件原件**（`component/6.json`）：
  ```
  pointerdown        trusted id=1 buttons=1 capture=false tracks=0
  gotpointercapture  trusted id=1 buttons=1 capture=true  tracks=1
  lostpointercapture trusted id=1 buttons=1 capture=false tracks=1   ← 同一指针、仍按住、此间无 pointerup
  ```
  随后 `beforeUnmount = { liveTracks:0, recorderStops:1 }`、`posts=[]`、`deletes=[]`、`tasks=[]`、`primary=[]`（即通过）。
  → 事件前提（trusted got/lost、同 ID、buttons=1、无 up）**成立**，异常失捕获确实触发了停录与零上传。

## G3. demo-safety 唯一失败（原文，暂不定性）

`scripts/demo/body.test.mjs:72` 的用例 **orphan watchdog terminates identified worker descendants after parent IPC closes, not unrelated processes**（6617ms），
在 `body.test.mjs:83` 断言：

```
AssertionError: The input did not match the regular expression /DEMO_ORPHAN_TIMEOUT/. Input: ''
```

- **能确认**：被检查的 `run.closed.stderr` 是**空字符串**，与期望的 `DEMO_ORPHAN_TIMEOUT` 不匹配；这是该用例中**第一条失败断言**。
- **不能确认（且不能当作结论）**：断言在 `:83` 就抛错，**其后的后代逐个退出、cleanup JSON 归属断言都没有执行**；因此**既不能说"自主回收失败"，也不能说"回收成功"**。
- **原件缺口**：该用例自身未保留诊断——本轮归档时 `.data/demo-runs` **不存在**、临时目录已按其 `finally` 自清；日志里也只有用例名与耗时，没有 PID/创建时间/cleanup 记录。
  **无法回溯**它究竟是"没写出 DEMO_ORPHAN_TIMEOUT"、"输出走了别的通道"还是"超时被别的分支吞掉"，不臆造。
- 其余 9 项通过（prepare 白名单/诱饵 env/junction、plan 校验、网络守卫、mock+real 预览端口与 SIGINT、mock 环境隔离、端点拒绝、real 需显式配置、拷贝白名单）。

## G4. 清理与证据

- 3001/4011/5173/5174/5175 无监听；本树无自有 node/chrome；`templates`/`apps`/`packages`/`scripts` 脏项 0；无 `.model-stage-*` 残留；`.data/demo-runs` 不存在。
- 未执行任何 kill；历史上两个保留现场（`fallback-parent-death-1Z4Qum` / `PxCzE3`）继续保留，不删不改。
- 归档：`manifest.json`、`manifest.log`、`typecheck.log`、`build.log`、`unit.log`、`demo-safety.log`、`cleanup.json`、`launcher/`、
  `d2-browser/`（**23 组 component JSON+PNG**、三个 cleanup、asset-lifecycle/asset-recovery 诊断）；
  `sha256-manifest.json` **63 载荷、排除自身、静态复算 0 mismatch**。

## G5. 统一问题清单（第八轮）

1. **W1（阻断，待诊断）** `demo-safety` 的 orphan-watchdog 用例：`run.closed.stderr` 为空、缺 `DEMO_ORPHAN_TIMEOUT`；后续回收断言未执行，**不定性**。已按根任务卡 `0210911`（diagnose-orphan-before-retry）暂停 full、交由 CodeBuddy 做一次有界 focused 诊断。
2. **W2（已关闭，有原件）** 上一轮 pointer-capture 用例通过，原生 got/lost 前提与"轨道归零 / stops=1 / 零上传 / 无 tasks"齐全。
3. **W3（覆盖缺口）** M4 独立 19 与旧九套 174（**10 套 / 193 例**，含 M1-B 23 像素）**全部未执行**。
4. **W4（边界）** 真实 Windows 控制台 Ctrl+C、生产资产 worker 整链、真实模板 iframe 点选与候选 HMR 端口未跑到；真实阿里/厂商识别/编码/Lux3D、真人 A/B、完整彩排未执行。
5. **W5（审查缺口）** Claude 独立复审仍无正式报告；**614 单测全绿不等于 M4 验收通过**。

## G6. 下一步

按根 `0210911`：**暂停 full**，CodeBuddy 只做一次有界 focused 诊断（成品保持不变），定位 W1 后再决定是否重跑集中轮。
本轮不改产品/测试/runner、不派实现者、不 merge 主线、不自动补跑。

## H. 唯一一次从头完整回归（job_b72fc460）

### H1. 身份与启动

- **受测 HEAD**：`3c0cc27bde1de33f8889166c5edf8d67b290d5ae`（`test/m4-acceptance`）。产品 `ea32d48`、源测试 `4d34bce` 在该提交上 **0 diff**（本轮只改测试侧 helper 与 docs）。
- 启动方式：`orbital\coordination\m2-takeover\bg-root.cmd "cd /d .worktrees\m4-acceptance&& node tests\e2e\m4\full-regression.mjs"`，job `job_b72fc460`，**exit 0，23m31s**。
- run 目录：`docs/reports/artifacts/M4/regression/2026-11-15T19-55-14-051Z-full/`；runner 未改（`tests/e2e/m4/full-regression.mjs` 原样），`--retries=0 --workers=1`，原始预算与像素阈值不变，`skip/flaky` 均为 0。
- 启动原命令与退出记录按原字节保全在 `launcher/`（`cmd`、`exit`、`job.json`、`output.log`、`path`），另附 `launcher-mapping.json`。

### H2. 14 步全通过（runner 判定：每步 `ok=true`、`problems=[]`）

| 步骤 | 结果 | 计数（来自该步 JSON 报告） |
| --- | --- | --- |
| typecheck | ok | — |
| build | ok | — |
| unit（`pnpm test`） | ok | **614**：shared 68 / vite-plugin-source-tag 20 / scene-renderer 5 / bridge 1（node:test）/ server 378 / studio 142 |
| demo-safety（`scripts/demo/safety.test.mjs`） | ok | **23/23**（tests 23 / pass 23 / fail 0 / skipped 0） |
| M4 E2E（`playwright.m4.config.ts`） | ok | 19 |
| M0-B | ok | 24 |
| M0-A | ok | 27 |
| M1-A | ok | 7 |
| **M1-B** | ok | **23** |
| M2-A | ok | 35 |
| M2-B | ok | 12 |
| M3-A | ok | 11 |
| M3-B | ok | 7 |
| M3-C | ok | 28 |

- E2E 合计 **193**（19+24+27+7+23+35+12+11+7+28），断言/脚本/单元合计 **830**。
- 10 份 `*-results.json` 逐 test 核对：`expected` 与 `tests` 相等、每例**单 result**、`passed`、`retry=0`、报告 `errors[]` 为空、无 `skipped/flaky`。
- **后五套 93 例**（M2-A 35 / M2-B 12 / M3-A 11 / M3-B 7 / M3-C 28）这次是实际执行并通过，不是沿用历史成绩。
- 首败即停逻辑未触发（无失败步骤），`notExecuted` 未产生。

### H3. M1-B 本次实际跑通的原始证据（本轮新采样，不外推）

- 四次界面操作真实返回 **HTTP 200**（三次 `PUT /scene` + 一次 `POST /scene/undo`），`errors[]` 为空：
  计时**取自本 full run 的 `fixed-additions/` 里那 4 份 sampling JSON**（`startedAt` 与 `elapsedMs` 原值）：
  consistency 写入 `startedAt=1794773046733` / **1214ms** / 差异 0.08334033201758069；
  writeback 写入 `1794773062043` / **1159ms** / 0.08191260043111895；
  undo 前写入 `1794773071358` / **1202ms** / 0.10085803868872652；
  undo 恢复 `1794773072563` / **1102ms** / **0**。
  （更正：本节早先误抄了 focused 轮的 1242/1200/1240/1253ms —— 那组数字属于 `2b70dac` 归档的 focused run；
  以上数值取自本 run 的原始 JSON，两者不再混用。）
- 三次写入期间预览可见高度先为 **341**（"同步/写回尚未就绪"），约 1.2 秒后**自然回到 378**；末次采样满足严格同窗口（坐标/rect/viewport/backing，无 1px 容差）后才用基线窗口比较。
- adopt：`sceneRestored=true`、`sidecarBytesMatch=true`、`cleanupErrors=[]`（GLB/parts 清理、sidecar 按原字节恢复）。
- 这组证据只说明**本次** 23 例的时序，不用来倒推此前 full 轮或 focused 轮当时发生了什么。

### H4. 证据归档

- **suite 刷新证据**：`evidence-refresh/` 保留本轮各步刷新过的已跟踪证据新字节（e2e-m0a 29、e2e-m0b 21、e2e-m1a 7、e2e-m1b 23、e2e-m2a 35、e2e-m2b 12、e2e-m3b 8，共 135 个），随后按 `HEAD` blob 逐文件还原并核对 `hash-object` 与 `status`。
- **固定 artifact 目录新增文件**：runner 只扫已跟踪证据，不会自动归档新增文件。本轮新增 **32 个**（M1-B 8 + M3-B `formal-20261115/checks` 6 + M3-C 18）先原字节保全到 `fixed-additions/<原相对路径>`，写 `fixed-additions-mapping.json`（`originalPath/mode=100644/bytes/sha256/archivedPath/byteEqual/removedFromFixedDir`），核对字节后**逐文件**删除固定目录副本（单文件删除，未用 `git clean/reset`、未删历史 tracked 或历史 run 原件）。
- 运行输出全部保留：`d2-browser/`、`e2e-*-output/`、`e2e-*-results.json`、各步 `.log`、`manifest.json`、`manifest.log`、`post-run-hygiene.json`。
- `sha256-manifest.json`：**291 个 payload**，排除自身，静态复算 0 不符；清单自身 sha256 = `d74d1388edf8dc0aef79d29c67ba3f80ff1ace031723f1036a17686743e0cd99`（本轮 docs 归档提交的锚点）。
- **原字节（CRLF）不静默 LF 化**：`launcher/exit` 原始内容是 `0 0\r\n`；仓库 `core.autocrlf=true` 会把它规范化，因此 run 目录放了局部 `.gitattributes`（`launcher/exit -text`）。已用 `git cat-file blob` 复核：入库 blob 5 字节、十六进制 `3020300d0a`，与磁盘一致；291 个条目全部按 Git 对象字节（不是工作树、不受过滤器影响）逐条比对通过。
- 本 run 目录内无嵌套仓库/符号链接，因此**没有新增 gitlink**；`docs/reports/artifacts/M4/...` 里原有的那 1 条历史 gitlink（`...work-data/candidates/ffac7609...`）未改动。

### H5. 运行后卫生（只读核对，`post-run-hygiene.json`）

- 端口 3001/4010/4011/5173/5174/5175：`netstat` 查询成功（`ok`），**未见 LISTENING** → 记为 `absent-as-observed`。
- 本树 node/chrome：CIM 查询成功，命令行含 `m4-acceptance` 的匹配数 **0** → `absent-as-observed`。
- `templates/`、`apps/`、`packages/`、`scripts/` 的 `git status` 全空；证据目录内除本 run 目录外无新增/修改；模板 `public/assets` 只有历史基线三件（`diffuser-4969889.glb`、`diffuser-4969889.provenance.json`、`parts.json`）。
- `unknown` 一律不当作 gone（本轮查询返回 `ok`，故按"本次未见"记录，不作为"证明不存在"）。

### H6. 审查结论与未执行项

- 审查**已完成**，不再欠审查：M1-B 正式审查 `ccdc609`（`docs/reports/M4-M1B-sampling-review.md`，0 blocker / 0 should-fix / 3 建议，本卡未实现建议）；watch-gate 审查 `772c591`（`docs/reports/M4-watch-gate-review.md`，0 blocker / 0 should-fix / 4 建议，同样只记录）。
- **未执行、不得视为已验证**：真实 Windows 控制台 Ctrl+C 交互、真实阿里云语音 / 真实厂商识别 / 真实编码模型 / 真实 Lux3D、真人 A/B 演示走查、完整演示彩排。本报告只覆盖 fake key / loopback / 白名单下的自动化回归。
- 归档身份：原归档 `757b3f47a3088d7cd4d3031d208d3bf998382c8e` 的父提交为受测 `3c0cc27bde1de33f8889166c5edf8d67b290d5ae`；补档 `9752bf0100af3276d43ab453c0699e185388c111` 的父提交为 `757b3f4`。两次都只改 docs，受测源代码没有变化。（更正：`ccdc609` 只是主树 M1-B 审查报告的提交，不是验收树归档的父提交。）

### H7. 补档：`757b3f4` 漏掉的运行时自有产物（`supplement-owned-runs/`）

`757b3f4` 的原 291 条载荷只覆盖 runner 自己写进 run 目录的内容，**漏掉了测试运行时落在 `.data/` 下的自有产物**（orphan 分支证据、真实 demo run 及其 plan.json/manifest）。本次补档按原字节补进**同一个** run 目录的 `supplement-owned-runs/`；原 291 清单、原 JSON、真实源目录一律不改不删。

**归属核对（不是按时间新旧猜）**

| 补档对象 | 归属证据 | 结论 |
| --- | --- | --- |
| `.data/demo-script-evidence/68828-1794772762028`、`…768904`、`…773742` | 每份 `orphan/<kind>/result.json` 的 `pid=68828`、`cleanupErrors=[]`；`begun` = 19:59:16.678Z / 19:59:22.061Z / 19:59:28.930Z，全落在 **demo-safety 步**窗口 19:59:12.108Z–19:59:33.792Z；kind = hard-kill / disconnect-hung / normal-close；生成者 `scripts/demo/test-support/orphan-case.mjs` 目录名即 `${process.pid}-${Date.now()}` | 本 run 的 demo-safety 步 |
| `.data/demo-runs/2026-11-15T19-59-59.459Z-9f3e7b64…`、`…20-00-02.858Z-562cbd1f…`、`…20-00-21.729Z-c05a4e68…`、`…20-00-23.833Z-0303c0ee…` | 各自 `manifest.json`：`head=3c0cc27`、`mode=mock`、`createdAt` = 19:59:59.462Z / 20:00:02.862Z / 20:00:21.732Z / 20:00:23.836Z，全落在 **e2e-m4 步**窗口 19:59:35.420Z–20:00:34.061Z；3 个 `status=stopped` + 1 个 `status=running`（hard-kill 用例故意留下） | 本 run 的 M4 E2E 步 |

- **复制**：363 个普通文件逐字节复制并复算（0 不符），保持 `demo-script-evidence/<dir>/…` 与 `demo-runs/<runId>/…` 结构；每个文件的 `source / archivedPath / bytes / sha256 / byteEqual` 都写在 `supplement-owned-runs/mapping.json`。
- **显式省略的缓存（352 个文件，205,921,292 字节）**：`demo-runs/<runId>/cache-<name>/…`（Vite optimizeDeps，88 个/轮）与 `demo-runs/<runId>/work-data/preview-cache/…`（预览依赖缓存）。每个省略文件在 `mapping.json` 的 `omitted` 里都有 `source/bytes/sha256/reason`，不是"只挑 manifest 就算完整"。
- **符号链接不跟随**：顶层映射记录 40 个 `work/node_modules/@spatial/*` 一类链接，只记 `source` 与原始 `target`；两个候选容器各另记录 10 个链接，共 60 个，Codex 已逐一核对目标文本。
- **嵌套 candidate 仓库（2 个）物化**：`work-data/candidates/9143e852…` 与 `4f0a997c…` 用现有 `materializeContainer` 打成 flat payload（各 15 个 `payload-*.bin`，其中各含 1 份惰性 `.git` 指针原始字节），各自带 `mapping.json`（`digest`、原始路径、每个 payload 的 sha256）；**不跟随 `.git`、不制造 gitlink**。
- **独立清单**：`supplement-owned-runs/sha256-manifest.json` 只覆盖补档目录自身（**397 条**，排除自身，静态复算 0 不符，清单 sha `9d1ef183eb1b8947710aef26af05239212d83ef1f58c695bad67732a3cd18c9e`）；提交后按 `git cat-file blob` 的 Git 对象字节逐条复核 **397/397 一致**；原 `sha256-manifest.json`（291 条，sha `d74d1388…`）**未改动**（与父提交逐字节比对相同）。
- **CRLF 原字节不被规范化**：demo 模板与部分证据是 CRLF，仓库 `core.autocrlf=true` 会把它 LF 化；补档目录放了局部 `.gitattributes`（`* -text`），并用 `git add --renormalize` 重算已暂存字节，最终以 Git 对象字节核对通过（不是靠工作树 `stat`）。
- **范围偏差记录（不重写历史）**：早前把 `orbital/jobs/job_b72fc460/path` 当作 launcher 原件复制进了 `launcher/`，而前一张卡明确禁止复制该文件。这里只记录偏差：**不再读取/不复述其内容、不再复制**，也不重写历史、不改动原 291 清单。
