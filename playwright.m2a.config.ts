import { defineConfig, devices } from '@playwright/test';
import {
  AGENT_MOCK, ARTIFACT_DIR, ASSETS, BACKEND_BASE, BACKEND_LAUNCHER, DEAD_LUX3D, GUARD_LOG, GUARD_SCRIPT_ARG,
  MOCK_BASE, MOCK_KEY, MOCK_MODEL, MOCK_PORT, SCENE_HISTORY, SERVER_DIR, STUDIO_DIR, STUDIO_URL, TEMPLATE_DIR,
  WORK_DATA, WORK_ROOT,
} from './tests/e2e/m2a/env';

/**
 * M2-A（指着说闭环 · 后端）测试配置。
 *
 * 编码 Agent 上游是本机可脚本化 mock（4011），Lux3D 指向一个没人监听的 loopback 端口，
 * 后端带出站网络守卫——全程不打真实模型、也不打真实 Lux3D。
 * WORK_ROOT 是真实模板目录（/preview/main/ 才会反映采用结果），工作数据与版本库都在 .data/pi-m2a。
 */
export default defineConfig({
  testDir: './tests/e2e/m2a',
  timeout: 420_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['json', { outputFile: `${ARTIFACT_DIR}/playwright-results.json` }]],
  outputDir: 'docs/reports/artifacts/M2-A/output',
  use: {
    baseURL: STUDIO_URL,
    viewport: { width: 1440, height: 900 },
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    {
      command: `node "${AGENT_MOCK}"`,
      cwd: SERVER_DIR,
      env: { MOCK_PORT: String(MOCK_PORT), MOCK_KEY },
      url: `${MOCK_BASE}/__stats`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `node "${BACKEND_LAUNCHER}"`,
      cwd: SERVER_DIR,
      env: {
        PORT: '3001',
        WORK_ROOT,
        WORK_DATA_DIR: WORK_DATA,
        ASSETS_DIR: ASSETS,
        SCENE_HISTORY_DIR: SCENE_HISTORY,
        LUX3D_BASE: DEAD_LUX3D,
        LUX3D_API_KEY: 'unused-in-m2a',
        CODING_AGENT_BASE_URL: MOCK_BASE,
        CODING_AGENT_API_KEY: MOCK_KEY,
        CODING_AGENT_MODEL: MOCK_MODEL,
        AGENT_TIMEOUT_MS: '4000',
        PI_FRESH: '1',
        PI_NET_GUARD_LOG: GUARD_LOG,
        NODE_OPTIONS: `--require ${GUARD_SCRIPT_ARG}`,
      },
      url: `${BACKEND_BASE}/health`,
      reuseExistingServer: false,
      timeout: 180_000,
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
