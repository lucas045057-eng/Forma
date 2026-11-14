import type { CheckName, CheckResult } from '@spatial/shared';
import type { SnapshotResult } from './snapshot.ts';
import type { ArtifactRef } from './artifacts.ts';

export interface RunPacket {
  kind: 'run'; token: number; runId: string; name: CheckName; buildRoot: string;
  snapshot: SnapshotResult; buildTimeoutMs: number; browserTimeoutMs: number;
}
export type ParentPacket = RunPacket | { kind: 'stop' } |
  { kind: 'artifact-result'; token: number; ref?: ArtifactRef; error?: string };
export type WorkerPacket = { kind: 'ready' } |
  { kind: 'artifact'; token: number; requestToken: number; name: string; encoding: 'utf8' | 'base64'; content: string } |
  { kind: 'result'; requestToken: number; result: CheckResult } |
  { kind: 'error'; requestToken: number; message: string };

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function isRunPacket(value: unknown): value is RunPacket {
  if (!record(value) || value.kind !== 'run' || !Number.isSafeInteger(value.token) || typeof value.runId !== 'string' || !/^[a-f0-9]{32}$/.test(value.runId)) return false;
  if (!['schema', 'build', 'smoke', 'occlusion'].includes(String(value.name)) || typeof value.buildRoot !== 'string' || !record(value.snapshot)) return false;
  const snapshot = value.snapshot;
  if (typeof snapshot.digest !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.digest) || !Array.isArray(snapshot.entries) || snapshot.entries.length > 500) return false;
  if (!Number.isSafeInteger(snapshot.totalBytes) || (snapshot.totalBytes as number) < 0 || (snapshot.totalBytes as number) > 50 * 1024 * 1024) return false;
  if (!snapshot.entries.every(item => record(item) && typeof item.path === 'string' && /^(src|public)\//.test(item.path) &&
    !item.path.split('/').includes('..') && typeof item.hash === 'string' && /^[a-f0-9]{64}$/.test(item.hash) && typeof item.bytes === 'number' && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= 32 * 1024 * 1024)) return false;
  return typeof value.buildTimeoutMs === 'number' && value.buildTimeoutMs > 0 && value.buildTimeoutMs <= 120000 &&
    typeof value.browserTimeoutMs === 'number' && value.browserTimeoutMs > 0 && value.browserTimeoutMs <= 30000;
}
