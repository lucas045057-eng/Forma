import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Asset, AssetEvent, ModelMetrics } from '@spatial/shared';
import { AssetError, Lux3DClient, type GenerationInput } from './lux3d.ts';
import { downloadGlb } from './download.ts';
import { processModel } from './process-model.ts';

type RecordEntry = Asset & { keyHash?: string; fingerprint?: string; deadline?: number };
export interface ServiceOptions {
  directory: string;
  client: Lux3DClient;
  pollMs?: number;
  timeoutMs?: number;
  process?: (input: string, output: string) => Promise<ModelMetrics>;
  download?: typeof downloadGlb;
  emit?: (event: AssetEvent) => void;
}
const safeId = /^[a-zA-Z0-9_-]{1,80}$/;
export function validAssetId(id: string) { return safeId.test(id); }
function publicAsset(entry: RecordEntry): Asset {
  const { keyHash: _key, fingerprint: _fingerprint, deadline: _deadline, ...asset } = entry;
  return structuredClone(asset);
}
function failure(error: unknown): { code: string; message: string } {
  return error instanceof AssetError ? { code: error.code, message: error.message } :
    { code: 'ASSET_PROCESSING_FAILED', message: '资产处理失败，请检查 GLB 文件和服务端配置' };
}

export class AssetService {
  private readonly options: ServiceOptions;
  private entries: RecordEntry[] = [];
  private writes: Promise<void> = Promise.resolve();
  private submissions: Promise<unknown> = Promise.resolve();
  private jobs = new Map<string, Promise<void>>();
  private abort = new AbortController();
  private sequence = 0;
  constructor(options: ServiceOptions) { this.options = options; }
  async init() {
    await mkdir(this.options.directory, { recursive: true });
    try {
      this.entries = JSON.parse(await readFile(path.join(this.options.directory, 'index.json'), 'utf8')) as RecordEntry[];
      if (!Array.isArray(this.entries) || this.entries.some(entry => !validAssetId(entry.id))) throw new Error('Invalid asset index');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取资产索引，请检查 .data/assets/index.json'); }
    for (const entry of this.entries) {
      if (entry.status === 'submitting') {
        entry.status = 'submit_unknown';
        entry.error = { code: 'SUBMIT_UNCONFIRMED', message: '上次提交未确认；请先查询 Lux3D 任务列表并导入，禁止自动重复提交' };
      }
    }
    await this.save();
    for (const entry of this.entries) {
      if (entry.taskId && ['polling', 'downloading', 'processing'].includes(entry.status)) this.start(entry);
    }
  }
  private save(): Promise<void> {
    const json = JSON.stringify(this.entries, null, 2);
    const file = path.join(this.options.directory, 'index.json');
    const operation = this.writes.then(async () => {
      await writeFile(`${file}.tmp`, json);
      await rename(`${file}.tmp`, file);
    });
    this.writes = operation.catch(() => {});
    return operation;
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.submissions.then(work);
    this.submissions = result.catch(() => {});
    return result;
  }
  private async update(entry: RecordEntry, changes: Partial<RecordEntry>) {
    Object.assign(entry, changes, { updatedAt: new Date().toISOString() });
    await this.save();
    this.options.emit?.({ type: entry.status === 'ready' ? 'asset.ready' : 'asset.progress', ts: entry.updatedAt, sequence: ++this.sequence, asset: publicAsset(entry) });
  }
  list() { return this.entries.map(publicAsset); }
  get(id: string) { const entry = this.entries.find(item => item.id === id); return entry ? publicAsset(entry) : undefined; }
  modelPath(id: string) {
    if (!validAssetId(id) || this.get(id)?.status !== 'ready') return undefined;
    const entry = this.entries.find(item => item.id === id)!;
    return path.join(this.options.directory, entry.taskId ?? id, 'model.glb');
  }
  submit(input: GenerationInput, idempotencyKey: string): Promise<Asset> {
    return this.exclusive(async () => {
      const keyHash = createHash('sha256').update(idempotencyKey).digest('hex');
      const fingerprint = createHash('sha256').update(JSON.stringify({ prompt: input.prompt, img: input.img, version: input.version })).digest('hex');
      const previous = this.entries.find(item => item.keyHash === keyHash);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new AssetError('IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同的生成参数');
        return publicAsset(previous);
      }
      const now = new Date().toISOString();
      const entry: RecordEntry = { id: randomUUID(), status: 'submitting', createdAt: now, updatedAt: now, keyHash, fingerprint };
      this.entries.push(entry);
      await this.save();
      try {
        const taskId = input.prompt ? await this.options.client.createTextTo3d(input) : await this.options.client.createImgTo3d(input);
        await this.update(entry, { taskId, status: 'polling', deadline: Date.now() + (this.options.timeoutMs ?? 900_000) });
        this.start(entry);
      } catch (error) {
        await this.update(entry, { status: 'submit_unknown', error: failure(error) });
      }
      return publicAsset(entry);
    });
  }
  importTask(taskId: string): Promise<Asset> {
    if (!/^\d{1,20}$/.test(taskId)) return Promise.reject(new AssetError('INVALID_TASK', '任务编号必须为数字'));
    return this.exclusive(async () => {
      const existing = this.entries.find(item => item.taskId === taskId);
      if (existing?.status === 'ready' || (existing && this.jobs.has(existing.id))) return publicAsset(existing);
      const now = new Date().toISOString();
      const entry: RecordEntry = existing ?? { id: `lux3d-${taskId}`, taskId, status: 'polling', createdAt: now, updatedAt: now };
      if (!existing) this.entries.push(entry);
      await this.update(entry, { status: 'polling', error: undefined, deadline: Date.now() + (this.options.timeoutMs ?? 900_000) });
      // Re-import always queries current remote state before downloading; it never creates another paid task.
      this.start(entry);
      return publicAsset(entry);
    });
  }
  async importLocal(input: string, id: string): Promise<Asset> {
    if (!validAssetId(id)) throw new AssetError('INVALID_ID', '本地资产编号无效');
    const existing = this.entries.find(entry => entry.id === id);
    if (existing && (existing.taskId || existing.status !== 'failed')) throw new AssetError('ASSET_EXISTS', '该本地资产编号已存在');
    const now = new Date().toISOString();
    const entry: RecordEntry = existing ?? { id, status: 'processing', createdAt: now, updatedAt: now };
    if (!existing) this.entries.push(entry);
    await this.update(entry, { status: 'processing', error: undefined });
    try {
      const directory = path.join(this.options.directory, id);
      await mkdir(directory, { recursive: true });
      await copyFile(input, path.join(directory, 'raw.glb'));
      await this.process(entry);
    } catch (error) { await this.update(entry, { status: 'failed', error: failure(error) }); }
    return publicAsset(entry);
  }
  private start(entry: RecordEntry) {
    const job = this.run(entry).catch(async error => {
      if (!this.abort.signal.aborted) await this.update(entry, { status: 'failed', error: failure(error) });
    }).finally(() => this.jobs.delete(entry.id));
    this.jobs.set(entry.id, job);
    // A persistence failure must not become an unhandled rejection or expose upstream data.
    void job.catch(() => {});
  }
  private async run(entry: RecordEntry) {
    while (!this.abort.signal.aborted) {
      if (Date.now() >= (entry.deadline ?? 0)) throw new AssetError('POLL_TIMEOUT', '等待 Lux3D 超过 15 分钟；可使用原任务编号重新导入查询，勿重复生成');
      const task = await this.options.client.getTask(entry.taskId!);
      if (task.status === 4) throw new AssetError('GENERATION_FAILED', 'Lux3D 生成失败');
      if (task.status === 6) { await this.update(entry, { status: 'cancelled', error: { code: 'GENERATION_CANCELLED', message: 'Lux3D 任务已取消' } }); return; }
      if (task.status === 3) {
        const output = task.outputs?.find(item => typeof item.content === 'string' && /\.glb(?:\?|$)/i.test(item.content));
        if (!output) throw new AssetError('NO_GLB', '任务成功但没有 GLB 输出，请使用 outputFormat: glb 创建任务');
        const directory = path.join(this.options.directory, entry.taskId ?? entry.id);
        await mkdir(directory, { recursive: true });
        await this.update(entry, { status: 'downloading' });
        await (this.options.download ?? downloadGlb)(output.content, path.join(directory, 'raw.glb'), this.options.client.base);
        await this.process(entry);
        return;
      }
      if (task.status !== 0 && task.status !== 1) throw new AssetError('UNKNOWN_STATUS', 'Lux3D 返回未知任务状态');
      await this.update(entry, { status: 'polling' });
      await delay(Math.min(this.options.pollMs ?? 15_000, Math.max(1, (entry.deadline ?? 0) - Date.now())), undefined, { signal: this.abort.signal });
    }
  }
  private async process(entry: RecordEntry) {
    await this.update(entry, { status: 'processing' });
    const directory = path.join(this.options.directory, entry.taskId ?? entry.id);
    const metrics = await (this.options.process ?? processModel)(path.join(directory, 'raw.glb'), path.join(directory, 'model.glb'));
    await this.update(entry, { status: 'ready', metrics, modelUrl: `/assets/${entry.id}/model.glb`, error: undefined });
  }
  async idle() { await Promise.allSettled([...this.jobs.values()]); await this.writes; }
  async close() { this.abort.abort(); await this.idle(); }
}
