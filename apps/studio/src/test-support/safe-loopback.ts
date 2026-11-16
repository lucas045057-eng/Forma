import type { Server } from 'node:http';

/**
 * Ports that Fetch and Chromium refuse even for loopback destinations.
 *
 * Fetch rejects the WHATWG "bad port" list (`TypeError: fetch failed`, cause `bad port`), and
 * Chromium refuses its restricted port list with `net::ERR_UNSAFE_PORT` before any request leaves
 * the browser. Tests bind with `listen(0)` so the OS picks the port, but the OS ephemeral pool is
 * unrelated to these deny lists; on this machine the pool has already handed out 5061/5062.
 *
 * The union below covers both consumers so a loopback origin is safe for `fetch()` and for
 * `page.goto()` alike. Tests must never pin a port, so the only remedy is to drop the listener the
 * OS just gave us and ask `listen(0)` again.
 */
const RESTRICTED_PORTS = new Set<number>([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

export function restrictedLoopbackPort(port: number): boolean {
  return RESTRICTED_PORTS.has(port);
}

/** Bind this test-owned HTTP server on an OS-assigned loopback port and return the actual port. */
export function listenOnEphemeralLoopback(server: Server): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (error: Error) => { server.off('error', onError); reject(error); };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const address = server.address();
      if (!address || typeof address === 'string') { reject(new Error('loopback listener has no TCP address')); return; }
      resolve(address.port);
    });
  });
}

export async function closeLoopbackServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

export interface LoopbackAttempt<T> {
  value: T;
  port: number;
  /** Close only the listener this attempt created; must be idempotent. */
  close(): Promise<void>;
}

export interface LoopbackOrigin<T> {
  value: T;
  port: number;
  origin: string;
}

/**
 * Create and bind a fresh loopback listener, rejecting (and closing) only the listener whose
 * OS-assigned port Fetch/Chromium would refuse, then try again with a new `listen(0)`.
 *
 * Deliberately does not probe a concrete port first, does not reuse a rejected listener, and does
 * not fall back to a fixed port: each attempt owns its listener and is discarded whole.
 */
export async function openLoopback<T>(
  attempt: () => Promise<LoopbackAttempt<T>>,
  options: { attempts?: number } = {},
): Promise<LoopbackOrigin<T>> {
  const limit = options.attempts ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('loopback attempts must be a positive integer');
  const rejected: number[] = [];
  for (let index = 0; index < limit; index++) {
    const current = await attempt();
    if (!restrictedLoopbackPort(current.port)) {
      return { value: current.value, port: current.port, origin: `http://127.0.0.1:${current.port}` };
    }
    rejected.push(current.port);
    await current.close();
  }
  throw new Error(`loopback listener stayed on ports that Fetch/Chromium refuse after ${limit} attempts: ${rejected.join(', ')}`);
}
