import { defineConfig } from '@playwright/test';

/**
 * M3-A 后端请示验收（API/真实 HTTP/真实候选 worktree/真实分源预览）。
 * 只跑 M3-A，不包含 M3-B 检查与 M3-C Studio 界面；不启动 Studio。
 * 测试自己启动 loopback mock Agent 与隔离后端；该 testDir 被默认 M0-B 套件显式排除。
 */
export default defineConfig({
  testDir: './tests/e2e/m3a',
  timeout: 420_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  outputDir: 'docs/reports/artifacts/M3-A/output',
});
