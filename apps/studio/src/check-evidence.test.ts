import { afterEach, expect, it, vi } from 'vitest';
import { readCheckEvidence } from './api.ts';
import type { CheckArtifact } from '@spatial/shared';

async function fixture(text = '<script>alert(1)</script>') {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  const ref: CheckArtifact = { name: 'build.log', mime: 'text/plain; charset=utf-8', bytes: bytes.length, hash };
  return { text, ref };
}
afterEach(() => vi.unstubAllGlobals());
it('GETs only the safe artifact endpoint and returns logs as inert text after hash verification', async () => {
  const { text, ref } = await fixture();
  const fetcher = vi.fn().mockResolvedValue(new Response(text, { headers: { 'Content-Type': ref.mime } }));
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  const result = await readCheckEvidence('run001', ref, controller.signal);
  expect(result.text).toBe(text);
  expect(result.blob.type).toBe('text/plain');
  expect(fetcher).toHaveBeenCalledWith('/checks/run001/artifacts/build.log', { signal: controller.signal, cache: 'no-store', redirect: 'error' });
});
it('rejects unreadable, wrong-MIME, tampered and size-mismatched evidence', async () => {
  const { text, ref } = await fixture();
  for (const response of [new Response('', { status: 404 }), new Response(text, { headers: { 'Content-Type': 'text/html' } }), new Response('x'.repeat(ref.bytes), { headers: { 'Content-Type': ref.mime } }), new Response('short', { headers: { 'Content-Type': ref.mime } })]) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(readCheckEvidence('run001', ref, new AbortController().signal)).rejects.toThrow();
  }
});
it('does not publish a late read after cancellation even when transport ignores AbortSignal', async () => {
  const { text, ref } = await fixture();
  let finish!: (value: Response) => void;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; })));
  const controller = new AbortController();
  const read = readCheckEvidence('run001', ref, controller.signal);
  controller.abort();
  finish(new Response(text, { headers: { 'Content-Type': ref.mime } }));
  await expect(read).rejects.toMatchObject({ name: 'AbortError' });
});
it('rejects unsupported paths before issuing any request', async () => {
  const { ref } = await fixture();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  await expect(readCheckEvidence('run001', { ...ref, name: 'attack.svg' }, new AbortController().signal)).rejects.toThrow();
  expect(fetcher).not.toHaveBeenCalled();
});
