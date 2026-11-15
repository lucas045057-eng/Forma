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
async function waitFor<T>(read:()=>Promise<T|undefined>,description:string,timeoutMs=10_000){
 const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){const value=await read();if(value!==undefined)return value;await delay(20);}throw new Error(`Timed out waiting for ${description}`);
}

it('a hard-killed asset parent loses its worker, preserves complete raw input and cleans owned staging on restart',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'fallback-parent-death-'));const directory=path.join(root,'assets');const preset=path.join(root,'presets');await mkdir(preset);
 const bytes=await model();await writeFile(path.join(preset,'lux3d-split-4969889.glb'),bytes);
 let parent:ChildProcess|undefined;let worker:ProcessIdentity|undefined;let restarted:AssetService|undefined;
 try{
  const fixture=path.resolve(import.meta.dirname,'../test-support/asset-parent.ts');
  const env:NodeJS.ProcessEnv={};for(const key of ['SystemRoot','WINDIR','PATH','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  const ownedParent=spawn(process.execPath,[fixture,directory,preset,sha256(bytes)],{env,stdio:['ignore','pipe','pipe']});parent=ownedParent;
  let output='';ownedParent.stdout!.on('data',chunk=>{output+=chunk;});ownedParent.stderr!.on('data',chunk=>{output+=chunk;});
  await waitFor(async()=>output.includes('"type":"ready"')?true:ownedParent.exitCode!==null?Promise.reject(new Error(`Asset parent exited early: ${output}`)):undefined,'asset parent readiness');
  await waitFor(async()=>output.includes('"type":"worker-blocked"')?true:undefined,'deterministic model import barrier');
  worker=await waitFor(async()=>processes(`$_.ParentProcessId -eq ${ownedParent.pid}`).find(item=>item.command.includes('process-worker')),'model worker identity');
  const owned={...worker};process.kill(ownedParent.pid!,'SIGKILL');await waitFor(async()=>ownedParent.exitCode!==null||ownedParent.signalCode!==null?true:undefined,'asset parent exit');
  await waitFor(async()=>!processes(`$_.ProcessId -eq ${owned.pid}`).some(item=>item.created===owned.created)?true:undefined,'worker IPC-disconnect exit');
  expect(await readFile(path.join(directory,'fallback-'+sha256(bytes).slice(0,24),'raw.glb'))).toEqual(bytes);
  expect(await exists(path.join(directory,'fallback-'+sha256(bytes).slice(0,24),'model.glb'))).toBe(false);
  restarted=new AssetService({directory,client:new Lux3DClient({base:'http://127.0.0.1:9',key:'mock-only'})});await restarted.init();
  expect(restarted.list()[0]).toMatchObject({status:'failed',error:{code:'LOCAL_IMPORT_INTERRUPTED'}});
  const assetDirectory=path.join(directory,'fallback-'+sha256(bytes).slice(0,24));
  expect((await readdir(assetDirectory)).some(name=>name.startsWith('.model-stage-'))).toBe(false);
  expect(processes(`$_.ProcessId -eq ${owned.pid}`).some(item=>item.created===owned.created)).toBe(false);
 }finally{
  if(restarted)await restarted.close();
  if(parent&&parent.exitCode===null&&parent.signalCode===null)process.kill(parent.pid!,'SIGKILL');
  const ownedWorker=worker;if(ownedWorker&&processes(`$_.ProcessId -eq ${ownedWorker.pid}`).some(item=>item.created===ownedWorker.created))process.kill(ownedWorker.pid,'SIGKILL');
  await rm(root,{recursive:true,force:true});
 }
},30_000);
