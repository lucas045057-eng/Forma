import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { AssetProvenance, LuxArtifact, LuxOperation, LuxSubmissionClass, LuxTask } from '@spatial/shared';
import { AssetError, Lux3DClient } from './lux3d.ts';
import { LuxUploadStore, type UploadRecord } from './lux3d-upload.ts';
import { LuxTaskStore } from './lux3d-task-store.ts';
import { luxCapabilities, luxInputRefs, luxParametersFingerprint, normalizeLuxParameters, providerBody, LUX_OPERATION_ROUTES, type LuxParameters } from './lux3d-operations.ts';
import { ProviderUploader } from './lux3d-provider-upload.ts';
import { downloadArtifactBytes } from './download.ts';
import { writeAtomic } from './atomic-file.ts';
import { sha256 } from './fallbacks.ts';
import type { AssetService } from './service.ts';
import { readPlainFile } from '../checks/paths.ts';
import { parseLuxOutputs, type LuxOutputSpec } from './lux3d-results.ts';

export interface LuxTaskServiceOptions {
  client: Lux3DClient;
  uploads: LuxUploadStore;
  uploader: ProviderUploader;
  assets: AssetService;
  artifactsDirectory: string;
  pollMs?: number;
  timeoutMs?: number;
  artifactHosts?: string[];
  downloadTimeoutMs?: number;
  optimize?: boolean;
  maxActiveTasks?: number;
}

type StoredLuxTask = LuxTask & { keyHash?: string; parameters?: LuxParameters; resumeListedAt?: string };

function failure(error: unknown, classification?: LuxSubmissionClass): { code: string; message: string; classification?: LuxSubmissionClass } {
  const kind = classification ?? (error instanceof AssetError ? error.classification : undefined);
  if (error instanceof AssetError) return { code: error.code, message: error.message, ...(kind ? { classification: kind } : {}) };
  return { code: 'LUX_TASK_FAILED', message: '任务处理失败，请查看本地任务记录，勿重复创建', ...(kind ? { classification: kind } : {}) };
}
function classify(error: unknown): LuxSubmissionClass {
  if (error instanceof AssetError && error.classification) return error.classification;
  if (error instanceof AssetError && ['UPSTREAM_REJECTED', 'UPSTREAM_AUTH', 'UPLOAD_REJECTED'].includes(error.code)) return 'rejected';
  if (error instanceof AssetError && ['MISSING_KEY', 'INVALID_PROVIDER_ROUTE', 'INVALID_OPERATION_INPUT', 'INVALID_UPLOAD_REFERENCE'].includes(error.code)) return 'blocked';
  return 'unknown';
}
function urlHash(url: string) { return createHash('sha256').update(url).digest('hex'); }

function sniff(bytes: Buffer): { format: string; kind: LuxArtifact['kind'] } | undefined {
  if (bytes.length >= 12 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { format: 'png', kind: 'image' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { format: 'jpg', kind: 'image' };
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { format: 'webp', kind: 'image' };
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'glTF' && bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.length) return { format: 'glb', kind: 'model' };
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2])) return { format: 'zip', kind: 'archive' };
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 3).toLowerCase() === 'ply') return { format: 'ply', kind: 'model' };
  if (bytes.length >= 5 && bytes.toString('ascii', 0, 5).toLowerCase() === 'solid') return { format: 'stl', kind: 'model' };
  if (bytes.length >= 18 && bytes.toString('ascii', 0, 18) === 'Kaydara FBX Binary') return { format: 'fbx', kind: 'model' };
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 6).toLowerCase().includes('fbx')) return { format: 'fbx', kind: 'model' };
  return undefined;
}
function glbJson(bytes: Buffer): { animations?: unknown[]; skins?: unknown[]; meshes?: Array<{ primitives?: Array<{ targets?: unknown[] }> }> } | undefined {
  try {
    if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF') return undefined;
    return JSON.parse(bytes.toString('utf8', 20, 20 + bytes.readUInt32LE(12))) as { animations?: unknown[]; skins?: unknown[]; meshes?: Array<{ primitives?: Array<{ targets?: unknown[] }> }> };
  } catch { return undefined; }
}

export class LuxTaskService {
  private readonly store: LuxTaskStore;
  private readonly options: LuxTaskServiceOptions;
  private exclusiveChain: Promise<unknown> = Promise.resolve();
  private jobs = new Map<string, Promise<void>>();
  private abort = new AbortController();
  private jobFailure: unknown;
  private paused = new Set<string>();
  private closing = false;
  private readonly maxActive: number;

  constructor(directory: string, options: LuxTaskServiceOptions) {
    this.store = new LuxTaskStore(directory);
    this.options = options;
    this.maxActive = Math.max(1, Math.min(2, options.maxActiveTasks ?? 2));
  }

  async init() {
    await this.store.init();
    for (const task of this.store.list() as StoredLuxTask[]) {
      if (task.stage === 'reserved') {
        await this.store.update({ ...task, stage: 'cancelled', note: '服务重启前尚未上传或提交生成；没有创建云端任务', updatedAt: new Date().toISOString() });
        continue;
      }
      if (task.providerTaskId && ['queued', 'running'].includes(task.stage)) this.start(task);
      else if (!task.providerTaskId && ['queued'].includes(task.stage)) {
        await this.store.update({ ...task, stage: 'submit_unknown', note: '重启后没有可信的任务编号；只允许查询或由用户明确关联', updatedAt: new Date().toISOString() });
      }
    }
  }

  capabilities() { return luxCapabilities(this.options.client.configured, { active: this.options.client.activeGateway, legacy: this.options.client.legacyGateway }); }
  list() { return this.store.list().map(task => this.public(task as StoredLuxTask)); }
  get(id: string) { return this.store.get(id); }
  public(task: LuxTask): LuxTask {
    const { localId, operation, providerTaskId, stage, inputRefs, parametersHash, artifacts, error, createdAt, updatedAt, resumeCandidates, manualLink, note } = task;
    return { localId, operation, providerTaskId, stage, inputRefs, parametersHash, artifacts, error, createdAt, updatedAt, resumeCandidates, manualLink, note };
  }

  private exclusive<T>(work: () => Promise<T>) {
    const next = this.exclusiveChain.then(() => { this.abort.signal.throwIfAborted(); return work(); });
    this.exclusiveChain = next.catch(() => {});
    return next;
  }
  private async persist(task: LuxTask) { task.updatedAt = new Date().toISOString(); return this.store.update(task); }

  create(input: { operation: LuxOperation; parameters: unknown; idempotencyKey: string }): Promise<LuxTask> {
    return this.exclusive(async () => {
      if (this.closing) throw new AssetError('SERVICE_CLOSING', '本地服务正在关闭，未接受新的生成请求', 503, 'blocked');
      if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 128) throw new AssetError('INVALID_IDEMPOTENCY_KEY', '幂等键必须为1–128字符', 400, 'blocked');
      const parameters = normalizeLuxParameters(input.operation, input.parameters);
      const fingerprint = luxParametersFingerprint(input.operation, parameters);
      const keyHash = createHash('sha256').update(input.idempotencyKey).digest('hex');
      const previous = this.store.findKey(keyHash) as StoredLuxTask | undefined;
      if (previous) {
        if (previous.parametersHash !== fingerprint) throw new AssetError('IDEMPOTENCY_CONFLICT', '同一幂等键不能用于不同参数', 409, 'blocked');
        return previous;
      }
      if (this.store.list().length >= 200) throw new AssetError('TASK_HISTORY_LIMIT', '任务历史已达到200条上限，请由操作者管理', 429, 'blocked');
      if (this.jobs.size >= this.maxActive) throw new AssetError('LUX_BUSY', `本地同时处理的任务已达上限（${this.maxActive}），本次未上传或提交云端；请等待当前任务结束`, 429, 'blocked');
      const refs = luxInputRefs(input.operation, parameters);
      for (const id of refs) {
        const record = this.options.uploads.get(id);
        if (!record) throw new AssetError('UPLOAD_NOT_FOUND', '输入引用不存在', 400, 'blocked');
        if (input.operation === 'animation-retarget' && !record.rigged) throw new AssetError('MODEL_NOT_RIGGED', '动画重定向需要已绑骨GLB，请先完成数字人绑骨', 400, 'blocked');
        const image = (parameters.images as string[] | undefined)?.includes(id) || parameters.imageUploadId === id;
        if (image && record.kind !== 'image') throw new AssetError('INVALID_INPUT_KIND', '图片输入必须引用真实图片', 400, 'blocked');
        if (!image && record.kind !== 'glb' && !(input.operation === 'export' && record.kind === 'lux-zip')) throw new AssetError('INVALID_INPUT_KIND', '该操作需要GLB；仅导出接受Lux3D ZIP', 400, 'blocked');
        if (input.operation === 'export' && record.kind === 'glb' && !(parameters.outputFormat as string[]).length) throw new AssetError('INVALID_OPERATION_INPUT', 'GLB导出至少选择一种目标格式', 400, 'blocked');
      }
      const now = new Date().toISOString();
      const task: StoredLuxTask = {
        localId: randomUUID(), operation: input.operation, stage: 'reserved', inputRefs: refs,
        parametersHash: fingerprint, artifacts: [], createdAt: now, updatedAt: now, keyHash, parameters,
      };
      await this.persist(task);
      this.start(task);
      return task;
    });
  }

  private start(task: LuxTask) {
    if (this.closing || this.abort.signal.aborted || this.jobs.has(task.localId)) return;
    if (this.jobs.size >= this.maxActive) return;
    const job = this.run(task).catch(async error => {
      const latest = this.get(task.localId) ?? task;
      if (this.abort.signal.aborted) {
        const stage = latest.providerTaskId ? latest.stage : latest.stage === 'submitting' || latest.stage === 'submit_unknown' ? 'submit_unknown' : 'cancelled';
        await this.persist({ ...latest, stage, note: latest.providerTaskId ? '本地服务停止，重启后只按原任务编号恢复查询' : '本地服务停止；未确认的生成不会被自动重提' });
      } else if (latest.providerTaskId) {
        // Once a provider id exists, later failures are task/output failures — never a resubmission.
        const detail = failure(error);
        await this.persist({ ...latest, stage: 'failed', error: { code: detail.code, message: detail.message } });
      } else {
        const kind = classify(error);
        await this.persist({ ...latest, stage: kind === 'unknown' ? 'submit_unknown' : 'failed', error: failure(error, kind) });
      }
    }).finally(() => {
      this.jobs.delete(task.localId);
      if (!this.closing && !this.abort.signal.aborted) {
        for (const next of this.store.list() as StoredLuxTask[]) {
          if (this.jobs.size >= this.maxActive) break;
          if (next.providerTaskId && ['queued', 'running'].includes(next.stage)) this.start(next);
        }
      }
    });
    this.jobs.set(task.localId, job);
    void job.catch(error => { this.jobFailure ??= error; });
  }

  private async publish(record: UploadRecord): Promise<string> {
    if (record.providerUrl && this.options.uploads.fresh(record)) return record.providerUrl;
    const url = await this.options.uploader.publish(await this.options.uploads.bytes(record.id, this.abort.signal), record.filename, this.options.client.base, this.abort.signal);
    return (await this.options.uploads.registerPublished(record.id, url)).providerUrl!;
  }

  private async run(initial: LuxTask) {
    let task = this.get(initial.localId) as StoredLuxTask;
    if (!task.providerTaskId) {
      if (task.stage === 'submit_unknown' || task.stage === 'cancelled') return;
      const urls = new Map<string, string>();
      if (task.inputRefs.length) {
        task = (await this.persist({ ...task, stage: 'uploading' })) as StoredLuxTask;
        try {
          for (const id of task.inputRefs) {
            const record = this.options.uploads.get(id);
            if (!record) throw new AssetError('UPLOAD_NOT_FOUND', '任务引用的上传不存在', 409, 'blocked');
            urls.set(id, await this.publish(record));
          }
        } catch (error) {
          await this.persist({ ...task, stage: 'failed', error: failure(error, classify(error)), note: '输入上传未完成，未提交生成任务；可用新的明确操作重试' });
          return;
        }
      }
      if (this.paused.has(task.localId)) {
        await this.persist({ ...task, stage: 'cancelled', note: '已停止本地等待；上传可能发生，但尚未提交生成任务' });
        return;
      }
      if (this.abort.signal.aborted) return;
      const parameters = task.parameters!;
      task = (await this.persist({ ...task, stage: 'submitting' })) as StoredLuxTask;
      let providerTaskId: string;
      try {
        providerTaskId = await this.options.client.createProviderTask(LUX_OPERATION_ROUTES[task.operation], providerBody(task.operation, parameters, urls), this.abort.signal);
      } catch (error) {
        const kind = classify(error);
        if (kind === 'unknown') {
          await this.persist({ ...task, stage: 'submit_unknown', error: failure(error, kind) });
        } else {
          await this.persist({ ...task, stage: 'failed', error: failure(error, kind) });
        }
        return;
      }
      task = (await this.persist({ ...task, providerTaskId, stage: 'queued', error: undefined })) as StoredLuxTask;
    }
    await this.poll(task);
  }

  private async queryProvider(id: string, deadline: number) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.options.client.getProviderTask(id, this.abort.signal); }
      catch (error) {
        if (!(error instanceof AssetError) || !['UPSTREAM_UNAVAILABLE', 'UPSTREAM_HTTP'].includes(error.code) || attempt >= 2 || Date.now() >= deadline) throw error;
        await delay(Math.min(1000 * (attempt + 1), Math.max(1, deadline - Date.now())), undefined, { signal: this.abort.signal });
      }
    }
  }

  private async poll(initial: LuxTask) {
    const deadline = Date.now() + (this.options.timeoutMs ?? 900_000);
    let task = initial;
    for (;;) {
      if (this.paused.has(task.localId)) {
        await this.persist({ ...task, note: '仅停止本地等待；云端任务可能仍运行，可稍后按原编号查询，不代表取消或退款' });
        return;
      }
      if (this.abort.signal.aborted) return;
      if (Date.now() >= deadline) {
        await this.persist({ ...task, note: '本地等待超时；请按原编号查询，不自动重新创建', error: { code: 'POLL_TIMEOUT', message: '本地等待超时，云端任务可能仍在运行', classification: 'unknown' } });
        return;
      }
      let remote;
      try { remote = await this.queryProvider(task.providerTaskId!, deadline); }
      catch (error) {
        const kind = classify(error);
        await this.persist({ ...task, stage: task.stage === 'ready' ? 'ready' : 'running', error: failure(error, kind === 'unknown' ? 'unknown' : kind), note: '查询未确认；已保留原任务编号，不重复创建' });
        return;
      }
      if (remote.status === 3) {
        const outputs = parseLuxOutputs(task, remote.outputs ?? []);
        task = await this.persist({ ...task, stage: 'running', error: undefined });
        await this.materialize(task, outputs);
        return;
      }
      if (remote.status === 4) {
        throw new AssetError('GENERATION_FAILED', '云端任务失败，未生成可采用的作品', 502, 'rejected');
      }
      if (remote.status === 6) {
        await this.persist({ ...task, stage: 'cancelled', error: { code: 'GENERATION_CANCELLED', message: '云端任务已取消' } });
        return;
      }
      task = await this.persist({ ...task, stage: 'running' });
      await delay(Math.min(this.options.pollMs ?? 3000, Math.max(1, deadline - Date.now())), undefined, { signal: this.abort.signal });
    }
  }

  private async materialize(task: LuxTask, outputs: LuxOutputSpec[]) {
    if (!outputs.length) throw new AssetError('NO_OUTPUT', '任务成功但没有可用产物', 502, 'rejected');
    const directory = path.join(this.options.artifactsDirectory, task.localId);
    await mkdir(directory, { recursive: true });
    const artifacts: LuxArtifact[] = [...task.artifacts];
    let warning = task.note;
    for (const [outputIndex, output] of outputs.entries()) {
      const downloaded = await downloadArtifactBytes(output.url, this.options.client.base, {
        format: 'other', signal: this.abort.signal, timeoutMs: this.options.downloadTimeoutMs,
        allowedHosts: this.options.artifactHosts, maxBytes: 100 * 1024 * 1024,
      });
      const detected = sniff(downloaded);
      let format = output.format;
      let kind = output.kind;
      if (detected) {
        const parameters = (task as StoredLuxTask).parameters;
        const requested = (task.operation === 'image-to-3d' || task.operation === 'text-to-3d') && parameters?.version === 'G1-Turbo'
          ? (parameters?.outputFormat as string[] | undefined) ?? ['zip']
          : undefined;
        if (detected.format === 'zip' && ['usdz', 'obj_zip', 'fbx_zip', '3mf'].includes(output.format)) {
          format = output.format;
          kind = 'archive';
        } else if (format === 'bin' || format === 'glb' || format === 'zip') {
          format = detected.format;
          kind = detected.kind;
        }
        if (requested && !requested.includes(format) && !(format === 'zip' && requested.includes('zip'))) {
          throw new AssetError('OUTPUT_FORMAT_MISMATCH', 'G1-Turbo 返回了未请求的产物格式', 502, 'unknown');
        }
      }
      if (format === 'jpeg') format = 'jpg';
      if (kind === 'image') { const { default: sharp } = await import('sharp'); try { await sharp(downloaded, { limitInputPixels: 40_960_000 }).toBuffer(); } catch { throw new AssetError('INVALID_IMAGE', '下载结果不是有效图片', 502, 'unknown'); } }
      if (output.format === 'glb' && format !== 'glb') throw new AssetError('OUTPUT_FORMAT_MISMATCH', '声明为GLB的槽位返回了其他格式', 502, 'unknown');
      if (kind === 'image' && !['png', 'jpg', 'webp'].includes(format)) throw new AssetError('UNSUPPORTED_OUTPUT', '返回的图片格式不受支持', 502, 'unknown');
      const id = createHash('sha256').update(task.localId).update(String(outputIndex)).update(sha256(downloaded)).digest('hex');
      const target = path.join(directory, `${id}.${format}`);
      await writeAtomic(target, downloaded, this.abort.signal);
      let assetId: string | undefined;
      if (format === 'glb') {
        const provenance: AssetProvenance = {
          kind: ['api.aholo.cn', 'api.aholo3d.cn'].includes(new URL(this.options.client.base).hostname) ? 'lux3d' : 'unknown',
          sourceTaskId: task.providerTaskId, sourceHash: sha256(downloaded), importedAt: new Date().toISOString(),
        };
        const asset = await this.options.assets.importOriginal(target, id, provenance);
        assetId = asset.id;
        const json = glbJson(downloaded);
        const hasAnimation = !!json?.animations?.length || !!json?.skins?.length || !!json?.meshes?.some(mesh => mesh.primitives?.some(primitive => primitive.targets?.length));
        if (!hasAnimation && downloaded.length <= 32 * 1024 * 1024 && this.options.optimize !== false) {
          try {
            const optimizedId = `opt-${id.slice(0, 60)}`;
            const optimized = await this.options.assets.importLocal(target, optimizedId, provenance);
            const model = this.options.assets.modelPath(optimizedId);
            if (optimized.status === 'ready' && model) {
              const optimizedBytes = await readFile(model);
              await writeAtomic(path.join(directory, `${optimizedId}.glb`), optimizedBytes);
              if (!artifacts.some(item => item.id === optimizedId)) {
                artifacts.push({
                  id: optimizedId, kind: 'model', format: 'glb', variant: 'optimized', bytes: optimizedBytes.length, sha256: sha256(optimizedBytes),
                  downloadUrl: `/assets/lux3d/tasks/${task.localId}/artifacts/${optimizedId}/download`, previewUrl: optimized.modelUrl,
                  assetId: optimized.id, sourceTaskId: task.providerTaskId, sourceUrlHash: urlHash(output.url), label: '网页优化件（原件保留）',
                });
              }
            }
          } catch { warning = `${warning ? warning + '；' : ''}网页优化未成功，原始产物仍保留；没有重复创建云任务`; }
        }
      }
      if (!artifacts.some(item => item.id === id)) {
        artifacts.push({
          id, kind, format, variant: 'original', label: output.label, animationId: output.animationId,
          ...(output.animationIds ? { animationIds: output.animationIds } : {}), ...(output.animationMode ? { animationMode: output.animationMode } : {}),
          bytes: downloaded.length, sha256: sha256(downloaded),
          downloadUrl: `/assets/lux3d/tasks/${task.localId}/artifacts/${id}/download`,
          previewUrl: kind === 'image' ? `/assets/lux3d/tasks/${task.localId}/artifacts/${id}/preview` : assetId ? `/assets/${assetId}/model.glb` : undefined,
          assetId, sourceTaskId: task.providerTaskId, sourceUrlHash: urlHash(output.url),
        });
      }
      await this.persist({ ...this.get(task.localId)!, stage: 'running', artifacts, note: warning });
    }
    await this.persist({ ...this.get(task.localId)!, stage: artifacts.length ? 'ready' : 'failed', artifacts, note: warning, error: artifacts.length ? undefined : { code: 'NO_OUTPUT', message: '没有可用产物' } });
  }

  async remoteHistory(page = 1, filters: { status?: number; starttime?: string | number; endtime?: string | number } = {}) {
    return this.options.client.listProviderTasks({ page, pagesize: 100, ...filters }, this.abort.signal);
  }

  async importExisting(operation: LuxOperation, providerTaskId: string): Promise<LuxTask> {
    if (!Object.hasOwn(LUX_OPERATION_ROUTES, operation) || typeof providerTaskId !== 'string' || !/^[1-9]\d{0,18}$/.test(providerTaskId) || BigInt(providerTaskId) > 9223372036854775807n) {
      throw new AssetError('INVALID_TASK', '操作类型或原任务ID无效', 400, 'blocked');
    }
    return this.exclusive(async () => {
      const existing = (this.store.list() as StoredLuxTask[]).find(task => task.providerTaskId === providerTaskId && task.operation === operation);
      if (existing) { this.start(existing); return existing; }
      await this.options.client.getProviderTask(providerTaskId, this.abort.signal);
      const now = new Date().toISOString();
      const task: StoredLuxTask = { localId: randomUUID(), operation, providerTaskId, stage: 'queued', inputRefs: [], parametersHash: urlHash(`${operation}:${providerTaskId}`), artifacts: [], createdAt: now, updatedAt: now, note: this.jobs.size >= this.maxActive ? '从云端已有任务导入；本地任务已满，尚未开始查询' : '从云端已有任务导入；没有重新创建生成任务' };
      await this.persist(task);
      this.start(task);
      return task;
    });
  }

  async stopWaiting(id: string): Promise<LuxTask> {
    const task = this.get(id) as StoredLuxTask | undefined;
    if (!task) throw new AssetError('TASK_NOT_FOUND', '任务不存在', 404);
    this.paused.add(id);
    if (task.providerTaskId) return this.persist({ ...task, note: '仅停止本地等待；云端任务可能仍运行，可稍后按原编号查询，不代表取消或退款' });
    if (task.stage === 'submitting' || task.stage === 'submit_unknown') {
      return this.persist({ ...task, stage: 'submit_unknown', note: '已停止本地等待；提交结果未知，不会自动重新创建' });
    }
    return this.persist({ ...task, stage: 'cancelled', note: '已停止本地等待；尚未提交生成任务' });
  }

  async resume(id: string): Promise<LuxTask> {
    this.paused.delete(id);
    const task = this.get(id) as StoredLuxTask | undefined;
    if (!task) throw new AssetError('TASK_NOT_FOUND', '任务不存在', 404);
    if (task.providerTaskId) { this.start(task); return task; }
    const now = new Date();
    const created = Date.parse(task.createdAt);
    const candidates = await this.options.client.listProviderTasks({ page: 1, pagesize: 100 }, this.abort.signal);
    const nearby = Number.isFinite(created)
      ? candidates.filter(item => {
        const at = item.created === undefined ? NaN : Number(item.created);
        return !Number.isFinite(at) || Math.abs(at - created) <= 30 * 60_000;
      })
      : candidates;
    const updated: StoredLuxTask = { ...task, resumeCandidates: nearby, resumeListedAt: now.toISOString(), note: '未能确认原提交结果；下面只是时间上可能对应的任务，必须由你明确关联，不能自动认领' };
    return this.persist(updated);
  }

  async link(id: string, providerTaskId: string): Promise<LuxTask> {
    if (typeof providerTaskId !== 'string' || !/^[1-9]\d{0,18}$/.test(providerTaskId) || BigInt(providerTaskId) > 9223372036854775807n) {
      throw new AssetError('INVALID_TASK', '云端任务编号必须是int64十进制字符串', 400, 'blocked');
    }
    return this.exclusive(async () => {
      const task = this.get(id) as StoredLuxTask | undefined;
      if (!task) throw new AssetError('TASK_NOT_FOUND', '任务不存在', 404);
      if (task.providerTaskId && task.providerTaskId !== providerTaskId) throw new AssetError('TASK_LINK_CONFLICT', '本地任务已关联不同云端任务', 409, 'blocked');
      const remote = await this.options.client.getProviderTask(providerTaskId, this.abort.signal);
      const manualLink = {
        at: new Date().toISOString(), providerTaskId,
        listedAt: task.resumeListedAt ?? new Date().toISOString(),
        candidateCount: task.resumeCandidates?.length ?? 0,
        parametersHash: task.parametersHash,
      };
      const updated = await this.persist({ ...task, providerTaskId, stage: remote.status === 3 ? 'running' : 'queued', error: undefined, manualLink, note: '已由用户明确关联云端任务；查询和产物校验不等于证明它就是响应丢失的原提交' });
      this.start(updated);
      return updated;
    });
  }

  async refresh(id: string): Promise<LuxTask> {
    const task = this.get(id) as StoredLuxTask | undefined;
    if (!task) throw new AssetError('TASK_NOT_FOUND', '任务不存在', 404);
    if (!task.providerTaskId) throw new AssetError('TASK_NOT_LINKED', '任务没有可查询的云端编号', 409, 'blocked');
    return this.exclusive(async () => {
      const remote = await this.options.client.getProviderTask(task.providerTaskId!, this.abort.signal);
      if (remote.status !== 3) throw new AssetError('TASK_NOT_READY', '云端任务尚未成功，不能刷新产物', 409, 'blocked');
      const outputs = parseLuxOutputs(task, remote.outputs ?? []);
      await this.materialize(task, outputs);
      return this.get(id)!;
    });
  }

  async artifact(id: string, artifactId: string): Promise<{ bytes: Buffer; artifact: LuxArtifact }> {
    const task = this.get(id);
    const artifact = task?.artifacts.find(item => item.id === artifactId);
    if (!task || !artifact) throw new AssetError('ARTIFACT_NOT_FOUND', '产物不存在', 404);
    const bytes = await readPlainFile(path.join(this.options.artifactsDirectory, id, `${artifactId}.${artifact.format}`), 100 * 1024 * 1024,
      () => new AssetError('ARTIFACT_PATH_DENIED', '产物路径未通过检查'), () => new AssetError('MODEL_TOO_LARGE', '产物超过大小限制'));
    if (sha256(bytes) !== artifact.sha256) throw new AssetError('ARTIFACT_CHANGED', '产物字节已变化', 409);
    return { bytes, artifact };
  }

  beginClose() { this.closing = true; this.abort.abort(); }
  async idle() { await this.exclusiveChain; while (this.jobs.size) await Promise.allSettled([...this.jobs.values()]); await this.store.idle(); if (this.jobFailure) throw this.jobFailure; }
  async close() { this.beginClose(); await this.idle(); }
}
