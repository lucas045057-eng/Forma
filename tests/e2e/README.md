# M0-B 端到端测试（Pi）

点选 → 源码定位的 Playwright 验收测试 + Codex 审查整改的回归用例。只依赖仓库根级配置与 `tests/`，不改 `apps/`、`packages/`、`templates/` 的实现代码。

## 运行

```powershell
pnpm install
pnpm exec playwright install chromium   # 首次
pnpm test:e2e
```

- 服务由 `playwright.config.ts` 的 `webServer` 自动执行 `pnpm dev` 启动（Studio 5173、模板 5174、后端 3001），跑完自动关闭。
- 结果与证据：`docs/reports/artifacts/M0-B/`，报告见 `docs/reports/M0-B-test.md`。
- `pnpm test:e2e:headed` 可以看着浏览器跑。
- 插件层用例（含 R2 回归）用 `pnpm test`。

## 三个环境开关

| 变量 | 用途 |
| --- | --- |
| `PLAYWRIGHT_BROWSERS_PATH` | 若你的环境已设置它，浏览器必须装在那个目录；Orbital 默认指向 `%APPDATA%\Orbital\browsers`，而 `pnpm exec playwright install chromium` 装到 `%LOCALAPPDATA%\ms-playwright`。两者不一致时把它指向后者：`$env:PLAYWRIGHT_BROWSERS_PATH="$env:LOCALAPPDATA\ms-playwright"` |
| `E2E_DIRECT_WEBSERVER=1` | `pnpm` 不可用（例如并行任务正在装依赖、`pnpm-workspace.yaml` 临时非法）时，直接用 `node node_modules/vite/bin/vite.js` 起模板与 Studio 两个服务 |
| `E2E_REUSE_SERVER=1` | 5173/5174 已被另一个并行任务的 `pnpm dev` 占用时直接复用。**复用前必须确认那个服务就是当前工作树**（否则测的不是你要测的代码） |

## 文件

| 文件 | 内容 |
| --- | --- |
| `lib.ts` | 打开 Studio、枚举 `data-src`、确定性抽样（种子 20261109）、真实鼠标点选、读 Selection、读源文件校验行列、注入探针 |
| `source-model.ts` | **AST oracle**：解析 `templates/product-page/src/**/*.tsx`，算出每个原生 JSX 开标签的 1 基行列。完全不经过插件、不读 DOM 的 `data-src` |
| `checks.ts` | 用例 8/9 与变异验证共用的判定逻辑 |
| `m0b-pick.spec.ts` | 验收用例 1–7 + 行号自检 + 用例 8（AST 确定性锚点）+ 用例 9（应标记节点完整性） |
| `m0b-known-issues.spec.ts` | Codex 审查 R1 的回归（pointerdown/mousedown、单输入框 Enter 隐式提交、链接、退出恢复） |
| `m0b-message-guard.spec.ts` | Codex 审查 S4 的消息安全回归（两端 origin/source 与畸形 payload） |
| `m0b-mutation-check.spec.ts` | 变异验证：同名标签错标、漏标某类元素、列号偏移都会被判定抓到 |
| `../../packages/vite-plugin-source-tag/src/reserved-jsx-r2.test.ts` | Codex 审查 R2 的插件层回归（保留属性内嵌 JSX），只新增测试文件 |

## 已知待修（预期失败，不是回归）

R1（`m0b-known-issues.spec.ts` 的 R1a/R1b）用 `test.fail()` 标注，R2 两条用 `it.fails` 标注：**修复后它们会变成「意外通过」并让套件失败**，届时删掉这些标记即可。

容器类元素（`main`）和零尺寸元素（`br`）鼠标无法命中，会退化为在元素自身派发 `click`；每条记录里的 `clickMode` 标明用了哪种方式。

## M0-A（Lux3D）测试：`m0a/` 子目录

```powershell
pnpm test:e2e:m0a      # = playwright test -c playwright.m0a.config.ts
```

与 M0-B 分开：用的是另一个配置文件，也不需要 `pnpm dev`。跑之前先确保 3001/4010/5173/5174 空闲（它自己会起 mock 4010 + 后端 3001 + Studio 5173 + 模板 5174，跑完自己收掉）。

| 文件 | 内容 |
| --- | --- |
| `env.ts` | 端口、数据目录、证据目录、运行 ID；M0-A 的单一事实来源（配置和测试都从这里取） |
| `harness.ts` | 起/停 mock、后端、剧本 stub 子进程；HTTP/WebSocket 客户端；GLB 解析（带 Meshopt 解码器）；截图统计与像素对比 |
| `no-real-network.cjs` | **出站网络守卫**（preload）：只放行回环地址，其余记录并拒绝 |
| `start-backend.mjs` | 被测后端启动器：与 `src/index.ts` 同一条 `createApp()`，只把 `pollMs`/`timeoutMs` 改成毫秒级；检查守卫是否加载 |
| `stub-upstream.mjs` | 补 CodeBuddy mock 没有的剧本：并发超限、create 500、无 GLB 输出 |
| `01-pipeline` … `06-viewport` | 主链路、幂等、失败路径、导入、安全、Studio 3D 视口 |

**不会碰真实 Lux3D**：后端进程不读 `apps/server/.env`，`LUX3D_BASE` 指向本地 mock，且带出站守卫；`docs/reports/M0-A-test.md` 有完整证据链。
