import {expect,it} from 'vitest';
import {Document,NodeIO} from '@gltf-transform/core';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,readdir,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {AssetService} from './service.ts';
import {Lux3DClient} from './lux3d.ts';
import {sha256} from './fallbacks.ts';

interface ProcessIdentity {pid:number;parent:number;created:string;command:string}
interface FixtureEvent {type:string;pid?:number;error?:string;stage?:string;code?:number|null;signal?:string|null}
function processes(filter?:string){
 const where=filter?`| Where-Object { ${filter} }`:'';
 const script=`Get-CimInstance Win32_Process ${where} | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');command=$_.CommandLine} } | ConvertTo-Json -Compress`;
 const value=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:10_000})||'[]') as ProcessIdentity|ProcessIdentity[]|null;
 return !value?[]:Array.isArray(value)?value:[value];
}
async function exists(file:string){try{await stat(file);return true;}catch{return false;}}
async function model(){
 const document=new Document();const buffer=document.createBuffer('geometry');
 const positions=document.createAccessor('positions').setType('VEC3').setArray(new Float32Array([0,0,0,1,0,0,0,1,0])).setBuffer(buffer);
 const indices=document.createAccessor('indices').setType('SCALAR').setArray(new Uint16Array([0,1,2])).setBuffer(buffer);
 const primitive=document.createPrimitive().setAttribute('POSITION',positions).setIndices(indices);
 const mesh=document.createMesh('triangle').addPrimitive(primitive);const node=document.createNode('triangle').setMesh(mesh);document.createScene('scene').addChild(node);
 return Buffer.from(await new NodeIO().writeBinary(document));
}
async function waitFor<T>(read:()=>Promise<T|undefined>,description:()=>string,timeoutMs=10_000){
 const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){const value=await read();if(value!==undefined)return value;await delay(20);}throw new Error(`Timed out waiting for ${description()}`);
}

it('a hard-killed asset parent loses its worker, preserves complete raw input and cleans owned staging on restart',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'fallback-parent-death-'));const directory=path.join(root,'assets');const preset=path.join(root,'presets');await mkdir(preset);
 const bytes=await model();await writeFile(path.join(preset,'lux3d-split-4969889.glb'),bytes);
 let parent:ChildProcess|undefined;let parentIdentity:ProcessIdentity|undefined;let restarted:AssetService|undefined;
 const owned=new Map<number,ProcessIdentity>();let output='';let stderr='';let spawnError:Error|undefined;const events:FixtureEvent[]=[];
 const diagnostics=()=>JSON.stringify({events,stderr:stderr.slice(-8000),spawnError:spawnError?.message});
 const captureWorkers=()=>{if(!parentIdentity)return;for(const item of processes(`$_.ParentProcessId -eq ${parentIdentity.pid}`))if(Date.parse(item.created)>=Date.parse(parentIdentity.created))owned.set(item.pid,item);};
 try{
  const fixture=path.resolve(import.meta.dirname,'../test-support/asset-parent.ts');
  const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  const child=spawn(process.execPath,[fixture,directory,preset,sha256(bytes)],{env,stdio:['ignore','pipe','pipe']});parent=child;
  child.once('error',error=>{spawnError=error;});
  child.stdout!.on('data',chunk=>{output+=String(chunk);let newline;while((newline=output.indexOf('\n'))!==-1){const line=output.slice(0,newline);output=output.slice(newline+1);try{const event=JSON.parse(line) as FixtureEvent;if(typeof event.type==='string')events.push(event);}catch{stderr+='\nUnparsed fixture output: '+line;}}});
  child.stderr!.on('data',chunk=>{stderr+=String(chunk);});
  parentIdentity=await waitFor(async()=>{if(spawnError)throw spawnError;return processes(`$_.ProcessId -eq ${child.pid}`).find(item=>item.pid===child.pid);},()=>`asset parent identity ${diagnostics()}`);
  await waitFor(async()=>{
   // Capture the OS identity as soon as fork is reported, even if the barrier never arrives.
   if(events.some(event=>event.type==='worker-spawned'))captureWorkers();
   const failure=events.find(event=>['worker-error','worker-spawn-error','worker-closed','parent-error'].includes(event.type));
   if(failure||spawnError||child.exitCode!==null||child.signalCode!==null)throw new Error(`Asset fixture failed before barrier: ${diagnostics()}`);
   const ready=events.find(event=>event.type==='worker-blocked');return ready&&events.some(event=>event.type==='ready')?ready:undefined;
  },()=>`deterministic model import barrier ${diagnostics()}`);
  captureWorkers();const barrier=events.find(event=>event.type==='worker-blocked')!;const worker=owned.get(barrier.pid!);expect(worker?.command).toContain('process-worker');if(!worker)throw new Error('Barrier worker ownership unavailable');
  process.kill(child.pid!,'SIGKILL');await waitFor(async()=>child.exitCode!==null||child.signalCode!==null?true:undefined,()=>`asset parent exit ${diagnostics()}`);
  await waitFor(async()=>!processes(`$_.ProcessId -eq ${worker.pid}`).some(item=>item.created===worker.created)?true:undefined,()=>`worker IPC-disconnect exit ${diagnostics()}`);
  const assetDirectory=path.join(directory,'fallback-'+sha256(bytes).slice(0,24));
  expect(await readFile(path.join(assetDirectory,'raw.glb'))).toEqual(bytes);expect(await exists(path.join(assetDirectory,'model.glb'))).toBe(false);
  restarted=new AssetService({directory,client:new Lux3DClient({base:'http://127.0.0.1:9',key:'mock-only'})});await restarted.init();
  expect(restarted.list()[0]).toMatchObject({status:'failed',error:{code:'LOCAL_IMPORT_INTERRUPTED'}});
  expect((await readdir(assetDirectory)).some(name=>name.startsWith('.model-stage-'))).toBe(false);
  expect(processes(`$_.ProcessId -eq ${worker.pid}`).some(item=>item.created===worker.created)).toBe(false);
 }finally{
  const errors:unknown[]=[];try{await restarted?.close();}catch(error){errors.push(error);}
  // Before stopping a failed parent, discover every worker it already forked, not only ready ones.
  try{captureWorkers();}catch(error){errors.push(error);}
  try{if(parent&&parent.exitCode===null&&parent.signalCode===null)parent.kill('SIGKILL');}catch(error){errors.push(error);}
  for(const item of owned.values())try{if(processes(`$_.ProcessId -eq ${item.pid}`).some(current=>current.created===item.created))process.kill(item.pid,'SIGKILL');}catch(error){errors.push(error);}
  try{await waitFor(async()=>{
   const alive=[...owned.values(),...(parentIdentity?[parentIdentity]:[])].some(item=>processes(`$_.ProcessId -eq ${item.pid}`).some(current=>current.created===item.created));return !alive?true:undefined;
  },()=>`owned fixture cleanup ${diagnostics()}`);}catch(error){errors.push(error);}
  if(process.env.D2_RUN_DIR)await writeFile(path.join(process.env.D2_RUN_DIR,`asset-parent-cleanup-${process.pid}.json`),JSON.stringify({parent:parentIdentity,workers:[...owned.values()],events,stderr,errors:errors.map(String),retained:errors.length?root:null},null,2));
  if(errors.length)throw new AggregateError(errors,`Asset fixture cleanup failed; retained ${root}`);
  await rm(root,{recursive:true,force:true});
 }
},30_000);
