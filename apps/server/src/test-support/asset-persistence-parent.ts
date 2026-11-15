import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {AssetService} from '../assets/service.ts';
import {Lux3DClient} from '../assets/lux3d.ts';

const [directory,base]=process.argv.slice(2);
if(!directory||!base||!process.send)throw new Error('Persistence fixture arguments/IPC required');
const endpoint=new URL(base);if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||!endpoint.port)throw new Error('Persistence fixture requires explicit loopback mock');
const service=new AssetService({directory,client:new Lux3DClient({base,key:'mock-only'})});await service.init();
const input={prompt:'bottle',version:'G1' as const};
await assert.rejects(service.submit(input,'disk-failure'),/disk full/);
await assert.rejects(service.idle(),/disk full/);
await assert.rejects(service.close(),/disk full/);
const liveProbe=new AssetService({directory,client:new Lux3DClient({base,key:'mock-only'})});
await assert.rejects(liveProbe.init(),(error:unknown)=>!!error&&typeof error==='object'&&'code'in error&&error.code==='INSTANCE_LOCKED');
const lock=JSON.parse(await readFile(path.join(directory,'.instance.lock'),'utf8'));assert.equal(lock.pid,process.pid);
const stored=JSON.parse(await readFile(path.join(directory,'index.json'),'utf8'));assert.equal(stored[0].status,'submitting');
process.send({type:'persistence-failure-held',pid:process.pid,assetId:stored[0].id,submitError:'disk full',idleError:'disk full',closeError:'disk full',lockPid:lock.pid,blockedCode:'INSTANCE_LOCKED'});
// No graceful-close claim or lock deletion. The test must really terminate this process.
setInterval(()=>{},1000);
