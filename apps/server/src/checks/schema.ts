import path from 'node:path';
import { lstat, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isSceneConfig, sceneConfigSchema } from '@spatial/shared/scene-config';
import Ajv from 'ajv';
import type { CheckResult } from '@spatial/shared';
import type { CheckContext } from './runner.ts';

const validate = new Ajv({ allErrors: true, strict: true }).compile(sceneConfigSchema);

/** The schema is evaluated against the same frozen input as the compiler. */
export async function checkSchema(ctx: CheckContext): Promise<CheckResult> {
  ctx.signal.throwIfAborted();
  const startedAt = Date.now();
  const finish = async (status: 'passed' | 'failed', detail: object, message?: string): Promise<CheckResult> => {
    ctx.signal.throwIfAborted();
    const ref = await ctx.writeArtifact('schema.json', JSON.stringify({ status, ...detail }));
    return { name: 'schema', status, evidence: ref.hash, message, durationMs: Date.now() - startedAt };
  };
  let raw: Buffer;
  try {
    const file = path.join(ctx.buildRoot, 'src/scene.config.json');
    // Parent already audited ancestors; the worker may read only its snapshot.
    for (const name of [ctx.buildRoot, path.dirname(file), file]) {
      if ((await lstat(name)).isSymbolicLink()) throw new Error('SCHEMA_LINK');
    }
    const handle = await open(file, 'r');
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 100_000) throw new Error('SCHEMA_SIZE');
      const buffer = Buffer.alloc(100_001);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > 100_000) throw new Error('SCHEMA_SIZE');
      raw = buffer.subarray(0, total);
    } finally { await handle.close(); }
  } catch {
    return finish('failed', { error: 'SCHEMA_UNREADABLE' }, '场景配置文件缺失或不可读');
  }
  const configHash = createHash('sha256').update(raw).digest('hex');
  let config: unknown;
  try { config = JSON.parse(raw.toString('utf8')); }
  catch { return finish('failed', { error: 'INVALID_JSON', configHash }, '场景配置不是有效 JSON'); }
  if (!validate(config)) {
    // No input values/snippets are copied to reports.
    const errors = validate.errors?.map(error => ({ path: error.instancePath, keyword: error.keyword, message: error.message })) ?? [];
    return finish('failed', { configHash, errors }, '场景配置 Schema 校验失败');
  }
  if (!isSceneConfig(config)) return finish('failed', { configHash, error: 'INVALID_KEYFRAMES' }, '关键帧位置必须严格递增');
  return finish('passed', { configHash });
}

