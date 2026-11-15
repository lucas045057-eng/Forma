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