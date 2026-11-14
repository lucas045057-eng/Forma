import { randomInt } from 'node:crypto';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface TestListener {
  listen(options: { host: string; port: number }): Promise<string>;
  close(): Promise<void>;
}

/** Test-only: bind and keep the real listener; never reserve then release a port.
 * Node fetch currently blocks ports up to 10080. Avoid that range even when the
 * machine's dynamic TCP range includes it. Only bind collisions and Windows
 * excluded ports are reallocated; invalid candidates also count toward the cap.
 */
export async function listenForFetch<T extends TestListener>(
  create: () => T | Promise<T>, nextPort: () => number = () => randomInt(20_000, 65_536),
): Promise<{ mock: T; baseUrl: string }> {
  let lastBindError: unknown;
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = nextPort();
    if (!Number.isInteger(port) || port < 20_000 || port > 65_535) continue;
    const mock = await create();
    try {
      const baseUrl = await mock.listen({ host: '127.0.0.1', port });
      return { mock, baseUrl };
    } catch (error) {
      lastBindError = error;
      await mock.close(); // A cleanup failure must stop allocation too.
      const code = error instanceof Error && 'code' in error ? error.code : undefined;
      if (code !== 'EADDRINUSE' && !(process.platform === 'win32' && code === 'EACCES')) throw error;
    }
  }
  throw new Error('Unable to bind a fetch-compatible test listener after 32 candidates', { cause: lastBindError });
}

/** Adapt a fresh native server, including production preview servers under test. */
export async function listenServerForFetch(create: () => Server) {
  const { mock, baseUrl } = await listenForFetch(() => {
    const server = create();
    return {
      server,
      listen(options: { host: string; port: number }): Promise<string> {
        return new Promise((resolve, reject) => {
          const onError = (error: Error) => reject(error);
          server.once('error', onError);
          server.listen(options, () => {
            server.off('error', onError);
            resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
          });
        });
      },
      async close() {
        if (!server.listening) return;
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      },
    };
  });
  return { server: mock.server, baseUrl };
}

/** The same allocation policy for tests using a plain node:http request handler. */
export async function listenHttpForFetch(listener: RequestListener) {
  return listenServerForFetch(() => createServer(listener));
}
