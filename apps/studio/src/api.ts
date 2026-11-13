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
