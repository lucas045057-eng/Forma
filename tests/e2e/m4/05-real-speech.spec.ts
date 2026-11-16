import path from 'node:path';
import { expect, test } from '@playwright/test';
import { ARTIFACT_DIR, BACKEND_BASE } from './env';
import { openStudio, restoreTemplate, writeArtifact } from './helpers';

/**
 * M4 真实语音验收（Pi）：真实麦克风管线 → 真实阿里云百炼 qwen3-asr-flash → 可编辑转写 → 写入指令。
 *
 * 与 01-speech.spec.ts 的区别是不装 speech stub、不 route 拦截：
 * - 浏览器侧用 Chromium 的 `--use-file-for-fake-audio-capture` 提供真实 PCM 音频，
 *   MediaRecorder 走真采集与真编码（webm/opus），产物字节真的发给后端；
 * - 后端真的打 dashscope.aliyuncs.com（见 playwright.m4-real-speech.config.ts）；
 * - 断言同时绑定：后端 /speech/config 报 aliyun、响应体是真实转写文本、请求与响应的
 *   X-Speech-Request-Id 一致（stub 无法伪造成立）。
 *
 * 编码 Agent 仍是 loopback mock，本轮不产生除语音以外的付费调用。
 */

const EXPECT_KEY_PHRASES = ['加入购物袋', '保留原来的购买行为'];
const normalize = (text: string) => text.replace(/[\s，。！？、,.!?;；:："'“”‘’（）()]/g, '');

test.describe('M4 真实语音：按住说话 → 真实转写 → 确认写入指令', () => {
  test.beforeAll(() => {
    const restored = restoreTemplate();
    expect(restored.clean, restored.status).toBe(true);
  });
  test.afterAll(() => {
    const restored = restoreTemplate();
    expect(restored.clean, restored.status).toBe(true);
  });

  test('真实 provider 转写正确、可编辑、不自动提交', async ({ page }) => {
    const config = await (await fetch(`${BACKEND_BASE}/speech/config`)).json();
    expect(config.enabled, '后端没有启用语音（.env 未生效）').toBe(true);
    expect(config.provider).toBe('aliyun');
    expect(config.model).toBe('qwen3-asr-flash');

    await page.addInitScript(() => {
      // 浏览器以 Blob/流上传时不发 Content-Length，Playwright 也拿不到请求体；
      // 这里在产品把 Blob 交给 fetch 的那一刻记录真实字节数，用来证明录音确实采到了数据。
      const target = window as any;
      target.__speechUploads = [];
      const original = window.fetch.bind(window);
      window.fetch = ((input: any, init: any = {}) => {
        try {
          const url = typeof input === 'string' ? input : String(input?.url ?? '');
          const body = init?.body;
          if (url.includes('/speech/transcribe') && body && typeof body.size === 'number' && typeof body.type === 'string') {
            const headers = init?.headers ?? {};
            target.__speechUploads.push({ size: body.size, type: body.type, requestId: headers['X-Speech-Request-Id'] ?? null });
          }
        } catch { /* 记录失败不能影响产品请求 */ }
        return original(input, init);
      }) as typeof window.fetch;
    });

    await openStudio(page);

    // 先真选一个对象，保证指令与选中元素绑定（与真实演示顺序一致）。
    const staged: Array<{ path: string; status: number; requestId: string | null; body: any; ms: number; bytes: number; contentType: string | null }> = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/speech/transcribe') {
        (request as any).__startedAt = Date.now();
      }
    });
    page.on('response', async (response) => {
      const url = new URL(response.url());
      if (response.request().method() !== 'POST' || url.pathname !== '/speech/transcribe') return;
      const request = response.request();
      // 浏览器用 Blob/流上传时不发 Content-Length；真正的字节数从 Playwright 捕获的请求体算。
      const posted = request.postDataBuffer()?.length ?? 0;
      const declared = Number(request.headers()['content-length'] ?? 0);
      let body: unknown = null;
      try { body = await response.json(); } catch { /* 原始文本已在别处断言 */ }
      staged.push({
        path: url.pathname,
        status: response.status(),
        requestId: request.headers()['x-speech-request-id'] ?? null,
        body,
        ms: Date.now() - ((request as any).__startedAt ?? Date.now()),
        bytes: posted || declared,
        contentType: request.headers()['content-type'] ?? null,
      });
    });

    const taskPosts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === '/tasks') taskPosts.push(request.url());
    });

    const button = page.getByTestId('speech-record');
    await expect(button).toBeEnabled({ timeout: 30_000 });
    await button.hover();
    await page.mouse.down();
    await expect(page.getByTestId('speech-status')).toContainText('正在录音', { timeout: 20_000 });
    // 语音样本 6.34s + 1.5s 尾部静音（7.84s），按住 7.0s 保证整句只出现一次。
    await page.waitForTimeout(7_000);
    await page.mouse.up();

    await page.getByTestId('speech-review').waitFor({ state: 'visible', timeout: 90_000 });
    const textarea = page.getByTestId('speech-review-text');
    const transcript = await textarea.inputValue();

    expect(staged.length, '没有抓到 /speech/transcribe 的响应').toBeGreaterThanOrEqual(1);
    const call = staged[0];
    expect(call.status, `转写失败：${JSON.stringify(call.body)}`).toBe(200);
    expect(call.body?.provider, '响应不是阿里云真实转写').toBe('aliyun');
    expect(call.body?.model).toBe('qwen3-asr-flash');
    expect(call.body?.requestId, '响应 requestId 与请求头不一致').toBe(call.requestId);
    expect(call.requestId, '请求没有携带 UUID').toMatch(/^[0-9a-f-]{36}$/);
    expect(call.contentType, '上传体不是录音编码产物').toMatch(/^audio\/(webm|ogg)/);
    expect(call.body?.text, '响应体没有转写文本').toBeTruthy();

    const uploads = await page.evaluate(() => (window as any).__speechUploads as Array<{ size: number; type: string; requestId: string | null }>);
    expect(uploads.length, '产品没有把录音 Blob 交给 fetch').toBeGreaterThanOrEqual(1);
    expect(uploads[0].size, '录音 Blob 字节过少，麦克风没真正采集').toBeGreaterThan(2_000);
    expect(uploads[0].type, '录音 Blob 不是浏览器编码产物').toMatch(/^audio\/(webm|ogg)/);
    expect(uploads[0].requestId, '上传的 requestId 与响应不一致').toBe(call.requestId);

    const normalized = normalize(transcript);
    for (const phrase of EXPECT_KEY_PHRASES) {
      expect(normalized, `转写内容缺少「${phrase}」：${transcript}`).toContain(phrase);
    }

    // 确认前可编辑，且确认不会自动提交任务。
    const edited = `${transcript.replace(/[。.]$/, '')}，按钮样式保持克制。`;
    await textarea.fill(edited);
    await page.getByTestId('speech-use').click();
    await expect(page.getByTestId('instruction-input')).toHaveValue(edited);
    await expect(page.getByTestId('generate-candidate')).toBeEnabled();
    expect(taskPosts, '确认转写后不应自动提交任务').toEqual([]);

    await page.screenshot({ path: path.join(ARTIFACT_DIR, 'real-speech-review.png'), fullPage: true });
    writeArtifact('real-speech-transcribe.json', {
      config,
      call: { status: call.status, requestId: call.requestId, ms: call.ms, contentType: call.contentType, body: call.body },
      uploads,
      transcript,
      normalized,
      editedInstruction: edited,
      taskPosts,
      speechWav: process.env.M4_REAL_SPEECH_WAV ?? 'tests/e2e/m4/fixtures/speech-instruction-48k.wav',
    });
  });
});
