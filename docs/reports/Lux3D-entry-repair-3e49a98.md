# 3e49a98 入口补修记录

- 来源：Pi `orbital/coordination/lux3d-increment/pi-focused-run1-report.md`，job `job_06465799` 在冻结 `9885b41` 的 typecheck 首步失败。
- 适用：`feat/lux3d-workbench`，父 `3e49a98e9b0dc9f51c1ec7fd73ee79aa9686786e`。
- 本记录只写入口语法补修与静态审计；F1–F8 的语义修正、预算/阈值/权限/断言全部保留，不删除任何测试。

## 修复

1. `apps/server/src/assets/mock-server.ts` 的 animation-retarget 结果表达式多一个 `)`：`ids.map(...)` 后由 `})) }) }]` 改为 `}) }) }]`。这是纯语法修复，不改变返回 JSON 形状或场景。
2. `apps/server/src/work/asset-ledger.test.ts` 的 literal model path 测试里，单引号字符串包含真实换行：改为单行字符串并使用 `\n` 转义。测试仍断言 `MODEL_PATH_IN_SOURCE`。

## 静态审计范围

- 复核 `9885b41..3e49a98` 的调用签名：`commitCandidate(id,message,ledger?,base?)`、`assertSnapshotBudget(root,overrides?)`、`auditTrustedImports`、`ensureModuleRuntime`、`LuxTaskService.materialize`、`LuxTaskStore`。
- 复核 import/共享导出：`SceneModuleConfig`/`SCENE_MODULE_RUNTIME_MARKERS`/`isTrustedRuntimeSource`、`SnapshotBudgetError`、`AssetFileDraft`、`AssetPlacementSession`。
- 复核 TSX/JSX：`AssetModuleControls`、`AssetPlacement`、`Lux3DWorkbench`、`scene-renderer` 的显式 animation 条件。
- 检查同类多行单引号字符串、`map(...)` 括号和尾随行；未发现其它已确认的同类语法缺陷。
- 未修改 Pi 验收树、旧证据、`9885b41`/`3e49a98` 字节、20884/39743、真实配置或主线。

## 入口编译

根授权唯一一次 `pnpm.cmd typecheck`。使用本机临时有界 runner（`.data/lux3d-entry-typecheck.mjs`，不入库），只运行项目原 `typecheck`；不运行 build/unit/demo-safety/Playwright/collect/服务/云请求，不安装依赖、不读 env/ASKS/密钥、不注入 `NODE_OPTIONS`。runner 保留命令、stdout/stderr、退出码、时间、HEAD、产品/脚本/模板/锁/测试字节身份前后对照。

- 失败：如实交回实际错误与未执行范围，**不自动改后重跑**。
- 通过：只说明固定新字节入口 typecheck 通过，**不代表 build/test/功能或验收通过**。

## 边界

本补修提交后先不宣称可编译；结果以唯一一次 typecheck 的实际输出为准。原失败 run 与旧报告保留。
