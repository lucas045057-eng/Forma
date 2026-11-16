# 第二轮 16 例 + R1 第二批返工

- 起点：`25fcb369d9cb62f6e2fc27d7a1f8a036c20c06d7`（父 `7148ce5`）。
- 依据：`pi-round2-triage.md`、`claude-r1-code-closure-25fcb36.md`、`rework-2-round2-and-r1.md`。
- 本批只修 A–F 与 R1；不改旧断言、预算、阈值、权限或生产云合同。

## A — 旧 mock 未登记任务

`mock-server.ts` 的 `task/get` 对未登记任务恢复旧的 GLB 结果合同：status=3 时返回 `/output/model.glb`，其余状态仍为空 outputs。这样旧 `AssetService.importTask` 可以真实走 get → download → process / expired403/404 / truncated / drip / recovery；新 10 操作已登记任务仍按各自 operation 的产物解析，不回退成统一 GLB。

## B — OUS lackBlocks fixture

`lux3d-provider-upload.test.ts` 的越界 fixture 改为 12 字节（blockSize 4 → 3 块），`['2-3']` 合法，断言仍为只上传 2、3 两块。新增：数字 `[2]` 只补第 2 块；`['4']` 越界在上传 part 前拒绝且 parts 为 0。生产 `parseBlockList` 边界未放宽。

## C — mock 重复 outputFormat

`mock-server.ts` 的 `validate` 对 generation/material/export 的 `outputFormat` 增加重复项检查；空数组仍只按各操作原有合同处理，没有对所有操作统一禁止缺省/空格式。畸形 `['glb','glb']` 仍按负例拒绝，不改 200 断言。

## D1 — ledger canonical fixture

`asset-ledger.test.ts` 的 `appWithRef` 改为服务端 canonical 形态：

```ts
import SpatialModel<id> from "./scene-modules/<id>.tsx";
export default <main><SpatialModel<id>/></main>;
```

不再直接 `<SpatialModule instanceId=.../>`。精确 path/操作/前后哈希清单、wrongBytes、缺 proof、managed/public 未授权写入等负例保持。

## D2 / R1 — 路径与 glob

- `moduleTarget` 支持相对路径和项目根 `/src/...`（含多重前导斜杠），统一大小写/分隔符/扩展名；`/@fs/`、盘符、`file:` 不做作品内解析，含 managed 关键字时拒绝。
- 所有 import/export/import-equals/dynamic import/require/glob 说明符统一做 managed 名称兜底：含 `spatial-module`/`scene-modules` 但不是服务端 canonical 相对导入的一律拒绝，修复 `../spatial-module.tsx` 归一化逃出 `src` 的漏检。
- glob 不再用有限代表路径。改为静态目录前缀规则：取第一个 glob 元字符段之前的目录，只有落在 `src/<普通子目录>/` 且不是 `scene-modules`、不以 `spatial-module` 开头才放行；`src/` 根、项目根、`/@fs`/盘符/file、宽 `**`、首字符模式、extglob、转义模式拒绝。
- 普通 DOM/`React.createElement`、字面普通文件动态 import/require、`components/*.tsx`、`components/**`、`components/{A,B}.tsx` 正例保留。

## E — ProductHero 插入目标

`insertModuleSource` 与 `classifyTarget` 对齐：`ProductHero` 和 `ProductScene`、`SpatialModule`、`SpatialModel*` 均不能作为普通新增锚点；普通容器插入与 inside 自闭合拒绝保留。

## F — 审批 AbortError

沿 `finalizeApprovedTask → failApproval → recoverApprovalIntent` 静态追踪；`previews.start` 拒绝后应走失败清理，但 `Error` 变体 4.86s、`AbortError` 变体 5.00s 超时，当前无法静态证明原因。保留“未证”，未改 5s/断言/取消语义。为两个变体在同一测试中加入阶段/开始结束/耗时 `console.info` 证据（无源码、凭据、私密错误文本），供下一次集中自检定位。

## 运行与边界

尚未运行；下一步固定新 HEAD 后唯一一次 `pnpm.cmd -r --no-bail typecheck`，成功后只跑卡列的 8 个 server 测试文件；不跑 build/safety/E2E/collect/真实云。失败不自动重试，未证项保留。
