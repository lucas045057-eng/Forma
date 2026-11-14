import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';

/** Worker-side Node code needs no outbound connection; browser requests are guarded separately. */
export function installNetworkGuard() {
  const denied = (): never => { throw Object.assign(new Error('CHECK_NETWORK_DENIED: 检查进程不允许出站连接'), { code: 'CHECK_NETWORK_DENIED' }); };
  http.request = denied; http.get = denied;
  https.request = denied; https.get = denied;
  net.connect = denied; net.createConnection = denied; net.Socket.prototype.connect = denied;
  const deniedDns = Object.assign(denied, { __promisify__: async (): Promise<never> => denied() });
  dns.lookup = deniedDns; dns.resolve = deniedDns; dns.resolve4 = deniedDns; dns.resolve6 = deniedDns;
  dns.promises.lookup = denied; dns.promises.resolve = denied; dns.promises.resolve4 = denied; dns.promises.resolve6 = denied;
  globalThis.fetch = async () => denied();
  Object.defineProperty(globalThis, 'WebSocket', { configurable: false, value: class { constructor() { denied(); } } });
  syncBuiltinESMExports();
}
