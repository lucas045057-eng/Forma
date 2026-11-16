# 7148ce5 后 R1 导入审计补修

- 起点：`7148ce5b355afa3d47f3b9d11054a568269d1d88`。
- 依据：`claude-rework-review-3043349.md` §1 R1 与根 `r1-import-audit-after-7148.md`。
- 本批只修 R1；F1/F2/F4–F8 和既有 N 项不重修。

## 修正

### 绝对 `/src/...` 与受管命名空间

`moduleTarget` 现在同时规范化相对导入和 Vite 项目根绝对导入：

- `./x` / `../x` 按文件目录解析；
- `/src/...` 按项目根解析为 `src/...`；
- 大小写/分隔符/路径规范化后统一判断。

受管判断覆盖 `src/spatial-module`、任意扩展名、同名目录，以及 `src/scene-modules` 本身和后代。绝对路径导入受管运行时或实例仍拒绝；普通 `/src/components/...` 文件导入不受影响。

### `import.meta.glob` / `globEager`

审计识别 `import.meta.glob` 和 `import.meta.globEager` 的字面字符串/数组参数：

- 将 pattern 按文件目录或项目根解析后，转成 glob 正则；
- 用受管运行时/实例代表路径（`src/spatial-module*`、`src/scene-modules/...`）检查是否可能命中；
- 命中受管树、宽 pattern、数组中的正向受管 pattern、绝对受管 pattern 都拒绝；
- 明确只覆盖普通目录的 glob 保留；
- 参数不是全部字面量、或含无法安全证明的动态值时拒绝，并说明是静态分析边界，不执行作品代码。

### 动态 import / require / createElement / jsx 收窄

- 动态 `import('./Section')`、`require('./image.png')` 等普通字面文件加载允许；
- 目标为受管命名空间（相对或绝对）时拒绝；
- 动态目标不是字面量时拒绝并说明无法静态证明；
- `document.createElement('div')`、`React.createElement(Button)` 等普通 DOM/组件构造允许；
- `createElement('SpatialModule')`、使用 canonical 实例标识符等仍拒绝；
- canonical 标识符在表达式、调用、props、别名中的使用仍由原 identifier 审计拒绝，单实例/锚点约束未放宽。

## 回归

`asset-ledger.test.ts` 增加：

- 负例：`/src/spatial-module.tsx`、`/src/scene-modules/<id>.tsx`、受管 glob（单个、数组、宽 pattern、绝对）、动态 glob 变量、非字面 dynamic import/require、`createElement('SpatialModule')`。
- 正例：`document.createElement('div')`、`React.createElement(Button)`、`import('./Section')`、`require('./image.png')`、普通 `components/*.tsx` glob、含负向普通 pattern 的 glob。
- 原 canonical 正例、别名/default 重命名、额外 props、重导出等断言保留。

## 未改变

- 不改 server canonical 导入、managed 拒绝优先、ledger 只由 server 提供、实例单引用/锚点校验。
- 不改 F1/F2/F4–F8 的预算、状态、恢复、产物或动画语义。
- 不改模板 tsconfig 或 tsconfig ledger 权限；该差异仍由根的独立复审统一判断。

## 运行状态

本轮尚未运行 typecheck；只完成静态补修与回归。下一步是固定新待验证 HEAD，然后唯一一次安全有界 `pnpm.cmd -r --no-bail typecheck`。build/unit/E2E/collect/真实服务/云 API 均未执行。
