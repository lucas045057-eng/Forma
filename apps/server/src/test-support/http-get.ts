import { get } from 'node:http';

/** Probe internal preview workers with the same HTTP transport as their proxy.
 * These ports are owned by PreviewManager and are not browser-facing listeners.
 */
export function getInternalPreview(url: string): Promise<{ status: number; text(): Promise<string> }> {
  return new Promise((resolve, reject) => {
    get(url, { agent: false, headers: { connection: 'close' } }, response => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.once('error', reject);
      response.once('end', () => resolve({
        status: response.statusCode ?? 0,
        text: async () => Buffer.concat(chunks).toString('utf8'),
      }));
    }).once('error', reject);
  });
}
