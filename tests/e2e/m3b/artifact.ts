import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 本分支的验收准备证据目录；正式 Pi 验收会另建目录，不复用这里。 */
export const ARTIFACT_DIR = path.join(process.cwd(), 'docs', 'reports', 'artifacts', 'M3-B', 'acceptance-precheck');

export function writeArtifact(name: string, data: unknown): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, name);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
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
