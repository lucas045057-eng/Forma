import type { CheckArtifact } from '@spatial/shared';
import { evidenceUrl, safeArtifact } from './check-state.ts';

export async function readCheckEvidence(runId: string, ref: CheckArtifact, signal: AbortSignal) {
  const url = evidenceUrl(runId, ref.name);
  if (!url || !safeArtifact(ref)) throw new Error('证据引用不完整');
  const response = await fetch(url, { signal, cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new Error('证据无法读取，请刷新检查状态');
  const mime = ref.mime.split(';')[0].trim().toLowerCase();
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== mime) throw new Error('证据类型不匹配');
  const bytes = await response.arrayBuffer();
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (bytes.byteLength !== ref.bytes) throw new Error('证据大小不匹配');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== ref.hash) throw new Error('证据 hash 不匹配');
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
  if (mime === 'image/png') {
    const header = new Uint8Array(bytes).slice(0, 8);
    if (header.join(',') !== '137,80,78,71,13,10,26,10') throw new Error('PNG 证据格式不匹配');
  }
  return { blob: new Blob([bytes], { type: mime }), text: mime === 'image/png' ? undefined : new TextDecoder().decode(bytes) };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const result = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
  if (!response.ok) throw new ApiError(response.status, result.error?.code ?? 'REQUEST_FAILED', result.error?.message ?? `请求失败（${response.status}）`);
  return result as T;
}
export const mutation = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
