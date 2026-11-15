const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const dns = require('node:dns');
const dnsPromises = require('node:dns/promises');
const http = require('node:http');
const { randomInt } = require('node:crypto');
const native = { lookup: dns.lookup, promiseLookup: dnsPromises.lookup, connect: net.Socket.prototype.connect, fetch: globalThis.fetch };
const calls = { dns: [], promiseDns: [], connect: [], fetch: [] };
const local = host => ['127.0.0.1','localhost','::1','[::1]'].includes(String(host).toLowerCase());
// Canaries sit below the guard. Even a broken guard cannot send a negative probe externally.
dns.lookup = function(host, ...args) { calls.dns.push(host); assert(local(host) || net.isIP(host), 'unguarded domain DNS reached native boundary'); return native.lookup.call(this,host,...args); };
dnsPromises.lookup = function(host,...args) { calls.promiseDns.push(host); assert(local(host) || net.isIP(host), 'unguarded async domain DNS reached native boundary'); return native.promiseLookup.call(this,host,...args); };
net.Socket.prototype.connect = function(...args) {
 const first = Array.isArray(args[0]) ? args[0][0] : args[0];
 const host = first && typeof first === 'object' ? first.host ?? first.hostname : typeof first === 'number' && typeof args[1] === 'string' ? args[1] : undefined;
 calls.connect.push(host ?? '(local IPC/default)'); assert(host === undefined || local(host), 'unguarded external TCP reached native boundary');
 return native.connect.apply(this,args);
};
globalThis.fetch = function(input,options) {const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);calls.fetch.push(url.hostname);assert(local(url.hostname),'unguarded external fetch reached native boundary');return native.fetch(input,options);};
assert.equal(require.cache[require.resolve('./d1-loopback.cjs')], undefined, 'probe must install canaries before loading the guard');
require('./d1-loopback.cjs');
const output = process.env.D1_RUN_DIR;
const checks=[];
const check = async(name,work)=>{await work();checks.push({name,passed:true});};
const lookup = (host,options) => new Promise((resolve,reject)=>dns.lookup(host,options,(error,...result)=>error?reject(error):resolve(result)));
const server=http.createServer((_request,response)=>response.end('guard-loopback-ok'));
(async()=>{
 try {
  await check('literal IPv4 and IPv6 callback/promise lookup stays local',async()=>{
   for(const host of ['10.0.0.1','8.8.8.8','::ffff:7f00:1','2001:4860:4860::8888']) {
    const [answers]=await lookup(host,{all:true});assert.equal(answers[0].address,host);
    const promised=await dnsPromises.lookup(host,{all:true});assert.equal(promised[0].address,host);
   }
  });
  await check('non-loopback domain DNS rejected before both native lookup boundaries',async()=>{
   const before={sync:calls.dns.length,async:calls.promiseDns.length};
   for(const host of ['untrusted.invalid','dashscope.aliyuncs.com','evil.oss-cn-hangzhou.aliyuncs.com','10.0.0.999']) {
    await assert.rejects(lookup(host,{all:true}),{code:'D1_NETWORK_DENIED'});
    await assert.rejects(dnsPromises.lookup(host,{all:true}),{code:'D1_NETWORK_DENIED'});
   }
   assert.equal(calls.dns.length,before.sync);assert.equal(calls.promiseDns.length,before.async);
  });
  await check('private/public/mapped TCP rejected before native connect',async()=>{
   const before=calls.connect.length;
   for(const host of ['10.0.0.1','8.8.8.8','::ffff:7f00:1','2001:4860:4860::8888','untrusted.invalid']) {
    const socket=new net.Socket();try {assert.throws(()=>socket.connect({host,port:443}),{code:'D1_NETWORK_DENIED'});} finally {socket.destroy();}
    const numeric=new net.Socket();try {assert.throws(()=>numeric.connect(443,host),{code:'D1_NETWORK_DENIED'});} finally {numeric.destroy();}
   }
   assert.equal(calls.connect.length,before);
  });
  await check('private/public/domain fetch rejected before native fetch',async()=>{
   const before=calls.fetch.length;
   for(const url of ['http://10.0.0.1/','https://8.8.8.8/','http://[::ffff:127.0.0.1]/','https://dashscope.aliyuncs.com/','https://untrusted.invalid/']) {
    await assert.rejects(fetch(url),{code:'D1_NETWORK_DENIED'});
    await assert.rejects(fetch(new Request(url)),{code:'D1_NETWORK_DENIED'});
   }
   assert.equal(calls.fetch.length,before);
  });
  await check('loopback DNS TCP and fetch still work with the same guard',async()=>{
   assert.equal((await dnsPromises.lookup('127.0.0.1')).address,'127.0.0.1');
   const [address]=await lookup('localhost',{});assert(local(address));
   let listening=false;
   for(let attempt=0;attempt<32;attempt++) {
    try {await new Promise((resolve,reject)=>{const error=cause=>reject(cause);server.once('error',error);server.listen(randomInt(20_000,65_536),'127.0.0.1',()=>{server.off('error',error);resolve();});});listening=true;break;}
    catch(error){if(!['EADDRINUSE','EACCES'].includes(error.code))throw error;}
   }
   assert(listening,'no safe local listener available');
   const {port}=server.address();
   await new Promise((resolve,reject)=>{const socket=net.createConnection({host:'127.0.0.1',port});socket.once('error',reject);socket.once('connect',()=>{socket.destroy();resolve();});});
   assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(),'guard-loopback-ok');
  });
 } catch(error){process.exitCode=1;console.error(error);checks.push({name:'probe failure',passed:false,error:String(error)});}
 finally {
  try {server.closeAllConnections();if(server.listening)await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));assert.equal(server.listening,false);}
  catch(error){process.exitCode=1;checks.push({name:'cleanup',passed:false,error:String(error)});}
  const result={pid:process.pid,checks,lowerBoundaryCalls:calls,serverListening:server.listening,exit:process.exitCode??0,note:'Same guard explicitly required after installing native-boundary canaries and before any network operation; canaries forbid negative probes from reaching real external syscalls.'};
  if(output)fs.writeFileSync(path.join(output,'guard-verification.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
 }
})();
