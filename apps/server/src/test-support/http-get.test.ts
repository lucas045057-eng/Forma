import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { getInternalPreview } from './http-get.ts';

it('preserves real status and body for isolation assertions and rejects a dropped connection', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/drop') { response.destroy(); return; }
    response.writeHead(403);
    response.write('PRIVATE-');
    response.end('SENTINEL');
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const response = await getInternalPreview(base);
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('PRIVATE-SENTINEL');
    await expect(getInternalPreview(`${base}/drop`)).rejects.toThrow();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
