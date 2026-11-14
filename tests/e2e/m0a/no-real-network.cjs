/**
 * 出站网络守卫（作为被测试后端进程的 preload：[NODE_OPTIONS=--require 本文件]）。
 *
 * 目的：证明「测试期间后端没有向真实 Lux3D 域名发过任何请求」。
 * 只放行回环地址（127.0.0.1 / localhost / ::1）；其他任何 DNS 解析或直连 IP 都会被
 * 记录进 PI_NET_GUARD_LOG 并被拒绝。测试断言这个日志为空。
 */
const dns = require('node:dns');
const net = require('node:net');
const fs = require('node:fs');

const LOG = process.env.PI_NET_GUARD_LOG || '';
// 只允许显式列出的真实编码服务域名及其解析出的地址；默认不开放任何非回环目标。
const ALLOW_HOSTS = (process.env.PI_NET_GUARD_ALLOW || '')
  .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
const allowedAddresses = new Set();

function hostAllowed(host) {
  const value = String(host === undefined || host === null ? '' : host).toLowerCase().replace(/^\[|\]$/g, '');
  return loopback(value) || ALLOW_HOSTS.some((allowed) => value === allowed || value.endsWith(`.${allowed}`));
}

function rememberAddress(value) {
  if (typeof value === 'string') { allowedAddresses.add(value); return; }
  if (Array.isArray(value)) { for (const entry of value) rememberAddress(entry && entry.address); return; }
  if (value && typeof value === 'object' && typeof value.address === 'string') allowedAddresses.add(value.address);
}

function loopback(host) {
  const value = String(host === undefined || host === null ? '' : host).toLowerCase().replace(/^\[|\]$/g, '');
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '0.0.0.0' ||
    value === '::' || value.endsWith('.localhost');
}

function record(kind, detail) {
  if (!LOG) return;
  try {
    fs.appendFileSync(LOG, `${JSON.stringify({ kind, detail: String(detail), pid: process.pid })}\n`);
  } catch { /* 记录失败不影响拦截 */ }
}

function blocked(kind, detail) {
  record(kind, detail);
  const error = new Error(`network guard blocked outbound ${kind} -> ${detail}`);
  error.code = 'ENETGUARD';
  return error;
}

// 1) DNS 解析（net / undici fetch 的默认路径）
const originalLookup = dns.lookup;
dns.lookup = function lookup(hostname, options, callback) {
  if (loopback(hostname)) return originalLookup.apply(this, arguments);
  if (!hostAllowed(hostname)) {
    const done = typeof options === 'function' ? options : callback;
    const error = blocked('dns.lookup', hostname);
    if (typeof done === 'function') { process.nextTick(() => done(error)); return; }
    throw error;
  }
  const done = typeof options === 'function' ? options : callback;
  const wrapped = function (error, address, family) {
    if (!error) rememberAddress(address);
    if (typeof done === 'function') done(error, address, family);
  };
  return typeof options === 'function'
    ? originalLookup.call(this, hostname, wrapped)
    : originalLookup.call(this, hostname, options, wrapped);
};

const dnsPromises = require('node:dns/promises');
const originalPromiseLookup = dnsPromises.lookup;
dnsPromises.lookup = function lookup(hostname, options) {
  if (loopback(hostname)) return originalPromiseLookup.call(this, hostname, options);
  if (!hostAllowed(hostname)) return Promise.reject(blocked('dns.promises.lookup', hostname));
  return originalPromiseLookup.call(this, hostname, options).then((result) => { rememberAddress(result); return result; });
};

// 自证：启动器会检查这个标记，证明守卫真的加载进了被测后端进程（而不是“没装上所以日志为空”）
globalThis.__piNetGuard = { ready: true, log: LOG, blocked };

// 2) 直连（不经过 DNS 的 IP 字面量）也要拦
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect() {
  const args = Array.prototype.slice.call(arguments);
  const first = args[0];
  const host = typeof first === 'object' && first !== null
    ? (first.host || first.hostname)
    : (typeof args[1] === 'string' ? args[1] : undefined);
  if (host && !loopback(host) && !hostAllowed(host) && !allowedAddresses.has(host)) throw blocked('net.Socket.connect', host);
  return originalConnect.apply(this, args);
};

module.exports = { guard: (host) => loopback(host) };
