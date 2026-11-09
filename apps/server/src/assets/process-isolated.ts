import { fork } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from './atomic-file.ts';
import type { processModel } from './process-model.ts';

type ModelResult = Awaited<ReturnType<typeof processModel>>;

export async function processModelIsolated(
  inputPath: string,
  outputPath: string,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ModelResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid model processing timeout');
  options.signal?.throwIfAborted();
  const directory = dirname(resolve(outputPath));
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, '.model-stage-'));
  try {
    options.signal?.throwIfAborted();
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const worker = fileURLToPath(new URL(`./process-worker.${extension}`, import.meta.url));
    // Never inherit provider keys, NODE_OPTIONS, proxy settings or loader hooks.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    const result = await new Promise<ModelResult>((resolveResult, reject) => {
      const child = fork(worker, [resolve(inputPath), join(staging, 'model.glb')], {
        env, execArgv: [], cwd: staging, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
      let result: ModelResult | undefined;
      let failure: Error | undefined;
      const stop = (error: Error) => {
        failure ??= error;
        child.kill('SIGKILL');
      };
      const abort = () => stop(new Error('Model processing aborted', { cause: options.signal?.reason }));
      const timer = setTimeout(() => stop(new Error('Model processing timed out')), timeoutMs);
      options.signal?.addEventListener('abort', abort, { once: true });
      child.on('message', (message: { result?: ModelResult; error?: string }) => {
        if (message?.error) failure ??= new Error(message.error);
        if (message?.result) result = message.result;
      });
      child.once('error', (error) => { failure ??= error; });
      // close follows exit (or spawn failure), so cleanup never races a live writer.
      child.once('close', (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        if (failure) reject(failure);
        else if (code !== 0 || !result) reject(new Error(`Model worker exited without a result (${code})`));
        else resolveResult(result);
      });
      if (options.signal?.aborted) abort();
    });
    options.signal?.throwIfAborted();
    const [binary, parts] = await Promise.all([
      readFile(join(staging, 'model.glb')), readFile(join(staging, 'parts.json')),
    ]);
    options.signal?.throwIfAborted();
    await writeAtomic(join(directory, 'parts.json'), parts);
    await writeAtomic(resolve(outputPath), binary);
    return result;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
