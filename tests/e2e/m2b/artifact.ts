import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ARTIFACT_DIR = path.join(process.cwd(), 'docs', 'reports', 'artifacts', 'M2-B');

/** 证据写到 docs/reports/artifacts/M2-B/，返回文件路径。 */
export function writeArtifactFrom(name: string, data: unknown): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, name);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
}
