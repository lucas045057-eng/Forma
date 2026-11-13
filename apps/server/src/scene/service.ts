import Ajv from 'ajv';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isSceneConfig, sceneConfigSchema, type SceneConfig } from '@spatial/shared/scene-config';
import { sceneDiff, type SceneChanged } from '@spatial/shared/scene-edit';
import { writeAtomic } from '../assets/atomic-file.ts';
import type { AssetService } from '../assets/service.ts';

export class SceneError extends Error {
  code: string;
  status: number;
  fields?: unknown;
  constructor(code: string, message: string, status = 400, fields?: unknown) {
    super(message); this.code = code; this.status = status; this.fields = fields;
  }
}
const validate = new Ajv({ allErrors: true, strict: true }).compile(sceneConfigSchema);
export function validateScene(value: unknown): asserts value is SceneConfig {
  if (!validate(value)) throw new SceneError('INVALID_SCENE', '场景配置不合法', 400,
    validate.errors?.map(error => ({ path: error.instancePath, keyword: error.keyword, message: error.message, params: error.params })));
  if (!isSceneConfig(value)) throw new SceneError('INVALID_SCENE', '关键帧位置必须严格递增', 400, [{ path: '/scroll', message: 'at must be strictly increasing' }]);
}

// Reject symlinks/junctions on every existing component, including the destination.
// WORK_ROOT itself is an operator-selected trust root, never supplied by a request.
export async function safeWorkPath(root: string, relative: string) {
  const absoluteRoot = await realpath(root);
  const target = path.resolve(absoluteRoot, relative);
  const rel = path.relative(absoluteRoot, target);
  if (!rel || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) throw new SceneError('PATH_DENIED', '路径超出作品目录', 403);
  let current = absoluteRoot;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new SceneError('PATH_DENIED', '作品路径不得包含符号链接', 403);
      // Real-path comparison catches every reparse-point kind, including junctions (review F1).
      if (path.relative(current, await realpath(current)) !== '') throw new SceneError('PATH_DENIED', '作品路径不得包含符号链接或目录联接', 403);
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return target;
}
// Bound the journal: it is rewritten on every commit and each entry holds two full configs.
const MAX_HISTORY = 50;
interface HistoryEntry { sequence: number; ts: string; previous: SceneConfig; next: SceneConfig; kind: 'write' | 'undo' }
interface Journal { sequence: number; stack: SceneConfig[]; entries: HistoryEntry[]; pending?: { entry: HistoryEntry; stack: SceneConfig[] } }

export class SceneService {
  private queue: Promise<unknown> = Promise.resolve();
  private state?: Journal;
  private journalFile = '';
  private options: { workRoot: string; historyDirectory: string; emit?: (event: SceneChanged) => void };
  constructor(options: { workRoot: string; historyDirectory: string; emit?: (event: SceneChanged) => void }) { this.options = options; }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {});
    return result;
  }
  async idle() { await this.queue; }
  private async configPath() { return safeWorkPath(this.options.workRoot, 'src/scene.config.json'); }
  private async load() {
    if (!this.state) {
      const root = await realpath(this.options.workRoot);
      const id = createHash('sha256').update(root).digest('hex').slice(0, 24);
      await mkdir(this.options.historyDirectory, { recursive: true });
      this.journalFile = path.join(this.options.historyDirectory, `${id}.json`);
      try {
        const state = JSON.parse(await readFile(this.journalFile, 'utf8')) as Journal;
        if (!Number.isSafeInteger(state.sequence) || !Array.isArray(state.stack) || !Array.isArray(state.entries)
          || !state.stack.every(isSceneConfig)) throw new Error('Invalid scene history');
        this.state = state;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.state = { sequence: 0, stack: [], entries: [] };
      }
    }
    if (this.state.pending) {
      const pending = this.state.pending;
      validateScene(pending.entry.next);
      // A durable intent is replayed after interruption; never publish an event before the file.
      await writeAtomic(await this.configPath(), JSON.stringify(pending.entry.next, null, 2) + '\n');
      const next: Journal = { sequence: pending.entry.sequence, stack: pending.stack.slice(-MAX_HISTORY), entries: [...this.state.entries, pending.entry].slice(-MAX_HISTORY) };
      await writeAtomic(this.journalFile, JSON.stringify(next, null, 2));
      this.state = next;
    }
  }
  private async read() {
    const config: unknown = JSON.parse(await readFile(await this.configPath(), 'utf8'));
    validateScene(config);
    return config;
  }
  get() { return this.serial(async () => { await this.load(); return this.read(); }); }
  private async commit(previous: SceneConfig, next: SceneConfig, kind: 'write' | 'undo', stack: SceneConfig[]) {
    validateScene(next);
    await this.configPath();
    const entry: HistoryEntry = { sequence: this.state!.sequence + 1, ts: new Date().toISOString(), previous, next, kind };
    const intent: Journal = { ...this.state!, pending: { entry, stack } };
    await writeAtomic(this.journalFile, JSON.stringify(intent, null, 2));
    this.state = intent;
    await this.load();
    const event: SceneChanged = { type: 'scene.changed', sequence: entry.sequence, ts: entry.ts, config: next, diff: sceneDiff(previous, next) };
    this.options.emit?.(event);
    return event;
  }
  put(value: unknown) {
    return this.serial(async () => {
      validateScene(value);
      const next = structuredClone(value);
      await this.load();
      const previous = await this.read();
      return this.commit(previous, next, 'write', [...this.state!.stack, previous]);
    });
  }
  undo() {
    return this.serial(async () => {
      await this.load();
      const previous = await this.read();
      const stack = [...this.state!.stack];
      const next = stack.pop();
      if (!next) throw new SceneError('NO_SCENE_HISTORY', '没有可以撤回的场景写入', 409);
      return this.commit(previous, next, 'undo', stack);
    });
  }
  adopt(service: AssetService, id: string, force: boolean) {
    return this.serial(async () => {
      if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new SceneError('INVALID_ASSET', '资产编号无效');
      const asset = service.get(id), source = service.modelPath(id);
      if (!asset || !source || asset.status !== 'ready') throw new SceneError('ASSET_NOT_READY', '模型尚未就绪', 409);
      if (asset.metrics?.webReady === false && !force) throw new SceneError('FORCE_REQUIRED', '模型超过网页门槛，需要明确强制采用', 409);
      const metadata = asset.metrics?.parts ?? { recognized: false, nodes: [], reason: 'No part metadata' };
      const binary = await readFile(source);
      await this.load();
      const previous = await this.read();
      const next = { ...previous, model: `/assets/${id}.glb` };
      validateScene(next);
      const destination = await safeWorkPath(this.options.workRoot, `public/assets/${id}.glb`);
      const parts = await safeWorkPath(this.options.workRoot, `public/assets/${id}.parts.json`);
      await mkdir(path.dirname(destination), { recursive: true });
      // Stable URLs are immutable: undo must not silently reference overwritten model bytes.
      try {
        if (!(await readFile(destination)).equals(binary)) throw new SceneError('ASSET_NAME_CONFLICT', '作品已有同名但内容不同的模型', 409);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await safeWorkPath(this.options.workRoot, `public/assets/${id}.glb`);
      await writeAtomic(destination, binary);
      await writeAtomic(parts, JSON.stringify(metadata, null, 2));
      return this.commit(previous, next, 'write', [...this.state!.stack, previous]);
    });
  }
}
