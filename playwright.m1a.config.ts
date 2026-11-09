import { defineConfig, devices } from '@playwright/test';
import {
  ARTIFACT_DIR,
  ASSETS,
  BACKEND_BASE,
  BACKEND_LAUNCHER,
  GUARD_LOG,
  GUARD_SCRIPT_ARG,
  MOCK_BASE,
  MOCK_PORT,
  SERVER_DIR,
  SPLIT_GLB,
  SENTINEL_KEY,
  STUDIO_DIR,
  STUDIO_URL,
  TEMPLATE_DIR,
} from './tests/e2e/m1a/env';

/**
 * M1-A（共享 3D 渲染 / 场景配置 / 部件命名 / 作品页首屏 3D）测试配置。
 *
 * 与 M0-A 配置分开：这里的 mock 供的是 M1-A 的拆分模型
 * （fallback/lux3d-split-4969889.glb），处理后应与作品页里提交的
 * public/assets/diffuser-4969889.glb 来自同一条管线，这样两个视口才能比较。
 * 同样带出站网络守卫，全程不打真实接口。
 */
export default defineConfig({
  testDir: './tests/e2e/m1a',
  timeout: 240_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['json', { outputFile: `${ARTIFACT_DIR}/playwright-results.json` }],
  ],
  outputDir: 'docs/reports/artifacts/M1-A/output',
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
      command: 'node src/assets/mock-server.ts',
      cwd: SERVER_DIR,
      env: { MOCK_PORT: String(MOCK_PORT), MOCK_SCENARIO: 'success', MOCK_GLB: SPLIT_GLB },
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
        LUX3D_BASE: MOCK_BASE,
        LUX3D_API_KEY: SENTINEL_KEY,
        ASSETS_DIR: ASSETS,
        POLL_MS: '80',
        TIMEOUT_MS: '60000',
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
