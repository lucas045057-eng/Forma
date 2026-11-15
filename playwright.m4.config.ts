import { defineConfig, devices } from '@playwright/test';
import {
  AGENT_MOCK, ARTIFACT_DIR, ASSETS, BACKEND_BASE, BACKEND_LAUNCHER, DEAD_LUX3D, GUARD_LOG, GUARD_SCRIPT_ARG,
  MOCK_BASE, MOCK_KEY, MOCK_MODEL, MOCK_PORT, SCENE_HISTORY, SERVER_DIR, STUDIO_DIR, STUDIO_URL, TEMPLATE_DIR,
  WORK_DATA, WORK_ROOT,
} from './tests/e2e/m4/env';

/**
 * M4 集中验收（D2 录音确认 / D3 备用资产 / D4 视觉布局 / D5 演示入口）的独立 E2E 配置。
 *
 * - 后端是同一个 `createApp()`（tests/e2e/m2a/start-backend.mjs），带出站网络守卫，不读 apps/server/.env；
 * - 语音：**没有**配置真实上游（SPEECH_BASE_URL 留空），浏览器侧用 route 替身模拟转写，绝不打阿里；
 * - 编码 Agent：本机 loopback mock（4011）；Lux3D 指向无人监听的 loopback；
 * - 作品目录用真实模板（/preview/main/ 才能反映采用/回退），测试结束必须还原；
 * - 单 worker、0 retry、forbidOnly。
 */
export default defineConfig({
  testDir: './tests/e2e/m4',
  timeout: 480_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['json', { outputFile: `${ARTIFACT_DIR}/playwright-results.json` }],
  ],
  outputDir: 'docs/reports/artifacts/M4/output',
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
        PREVIEW_ORIGIN_PORT: '5175',
        MAIN_PREVIEW_PORT: '5174',
        STUDIO_ORIGIN: STUDIO_URL.replace(/\/$/, ''),
        WORK_ROOT,
        WORK_DATA_DIR: WORK_DATA,
        ASSETS_DIR: ASSETS,
        SCENE_HISTORY_DIR: SCENE_HISTORY,
        LUX3D_BASE: DEAD_LUX3D,
        LUX3D_API_KEY: 'unused-in-m4',
        CODING_AGENT_BASE_URL: MOCK_BASE,
        CODING_AGENT_API_KEY: MOCK_KEY,
        CODING_AGENT_MODEL: MOCK_MODEL,
        AGENT_TIMEOUT_MS: '30000',
        AGENT_MAX_ROUNDS: '16',
        // 语音上游必须留空：任何真实识别都不在本次范围。
        SPEECH_BASE_URL: '',
        DASHSCOPE_API_KEY: '',
        SPEECH_MODEL: 'qwen3-asr-flash',
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
