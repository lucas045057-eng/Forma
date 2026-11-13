import { defineConfig, devices } from '@playwright/test';
import {
  ARTIFACT_DIR,
  ASSETS,
  BACKEND_BASE,
  BACKEND_LAUNCHER,
  GUARD_LOG,
  GUARD_SCRIPT_ARG,
  HISTORY,
  MOCK_BASE,
  MOCK_PORT,
  SERVER_DIR,
  SENTINEL_KEY,
  SPLIT_GLB,
  STUDIO_DIR,
  STUDIO_URL,
  TEMPLATE_DIR,
  WORK_ROOT,
} from './tests/e2e/m1b/env';

/**
 * M1-B（场景写回 / Studio 编辑面板）测试配置。
 *
 * 主后端以真实模板目录为 WORK_ROOT，这样 `PUT /scene` 写文件后 Vite HMR 能把改动
 * 反映到作品页——测试对 `scene.config.json` 的改动都会逐次还原并校验。
 * 采用模型、路径越界、并发写入等会往作品目录里写文件的用例改用沙箱 WORK_ROOT
 * （`.data/pi-m1b/sandbox/work`），不往仓库里留产物。
 */
export default defineConfig({
  testDir: './tests/e2e/m1b',
  timeout: 300_000,
  expect: { timeout: 25_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['json', { outputFile: `${ARTIFACT_DIR}/playwright-results.json` }],
  ],
  outputDir: 'docs/reports/artifacts/M1-B/output',
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
        PREVIEW_ORIGIN_PORT: '5175',
        MAIN_PREVIEW_PORT: '5174',
        STUDIO_ORIGIN: 'http://127.0.0.1:5173',
        WORK_ROOT,
        SCENE_HISTORY_DIR: HISTORY,
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
