# Studio 真机夹具 CJS 引导失败：定位与修复（起点 a500ee8）

- 受测实现：`a500ee8ece61131f72a4e9100ac9ae3d6ee94609`，树 `.worktrees/m4`
- 失败原件：`job_2990283e`（exit 1），`apps/studio/src/speech-app.browser.test.ts:11` 在 `app-bootstrap / navigate-real-app` 阶段失败
- 报错：`The requested module '/@fs/…/use-sync-external-store@1.7.0_react@19.3.1/…/shim/with-selector.js' does not provide an export named 'default'`
- Pi 树 `d2d2b00` 与第三轮 run 未动。

## 1. 真实导入链（静态逐跳确认）

| 跳 | 位置 | 内容 |
|---|---|---|
| 1 | `apps/studio/src/test-support/speech-app.tsx:2` | `import App from '../App.tsx'` |
| 2 | `apps/studio/src/App.tsx:12` | `import AssetPlacement from './AssetPlacement.tsx'` —— **本增量 `77daea6` 新增的静态边** |
| 3 | `apps/studio/src/AssetPlacement.tsx:7` | `import { ProductScene } from '@spatial/scene-renderer'` |
| 4 | `packages/scene-renderer/src/index.tsx:2` | `import { Canvas, useThree, useFrame } from '@react-three/fiber'` |
| 5 | `@react-three/fiber@9.8.2/dist/events-*.esm.js:5` | `import { createWithEqualityFn } from 'zustand/traditional'` |
| 6 | `zustand@5.1.0/esm/traditional.mjs:2` | `import useSyncExternalStoreExports from 'use-sync-external-store/shim/with-selector.js'`（**默认导入**） |
| 7 | `use-sync-external-store@1.7.0/shim/with-selector.js:1-7` | 纯 CJS：`'use strict'; module.exports = require('../cjs/…/with-selector.development.js')`；包无 `type: module`、无 `module`/`exports` ESM 条件 |

改动前该测试不会加载这一链：`scene-renderer` 只被 `App.tsx:21-22` 的 `lazy(() => import('./AssetPanel'))` / `SceneEditor` 引用，真机用例从不打开这两个面板。`AssetPlacement` 改为静态导入后，链在**页面引导阶段**就必须解析。

## 2. 失败机制

- 夹具 Vite 配置是 `configFile:false` + `optimizeDeps.noDiscovery:true`，`include` 只有 React 五个入口（`speech-browser-fixture.ts:8-12`）。
- `noDiscovery` 下 Vite 不扫描入口图，只预构建 `include`；未被预构建的裸依赖按源码直接下发。
- 于是 `@react-three/fiber`、`zustand`、`with-selector.js` 都被原样 `/@fs/` 服务。前两者是 ESM 源码可执行；`with-selector.js` 是 CJS，浏览器按 ESM 解析时看不到 `default`，在模块链接阶段即抛错——与 `18.7 ms` 就失败、尚未进入交互断言的现象一致。
- 真实 `vite dev` / `vite build` 不会出现该错误：前者走默认依赖发现、后者走 rollup commonjs，两者都会把 CJS 转成 ESM。

**与旧 `apps/studio/node_modules/.vite` 时间戳无关**：用例 `mkdtemp('speech-real-app-')` 且显式 `cacheDir:cache`（`speech-app.browser.test.ts:12,20`），每轮是全新缓存目录。本批未删除/移动任何依赖缓存。

## 3. 修复（只改夹具预构建策略）

`apps/studio/src/test-support/speech-browser-fixture.ts`

```ts
export function speechBrowserVite(options:{entry?:string}={}):InlineConfig{
 const react=['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime'];
 return {
  mode:'development',configFile:false,envFile:false,
  esbuild:{jsx:'automatic',jsxDev:true},
  optimizeDeps:options.entry?{entries:[options.entry],include:react}:{noDiscovery:true,include:react},
 };
}
```

`apps/studio/src/speech-app.browser.test.ts:20`

```ts
vite=await createVite({...speechBrowserVite({entry:'src/test-support/speech-app.tsx'}), …})
```

- 真机夹具把自己实际服务的入口交给 Vite 依赖扫描（`entries` 相对 `root` 解析，Vite 7.3.7 `globEntries` 以 `config.root` 为 cwd），由 esbuild 按真实图把 fiber / drei / three / zustand 及其 CJS interop 一起预构建，等价于产品 `vite dev` 的加载路径。
- 不再扩充手写 `include` 白名单——正是这份名单没有随新静态边更新才导致本次失败，继续追加同类条目会在下次新增依赖时复发。
- 组件夹具（`speech-browser.test.ts` 的 harness 页）不加载 3D 图，保持原 `noDiscovery` + React include 不变。

**没有做**：不 mock 依赖、不 alias 到 stub、不过滤 `pageerror`、不改 lazy 时序、不改断言/超时/重试、不动依赖与锁、不安装、不改产品代码。

## 4. 保持项

- 真实 React / 真实 App / 真实 `AssetPlacement` / 真实 EventCenter / 真实跨 origin preview：全部保留。
- 原断言（review 保持、跨 origin pick、WS 重连、任务绑定、`speeches`/`tasks` 计数）、随机端口、全新 `mkdtemp` 缓存、`context.route` 只允许本 origin 与 preview origin、`requestfailed`/`pageerror` 采集、Chromium/端口/媒体轨清理断言：一处未改。
- 60 s 用例超时未动。

## 5. 证据与未证面

- 已静态证实：导入链、CJS 形态、`noDiscovery` 语义、旧图只在 lazy 分支出现。
- 未证：drei 及其传递依赖在 esbuild 预构建下是否全部干净（只能由本轮定向运行回答）；预构建耗时（可能显著拉长首次导航，但仍在 60 s 用例预算内，只有实测能确认）。
- 本报告不预判结果。失败则保留 `cacheDir` 原件与 `unit.*.log`，不清理后重试。

定向 runner：`.data/studio-speech-check.mjs` — workspace typecheck → `@spatial/studio` 一次 Vitest（`src/speech-app.browser.test.ts` + `src/speech-browser.test.ts`），白名单环境、不注入 `NODE_OPTIONS`、禁 pnpm bootstrap；记录身份前后、stdout/stderr/exit/耗时/计数，以及运行前后 `speech-*` 临时缓存目录清单。

## 6. 未运行事实

未 build、未跑全仓单测、未 safety、未 Lux3D E2E、未 full/collect/probe/云；未读 env/ASKS/凭据；未安装、未派人；live 20884/39743、主线、Pi 树与旧证据未动。
