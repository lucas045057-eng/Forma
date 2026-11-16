import type { AssetPlacementSession, LuxCapabilities, LuxOperation, LuxTask } from '@spatial/shared';
import type { SceneModuleConfig } from '@spatial/shared/scene-module';
export interface WorkbenchUpload { id: string; kind: 'image' | 'glb' | 'lux-zip'; filename: string; bytes: number; sha256: string; width?: number; height?: number; rigged?: boolean }
export class LuxApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) { super(message); this.name = 'LuxApiError'; this.status = status; this.code = code; }
}
async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(30000) }); }
  catch { throw new LuxApiError(0, 'NETWORK', '请求未确认；请刷新原任务，不要重复提交'); }
  let result: unknown = undefined;
  try { result = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    const error = result && typeof result === 'object' ? (result as { error?: { code?: unknown; message?: unknown } }).error : undefined;
    throw new LuxApiError(response.status, typeof error?.code === 'string' ? error.code : 'REQUEST_FAILED', typeof error?.message === 'string' ? error.message : '请求未确认，请刷新原任务，勿重复提交');
  }
  return result as T;
}
const body = (value: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
export function describeError(cause: unknown): string {
  return cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '操作未确认，请刷新状态';
}
export interface ModuleRecord { id: string; config: SceneModuleConfig; canUndo: boolean; stale: boolean; entries: number }
export const luxApi = {
  capabilities: () => request<LuxCapabilities>('/assets/lux3d/capabilities'),
  uploads: () => request<WorkbenchUpload[]>('/assets/uploads'),
  tasks: () => request<LuxTask[]>('/assets/lux3d/tasks'),
  remoteHistory: (page = 1, filters: { status?: number; starttime?: string; endtime?: string } = {}) => {
    const query = new URLSearchParams({ page: String(page) });
    if (filters.status !== undefined) query.set('status', String(filters.status));
    if (filters.starttime) query.set('starttime', filters.starttime);
    if (filters.endtime) query.set('endtime', filters.endtime);
    return request<Array<{ providerTaskId: string; status: number; created?: string }>>(`/assets/lux3d/remote-history?${query.toString()}`);
  },
  importExisting: (operation: LuxOperation, providerTaskId: string) => request<LuxTask>('/assets/lux3d/import-operation', body({ operation, providerTaskId })),
  create: (operation: LuxOperation, parameters: Record<string, unknown>, idempotencyKey: string) => request<LuxTask>('/assets/lux3d/operations', body({ operation, parameters, idempotencyKey })),
  stop: (id: string) => request<LuxTask>(`/assets/lux3d/tasks/${encodeURIComponent(id)}/stop`, body({})),
  resume: (id: string) => request<LuxTask>(`/assets/lux3d/tasks/${encodeURIComponent(id)}/resume`, body({})),
  link: (id: string, providerTaskId: string) => request<LuxTask>(`/assets/lux3d/tasks/${encodeURIComponent(id)}/link`, body({ providerTaskId, confirmed: true })),
  refresh: (id: string) => request<LuxTask>(`/assets/lux3d/tasks/${encodeURIComponent(id)}/refresh`, body({})),
  useInput: (task: string, artifact: string) => request<WorkbenchUpload>(`/assets/lux3d/tasks/${encodeURIComponent(task)}/artifacts/${encodeURIComponent(artifact)}/use-input`, body({})),
  upload: (file: File) => request<WorkbenchUpload>(`/assets/uploads?kind=${file.name.toLowerCase().endsWith('.glb') ? 'glb' : 'image'}&filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal: AbortSignal.timeout(60000) }),
  placementSession: (assetId: string, baseVersion: string) => request<AssetPlacementSession>('/assets/placements/sessions', body({ assetId, baseVersion })),
  modules: () => request<ModuleRecord[]>('/assets/modules'),
  module: (id: string) => request<{ config: SceneModuleConfig; canUndo: boolean; stale: boolean; history: unknown[]; conflict?: string }>(`/assets/modules/${encodeURIComponent(id)}`),
  adjustModule: (id: string, baseVersion: string, adjustment: unknown) => request<{ config: SceneModuleConfig; version: string }>(`/assets/modules/${encodeURIComponent(id)}/adjust`, body({ baseVersion, adjustment })),
  undoModule: (id: string, baseVersion: string) => request<{ config: SceneModuleConfig; version: string }>(`/assets/modules/${encodeURIComponent(id)}/undo`, body({ baseVersion })),
  removeModule: (id: string, baseVersion: string) => request<{ id: string }>(`/assets/modules/${encodeURIComponent(id)}/remove`, body({ baseVersion })),
};
