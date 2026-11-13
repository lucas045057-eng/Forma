import base from './playwright.m2a.config';

/**
 * M2-B 界面测试：复用 M2-A 的那套服务（mock 编码上游 + 独立预览源 + Studio + 模板）。
 */
export default {
  ...base,
  testDir: './tests/e2e/m2b',
  timeout: 420_000,
  reporter: [['list'], ['json', { outputFile: 'docs/reports/artifacts/M2-B/playwright-results.json' }]],
  outputDir: 'docs/reports/artifacts/M2-B/output',
};
