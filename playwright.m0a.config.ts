import { defineConfig, devices } from '@playwright/test';
import {
  BACKEND_BASE,
  BACKEND_LAUNCHER,
  GUARD_LOG,
  GUARD_SCRIPT_ARG,
  MOCK_BASE,
  MOCK_FIXTURE,
  MOCK_PORT,
  PRIMARY_ASSETS,
  SENTINEL_KEY,
  SERVER_DIR,
  STUDIO_DIR,
  STUDIO_URL,
  TEMPLATE_DIR,
} from './tests/e2e/m0a/env';

/**
 * M0-A「Lux3D 调用跑通」测试配置（Pi 负责）。
 *
 * 关键约束：**不使用 apps/server/.env 里的真实 key，也不访问真实 Lux3D 接口。**
 * - mock Lux3D 服务（CodeBuddy 提供）跑在 4010；
 * - 被测后端由 tests/e2e/m0a/start-backend.mjs 启动，环境变量全部由这里显式注入，
 *   并加载出站网络守卫（tests/e2e/m0a/no-real-network.cjs）：任何非回环的出站请求都会被
 *   记录并拒绝，测试断言那份日志为空；
 * - 数据目录用独立的 .data/pi-m0a/assets，启动前清空。
 */
export default defineConfig({
  testDir: './tests/e2e/m0a',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['json', { outputFile: 'docs/reports/artifacts/M0-A/playwright-results.json' }],
  ],
  outputDir: 'docs/reports/artifacts/M0-A/output',
  use: {
    baseURL: STUDIO_URL,
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
      command: `node src/assets/mock-server.ts`,
      cwd: SERVER_DIR,
      env: {
        MOCK_PORT: String(MOCK_PORT),
        MOCK_SCENARIO: 'success',
        MOCK_GLB: MOCK_FIXTURE,
      },
      url: `${MOCK_BASE}/__stats`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `node "${BACKEND_LAUNCHER}"`,
      cwd: SERVER_DIR,
      env: {
        PORT: '3001',
        PREVIEW_ORIGIN_PORT: '5175',
        MAIN_PREVIEW_PORT: '5174',
        STUDIO_ORIGIN: 'http://127.0.0.1:5173',
        LUX3D_BASE: MOCK_BASE,
        LUX3D_API_KEY: SENTINEL_KEY,
        ASSETS_DIR: PRIMARY_ASSETS,
        POLL_MS: '80',
        TIMEOUT_MS: '30000',
        PI_FRESH: '1',
        PI_NET_GUARD_LOG: GUARD_LOG,
        NODE_OPTIONS: `--require ${GUARD_SCRIPT_ARG}`,
      },
      url: `${BACKEND_BASE}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node node_modules/vite/bin/vite.js',
      cwd: STUDIO_DIR,
      url: STUDIO_URL,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // Studio 首页的选取预览 iframe 会加载模板页；把它一起起起来，避免出无关的加载错误。
      command: 'node node_modules/vite/bin/vite.js',
      cwd: TEMPLATE_DIR,
      url: 'http://127.0.0.1:5174/preview/main/',
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
