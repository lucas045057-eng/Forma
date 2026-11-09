import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { writeFile, rename } from 'node:fs/promises';
import { AssetError } from './lux3d.ts';

function publicAddress(address: string): boolean {
  if (isIP(address) === 6) return /^[23]/.test(address) && !address.startsWith('2001:db8:');
  const [a, b] = address.split('.').map(Number);
  return isIP(address) === 4 && a !== 0 && a !== 10 && a !== 127 && a < 224 &&
    !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
    !(a === 192 && b === 168) && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && (b === 18 || b === 19));
}

export async function downloadGlb(source: string, destination: string, mockBase?: string, redirects = 0): Promise<void> {
  let url: URL;
  try { url = new URL(source); } catch { throw new AssetError('INVALID_OUTPUT_URL', '模型下载地址无效'); }
  const localMock = mockBase && url.origin === new URL(mockBase).origin && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(localMock && url.protocol === 'http:'))) {
    throw new AssetError('UNSAFE_OUTPUT_URL', '模型地址必须是公网 HTTPS，或配置的本地 mock 服务');
  }
  const addresses = await lookup(url.hostname.replace(/^\[|\]$/g, ''), { all: true }).catch(() => {
    throw new AssetError('DOWNLOAD_DNS', '模型下载域名解析失败');
  });
  if (!addresses.length || (!localMock && addresses.some(item => !publicAddress(item.address)))) {
    throw new AssetError('UNSAFE_OUTPUT_URL', '模型下载地址不能指向内网');
  }
  const address = addresses[0];
  const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const get = url.protocol === 'https:' ? httpsGet : httpGet;
    const request = get(url, {
      // Pin the validated DNS result so a second resolution cannot redirect to an internal host.
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      timeout: 60_000,
    }, resolve);
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => reject(new AssetError('DOWNLOAD_FAILED', '模型下载连接失败，请查询任务后重试导入')));
  });
  const status = response.statusCode ?? 0;
  if ([301, 302, 303, 307, 308].includes(status) && response.headers.location && redirects < 3) {
    response.resume();
    return downloadGlb(new URL(response.headers.location, url).href, destination, mockBase, redirects + 1);
  }
  if (status !== 200) {
    response.resume();
    if (status === 403 || status === 404) throw new AssetError('OUTPUT_URL_EXPIRED', `模型下载返回 ${status}：结果 URL 可能已超过 2 小时有效期，请重新查询任务后导入，或创建新任务`);
    throw new AssetError('DOWNLOAD_HTTP', `模型下载返回 HTTP ${status}`);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of response) {
      const buffer = Buffer.from(chunk as Uint8Array);
      bytes += buffer.length;
      if (bytes > 100 * 1024 * 1024) { response.destroy(); throw new AssetError('MODEL_TOO_LARGE', '模型超过 100 MiB 下载限制'); }
      chunks.push(buffer);
    }
  } catch (error) {
    if (error instanceof AssetError) throw error;
    throw new AssetError('DOWNLOAD_FAILED', '模型下载中断，请重新导入');
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'glTF' || buffer.readUInt32LE(4) !== 2 || buffer.readUInt32LE(8) !== bytes) {
    throw new AssetError('INVALID_GLB', '下载结果不是完整的 glTF 2.0 GLB 文件');
  }
  await writeFile(`${destination}.tmp`, buffer);
  await rename(`${destination}.tmp`, destination);
}
