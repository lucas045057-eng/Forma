import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { get as httpGet, type IncomingMessage } from 'node:http';
import { get as httpsGet } from 'node:https';
import { AssetError } from './lux3d.ts';
import { writeAtomic } from './atomic-file.ts';

function publicAddress(address: string): boolean {
  if (isIP(address) === 6) return /^[23]/.test(address) && !address.startsWith('2001:db8:');
  const [a, b] = address.split('.').map(Number);
  return isIP(address) === 4 && a !== 0 && a !== 10 && a !== 127 && a < 224 &&
    !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && b === 168) && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19));
}
function waitWithAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}
export interface DownloadOptions { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }

export async function downloadGlb(source: string, destination: string, mockBase?: string, options: DownloadOptions = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(maxBytes) || maxBytes <= 0) throw new AssetError('DOWNLOAD_CONFIG', '下载时限和大小限制必须为正数');
  const budget = new AbortController();
  const timer = setTimeout(() => budget.abort(new AssetError('DOWNLOAD_TIMEOUT', '模型下载超过总时限，请重新导入原任务')), timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, budget.signal]) : budget.signal;
  let response: IncomingMessage | undefined;
  try {
    let sourceUrl = source;
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted();
      let url: URL;
      try { url = new URL(sourceUrl); } catch { throw new AssetError('INVALID_OUTPUT_URL', '模型下载地址无效'); }
      const localMock = mockBase && url.origin === new URL(mockBase).origin && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
      if (url.username || url.password || (url.protocol !== 'https:' && !(localMock && url.protocol === 'http:'))) {
        throw new AssetError('UNSAFE_OUTPUT_URL', '模型地址必须是公网 HTTPS，或配置的本地 mock 服务');
      }
      const addresses = await waitWithAbort(lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true }), signal).catch(error => {
        if (signal.aborted) throw error;
        throw new AssetError('DOWNLOAD_DNS', '模型下载域名解析失败');
      });
      if (!addresses.length || (!localMock && addresses.some(item => !publicAddress(item.address))) ||
          (localMock && addresses.some(item => item.address !== '127.0.0.1' && item.address !== '::1'))) {
        throw new AssetError('UNSAFE_OUTPUT_URL', '模型下载地址不能指向内网');
      }
      signal.throwIfAborted();
      const address = addresses[0];
      response = await new Promise<IncomingMessage>((resolve, reject) => {
        const get = url.protocol === 'https:' ? httpsGet : httpGet;
        const request = get(url, {
          signal,
          // Use the validated DNS result for the connection, including redirects.
          lookup: (_hostname, lookupOptions, callback) => {
            if (lookupOptions.all) callback(null, [address]);
            else callback(null, address.address, address.family);
          },
          timeout: 60_000,
        }, resolve);
        request.on('timeout', () => request.destroy(new Error('timeout')));
        request.on('error', () => reject(new AssetError('DOWNLOAD_FAILED', '模型下载连接失败，请重新导入')));
      });
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
        const location = response.headers.location;
        response.destroy();
        response = undefined;
        if (redirects >= 3) throw new AssetError('DOWNLOAD_REDIRECTS', '模型下载重定向次数过多');
        sourceUrl = new URL(location, url).href;
        continue;
      }
      if (status !== 200) {
        if (status === 403 || status === 404) throw new AssetError('OUTPUT_URL_EXPIRED', `模型下载返回 ${status}：结果 URL 可能已超过 2 小时有效期，请重新查询任务后导入，或创建新任务`);
        throw new AssetError('DOWNLOAD_HTTP', `模型下载返回 HTTP ${status}`);
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      if (Number(response.headers['content-length']) > maxBytes) throw new AssetError('MODEL_TOO_LARGE', '模型超过下载大小限制');
      for await (const chunk of response) {
        signal.throwIfAborted();
        const buffer = Buffer.from(chunk as Uint8Array);
        bytes += buffer.length;
        if (bytes > maxBytes) throw new AssetError('MODEL_TOO_LARGE', '模型超过下载大小限制');
        chunks.push(buffer);
      }
      signal.throwIfAborted();
      const buffer = Buffer.concat(chunks);
      if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'glTF' || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== bytes) {
        throw new AssetError('INVALID_GLB', '下载结果不是完整的 glTF 2.0 GLB 文件');
      }
      await writeAtomic(destination, buffer, signal);
      return;
    }
  } catch (error) {
    if (options.signal?.aborted) throw new AssetError('DOWNLOAD_ABORTED', '模型下载已停止，可用原任务恢复');
    if (budget.signal.aborted) throw new AssetError('DOWNLOAD_TIMEOUT', '模型下载超过总时限，请重新导入原任务');
    if (error instanceof AssetError) throw error;
    throw new AssetError('DOWNLOAD_FAILED', '模型下载或写盘失败，请重新导入');
  } finally {
    clearTimeout(timer);
    response?.destroy();
  }
}
