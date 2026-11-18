import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp, redactErrorText, sanitizeServerError } from './app.ts';

describe('server 500 error logging and credential redaction', () => {
  it('redacts bearer tokens, URL userinfo, query parameters and sk- keys from error text', () => {
    const raw = 'Failed calling https://user:topsecret@example.com/v1/run?apiKey=secret123 with Bearer tok_abc999 and sk-1234567890abcdef';
    const redacted = redactErrorText(raw);
    expect(redacted).not.toContain('topsecret');
    expect(redacted).not.toContain('secret123');
    expect(redacted).not.toContain('tok_abc999');
    expect(redacted).not.toContain('sk-1234567890abcdef');
    expect(redacted).toContain('[REDACTED]');

    const structured = sanitizeServerError(Object.assign(new Error(raw), { code: 'EIO' }));
    expect(structured.code).toBe('EIO');
    expect(structured.message).not.toContain('tok_abc999');
    expect(structured.stack ?? '').not.toContain('tok_abc999');
  });

  it('logs sanitized diagnostic details on unexpected 500 errors while keeping the public response opaque', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'spatial-err-log-'));
    const workRoot = path.join(root, 'work');
    await mkdir(path.join(workRoot, 'src'), { recursive: true });
    await writeFile(path.join(workRoot, 'src/App.tsx'), 'export default () => <main/>;\n');

    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });

    const instance = await createApp({
      workRoot,
      dataDirectory: path.join(root, 'assets'),
      workDataDirectory: path.join(root, 'work-data'),
      historyDirectory: path.join(root, 'history'),
      base: 'http://127.0.0.1:9',
      key: 'fake-key-canary',
      codingAgentBaseUrl: 'http://127.0.0.1:9',
      codingAgentApiKey: 'fake-key-canary',
      codingAgentModel: 'mock-coder',
      speech: {},
      logger: { level: 'error', stream },
    });

    const boom = Object.assign(
      new Error('Unexpected crash with Bearer secret-canary-999 at https://op:pwd@example.com/x?token=xyz'),
      { code: 'ENOENT' },
    );
    const spy = vi.spyOn(instance.service, 'list').mockImplementationOnce(() => {
      throw boom;
    });

    try {
      const response = await instance.app.inject({ method: 'GET', url: '/assets?debug=secret-query' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        error: { code: 'SERVER_ERROR', message: '本地服务错误，请检查配置和文件' },
      });

      const joined = lines.join('');
      expect(joined).toContain('unhandled server error');
      expect(joined).toContain('"code":"ENOENT"');
      expect(joined).toContain('"url":"/assets"');
      expect(joined).not.toContain('secret-canary-999');
      expect(joined).not.toContain('secret-query');
      expect(joined).not.toContain('op:pwd');
      expect(joined).not.toContain('token=xyz');
    } finally {
      spy.mockRestore();
      await instance.app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
