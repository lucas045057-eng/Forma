import {expect,it} from 'vitest';
import {Document,NodeIO} from '@gltf-transform/core';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AssetService} from './service.ts';
import {Lux3DClient} from './lux3d.ts';
import {sha256} from './fallbacks.ts';

import {fixtureProcesses,fixtureFailure,writeFixtureEvidence,fixtureDirectoryIdentity,removeFixtureDirectory,failFixture,type FixtureProcess} from '../test-support/fixture-diagnostics.ts';
interface FixtureEvent {type:string;pid?:number;error?:string;stage?:string;code?:number|null;signal?:string|null}
async function exists(file:string){try{await stat(file);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
async function model(){
 const document=new Document();const buffer=document.createBuffer('geometry');
 const positions=document.createAccessor('positions').setType('VEC3').setArray(new Float32Array([0,0,0,1,0,0,0,1,0])).setBuffer(buffer);
 const indices=document.createAccessor('indices').setType('SCALAR').setArray(new Uint16Array([0,1,2])).setBuffer(buffer);
 const primitive=document.createPrimitive().setAttribute('POSITION',positions).setIndices(indices);
 const mesh=document.createMesh('triangle').addPrimitive(primitive);const node=document.createNode('triangle').setMesh(mesh);document.createScene('scene').addChild(node);
 return Buffer.from(await new NodeIO().writeBinary(document));
}
async function waitFor<T>(read:()=>Promise<T|undefined>,description:()=>string,timeoutMs=10_000,pollMs=20){
 const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){const value=await read();if(value!==undefined)return value;await delay(pollMs);}throw new Error(`Timed out waiting for ${description()}`);
}

it('a hard-killed asset parent loses its worker, preserves complete raw input and cleans owned staging on restart',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'fallback-parent-death-'));const rootOwner=await fixtureDirectoryIdentity(root);const directory=path.join(root,'assets');const preset=path.join(root,'presets');await mkdir(preset);
 const bytes=await model();await writeFile(path.join(preset,'lux3d-split-4969889.glb'),bytes);
 let parent:ChildProcess|undefined;let parentIdentity:FixtureProcess|undefined;let restarted:AssetService|undefined;let primary:unknown;let autonomousWorkerExit=false;
 const owned=new Map<number,FixtureProcess>();let output='';let stderr='';let spawnError:Error|undefined;const events:FixtureEvent[]=[];
 const stages:Array<{phase:string;ms:number}>=[];const started=performance.now();const mark=(phase:string)=>stages.push({phase,ms:performance.now()-started});
 const diagnostics=()=>JSON.stringify({stages,events,stderr:stderr.slice(-8000),spawnError:spawnError?.message,exit:parent?.exitCode,signal:parent?.signalCode});
 const assertRunning=()=>{if(spawnError||events.some(event=>['worker-error','worker-spawn-error','worker-closed','parent-error'].includes(event.type))||parent?.exitCode!==null||parent?.signalCode!==null)throw new Error(`Asset fixture failed: ${diagnostics()}`);};
 const captureWorkers=async()=>{
  if(!parent?.pid)return;const table=await fixtureProcesses([parent.pid],parent.pid);const current=table.find(item=>item.pid===parent!.pid);
  if(current){if(parentIdentity&&current.created!==parentIdentity.created)throw new Error('Fixture parent PID reused');parentIdentity??=current;}
  if(parentIdentity)for(const item of table)if(item.parent===parentIdentity.pid&&Date.parse(item.created)>=Date.parse(parentIdentity.created))owned.set(item.pid,item);
 };
 try{
  const fixture=path.resolve(import.meta.dirname,'../test-support/asset-parent.ts');
  const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  const child=spawn(process.execPath,[fixture,directory,preset,sha256(bytes)],{env,stdio:['ignore','pipe','pipe']});parent=child;
  child.once('error',error=>{spawnError=error;});
  child.stdout!.on('data',chunk=>{output+=String(chunk);let newline;while((newline=output.indexOf('\n'))!==-1){const line=output.slice(0,newline);output=output.slice(newline+1);try{const event=JSON.parse(line) as FixtureEvent;if(typeof event.type==='string')events.push(event);}catch{stderr+='\nUnparsed fixture output: '+line;}}});
  child.stderr!.on('data',chunk=>{stderr+=String(chunk);});
  mark('spawn');await waitFor(async()=>{assertRunning();return events.some(event=>event.type==='ready')?true:undefined;},()=>`parent readiness ${diagnostics()}`);
  mark('identity');await captureWorkers();assertRunning();if(!parentIdentity)throw new Error(`Asset parent identity unavailable: ${diagnostics()}`);
  let captured=owned.size>0;
  mark('barrier');await waitFor(async()=>{
   assertRunning();if(!captured&&events.some(event=>event.type==='worker-spawned')){await captureWorkers();captured=true;assertRunning();}
   return events.find(event=>event.type==='worker-blocked');
  },()=>`deterministic model import barrier ${diagnostics()}`);
  const barrier=events.find(event=>event.type==='worker-blocked')!;if(!owned.has(barrier.pid!))await captureWorkers();const worker=owned.get(barrier.pid!);expect(worker?.command).toContain('process-worker');if(!worker)throw new Error(`Barrier worker ownership unavailable: ${diagnostics()}`);
  mark('kill-parent');process.kill(child.pid!,'SIGKILL');await waitFor(async()=>child.exitCode!==null||child.signalCode!==null?true:undefined,()=>`asset parent exit ${diagnostics()}`);
  mark('autonomous-worker-exit');await waitFor(async()=>!(await fixtureProcesses([worker.pid])).some(item=>item.created===worker.created)?true:undefined,()=>`worker IPC-disconnect exit ${diagnostics()}`,10_000,250);autonomousWorkerExit=true;
  const assetDirectory=path.join(directory,'fallback-'+sha256(bytes).slice(0,24));
  expect(await readFile(path.join(assetDirectory,'raw.glb'))).toEqual(bytes);expect(await exists(path.join(assetDirectory,'model.glb'))).toBe(false);
  mark('restart');restarted=new AssetService({directory,client:new Lux3DClient({base:'http://127.0.0.1:9',key:'mock-only'})});await restarted.init();
  expect(restarted.list()[0]).toMatchObject({status:'failed',error:{code:'LOCAL_IMPORT_INTERRUPTED'}});
  expect((await readdir(assetDirectory)).some(name=>name.startsWith('.model-stage-'))).toBe(false);
  expect((await fixtureProcesses([worker.pid])).some(item=>item.created===worker.created)).toBe(false);mark('assertions-complete');
 }catch(error){primary=error;}
 const errors:unknown[]=[];const cleanupKills:number[]=[];mark('cleanup');try{await restarted?.close();}catch(error){errors.push(error);}
 try{await captureWorkers();}catch(error){errors.push(error);}
 try{if(parent&&parent.exitCode===null&&parent.signalCode===null){parent.kill('SIGKILL');if(parent.pid)cleanupKills.push(parent.pid);}}catch(error){errors.push(error);}
 try{
  const table=await fixtureProcesses([...owned.keys()]);for(const item of owned.values())if(table.some(current=>current.pid===item.pid&&current.created===item.created)){process.kill(item.pid,'SIGKILL');cleanupKills.push(item.pid);}
  const identities=[...owned.values(),...(parentIdentity?[parentIdentity]:[])];await waitFor(async()=>{const live=await fixtureProcesses(identities.map(item=>item.pid));return !live.some(current=>identities.some(item=>item.pid===current.pid&&item.created===current.created))?true:undefined;},()=>`owned fixture cleanup ${diagnostics()}`,10_000,250);
 }catch(error){errors.push(error);}
 try{await writeFixtureEvidence(process.env.D2_RUN_DIR??root,'asset-lifecycle',`cleanup-${process.pid}.json`,{parent:parentIdentity,workers:[...owned.values()],stages,events,stderr,autonomousWorkerExit,cleanupKills,primary:primary===undefined?null:fixtureFailure(primary),cleanup:errors.map(fixtureFailure),directoryPolicy:'retain on any failure'});}catch(error){errors.push(error);}
 if(primary===undefined&&!errors.length)try{await removeFixtureDirectory(root,rootOwner);}catch(error){errors.push(error);}
 failFixture(primary,errors,`Asset fixture failed; retained on failure: ${root}; ${diagnostics()}`);
},30_000);
