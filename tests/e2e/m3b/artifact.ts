import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 正式 Pi 验收的证据目录（2026-11-15 那一轮）。本轮固定写到这里，
 * 不再与 `acceptance-precheck/`（验收准备）混用；下次正式验收改这里的日期即可。
 */
export const FORMAL_RUN_ID = 'formal-20261115';
export const ARTIFACT_DIR = path.join(process.cwd(), 'docs', 'reports', 'artifacts', 'M3-B', FORMAL_RUN_ID, 'checks');

export function writeArtifact(name: string, data: unknown): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, name);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
}

/** 原样落盘一份接口取回的证据字节（不改内容，便于事后逐字节复算 sha256）。 */
export function writeEvidenceBytes(dir: string, name: string, bytes: Buffer): string {
  const target = path.join(ARTIFACT_DIR, dir, name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes);
  return target;
}

/** 只保留可归档的检查摘要，不把整份 run 的原始证据内联进报告。 */
export function summarizeRun(run: {
  id: string; status: string; outcome?: string; policyVersion: string; createdAt: string; finishedAt?: string;
  checks: Array<{ name: string; status: string; message?: string; evidence?: string; durationMs?: number }>;
  artifacts?: Array<{ name: string; mime: string; bytes: number; hash: string }>;
  error?: { code: string; message: string };
}) {
  return {
    id: run.id,
    status: run.status,
    outcome: run.outcome,
    policyVersion: run.policyVersion,
    createdAt: run.createdAt,
    finishedAt: run.finishedAt,
    durationMs: run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.createdAt) : undefined,
    checks: run.checks.map((check) => ({ name: check.name, status: check.status, message: check.message, evidence: check.evidence, durationMs: check.durationMs })),
    artifacts: run.artifacts?.map((ref) => ({ name: ref.name, mime: ref.mime, bytes: ref.bytes, hash: ref.hash })),
    error: run.error,
  };
}
