import {AssetService} from '../assets/service.ts';
import type {ModelMetrics} from '@spatial/shared';
import {Lux3DClient} from '../assets/lux3d.ts';
import {fork} from 'node:child_process';
import {mkdtemp} from 'node:fs/promises';
import {fixtureDirectoryIdentity,removeFixtureDirectory} from './fixture-diagnostics.ts';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Test parent only: real process-worker IPC, synthetic blocked model module, no HTTP/env files.
const [directory,fallbackDirectory,digest]=process.argv.slice(2);
if(!directory||!fallbackDirectory||!digest)throw new Error('Asset parent fixture arguments missing');
const report=(value:Record<string,unknown>)=>process.stdout.write(JSON.stringify(value)+'\n');
const service=new AssetService({directory,fallbackDirectory,presetDigests:{'diffuser-split':digest},client:new Lux3DClient({base:'http://127.0.0.1:9',key:'mock-only'}),process:async(input,output)=>{
 const stage=await mkdtemp(path.join(path.dirname(output),'.model-stage-'));const stageOwner=await fixtureDirectoryIdentity(stage);let primary:unknown;
 try{return await new Promise<ModelMetrics>((_resolve,reject)=>{
  let spawnFailure:Error|undefined;
  const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  const worker=fork(fileURLToPath(new URL('../assets/process-worker.ts',import.meta.url)),[input,path.join(stage,'model.glb')],{env,execArgv:['--import',fileURLToPath(new URL('./asset-loader-register.mjs',import.meta.url))],stdio:['ignore','ignore','pipe','ipc']});
  // Ownership is reported before barrier readiness; failed startup is still ours to reap.
  worker.once('spawn',()=>report({type:'worker-spawned',pid:worker.pid,stage}));
  worker.stderr?.on('data',bytes=>process.stderr.write(bytes));
  worker.on('message',(message:unknown)=>{
   if(message&&typeof message==='object'&&'fixtureModelBlocked'in message&&'pid'in message&&message.pid===worker.pid)report({type:'worker-blocked',pid:worker.pid,stage});
   if(message&&typeof message==='object'&&'error'in message)report({type:'worker-error',pid:worker.pid,error:String(message.error)});
  });
  worker.once('error',error=>{spawnFailure=error;report({type:'worker-spawn-error',pid:worker.pid,error:error.message});});
  worker.once('close',(code,signal)=>{report({type:'worker-closed',pid:worker.pid,code,signal});reject(spawnFailure??new Error(`Fixture model worker closed (${code}, ${signal})`));});
 });}catch(error){primary=error;throw error;}finally{try{await removeFixtureDirectory(stage,stageOwner);}catch(error){throw new AggregateError([...(primary===undefined?[]:[primary]),error],'Model fixture and staging cleanup failed');}}
}});
await service.init();report({type:'ready',pid:process.pid});
try{await service.importFallback('diffuser-split');await service.idle();}
catch(error){report({type:'parent-error',error:error instanceof Error?error.message:String(error)});process.exitCode=1;}
