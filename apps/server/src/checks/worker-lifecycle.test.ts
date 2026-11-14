import cp, { type ChildProcess } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { createRealExecutor } from './worker.ts';
import { copyAudited } from './snapshot.ts';
import { writeArtifact } from './artifacts.ts';
import type { CheckContext, CheckExecutor } from './runner.ts';
const directories:string[]=[],owned:{executor:CheckExecutor;ctx:CheckContext;controller:AbortController}[]=[],children:ChildProcess[]=[];
afterEach(async()=>{
  for(const item of owned.splice(0)){item.controller.abort();await item.executor.stop?.(item.ctx.runId);}
  for(const child of children.splice(0)){if(child.exitCode===null&&child.signalCode===null){const closed=new Promise<void>(r=>child.once('close',()=>r()));child.kill();await closed;}}
  vi.restoreAllMocks();syncBuiltinESMExports();
  for(const dir of directories.splice(0))await rm(dir,{recursive:true,force:true});
});
async function fixture(){
  const directory=await mkdtemp(path.join(tmpdir(),'m3b-lifecycle-'));directories.push(directory);
  const candidateRoot=path.join(directory,'candidate');await mkdir(path.join(candidateRoot,'src'),{recursive:true});
  await writeFile(path.join(candidateRoot,'src/main.tsx'),'export {};');
  await writeFile(path.join(candidateRoot,'src/scene.config.json'),await readFile(new URL('../../../../templates/product-page/src/scene.config.json',import.meta.url)));
  const buildRoot=path.join(directory,'snapshot'),snapshot=await copyAudited(candidateRoot,buildRoot),controller=new AbortController();
  const ctx:CheckContext={runId:randomUUID().replaceAll('-',''),candidateRoot,buildRoot,snapshot,signal:controller.signal,buildTimeoutMs:120000,browserTimeoutMs:30000,artifactsDir:directory,writeArtifact:(name,data)=>writeArtifact(directory,ctx.runId,name,data)};
  const executor=createRealExecutor();owned.push({executor,ctx,controller});
  const spy=vi.spyOn(cp,'spawn');syncBuiltinESMExports();
  expect((await executor.schema(ctx)).status).toBe('passed');
  const child=spy.mock.results.find((result,index)=>spy.mock.calls[index][1]?.some(arg=>String(arg).includes('worker-entry.')))?.value as ChildProcess;
  expect(child.pid).toBeTypeOf('number');
  return {directory,ctx,executor,controller,child};
}
it('stop settles the active request and confirms exit even without aborting its signal',async()=>{
  const f=await fixture();const original=f.child.send.bind(f.child);
  vi.spyOn(f.child,'send').mockImplementation(((message:unknown,...args:unknown[])=>{
    if((message as {kind?:string}).kind==='run')return true;
    return Reflect.apply(original,f.child,[message,...args]);
  }) as typeof f.child.send);
  let settled=false;
  const pending=f.executor.build(f.ctx);void pending.then(()=>{settled=true;},()=>{settled=true;});
  // Await the existing-session microtask so the request has been admitted.
  await Promise.resolve();await Promise.resolve();
  await f.executor.stop?.(f.ctx.runId);
  await Promise.resolve();
  expect(f.child.exitCode!==null||f.child.signalCode!==null).toBe(true);
  expect(settled,'stop must release callers as well as the process').toBe(true);
  await expect(pending).rejects.toMatchObject({code:'CANCELLED'});
},10000);
it('a phase deadline rejects with TIMEOUT only after the owned worker exits',async()=>{
  const f=await fixture();const original=f.child.send.bind(f.child);
  vi.spyOn(f.child,'send').mockImplementation(((message:unknown,...args:unknown[])=>{
    if((message as {kind?:string}).kind==='run')return true;
    return Reflect.apply(original,f.child,[message,...args]);
  }) as typeof f.child.send);
  f.ctx.buildTimeoutMs=40;
  await expect(f.executor.build(f.ctx)).rejects.toMatchObject({code:'TIMEOUT'});
  expect(f.child.exitCode!==null||f.child.signalCode!==null).toBe(true);
},10000);
it('unexpected worker exit rejects a pending request instead of leaving a green result',async()=>{
  const f=await fixture();const original=f.child.send.bind(f.child);
  vi.spyOn(f.child,'send').mockImplementation(((message:unknown,...args:unknown[])=>{
    if((message as {kind?:string}).kind==='run'){f.child.kill();return true;}
    return Reflect.apply(original,f.child,[message,...args]);
  }) as typeof f.child.send);
  await expect(f.executor.build(f.ctx)).rejects.toMatchObject({code:'WORKER_EXITED'});
  await f.executor.stop?.(f.ctx.runId);
},10000);
function processes(parentPid?:number):Promise<{pid:number;parent:number;created:string;name:string}[]>{
  if(process.platform!=='win32')throw new Error('This process-identity acceptance fixture targets Windows');
  const query=parentPid===undefined?'':" -Filter 'ParentProcessId="+parentPid+"'";
  return new Promise((resolve,reject)=>cp.execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',
    'Get-CimInstance Win32_Process'+query+' | Select-Object @{n="pid";e={$_.ProcessId}},@{n="parent";e={$_.ParentProcessId}},@{n="created";e={$_.CreationDate.ToUniversalTime().ToString("o")}},@{n="name";e={$_.Name}} | ConvertTo-Json -Compress'],
    {windowsHide:true},(error,stdout)=>{if(error)return reject(error);const data=stdout.trim()?JSON.parse(stdout):[];resolve(Array.isArray(data)?data:[data]);}));
}
it('parent death reclaims the real worker and esbuild service without killing an unrelated process',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'m3b-parent-death-'));directories.push(directory);
  const helper=fileURLToPath(new URL('./test-support/lifecycle-parent.mjs',import.meta.url));
  const env:NodeJS.ProcessEnv={};
  for(const key of ['SystemRoot','WINDIR','PATH','Path','TEMP','TMP','ComSpec','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key];
  const parent=cp.spawn(process.execPath,[helper,directory],{env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});children.push(parent);
  let output='';parent.stderr?.on('data',data=>{output=(output+String(data)).slice(-3000);});
  const packet=await new Promise<{workerPid:number}>((resolve,reject)=>{
    parent.once('message',(message:any)=>message.kind==='built'?resolve(message):reject(new Error(message.message)));
    parent.once('exit',code=>reject(new Error('Fixture exited '+code+' '+output)));
  });
  const worker=(await processes(parent.pid!)).find(item=>item.pid===packet.workerPid);expect(worker).toBeDefined();
  const descendants=await processes(packet.workerPid);
  expect(descendants.some(item=>/esbuild/i.test(item.name)),'real build must create an observed esbuild service').toBe(true);
  const decoy=cp.spawn(process.execPath,['--interactive'],{env,windowsHide:true,stdio:['pipe','ignore','ignore']});children.push(decoy);
  const decoyIdentity=(await processes()).find(item=>item.pid===decoy.pid);expect(decoyIdentity).toBeDefined();
  console.info('LIFECYCLE_OWNED_IDENTITIES', JSON.stringify({parentPid:parent.pid,worker,descendants,decoy:decoyIdentity}));
  const closed=new Promise<void>(resolve=>parent.once('close',()=>resolve()));parent.kill('SIGKILL');await closed;
  await expect.poll(async()=>{
    const current=await processes();
    return [worker!,...descendants].filter(old=>current.some(now=>now.pid===old.pid&&now.created===old.created)).map(item=>item.pid);
  },{timeout:10000,interval:200}).toEqual([]);
  const final=await processes();
  expect(final.some(item=>item.pid===decoyIdentity!.pid&&item.created===decoyIdentity!.created)).toBe(true);
  console.info('LIFECYCLE_RECLAIMED',JSON.stringify({workerPid:worker!.pid,descendantPids:descendants.map(item=>item.pid),decoyPid:decoyIdentity!.pid,decoyAlive:true}));
},30000);

