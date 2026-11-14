import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ARTIFACT_DIR } from './env';

/**
 * M3-C 证据落盘：结构化中间结果写进 docs/reports/artifacts/M3-C/。
 * 正式轮次由入口用 --output / PLAYWRIGHT_JSON_OUTPUT_NAME 定向到本轮目录，这里只写“当轮产物”。
 */
export function writeArtifact(name: string, data: unknown): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, name);
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
}
