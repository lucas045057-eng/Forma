import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, open } from 'node:fs/promises';
import { writeAtomic } from './atomic-file.ts';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { Asset, AssetEvent, AssetProvenance, FallbackPreset, ModelMetrics } from '@spatial/shared';
import {assertPlainPath,readPlainFile} from '../checks/paths.ts';
import {FALLBACK_PRESETS,DEFAULT_FALLBACK_DIRECTORY,readFallback,sha256} from './fallbacks.ts';
import {cleanAssetProvenance} from './provenance.ts';
import { AssetError, Lux3DClient, type GenerationInput } from './lux3d.ts';
import { downloadGlb } from './download.ts';
import { processModelIsolated } from './process-isolated.ts';
import { cleanupAssetTemporaries } from './cleanup.ts';
import { acquireInstanceLock } from './instance-lock.ts';

type RecordEntry = Asset & { keyHash?: string; fingerprint?: string; deadline?: number };
export interface ServiceOptions {
  directory: string;
  client: Lux3DClient;
  fallbackDirectory?: string;
  /** Internal fixture digests only; production AppOptions/HTTP/env do not expose this. */
  presetDigests?: Readonly<Record<string,string>>;
  mockUpstream?: boolean;
  pollMs?: number;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
  process?: (input: string, output: string) => Promise<ModelMetrics>;
  download?: typeof downloadGlb;
  emit?: (event: AssetEvent) => void;
}
const safeId = /^[a-zA-Z0-9_-]{1,80}$/;
export function validAssetId(id: string) { return safeId.test(id); }
function publicAsset(entry: RecordEntry): Asset {
  const { keyHash: _key, fingerprint: _fingerprint, deadline: _deadline, ...asset } = entry;
  return structuredClone({...asset,provenance:cleanAssetProvenance(asset.provenance)});
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
  private jobFailure?: unknown;
  private releaseLock?: () => Promise<void>;
  constructor(options: ServiceOptions) { this.options = options; }
  async init() {
    await mkdir(this.options.directory, { recursive: true });
    // Ownership first: nothing below may run while another instance owns this directory.
    this.releaseLock = await acquireInstanceLock(this.options.directory);
    await cleanupAssetTemporaries(this.options.directory);
    try {
      this.entries = JSON.parse(await readFile(path.join(this.options.directory, 'index.json'), 'utf8')) as RecordEntry[];
      if (!Array.isArray(this.entries) || this.entries.some(entry => !validAssetId(entry.id))) throw new Error('Invalid asset index');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取资产索引，请检查 .data/assets/index.json'); }
    for (const entry of this.entries) {
      if (entry.status === 'submitting') {
        entry.status = 'submit_unknown';
        entry.error = { code: 'SUBMIT_UNCONFIRMED', message: '上次提交未确认；请先查询 Lux3D 任务列表并导入，禁止自动重复提交' };
      }
      if (entry.status === 'ready' && !await this.modelExists(entry)) {
        entry.status = 'failed';
        entry.modelUrl = undefined;
        entry.error = { code: 'MODEL_MISSING', message: '模型文件缺失，请按原任务编号重新导入修复' };
      }
      if (!entry.taskId && ['polling', 'downloading', 'processing'].includes(entry.status)) {
        entry.status='failed';entry.error={code:'LOCAL_IMPORT_INTERRUPTED',message:'本地处理被中断，请明确重新导入备用资产'};entry.modelUrl=undefined;
      }
      if (entry.taskId && ['polling', 'downloading', 'processing'].includes(entry.status)) {
        entry.status = 'polling';
        entry.deadline = Date.now() + (this.options.timeoutMs ?? 900_000);
        entry.error = undefined;
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
      await writeAtomic(file, json);
    });
    this.writes = operation.catch(error => { this.jobFailure ??= error; });
    return operation;
  }
  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const result = this.submissions.then(() => {
      if (this.abort.signal.aborted) throw new AssetError('SERVICE_STOPPED', '资产服务已停止');
      return work();
    });
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
  private async modelExists(entry: RecordEntry) {
    try {
      if(entry.provenance?.outputHash){const denied=()=>new AssetError('ASSET_PATH_DENIED','资产路径未通过检查');const bytes=await readPlainFile(path.join(this.options.directory,entry.taskId??entry.id,'model.glb'),100*1024*1024,denied,denied,this.abort.signal);return sha256(bytes)===entry.provenance.outputHash;}
      const file = await open(path.join(this.options.directory, entry.taskId ?? entry.id, 'model.glb'), 'r');
      try { const info = await file.stat(); return info.isFile() && info.size > 0; }
      finally { await file.close(); }
    } catch { return false; }
  }
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
        const taskId = input.prompt ? await this.options.client.createTextTo3d(input, this.abort.signal) : await this.options.client.createImgTo3d(input, this.abort.signal);
        await this.update(entry, { taskId, status: 'polling', provenance:{kind:this.options.mockUpstream?'unknown':'lux3d',sourceTaskId:taskId,importedAt:entry.createdAt}, deadline: Date.now() + (this.options.timeoutMs ?? 900_000) });
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
      if (existing && this.jobs.has(existing.id)) return publicAsset(existing);
      if (existing?.status === 'ready' && await this.modelExists(existing)) return publicAsset(existing);
      const now = new Date().toISOString();
      const entry: RecordEntry = existing ?? { id: `lux3d-${taskId}`, taskId, status: 'polling', createdAt: now, updatedAt: now };
      if (!existing) this.entries.push(entry);
      await this.update(entry, { status: 'polling', modelUrl: undefined, error: undefined, provenance:{kind:this.options.mockUpstream?'unknown':'lux3d',sourceTaskId:taskId,importedAt:entry.provenance?.importedAt??now}, deadline: Date.now() + (this.options.timeoutMs ?? 900_000) });
      // Re-import always queries current remote state before downloading; it never creates another paid task.
      this.start(entry);
      return publicAsset(entry);
    });
  }
  async listFallbacks():Promise<FallbackPreset[]> {
    return Promise.all(FALLBACK_PRESETS.map(async preset=>{
      try {await readFallback(this.options.fallbackDirectory??DEFAULT_FALLBACK_DIRECTORY,preset.id,this.abort.signal,this.options.presetDigests);return {id:preset.id,title:preset.title,available:true,description:'备用资产，预先生成；时间未记录'};}
      catch {return {id:preset.id,title:preset.title,available:false,description:'备用资产，预先生成；时间未记录',reason:'本地文件缺失、过大或未通过路径/格式检查'};}
    }));
  }
  importFallback(presetId:string):Promise<Asset> {
    return this.exclusive(async()=>{
      const {binary,sourceHash}=await readFallback(this.options.fallbackDirectory??DEFAULT_FALLBACK_DIRECTORY,presetId,this.abort.signal,this.options.presetDigests);
      return this.prepareLocal(binary,`fallback-${sourceHash.slice(0,24)}`,{kind:'fallback',presetId,sourceHash,importedAt:new Date().toISOString()});
    });
  }
  async importLocal(input:string,id:string):Promise<Asset> {
    if(!validAssetId(id))throw new AssetError('INVALID_ID','本地资产编号无效');
    const asset=await this.exclusive(async()=>{
      const bytes=await readPlainFile(input,32*1024*1024,()=>new AssetError('LOCAL_PATH_DENIED','本地模型路径不得包含链接'),()=>new AssetError('MODEL_TOO_LARGE','本地模型超过32MiB'),this.abort.signal);
      return this.prepareLocal(bytes,id,{kind:'unknown',sourceHash:sha256(bytes),importedAt:new Date().toISOString()});
    });
    await this.jobs.get(asset.id);
    return this.get(asset.id)!;
  }
  private async prepareLocal(binary:Buffer,id:string,provenance:AssetProvenance):Promise<Asset> {
    this.abort.signal.throwIfAborted();
    const fingerprint=sha256(binary);const existing=this.entries.find(entry=>entry.id===id);
    if(existing?.taskId||existing&&existing.fingerprint!==fingerprint)throw new AssetError('ASSET_EXISTS','本地资产编号已用于不同的内容');
    if(existing&&(this.jobs.has(id)||existing.status==='ready'&&await this.modelExists(existing)))return publicAsset(existing);
    const now=new Date().toISOString();const entry:RecordEntry=existing??{id,status:'processing',createdAt:now,updatedAt:now,fingerprint};
    if(!existing)this.entries.push(entry);
    const directory=path.join(this.options.directory,id);
    await assertPlainPath(directory,()=>new AssetError('LOCAL_PATH_DENIED','资产写入目录不得包含链接'),true);await mkdir(directory,{recursive:true});
    const raw=path.join(directory,'raw.glb');await assertPlainPath(raw,()=>new AssetError('LOCAL_PATH_DENIED','资产文件不得包含链接'),true);
    await this.update(entry,{status:'processing',modelUrl:undefined,error:undefined,provenance:existing?.provenance??provenance});
    try {await writeAtomic(raw,binary);this.abort.signal.throwIfAborted();}
    catch(error){await this.update(entry,{status:'failed',error:failure(error)});throw error;}
    const job=this.process(entry).catch(async error=>{await this.update(entry,{status:this.abort.signal.aborted?'cancelled':'failed',modelUrl:undefined,error:this.abort.signal.aborted?{code:'LOCAL_IMPORT_CANCELLED',message:'本地处理已停止，请明确重新导入'}:failure(error)});}).finally(()=>this.jobs.delete(id));
    this.jobs.set(id,job);void job.catch(error=>{this.jobFailure??=error;});
    return publicAsset(entry);
  }
  private start(entry: RecordEntry) {
    const job = this.run(entry).catch(async error => {
      if (this.abort.signal.aborted) {
        await this.update(entry, { status: 'polling', deadline: undefined, error: { code: 'SERVICE_STOPPED', message: '服务已停止，重启后继续查询原任务' } });
      } else await this.update(entry, { status: 'failed', error: failure(error) });
    }).finally(() => this.jobs.delete(entry.id));
    this.jobs.set(entry.id, job);
    // A persistence failure must not become an unhandled rejection or expose upstream data.
    void job.catch(error => { this.jobFailure ??= error; });
  }
  private async run(entry: RecordEntry) {
    while (true) {
      this.abort.signal.throwIfAborted();
      if (Date.now() >= (entry.deadline ?? 0)) throw new AssetError('POLL_TIMEOUT', '等待 Lux3D 超过 15 分钟；可使用原任务编号重新导入查询，勿重复生成');
      const task = await this.options.client.getTask(entry.taskId!, this.abort.signal);
      this.abort.signal.throwIfAborted();
      if (task.status === 4) throw new AssetError('GENERATION_FAILED', 'Lux3D 生成失败');
      if (task.status === 6) { await this.update(entry, { status: 'cancelled', error: { code: 'GENERATION_CANCELLED', message: 'Lux3D 任务已取消' } }); return; }
      if (task.status === 3) {
        const output = task.outputs?.find(item => typeof item.content === 'string' && /\.glb(?:\?|$)/i.test(item.content));
        if (!output) throw new AssetError('NO_GLB', '任务成功但没有 GLB 输出，请使用 outputFormat: glb 创建任务');
        const directory = path.join(this.options.directory, entry.taskId ?? entry.id);
        await mkdir(directory, { recursive: true });
        await this.update(entry, { status: 'downloading' });
        await (this.options.download ?? downloadGlb)(output.content, path.join(directory, 'raw.glb'), this.options.client.base, { signal: this.abort.signal, timeoutMs: this.options.downloadTimeoutMs });
        await this.process(entry);
        return;
      }
      if (task.status !== 0 && task.status !== 1) throw new AssetError('UNKNOWN_STATUS', 'Lux3D 返回未知任务状态');
      await this.update(entry, { status: 'polling' });
      await delay(Math.min(this.options.pollMs ?? 15_000, Math.max(1, (entry.deadline ?? 0) - Date.now())), undefined, { signal: this.abort.signal });
    }
  }
  private async process(entry: RecordEntry) {
    this.abort.signal.throwIfAborted();
    await this.update(entry, { status: 'processing' });
    const directory = path.join(this.options.directory, entry.taskId ?? entry.id);
    const input = path.join(directory, 'raw.glb');
    const output = path.join(directory, 'model.glb');
    const metrics = this.options.process
      ? await this.options.process(input, output)
      : await processModelIsolated(input, output, { signal: this.abort.signal });
    this.abort.signal.throwIfAborted();
    let provenance=entry.provenance;
    if(!this.options.process||provenance?.kind==='fallback'){
      const denied=()=>new AssetError('ASSET_PATH_DENIED','处理产物路径未通过检查');const large=()=>new AssetError('MODEL_TOO_LARGE','处理产物超过100MiB');
      const [source,processed]=await Promise.all([readPlainFile(input,100*1024*1024,denied,large,this.abort.signal),readPlainFile(output,100*1024*1024,denied,large,this.abort.signal)]);
      const origin:AssetProvenance=provenance??{kind:'unknown'};
      provenance={...origin,sourceHash:sha256(source),outputHash:sha256(processed)};
    }
    await this.update(entry, { status: 'ready', metrics, provenance, modelUrl: `/assets/${entry.id}/model.glb?revision=${randomUUID()}`, error: undefined });
  }
  async idle() { const results=await Promise.allSettled([...this.jobs.values()]); await this.writes; const failed=results.find((item):item is PromiseRejectedResult=>item.status==='rejected');if(this.jobFailure||failed)throw this.jobFailure??failed!.reason; }
  async close() {
    this.abort.abort(); await this.submissions; await this.idle();
    const release = this.releaseLock; this.releaseLock = undefined;
    await release?.();
  }
}
