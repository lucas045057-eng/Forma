import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * M0-B「点选 → 源码定位」端到端测试配置（Pi 负责）。
 *
 * 预览分源后（M2-A 整改）：Studio 不再代理 /preview/*，作品页由独立预览源 5175 提供，
 * 所以这里除了 Studio 和模板 dev server，还要起 API + 预览源（用测试启动器，带出站守卫，
 * 不读 apps/server/.env）。
 */

// 若端口已被另一个并行任务的 `pnpm dev` 占用，设 E2E_REUSE_SERVER=1 复用它。
const reuseExistingServer = process.env.E2E_REUSE_SERVER === '1';
const REPO = process.cwd();

export default defineConfig({
  testDir: './tests/e2e',
  // M0-A / M1-A / M1-B / M2-A / M2-B 的用例需要各自的配置，不能跟 M0-B 混跑。
  testIgnore: ['**/m0a/**', '**/m1a/**', '**/m1b/**', '**/m2a/**', '**/m2b/**', '**/m3a/**'],
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
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
  ],
  webServer: [
    {
      command: `node "${path.join(REPO, 'tests/e2e/m0a/start-backend.mjs')}"`,
      cwd: 'apps/server',
      env: {
        PORT: '3001',
        PREVIEW_ORIGIN_PORT: '5175',
        MAIN_PREVIEW_PORT: '5174',
        STUDIO_ORIGIN: 'http://127.0.0.1:5173',
        LUX3D_BASE: 'http://127.0.0.1:4019',
        LUX3D_API_KEY: 'unused-in-m0b',
        ASSETS_DIR: path.join(REPO, '.data', 'pi-m0b', 'assets'),
        PI_FRESH: '1',
        PI_NET_GUARD_LOG: path.join(REPO, '.data', 'pi-m0b', 'net-guard.log'),
        NODE_OPTIONS: `--require ${path.join(REPO, 'tests/e2e/m0a/no-real-network.cjs').split(path.sep).join('/')}`,
      },
      url: 'http://127.0.0.1:3001/health',
      reuseExistingServer,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
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
  ],
});
