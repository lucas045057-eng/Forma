# 011dda8 观测代码补修与 R1 边界收口

- 起点：`011dda8983e3910524172aec3b73058902d2de43`。
- 依据：`repair-instrumentation-011dda8.md`、`claude-rework2-review-011dda8.md`。

## 必修 blocker

`approvals.test.ts` 的三个无关测试里各有 `mark('close-start')` / `mark('close-returned')`，但作用域没有定义 `mark`；已精确删除这 **6 处**调用（`preserves a pending card…`、`resumes failed-preview cleanup…`、`retains stale cleanup intent…`）。没有新增全局 `mark`，没有改测试结构，没有做全文件替换。

`isolates preview %s` 内的局部 `mark` 保留：定义在该测试内，作用域正确；5 秒超时、断言、清理、Error/AbortError 两个变体均未改。F 仍为“原因未证”，等待实际阶段时序。

## R1 边界补强

- `/@fs/`、`file:`、盘符绝对、UNC、DOS 8.3 短文件名说明符，在 import/export/import-equals/dynamic/require/glob 全部直接拒绝，不依赖是否包含 managed 关键词。
- 受管说明符改为路径段边界判断：`spatial-module` 本身/点扩展/同名目录、`scene-modules` 本身和后代；`spatial-module-card.tsx`、`scene-modules-card.tsx` 等普通文件名不再误拒。
- glob 静态目录前缀规则保留；含 `..` 的路径段/花括号展开拒绝，`components/{A,B}.tsx` 普通正例保留。
- 原有 G1–G4、相对/绝对受管、canonical 正例、普通 DOM/字面动态加载和旧断言保持。

## 运行

本批尚未运行；新 HEAD 固定后执行唯一一次 `pnpm.cmd -r --no-bail typecheck`，通过后只跑原 8 个受影响 server 测试文件。失败不自动重试；F 未证项不 skip。
