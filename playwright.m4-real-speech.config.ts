import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import {
  AGENT_MOCK, ARTIFACT_DIR, ASSETS, BACKEND_BASE, BACKEND_LAUNCHER, DEAD_LUX3D,
  MOCK_BASE, MOCK_KEY, MOCK_MODEL, MOCK_PORT, SCENE_HISTORY, SERVER_DIR, STUDIO_DIR, STUDIO_URL, TEMPLATE_DIR,
  WORK_DATA, WORK_ROOT,
} from './tests/e2e/m4/env';

/**
 * M4 真实语音验收轮（Pi）。
 *
 * 与 playwright.m4.config.ts 的唯一区别：语音走**真实阿里云百炼**（qwen3-asr-flash），
 * 不做 route mock、不装 loopback 网络守卫；编码 Agent 仍是 loopback mock（4011），
 * Lux3D 仍指向死端点，所以本轮不产生除语音之外的任何付费调用。
 *
 * 录音侧不是 stub：Chromium 用 `--use-file-for-fake-audio-capture` 把一段真实中文指令
 * 的 48kHz PCM WAV（tests/e2e/m4/fixtures/speech-instruction-48k.wav，Windows 中文语音
 * 合成后重采样，6.34s 语料 + 1.5s 尾部静音）当麦克风输入，MediaRecorder 真采集、真编码成
 * webm/opus 再上传。
 */

const repoRoot = process.cwd();
const envFile = readFileSync(path.join(repoRoot, 'apps', 'server', '.env'), 'utf8');
const envValue = (name: string): string => {
  const line = envFile.split(/\r?\n/).find(entry => entry.startsWith(`${name}=`));
  if (!line) throw new Error(`apps/server/.env 缺少 ${name}`);
  const value = line.slice(name.length + 1).trim();
  if (!value) throw new Error(`apps/server/.env 的 ${name} 为空`);
  return value;
};

const SPEECH_WAV = path.resolve(process.env.M4_REAL_SPEECH_WAV ?? path.join(repoRoot, 'tests', 'e2e', 'm4', 'fixtures', 'speech-instruction-48k.wav'))
  .split(path.sep).join('/');

export default defineConfig({
  testDir: './tests/e2e/m4',
  testMatch: '05-real-speech.spec.ts',
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
  outputDir: '.data/pi-m4-real-speech/output',
  use: {
    baseURL: STUDIO_URL,
    viewport: { width: 1440, height: 900 },
    permissions: ['microphone'],
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        `--use-file-for-fake-audio-capture=${SPEECH_WAV}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    },
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
        // 本轮唯一放开的真实依赖：语音转写。
        SPEECH_BASE_URL: envValue('SPEECH_BASE_URL'),
        DASHSCOPE_API_KEY: envValue('DASHSCOPE_API_KEY'),
        SPEECH_MODEL: 'qwen3-asr-flash',
        PI_FRESH: '1',
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
