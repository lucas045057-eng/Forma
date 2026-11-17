import { defineConfig, devices } from '@playwright/test';
import {
  AGENT_BASE, AGENT_KEY, AGENT_MODEL, ARTIFACT_DIR, ASSETS, BACKEND_BASE, BACKEND_PORT, DATA_ROOT, FAKE_BASE, FAKE_KEY,
  FAKE_OUS_TOKEN, PREVIEW_ORIGIN, PREVIEW_ORIGIN_PORT, SCENE_HISTORY, SERVER_DIR, STUDIO_DIR, STUDIO_PORT,
  STUDIO_URL, TEMPLATE_DIR, TEMPLATE_PORT, WORK_DATA, WORK_ROOT,
} from './tests/e2e/lux3d/env';

const guard = `${process.cwd().replace(/\\/g, '/')}/tests/e2e/m0a/no-real-network.cjs`;
/** 每轮唯一的 guard 证据目录（runner 通过 LUX3D_GUARD_DIR 指定；缺省落在本轮 artifacts 旁）。 */
const guardDir = (process.env.LUX3D_GUARD_DIR ?? `${ARTIFACT_DIR}/../guard`).replace(/\\/g, '/');

/**
 * Lux3D 站内创作与网页放置：唯一一次 focused 验收。
 *
 * - 云侧只有 loopback fake（LUX3D_BASE=127.0.0.1:4019），不接任何真实 provider；
 * - NODE_OPTIONS 显式注入只允许回环的网络 guard，不继承外部值；
 * - 作品根就是模板（M4 既有做法），用例结束时按 Git 还原；运行期间不提交模板改动；
 * - workers=1 / retries=0 / forbidOnly，逐例单 result。
 */
export default defineConfig({
  testDir: './tests/e2e/lux3d',
  timeout: 480_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['json', { outputFile: `${ARTIFACT_DIR}/playwright-results.json` }]],
  outputDir: `${ARTIFACT_DIR}/output`,
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
      command: `node "${pathOf('tests/e2e/lux3d/fake/agent.mjs')}"`,
      cwd: process.cwd(),
      env: { AGENT_PORT: '4018' },
      url: `${AGENT_BASE}/__stats`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `node "${pathOf('tests/e2e/lux3d/fake/provider.mjs')}"`,
      cwd: process.cwd(),
      env: { FAKE_PORT: '4019', LUX3D_ARTIFACT_DIR: ARTIFACT_DIR },
      url: `${FAKE_BASE}/__counters`,
      reuseExistingServer: false,
      timeout: 60_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `node "${pathOf('tests/e2e/lux3d/support/start-backend.mjs')}"`,
      cwd: process.cwd(),
      env: {
        PORT: String(BACKEND_PORT),
        PREVIEW_ORIGIN_PORT: String(PREVIEW_ORIGIN_PORT),
        MAIN_PREVIEW_PORT: String(TEMPLATE_PORT),
        STUDIO_ORIGIN: STUDIO_URL.replace(/\/$/, ''),
        WORK_ROOT,
        WORK_DATA_DIR: WORK_DATA,
        ASSETS_DIR: ASSETS,
        SCENE_HISTORY_DIR: SCENE_HISTORY,
        LUX3D_BASE: FAKE_BASE,
        LUX3D_API_KEY: FAKE_KEY,
        LUX3D_UPLOAD_HOSTS: `127.0.0.1:${new URL(FAKE_BASE).port}`,
        CODING_AGENT_BASE_URL: AGENT_BASE,
        CODING_AGENT_API_KEY: AGENT_KEY,
        CODING_AGENT_MODEL: AGENT_MODEL,
        AGENT_TIMEOUT_MS: '30000',
        AGENT_MAX_ROUNDS: '16',
        POLL_MS: '80',
        TIMEOUT_MS: '60000',
        PREVIEW_START_TIMEOUT_MS: '60000',
        PI_LUX_FRESH: '1',
        LUX3D_GUARD_DIR: guardDir,
        PI_NET_GUARD_LOG: `${guardDir}/backend.log`,
        PI_NET_GUARD_ALLOW: '',
        NODE_OPTIONS: `--require "${guard}"`,
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
      env: { STUDIO_PORT: String(STUDIO_PORT), BACKEND_ORIGIN: BACKEND_BASE, VITE_PREVIEW_ORIGIN: PREVIEW_ORIGIN },
      url: STUDIO_URL,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: 'node node_modules/vite/bin/vite.js',
      cwd: TEMPLATE_DIR,
      env: { PREVIEW_PORT: String(TEMPLATE_PORT), PREVIEW_ORIGIN_PORT: String(PREVIEW_ORIGIN_PORT) },
      url: `http://127.0.0.1:${TEMPLATE_PORT}/preview/main/`,
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});

function pathOf(relative: string) {
  return `${process.cwd()}/${relative}`.replaceAll('\\', '/');
}
