import { defineConfig } from '@playwright/test';

/**
 * M3-B「真实检查与采用门禁」验收准备配置（本分支为 Pi 独立验收做准备，不是正式验收）。
 *
 * - 用例自己起隔离后端（同一 `createApp()` + 出站守卫）、作品副本和 mock 编码上游；
 *   所以这里没有 webServer；
 * - 只走 loopback、fake key、把 Lux3D 指向死端口；不打真实模型或真实 Lux3D；
 * - 单 worker、0 retry、forbidOnly：任何一个失败都如实暴露，不靠重试凑绿；
 * - 证据写在 docs/reports/artifacts/M3-B/acceptance-precheck/，正式验收会另建目录。
 */
export default defineConfig({
  testDir: './tests/e2e/m3b',
  timeout: 600_000,
  expect: { timeout: 60_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['json', { outputFile: 'docs/reports/artifacts/M3-B/acceptance-precheck/playwright-results.json' }],
  ],
  outputDir: 'docs/reports/artifacts/M3-B/acceptance-precheck/output',
  use: {
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
});
