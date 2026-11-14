import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * 真实模型固定十题（或 loopback mock 接线验证）专用配置。
 * 只启动 Studio（5173）；每题的作品副本/后端/预览源/模板 Vite 由 spec 自己启停。
 * 真实凭据只在 spec 内读取并传给后端子进程，不进入浏览器/Studio/日志。
 */
export default defineConfig({
  testDir: './tests/e2e/real-model',
  timeout: 60 * 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list']],
  outputDir: 'docs/reports/artifacts/M2-real-model/output',
  use: {
    baseURL: 'http://127.0.0.1:5173/',
    viewport: { width: 1440, height: 900 },
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
  webServer: [{
    command: 'node node_modules/vite/bin/vite.js',
    cwd: path.resolve('apps/studio'),
    url: 'http://127.0.0.1:5173/',
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'ignore',
    stderr: 'pipe',
  }],
});
