import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ARTIFACT_DIR } from './env';

export function writeArtifactFrom(name: string, data: unknown): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, name);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
}
