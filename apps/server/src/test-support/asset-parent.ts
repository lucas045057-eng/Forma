import {AssetService} from '../assets/service.ts';
import type {ModelMetrics} from '@spatial/shared';
import {Lux3DClient} from '../assets/lux3d.ts';
import {fork} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Implementation-test fixture only. No HTTP/env files. The real process-worker runs with
// only its heavy model module held at a deterministic test barrier; its IPC listener is real.
const [directory,fallbackDirectory,digest]=process.argv.slice(2);
if(!directory||!fallbackDirectory||!digest)throw new Error('Asset parent fixture arguments missing');
const service=new AssetService({directory,fallbackDirectory,presetDigests:{'diffuser-split':digest},client:new Lux3DClient({base:'http://127.0.0.1:9',key:'mock-only'}),process:async(input,output)=>{
 const stage=await mkdtemp(path.join(path.dirname(output),'.model-stage-'));
 try{return await new Promise<ModelMetrics>((_resolve,reject)=>{
  const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  const worker=fork(fileURLToPath(new URL('../assets/process-worker.ts',import.meta.url)),[input,path.join(stage,'model.glb')],{env,execArgv:['--import',fileURLToPath(new URL('./asset-loader-register.mjs',import.meta.url))],stdio:['ignore','ignore','pipe','ipc']});
  worker.on('message',(message:unknown)=>{if(message&&typeof message==='object'&&'fixtureModelBlocked'in message)console.log(JSON.stringify({type:'worker-blocked',pid:worker.pid,stage}));});
  worker.once('error',reject);worker.once('close',()=>reject(new Error('Fixture model worker closed')));
 });}finally{await rm(stage,{recursive:true,force:true});}
}});
await service.init();console.log(JSON.stringify({type:'ready',pid:process.pid}));
await service.importFallback('diffuser-split');await service.idle();
