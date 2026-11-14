import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from '../assets/atomic-file.ts';

/**
 * Fixed artifact filenames for each check run. No HTTP-supplied paths.
 * Unknown run/name returns 404. Path traversal is rejected.
 */
export const ARTIFACT_NAMES = [
  'schema.json', 'build.log', 'smoke.json', 'smoke.png',
  'occlusion.json', 'occlusion.png', 'runner.log', 'summary.json',
] as const;
export type ArtifactName = typeof ARTIFACT_NAMES[number];

const allowedNames = new Set<string>(ARTIFACT_NAMES);
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024; // 2 MB per artifact
const MAX_LOG_BYTES = 100_000; // 100 KB for text logs

export class ArtifactError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) { super(message); this.code = code; this.status = status; }
}

export interface ArtifactRef {
  name: string;
  mime: string;
  bytes: number;
  hash: string;
}

/** Validate that a name is in the fixed set and has no traversal characters. */
export function validateArtifactName(name: string): asserts name is ArtifactName {
  if (!allowedNames.has(name) || name.includes('/') || name.includes('\\') || name.includes('..') || name.includes('\0')) {
    throw new ArtifactError('UNKNOWN_ARTIFACT', '未知或非法的证据文件名', 404);
  }
}

/** Get the MIME type for an artifact name. */
export function artifactMime(name: string): string {
  if (name.endsWith('.json')) return 'application/json; charset=utf-8';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.log')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

/** Determine if an artifact is text (can be truncated) or binary (stored as-is). */
function isTextArtifact(name: string): boolean {
  return name.endsWith('.json') || name.endsWith('.log');
}

/**
 * Atomically write an artifact to the run's evidence directory.
 * Text artifacts are truncated to MAX_LOG_BYTES; binary artifacts to MAX_ARTIFACT_BYTES.
 */
export async function writeArtifact(baseDir: string, runId: string, name: string, content: Buffer | string): Promise<ArtifactRef> {
  validateArtifactName(name);
  const dir = path.join(baseDir, 'check-artifacts', runId);
  await mkdir(dir, { recursive: true });
  let buf: Buffer;
  if (typeof content === 'string') {
    buf = Buffer.from(content, 'utf8');
    if (isTextArtifact(name) && buf.byteLength > MAX_LOG_BYTES) {
      buf = Buffer.from(buf.subarray(0, MAX_LOG_BYTES).toString('utf8') + '\n…（日志过长，已截断）\n', 'utf8');
    }
  } else {
    buf = content;
    if (buf.byteLength > MAX_ARTIFACT_BYTES) throw new ArtifactError('ARTIFACT_TOO_LARGE', `证据文件 ${name} 超过上限`, 413);
  }
  const file = path.join(dir, name);
  await writeAtomic(file, buf);
  const hash = createHash('sha256').update(buf).digest('hex');
  return { name, mime: artifactMime(name), bytes: buf.byteLength, hash };
}

/** Read an artifact's raw bytes, enforcing no path traversal. */
export async function readArtifact(baseDir: string, runId: string, name: string): Promise<{ buffer: Buffer; ref: ArtifactRef }> {
  validateArtifactName(name);
  // runId must be alphanumeric only.
  if (!/^[a-z0-9]{6,32}$/.test(runId)) throw new ArtifactError('UNKNOWN_RUN', '未知的检查运行编号', 404);
  const dir = path.join(baseDir, 'check-artifacts', runId);
  const file = path.join(dir, name);
  // Resolve and verify no traversal.
  const resolved = path.resolve(file);
  const resolvedDir = path.resolve(dir);
  if (!resolved.startsWith(resolvedDir + path.sep) && resolved !== resolvedDir) {
    throw new ArtifactError('PATH_DENIED', '路径攻击被拒绝', 403);
  }
  let stats;
  try { stats = await stat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ArtifactError('ARTIFACT_NOT_FOUND', '证据文件不存在', 404); throw error; }
  if (!stats.isFile()) throw new ArtifactError('ARTIFACT_NOT_FOUND', '证据文件不存在', 404);
  // Refuse if it's a symlink or directory.
  try {
    const real = await realpath(file);
    if (path.relative(file, real) !== '') throw new ArtifactError('PATH_DENIED', '证据路径包含链接', 403);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const buffer = await readFile(file);
  const hash = createHash('sha256').update(buffer).digest('hex');
  return { buffer, ref: { name, mime: artifactMime(name), bytes: buffer.byteLength, hash } };
}

/** List all artifacts for a run. */
export async function listArtifacts(baseDir: string, runId: string): Promise<ArtifactRef[]> {
  if (!/^[a-z0-9]{6,32}$/.test(runId)) throw new ArtifactError('UNKNOWN_RUN', '未知的检查运行编号', 404);
  const dir = path.join(baseDir, 'check-artifacts', runId);
  let entries: string[];
  try { entries = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const refs: ArtifactRef[] = [];
  for (const name of entries) {
    if (!allowedNames.has(name)) continue;
    const file = path.join(dir, name);
    const stats = await stat(file);
    if (!stats.isFile()) continue;
    const buffer = await readFile(file);
    const hash = createHash('sha256').update(buffer).digest('hex');
    refs.push({ name, mime: artifactMime(name), bytes: stats.size, hash });
  }
  return refs;
}

/** Remove all artifacts for a run. */
export async function removeArtifacts(baseDir: string, runId: string): Promise<void> {
  const { rm } = await import('node:fs/promises');
  const dir = path.join(baseDir, 'check-artifacts', runId);
  await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}
