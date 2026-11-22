import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, binaryUpload, mutation } from './api.ts';

describe('api transport helper', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('injects cache: no-store, redirect: error, and a timeout AbortSignal by default', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const data = await api<{ ok: boolean }>('/works');
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('/works');
    expect(init.cache).toBe('no-store');
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('preserves caller-provided signal and headers while wrapping server error fields into ApiError', async () => {
    const callerController = new AbortController();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'VALIDATION_ERROR', message: '字段越界', fields: { fov: 'out of range' } },
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    let thrown: unknown;
    try {
      await api('/scene', { ...mutation('PUT', { fov: 999 }), signal: callerController.signal });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect(thrown).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      message: '字段越界',
      fields: { fov: 'out of range' },
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[1].signal).toBe(callerController.signal);
  });

  it('falls back to REQUEST_FAILED on non-JSON error responses and formats binaryUpload', async () => {
    const fetchMock = vi.fn(async () => new Response('Bad Gateway', { status: 502 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(api('/assets')).rejects.toMatchObject({
      status: 502,
      code: 'REQUEST_FAILED',
      message: '请求失败（502）',
    });

    const payload = new Uint8Array([1, 2, 3, 4]).buffer;
    expect(binaryUpload(payload)).toEqual({
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: payload,
    });
  });
});
