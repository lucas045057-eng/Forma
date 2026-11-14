import { createHash } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from '../assets/atomic-file.ts';
import { assertPlainPath, readPlainFile } from './paths.ts';

export const ARTIFACT_NAMES = [
  'schema.json', 'build.log', 'smoke.json', 'smoke.png',
  'occlusion.json', 'occlusion.png', 'runner.log', 'summary.json',
] as const;
export type ArtifactName = typeof ARTIFACT_NAMES[number];
const allowedNames = new Set<string>(ARTIFACT_NAMES);
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const MAX_LOG_BYTES = 100_000;

export class ArtifactError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}
export interface ArtifactRef { name: string; mime: string; bytes: number; hash: string }

export function validateArtifactName(name: string): asserts name is ArtifactName {
  if (!allowedNames.has(name)) throw new ArtifactError('UNKNOWN_ARTIFACT', '未知或非法的证据文件名', 404);
}
function validateRunId(runId: string) {
  if (!/^[a-z0-9]{6,32}$/.test(runId)) throw new ArtifactError('UNKNOWN_RUN', '未知的检查运行编号', 404);
}
export function artifactMime(name: string): string {
  if (name.endsWith('.json')) return 'application/json; charset=utf-8';
  if (name.endsWith('.png')) return 'image/png';
  return 'text/plain; charset=utf-8';
}
const denied = () => new ArtifactError('PATH_DENIED', '证据路径包含链接或特殊文件', 403);
const tooLarge = () => new ArtifactError('ARTIFACT_TOO_LARGE', '证据文件超过上限', 413);

async function directory(baseDir: string, runId: string, create = false): Promise<string> {
  validateRunId(runId);
  const dir = path.join(path.resolve(baseDir), 'check-artifacts', runId);
  await assertPlainPath(dir, denied, true);
  if (create) {
    await mkdir(dir, { recursive: true });
    await assertPlainPath(dir, denied);
  }
  return dir;
}

export async function writeArtifact(baseDir: string, runId: string, name: string, content: Buffer | string): Promise<ArtifactRef> {
  validateArtifactName(name);
  const dir = await directory(baseDir, runId, true);
  let buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (name.endsWith('.log') && buffer.length > MAX_LOG_BYTES) {
    const suffix = Buffer.from('\n…（日志过长，已截断）\n');
    buffer = Buffer.concat([buffer.subarray(0, MAX_LOG_BYTES - suffix.length), suffix]);
  } else if (buffer.length > (name.endsWith('.json') ? MAX_LOG_BYTES : MAX_ARTIFACT_BYTES)) throw tooLarge();
  const file = path.join(dir, name);
  await assertPlainPath(file, denied, true);
  await writeAtomic(file, buffer);
  await assertPlainPath(file, denied);
  return { name, mime: artifactMime(name), bytes: buffer.length, hash: createHash('sha256').update(buffer).digest('hex') };
}

export async function readArtifact(baseDir: string, runId: string, name: string, expected?: ArtifactRef): Promise<{ buffer: Buffer; ref: ArtifactRef }> {
  validateArtifactName(name);
  const dir = await directory(baseDir, runId);
  let buffer: Buffer;
  try { buffer = await readPlainFile(path.join(dir, name), MAX_ARTIFACT_BYTES, denied, tooLarge); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ArtifactError('ARTIFACT_NOT_FOUND', '证据文件不存在', 404);
    throw error;
  }
  const ref = { name, mime: artifactMime(name), bytes: buffer.length, hash: createHash('sha256').update(buffer).digest('hex') };
  if (expected && (expected.name !== ref.name || expected.mime !== ref.mime || expected.bytes !== ref.bytes || expected.hash !== ref.hash)) {
    throw new ArtifactError('EVIDENCE_CHANGED', '证据内容与检查记录不一致', 409);
  }
  return { buffer, ref };
}

export async function listArtifacts(baseDir: string, runId: string): Promise<ArtifactRef[]> {
  const dir = await directory(baseDir, runId);
  let entries: string[];
  try { entries = await readdir(dir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const refs: ArtifactRef[] = [];
  for (const name of entries.sort()) if (allowedNames.has(name)) refs.push((await readArtifact(baseDir, runId, name)).ref);
  return refs;
}

export async function removeArtifacts(baseDir: string, runId: string): Promise<void> {
  const dir = await directory(baseDir, runId);
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
