# 17132b6 类型入口整批补修

- 起点：`feat/lux3d-workbench` 的 `17132b679db3ed13449d8fbd5164727f3a4bdcc7`；旧 run `.data/lux3d-entry-typecheck/2026-11-16T10-04-49-529Z/` 保留不改。
- 旧 run：job `job_c1c651f7`，exit 2，受测 HEAD 未变、identityStable=true；`typecheck` 输出 14 条 server 诊断；build/unit/safety/E2E 未执行。
- 本批只修类型与入口 runner；F1–F8 的权限、预算、引用审计、状态语义和安全断言全部保留。

## 14 条诊断的修复

1. `assets/lux3d-task-store.ts` TS7022：定义 `PersistedLuxTask = LuxTask & { keyHash?: string }`，`tasks` 用该类型；`findKey` 直接读 `item.keyHash`，保留反序列化字段校验，不用 `any`。
2. `assets/lux3d-upload.ts` TS2503：`import sharp, { type Metadata } from 'sharp'`，本地 metadata 使用 `Metadata`。
3. `work/asset-ledger.ts` AST 空收窄：非法导入分支改为 `return reject(...)`；显式检查 `clause` 与 `clause.name`，使用局部 `binding` 后再 `canonical.set/allowed.add`。不依靠非空断言。
4. `work/asset-module.ts` 模块边界：`scanModuleReferences` 从 `./asset-ledger.ts` 取（不是 `@spatial/shared/scene-module`），同时导入 `ModuleReference` 类型；四处隐式 any 消除。
5. `removeModulePackage`：扫描结果保存实际 `references: ModuleReference[]`，校验唯一引用后取 `reference`；缺少实际节点显式 404，不再引用不存在的 `target.references[0]`，ledger anchor 使用真实 `reference.line/column`。删除 `beforeBytes` 的非空断言，缺失时明确失败。

## 静态审计

- 复核新增类型、`PersistedLuxTask` 的赋值/返回、sharp 类型、`ModuleReference` 导出、`asset-module` 与 `asset-ledger` 的模块边界及循环加载顺序。
- 复核 full workspace 调用签名：`commitCandidate(id,message,ledger?,base?)`、`assertSnapshotBudget`、`auditTrustedImports`、`ensureModuleRuntime`、`findModuleReference`、`scanModuleReferences`、`LuxTaskStore`、`LuxTaskService.materialize`。
- 复核 TSX/JSX、共享 exports、回归 fixture 形状和 studio/template 下游调用；没有把 server AST 扫描搬进 shared，没有用 `any`/非空断言消除错误，没有改安全/阈值/测试断言。
- 原 Pi 失败 run、`9885b41`/`17132b6` 字节、测试树、主线、20884/39743 均未触碰。

## 入口 runner 收口

旧 runner 的身份快照递归 `apps` 等目录，未排除 `.env`，且 symlink 分支用 `readFile` 会跟随链接；已废弃。

新 runner（`.data/lux3d-entry-typecheck.mjs`，不入库）：

- 身份枚举只来自 `git ls-files -s -z -- apps packages templates scripts tests package.json pnpm-lock.yaml tsconfig.json`，即 **Git 跟踪**的源码/脚本/模板/测试及显式普通 manifest。
- 明确排除 `.env*`、secret/credential/private-key、证书/私钥扩展和 `.git` 路径；排除路径只记名称，不读内容。
- 按 Git mode/lstat 区分文件、符号链接、gitlink；符号链接用 `readlink` 记录目标文本，不 `readFile` 跟随。
- 环境白名单、无 `NODE_OPTIONS`；不注入真实配置。
- 只跑 `pnpm.cmd -r --no-bail typecheck`；300 秒上限；记录 stdout/stderr/退出码、started/finished、HEAD/status、身份前后摘要、排除路径和 `notExecuted`。
- 设置 `npm_config_verify_deps_before_run=false`，避免 pnpm 的自动依赖验证触发 install/download；若 workspace 仍缺依赖则直接失败，不自动安装/改锁。
- 旧日志在 typecheck 前确实出现 `Scope: all 8 workspace projects`、lockfile 检查、`Already up to date`/`Done in 597ms` 等 pnpm 引导输出；本轮不能声称旧运行完全没有 bootstrap，只记录该实际输出。新 runner 在命令层不主动安装，真实输出另存。

## 唯一下一次检查

新 runner 只启动一次 `pnpm.cmd -r --no-bail typecheck`，覆盖所有 workspace，整体非 0 原样返回，不用 no-bail 吞错。不跑 build/unit/safety/E2E/collect/服务/云调用。失败保留错误，不自动重试或改后重跑；通过只声明 typecheck 通过，不代表功能或验收。

## 未运行

本轮尚未运行 typecheck（先完成修复和提交）；也没有 build、测试、服务、云请求、env/ASKS 读取或人员派发。
