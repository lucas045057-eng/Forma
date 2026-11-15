const net = require('node:net');
const dns = require('node:dns');
const promises = require('node:dns/promises');
const fs = require('node:fs');
const allowed = host => ['127.0.0.1', '::1', '[::1]', 'localhost'].includes(String(host).toLowerCase());
function reject(host) {
  if (process.env.D1_GUARD_LOG) fs.appendFileSync(process.env.D1_GUARD_LOG, JSON.stringify({ pid: process.pid, blockedHost: String(host) }) + '\n');
  const error = new Error('D1 loopback-only network guard'); error.code = 'D1_NETWORK_DENIED'; return error;
}
const lookup = dns.lookup;
dns.lookup = function(host, options, callback) {
  if (allowed(host)) return lookup.apply(this, arguments);
  const done = typeof options === 'function' ? options : callback;
  const error = reject(host);
  if (typeof done === 'function') { process.nextTick(() => done(error)); return; }
  throw error;
};
const asyncLookup = promises.lookup;
promises.lookup = function(host, options) { return allowed(host) ? asyncLookup.call(this, host, options) : Promise.reject(reject(host)); };
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = first && typeof first === 'object' ? first.host ?? first.hostname : typeof args[1] === 'string' && typeof first === 'number' ? args[1] : undefined;
  if (host !== undefined && !allowed(host)) throw reject(host);
  return connect.apply(this, args);
};
const fetch = globalThis.fetch;
globalThis.fetch = function(input, options) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!allowed(url.hostname)) return Promise.reject(reject(url.hostname));
  return fetch(input, options);
};
