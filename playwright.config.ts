import { defineConfig, devices } from '@playwright/test';

/**
 * M0-B「点选 → 源码定位」端到端测试配置（Pi 负责）。
 * 只依赖根级配置与 tests/ 目录，不改 apps/、packages/、templates/ 的实现代码。
 */

// 若端口已被另一个并行任务的 `pnpm dev` 占用，设 E2E_REUSE_SERVER=1 复用它。
// 复用前必须确认那个服务就是当前工作树，否则测的不是你要测的代码。
const reuseExistingServer = process.env.E2E_REUSE_SERVER === '1';

export default defineConfig({
  testDir: './tests/e2e',
  // M0-A / M1-A 的用例需要各自的配置（不同 mock 与专用后端启动器），不能跟 M0-B 混跑。
  testIgnore: ['**/m0a/**', '**/m1a/**'],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['json', { outputFile: 'docs/reports/artifacts/M0-B/playwright-results.json' }],
  ],
  outputDir: 'docs/reports/artifacts/M0-B/output',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    viewport: { width: 1440, height: 900 },
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
  ],
  // 默认用 `pnpm dev` 起三个服务。若根目录 pnpm 状态暂不可用（并行任务正在安装依赖、
  // pnpm-workspace.yaml 非法），设 E2E_DIRECT_WEBSERVER=1 直接用 node 跑两个 Vite
  // 开发服务（M0-B 测试不需要后端）。
  webServer: process.env.E2E_DIRECT_WEBSERVER === '1'
    ? [
        {
          command: 'node node_modules/vite/bin/vite.js',
          cwd: 'templates/product-page',
          url: 'http://127.0.0.1:5174/preview/main/',
          reuseExistingServer,
          timeout: 180_000,
          stdout: 'ignore',
          stderr: 'pipe',
        },
        {
          command: 'node node_modules/vite/bin/vite.js',
          cwd: 'apps/studio',
          url: 'http://127.0.0.1:5173/',
          reuseExistingServer,
          timeout: 180_000,
          stdout: 'ignore',
          stderr: 'pipe',
        },
      ]
    : {
        command: 'pnpm dev',
        url: 'http://127.0.0.1:5173/',
        reuseExistingServer,
        timeout: 180_000,
        stdout: 'ignore',
        stderr: 'pipe',
      },
});
