import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { AssetError, Lux3DClient } from './lux3d.ts';
import { parseProviderJson } from './provider-json.ts';
import { securePublicFetch, publicAddress, waitWithAbort } from './download.ts';

function safeHost(value: string): string { return value.toLowerCase().replace(/^\[|\]$/g, ''); }
function isLoopback(url: URL, mockBase?: string): boolean {
  return !!mockBase && url.origin === new URL(mockBase).origin && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}
function safeFilename(value: string): string {
  const name = value.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 160);
  return name || 'upload.bin';
}
function parseBlockList(value: unknown, blocks: number): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new AssetError('UPLOAD_FORMAT', '云端分片缺失列表格式错误', 502, 'unknown');
  const result = new Set<number>();
  for (const item of value) {
    const text = String(item);
    const range = /^(\d{1,6})(?:-(\d{1,6}))?$/.exec(text);
    if (!range) throw new AssetError('UPLOAD_FORMAT', '云端分片缺失范围格式错误', 502, 'unknown');
    const from = Number(range[1]), to = Number(range[2] ?? range[1]);
    if (from < 1 || to < from || to > blocks) throw new AssetError('UPLOAD_FORMAT', '云端分片缺失范围越界', 502, 'unknown');
    for (let block = from; block <= to; block++) result.add(block);
  }
  return [...result].sort((a, b) => a - b);
}

export class ProviderUploader {
  private readonly client: Lux3DClient;
  private readonly allowedHosts: string[];
  constructor(client: Lux3DClient, allowedHosts: string[] = ['ous-cos.kujiale.com']) {
    this.client = client;
    this.allowedHosts = allowedHosts.map(host => host.trim()).filter(Boolean);
    if (!this.allowedHosts.length) throw new Error('LUX3D upload host allow-list is empty');
  }

  private async assertDomain(value: string, mockBase?: string, signal: AbortSignal = AbortSignal.timeout(10_000)): Promise<URL> {
    const url = new URL(value);
    if (isLoopback(url, mockBase)) return url;
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/' || url.search || url.hash) {
      throw new AssetError('UNSAFE_UPLOAD_DOMAIN', '上传目的域必须是不带路径、端口或凭据的HTTPS源', 400, 'blocked');
    }
    const allowed = this.allowedHosts.map(safeHost);
    if (!allowed.includes(safeHost(url.hostname))) throw new AssetError('UNSAFE_UPLOAD_DOMAIN', '上传目的域不在后端明确允许列表', 400, 'blocked');
    const addresses = await waitWithAbort(lookup(url.hostname, { all: true }), signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000));
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new AssetError('UNSAFE_UPLOAD_DOMAIN', '上传目的域不能解析到内网', 400, 'blocked');
    return url;
  }

  private async call(domain: URL, route: string, token: string, options: { method?: 'GET' | 'POST'; query?: URLSearchParams; form?: FormData; signal?: AbortSignal }, mockBase?: string): Promise<Record<string, unknown>> {
    const url = new URL(route, domain);
    if (options.query) url.search = options.query.toString();
    let response: Response;
    try {
      response = await securePublicFetch(url, {
        method: options.method ?? 'POST',
        headers: { 'ous-token-v2': token },
        body: options.form,
        signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      }, mockBase);
    } catch (error) {
      if (error instanceof AssetError) throw error;
      throw new AssetError('UPLOAD_UPSTREAM', '上传请求失败，不能确认云端状态', 502, 'unknown');
    }
    let text: string;
    try { text = await response.text(); } catch { throw new AssetError('UPLOAD_FORMAT', '上传响应读取失败', 502, 'unknown'); }
    let body: Record<string, unknown>;
    try { body = parseProviderJson(text) as Record<string, unknown>; }
    catch { throw new AssetError('UPLOAD_FORMAT', '上传响应格式错误', 502, 'unknown'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AssetError('UPLOAD_FORMAT', '上传响应必须是JSON对象', 502, 'unknown');
    if (!response.ok) throw new AssetError('UPLOAD_UPSTREAM', `上传返回HTTP ${response.status}`, 502, 'unknown');
    if (String(body.c) !== '0') {
      const detail = typeof body.m === 'string' ? body.m.replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 60) : '';
      throw new AssetError('UPLOAD_REJECTED', detail ? `云端未接受文件上传（${detail}）` : '云端未接受文件上传', 400, 'rejected');
    }
    if (body.d === null) return {};
    if (!body.d || typeof body.d !== 'object') throw new AssetError('UPLOAD_FORMAT', '上传响应缺少状态数据', 502, 'unknown');
    return body.d as Record<string, unknown>;
  }

  private async resolveUrl(value: unknown, mockBase?: string, signal?: AbortSignal): Promise<string> {
    if (typeof value !== 'string') throw new AssetError('UPLOAD_FORMAT', '上传完成但没有资源URL', 502, 'unknown');
    let url: URL;
    try { url = new URL(value); } catch { throw new AssetError('UNSAFE_UPLOAD_RESULT', '上传结果地址无效', 502, 'unknown'); }
    const local = isLoopback(url, mockBase);
    if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.hash) throw new AssetError('UNSAFE_UPLOAD_RESULT', '上传结果地址不安全', 502, 'unknown');
    if (local) return url.href;
    const addresses = await waitWithAbort(lookup(url.hostname, { all: true }), signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000));
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw new AssetError('UNSAFE_UPLOAD_RESULT', '上传结果不得指向内网', 502, 'unknown');
    return url.href;
  }

  async publish(bytes: Buffer, filename: string, mockBase?: string, signal?: AbortSignal): Promise<string> {
    const credentials = await this.client.getUploadCredentials(signal);
    const domain = await this.assertDomain(credentials.globalDomain, mockBase, signal);
    const md5 = createHash('md5').update(bytes).digest('hex');
    let taskId: string;
    if (bytes.length <= credentials.blockSize) {
      const form = new FormData();
      form.append('md5', md5);
      form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }), safeFilename(filename));
      const data = await this.call(domain, '/ous/api/v2/single/upload', credentials.token, { form, signal }, mockBase);
      const rawTaskId = data.taskId ?? data.obsTaskId;
      taskId = typeof rawTaskId === 'number' ? String(rawTaskId) : String(rawTaskId ?? '');
    } else {
      const blocks = Math.ceil(bytes.length / credentials.blockSize);
      if (blocks > 100) throw new AssetError('UPLOAD_TOO_MANY_PARTS', '分片数量超过本地限制', 413, 'blocked');
      const query = new URLSearchParams({ md5, blocks: String(blocks), size: String(bytes.length), name: safeFilename(filename) });
      const init = await this.call(domain, '/ous/api/v2/block/upload/init', credentials.token, { query, signal }, mockBase);
      const rawInitId = init.taskId ?? init.obsTaskId;
      taskId = typeof rawInitId === 'number' ? String(rawInitId) : String(rawInitId ?? '');
      const deduplicated = init.deduplicated === true;
      const missing = deduplicated ? [] : parseBlockList(init.lackBlocks, blocks);
      const pending = deduplicated ? [] : missing.length ? missing : Array.from({ length: blocks }, (_item, index) => index + 1);
      for (const block of pending) {
        const form = new FormData();
        form.append('block', String(block));
        form.append('file', new Blob([new Uint8Array(bytes.subarray((block - 1) * credentials.blockSize, Math.min(block * credentials.blockSize, bytes.length)))], { type: 'application/octet-stream' }));
        await this.call(domain, '/ous/api/v2/block/upload/part', credentials.token, { form, signal }, mockBase);
      }
    }
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw new AssetError('UPLOAD_FORMAT', '上传任务编号无效', 502, 'unknown');
    const pollBudgetMs = mockBase ? 5_000 : 30_000;
    const deadline = Date.now() + pollBudgetMs;
    for (;;) {
      const data = await this.call(domain, '/ous/api/v2/upload/status', credentials.token, { method: 'GET', signal }, mockBase);
      const status = Number(data.status);
      if (data.errorCode !== undefined && data.errorCode !== null && Number(data.errorCode) !== 0) {
        throw new AssetError('UPLOAD_REJECTED', `云端上传失败（错误码 ${String(data.errorCode)}）`, 400, 'rejected');
      }
      if (status === 5) return this.resolveUrl(data.url, mockBase, signal);
      if (status === 6 || status === 8) throw new AssetError('UPLOAD_REJECTED', '云端上传失败或已中止', 400, 'rejected');
      if (![0, 1, 2, 3, 4, 7].includes(status)) throw new AssetError('UPLOAD_FORMAT', '云端上传状态无效', 502, 'unknown');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AssetError('UPLOAD_TIMEOUT', `上传状态在${Math.round(pollBudgetMs / 1000)}秒预算内未完成；保留上传引用供明确恢复，不会重复创建模型`, 504, 'unknown');
      await delay(Math.min(200, remaining), undefined, { signal });
    }
  }
}
