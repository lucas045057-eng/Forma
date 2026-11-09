# M0-B 端到端测试（Pi）

点选 → 源码定位的 Playwright 验收测试。只依赖仓库根级配置与 `tests/`，不改 `apps/`、`packages/`、`templates/` 的实现代码。

## 运行

```powershell
pnpm install
pnpm exec playwright install chromium   # 首次
pnpm test:e2e
```

- 服务由 `playwright.config.ts` 的 `webServer` 自动执行 `pnpm dev` 启动（Studio 5173、模板 5174、后端 3001），跑完自动关闭。
- 结果与证据：`docs/reports/artifacts/M0-B/`，报告见 `docs/reports/M0-B-test.md`。
- `pnpm test:e2e:headed` 可以看着浏览器跑。

## 两个环境注意

1. **浏览器路径**：若设置了 `PLAYWRIGHT_BROWSERS_PATH`，浏览器必须装在那个目录里；Orbital 环境默认指向 `%APPDATA%\Orbital\browsers`，而 `pnpm exec playwright install chromium` 装到 `%LOCALAPPDATA%\ms-playwright`。两者不一致时按下面任一方式处理：
   - `$env:PLAYWRIGHT_BROWSERS_PATH="$env:LOCALAPPDATA\ms-playwright"`，或
   - 在 Orbital 的目录里再装一次。
2. **pnpm 不可用时的逃生口**：`pnpm dev` 依赖根 `pnpm-workspace.yaml` 与依赖状态。若并行任务正在改 workspace 配置导致 pnpm 起不来，用

   ```powershell
   $env:E2E_DIRECT_WEBSERVER="1"; pnpm test:e2e
   ```

   此时直接用 `node node_modules/vite/bin/vite.js` 起模板与 Studio 两个服务（M0-B 不需要后端）。正式验收请用默认的 `pnpm dev` 路径。

## 用例结构

- `lib.ts`：打开 Studio、枚举 `data-src`、确定性抽样（种子 20261109）、真实鼠标点选、读 Selection、读源文件校验行列。
- `m0b-pick.spec.ts`：7 个验收用例 + 1 个校验器自检用例。

容器类元素（`main`）和零尺寸元素（`br`）鼠标无法命中，会退化为在元素自身派发 `click`；每条记录里的 `clickMode` 标明用了哪种方式。
