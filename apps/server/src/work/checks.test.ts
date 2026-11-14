import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { CheckRun, Selection } from '@spatial/shared';
import { CodingAgent } from '../agent/client.ts';
import { WorkService, type WorkServiceOptions } from './service.ts';
import type { StudioEvent } from '../events.ts';
import type { CheckContext, CheckExecutor } from '../checks/runner.ts';
import type { ArtifactRef } from '../checks/artifacts.ts';

type IntegratedWork=WorkService & {
  startChecks(id:string,options?:{rerun?:boolean}):Promise<CheckRun>;
  getCheckRun(id:string):CheckRun;
  cancelCheckRun(id:string):Promise<CheckRun>;
  readCheckArtifact(id:string,name:string):Promise<{buffer:Buffer;ref:ArtifactRef}>;
};
const owned:{directory:string;work:IntegratedWork;allowPoisonedCleanup?:boolean}[]=[];
afterEach(async()=>{
  vi.restoreAllMocks();
  for(const f of owned.splice(0)){
    try { await f.work.close(); }
    catch(error){
      if(!f.allowPoisonedCleanup)throw error;
      // Fault tests first assert that normal close retains ownership. This explicit
      // test-only cleanup waits for the no-process executor, then releases its lock.
      const runner=Reflect.get(f.work,'checkRunner') as {waitForActive():Promise<void>};
      await runner.waitForActive().catch(()=>{});await f.work.previews.stopAll();
      const release=Reflect.get(f.work,'releaseLock') as (()=>Promise<void>)|undefined;await release?.();
    }
    await rm(f.directory,{recursive:true,force:true});
  }
});
async function fixture(){
  const directory=await mkdtemp(path.join(tmpdir(),'m3b-integrated-')),workRoot=path.join(directory,'work'),dataDirectory=path.join(directory,'data');
  await mkdir(path.join(workRoot,'src'),{recursive:true});
  await writeFile(path.join(workRoot,'src/App.tsx'),'export default ()=> <main>Baseline</main>;\n');
  await writeFile(path.join(workRoot,'src/main.tsx'),'import App from "./App";export {App};\n');
  await writeFile(path.join(workRoot,'src/scene.config.json'),await readFile(new URL('../../../../templates/product-page/src/scene.config.json',import.meta.url)));
  let edit=0;
  vi.spyOn(CodingAgent.prototype,'run').mockImplementation(async input=>{
    await writeFile(path.join(input.root,'src/App.tsx'),'export default ()=> <main>Candidate '+(++edit)+'</main>;\n');
    return {summary:'local App edit',written:['src/App.tsx']};
  });
  const calls:string[]=[],stopped:string[]=[],published:StudioEvent[]=[],durableEvents:{type:string;state:any}[]=[];
  let phaseHook:((name:string,ctx:CheckContext)=>Promise<void>)|undefined;
  const phase=(name:'schema'|'build'|'smoke'|'occlusion')=>async(ctx:CheckContext)=>{
    calls.push(name);await phaseHook?.(name,ctx);ctx.signal.throwIfAborted();
    if(name==='smoke'||name==='occlusion')await ctx.writeArtifact(name+'.png',Buffer.from('89504e470d0a1a0a','hex'));
    const ref=await ctx.writeArtifact(name==='build'?'build.log':name+'.json',JSON.stringify({phase:name,fixture:true}));
    return {name,status:'passed' as const,evidence:ref.hash};
  };
  const executor:CheckExecutor={schema:phase('schema'),build:phase('build'),smoke:phase('smoke'),occlusion:phase('occlusion'),stop:async id=>{stopped.push(id);}};
  const options:WorkServiceOptions & {checks:{executor:CheckExecutor;toolIdentity:string}}={
    workRoot,directory:dataDirectory,agent:{baseUrl:'http://127.0.0.1:1',apiKey:'mock-only',model:'mock-coder'},
    checks:{executor,toolIdentity:'unit-test-trusted-tools'},
    emit:event=>{
      if(event.type.startsWith('check.'))durableEvents.push({type:event.type,state:JSON.parse(readFileSync(path.join(dataDirectory,'tasks.json'),'utf8'))});
      const stamped={...event,seq:published.length+1,ts:new Date().toISOString()} as StudioEvent;published.push(stamped);return stamped;
    },
  };
  const f={directory,workRoot,dataDirectory,options,calls,stopped,published,durableEvents,allowPoisonedCleanup:false,work:new WorkService(options) as IntegratedWork,
    hook:(hook:typeof phaseHook)=>{phaseHook=hook;}};
  owned.push(f);
  await f.work.init();
  stubPreview(f.work);
  return f;
}
function stubPreview(work:WorkService){
  work.previews.start=async id=>'/preview/c/'+id+'/';work.previews.stop=async()=>{};work.previews.stopAll=async()=>{};
}
async function candidate(f:Awaited<ReturnType<typeof fixture>>){
  const baseVersion=(await f.work.version()).version;
  const selection:Selection={src:'src/App.tsx:1:1',baseVersion,cid:'App',instances:1,ancestors:[],bbox:[0,0,10,10],styles:{} as Selection['styles']};
  const task=await f.work.submit('Edit local copy',selection);await f.work.idle();
  expect(f.work.getTask(task.id).status,JSON.stringify(f.work.getTask(task.id).error)).toBe('done');
  return f.work.getCandidate(task.id);
}
async function start(f:Awaited<ReturnType<typeof fixture>>,id:string){
  expect(typeof f.work.startChecks,'WorkService must own the checks admission API').toBe('function');
  return f.work.startChecks(id);
}
async function complete(f:Awaited<ReturnType<typeof fixture>>,id:string){
  const run=await start(f,id);
  await vi.waitFor(()=>expect(['completed','cancelled']).toContain(f.work.getCheckRun(run.id).status),{timeout:5000,interval:20});
  return f.work.getCheckRun(run.id);
}
it('refuses adopt before checks while preserving the candidate and main bytes',async()=>{
  const f=await fixture(),c=await candidate(f),before=await readFile(path.join(f.workRoot,'src/App.tsx'),'utf8');
  await expect(f.work.adopt(c.id)).rejects.toMatchObject({code:'CHECKS_NOT_PASSED',status:409});
  expect(await readFile(path.join(f.workRoot,'src/App.tsx'),'utf8')).toBe(before);
  expect(f.work.getCandidate(c.id).decision).toBe('pending');expect(await f.work.repo.candidateExists(c.id)).toBe(true);
},15000);
it('persists runs with tasks before check events and adopts only the exact evidenced draft',async()=>{
  const f=await fixture(),c=await candidate(f),run=await complete(f,c.id);
  expect(run).toMatchObject({candidateId:c.id,status:'completed',outcome:'passed',baseVersion:c.baseVersion,mainVersion:c.baseVersion});
  expect(run.checks.map(check=>check.name)).toEqual(['schema','build','smoke','occlusion']);
  expect(f.calls).toEqual(['schema','build','smoke','occlusion']);
  const state=JSON.parse(await readFile(path.join(f.dataDirectory,'tasks.json'),'utf8'));
  expect(state.checkRuns.find((item:CheckRun)=>item.id===run.id)).toEqual(run);
  await expect(readFile(path.join(f.dataDirectory,'check-runs.json'))).rejects.toMatchObject({code:'ENOENT'});
  expect(f.work.getCandidate(c.id)).toMatchObject({latestCheckRunId:run.id});
  expect(f.work.getCandidate(c.id).checks.every(check=>check.status==='passed'&&check.runId===run.id)).toBe(true);
  expect(f.durableEvents.some(item=>item.type==='check.finished'&&item.state.checkRuns.some((r:CheckRun)=>r.id===run.id&&r.outcome==='passed'))).toBe(true);
  const ref=run.artifacts!.find(item=>item.name==='schema.json')!;
  expect((await f.work.readCheckArtifact(run.id,'schema.json')).ref).toEqual(ref);
  await f.work.adopt(c.id);expect(await readFile(path.join(f.workRoot,'src/App.tsx'),'utf8')).toContain('Candidate');
  await f.work.revert();expect(await readFile(path.join(f.workRoot,'src/App.tsx'),'utf8')).toContain('Baseline');
},15000);
it('deduplicates simultaneous starts on one candidate',async()=>{
  const f=await fixture(),c=await candidate(f);
  expect(typeof f.work.startChecks).toBe('function');
  const [a,b]=await Promise.all([f.work.startChecks(c.id),f.work.startChecks(c.id)]);
  expect(a.id).toBe(b.id);
  await vi.waitFor(()=>expect(f.work.getCheckRun(a.id).status).toBe('completed'),{timeout:5000});
  expect(f.calls).toHaveLength(4);
},15000);
it('refuses reuse after candidate input bytes change',async()=>{
  const f=await fixture(),c=await candidate(f);await complete(f,c.id);
  await writeFile(path.join(f.work.repo.candidatePath(c.id),'src/App.tsx'),'export default ()=> <main>Tampered after check</main>;');
  await expect(f.work.adopt(c.id)).rejects.toMatchObject({code:'CHECKS_NOT_PASSED',status:409});
  expect(f.work.getCandidate(c.id).decision).toBe('pending');
},15000);
it('requires regeneration after main advances and does not adopt a formerly green run',async()=>{
  const f=await fixture(),c=await candidate(f);await complete(f,c.id);
  await writeFile(path.join(f.workRoot,'src/Other.tsx'),'export const Other=()=> <aside>New main</aside>;');
  await expect(f.work.adopt(c.id)).rejects.toMatchObject({code:'CHECKS_NOT_PASSED',status:409});
  await expect(f.work.startChecks(c.id)).rejects.toMatchObject({code:'STALE_CANDIDATE',status:409});
  expect(f.work.getCandidate(c.id).decision).toBe('pending');
},15000);
it('refuses adopt when a recorded artifact changes on disk',async()=>{
  const f=await fixture(),c=await candidate(f),run=await complete(f,c.id);
  await writeFile(path.join(f.dataDirectory,'check-artifacts',run.id,'schema.json'),'{"changed":true}');
  await expect(f.work.adopt(c.id)).rejects.toMatchObject({code:'CHECKS_NOT_PASSED',status:409});
  await expect(f.work.readCheckArtifact(run.id,'schema.json')).rejects.toMatchObject({code:'EVIDENCE_CHANGED',status:409});
},15000);
it('cancels an active check before discarding its candidate without a repo-lock deadlock',async()=>{
  const f=await fixture(),c=await candidate(f);
  f.hook(async(name,ctx)=>{if(name==='schema')await new Promise<void>((_resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true}));});
  const run=await start(f,c.id);await vi.waitFor(()=>expect(f.calls).toContain('schema'));
  const original=f.work.repo.removeCandidate.bind(f.work.repo);
  vi.spyOn(f.work.repo,'removeCandidate').mockImplementation(async id=>{expect(f.stopped).toContain(run.id);await original(id);});
  await f.work.discard(c.id);
  expect(f.work.getCheckRun(run.id).status).toBe('cancelled');expect(f.work.getCandidate(c.id).decision).toBe('discarded');
  expect(f.published.some(event=>event.type==='check.finished'&&(event.run as CheckRun)?.outcome==='passed')).toBe(false);
},15000);
it('drains checks before close and refuses later start/cancel without late events',async()=>{
  const f=await fixture(),c=await candidate(f);
  f.hook(async(name,ctx)=>{if(name==='schema')await new Promise<void>((_resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true}));});
  const run=await start(f,c.id);await vi.waitFor(()=>expect(f.calls).toContain('schema'));
  await f.work.close();
  expect(f.stopped).toContain(run.id);
  await expect(f.work.startChecks(c.id)).rejects.toMatchObject({code:'SERVICE_CLOSING'});
  await expect(f.work.cancelCheckRun(run.id)).rejects.toMatchObject({code:'SERVICE_CLOSING'});
  const saved=await readFile(path.join(f.dataDirectory,'tasks.json'),'utf8'),events=JSON.stringify(f.published);
  await f.work.idle();expect(await readFile(path.join(f.dataDirectory,'tasks.json'),'utf8')).toBe(saved);expect(JSON.stringify(f.published)).toBe(events);
},15000);
it('recovers interrupted saved checks as failed without rerunning them',async()=>{
  const f=await fixture(),c=await candidate(f),run=await complete(f,c.id);await f.work.close();
  const file=path.join(f.dataDirectory,'tasks.json'),state=JSON.parse(await readFile(file,'utf8'));
  const stored=state.checkRuns.find((item:CheckRun)=>item.id===run.id);stored.status='running';delete stored.outcome;delete stored.finishedAt;
  stored.checks=stored.checks.map((check:any)=>({name:check.name,status:'not_run'}));
  await writeFile(file,JSON.stringify(state));
  const calls=f.calls.length;f.work=new WorkService(f.options) as IntegratedWork;await f.work.init();stubPreview(f.work);
  expect(f.work.getCheckRun(run.id)).toMatchObject({status:'completed',outcome:'failed',error:{code:'SERVICE_RESTARTED'}});
  expect(f.calls).toHaveLength(calls);
  await expect(f.work.adopt(c.id)).rejects.toMatchObject({code:'CHECKS_NOT_PASSED',status:409});
},15000);
it('migrates missing run storage without trusting legacy candidate green labels',async()=>{
  const f=await fixture(),c=await candidate(f);await f.work.close();
  const file=path.join(f.dataDirectory,'tasks.json'),state=JSON.parse(await readFile(file,'utf8'));delete state.checkRuns;
  state.candidates[0].checks=['schema','build','smoke','occlusion'].map(name=>({name,status:'passed'}));
  await writeFile(file,JSON.stringify(state));
  f.work=new WorkService(f.options) as IntegratedWork;await f.work.init();stubPreview(f.work);
  await expect(f.work.adopt(c.id)).rejects.toMatchObject({code:'CHECKS_NOT_PASSED',status:409});
  expect(f.work.getCandidate(c.id).checks.every(check=>check.status==='not_run')).toBe(true);
},15000);


function mutableSave(work:WorkService){return work as unknown as {save():Promise<void>};}
async function assertFaultRetainsOwnership(f:Awaited<ReturnType<typeof fixture>>){
  await expect(f.work.close()).rejects.toMatchObject({code:'PERSISTENCE_FAILED'});
  const second=new WorkService(f.options);
  await expect(second.init()).rejects.toMatchObject({code:'INSTANCE_LOCKED'});
}
it('reports cleanup failure on cancel and close, rejects new checks and retains the instance lock',async()=>{
  const f=await fixture(),c=await candidate(f);f.allowPoisonedCleanup=true;
  let started!:()=>void;const running=new Promise<void>(resolve=>{started=resolve;});
  f.hook(async(_name,ctx)=>{started();await new Promise<void>(resolve=>ctx.signal.addEventListener('abort',()=>resolve(),{once:true}));});
  f.options.checks.executor.stop=async()=>{throw Object.assign(new Error('injected unconfirmed termination'),{code:'CLEANUP_FAILED',pid:123456789});};
  const run=await f.work.startChecks(c.id);await running;
  await expect(f.work.cancelCheckRun(run.id)).rejects.toMatchObject({code:'CLEANUP_FAILED'});
  expect(f.work.getCheckRun(run.id).outcome).toBe('failed');
  const diagnostic=JSON.parse((await f.work.readCheckArtifact(run.id,'runner.log')).buffer.toString());
  expect(diagnostic).toMatchObject({code:'CLEANUP_FAILED',pid:123456789,exitConfirmed:false});
  await expect(f.work.startChecks(c.id,{rerun:true})).rejects.toMatchObject({code:'CLEANUP_FAILED'});
  await expect(f.work.adopt(c.id)).rejects.toMatchObject({code:'CHECKS_NOT_PASSED'});
  await expect(f.work.close()).rejects.toMatchObject({code:'CLEANUP_FAILED'});
  const second=new WorkService(f.options);await expect(second.init()).rejects.toMatchObject({code:'INSTANCE_LOCKED'});
},15000);
it('does not execute or emit when the check start save fails and retains ownership',async()=>{
  const f=await fixture(),c=await candidate(f);f.allowPoisonedCleanup=true;
  const published=f.published.length;
  vi.spyOn(mutableSave(f.work),'save').mockRejectedValueOnce(new Error('injected initial check save failure'));
  await expect(f.work.startChecks(c.id)).rejects.toMatchObject({code:'PERSISTENCE_FAILED'});
  expect(f.calls).toEqual([]);expect(f.published).toHaveLength(published);
  expect(JSON.parse(await readFile(path.join(f.dataDirectory,'tasks.json'),'utf8')).checkRuns).toEqual([]);
  await expect(f.work.adopt(c.id)).rejects.toMatchObject({code:'CHECKS_NOT_PASSED'});
  await assertFaultRetainsOwnership(f);
},15000);
it('withholds green state and events when the terminal save fails',async()=>{
  const f=await fixture(),c=await candidate(f);f.allowPoisonedCleanup=true;
  const original=mutableSave(f.work).save.bind(f.work);let failed=false;
  vi.spyOn(mutableSave(f.work),'save').mockImplementation(async()=>{
    const state=Reflect.get(f.work,'state') as {checkRuns:CheckRun[]};
    if(!failed&&state.checkRuns.some(run=>run.status==='completed'&&run.outcome==='passed')){failed=true;throw new Error('injected terminal check save failure');}
    await original();
  });
  const run=await f.work.startChecks(c.id);
  await vi.waitFor(()=>expect(f.work.getCheckRun(run.id).error?.code).toBe('PERSISTENCE_FAILED'),{timeout:5000});
  expect(failed).toBe(true);
  expect(f.work.getCandidate(c.id).checks.every(check=>check.status!=='passed')).toBe(true);
  expect(f.published.some(event=>event.type==='check.finished'&&(event.run as CheckRun).outcome==='passed')).toBe(false);
  expect(JSON.parse(await readFile(path.join(f.dataDirectory,'tasks.json'),'utf8')).checkRuns.find((r:CheckRun)=>r.id===run.id).status).not.toBe('completed');
  await expect(f.work.adopt(c.id)).rejects.toMatchObject({code:'CHECKS_NOT_PASSED'});
  expect(f.stopped).toContain(run.id);await assertFaultRetainsOwnership(f);
},15000);
it('blocks adoption and retains the lock when check publication fails after saving',async()=>{
  const f=await fixture(),c=await candidate(f);f.allowPoisonedCleanup=true;
  const emit=f.options.emit;
  f.options.emit=event=>{if(event.type==='check.finished')throw new Error('injected event journal failure');return emit(event);};
  const run=await f.work.startChecks(c.id);
  await vi.waitFor(()=>expect(f.work.getCheckRun(run.id).error?.code).toBe('PERSISTENCE_FAILED'),{timeout:5000});
  expect(f.work.getCandidate(c.id).checks.every(check=>check.status!=='passed')).toBe(true);
  await expect(f.work.adopt(c.id)).rejects.toMatchObject({code:'CHECKS_NOT_PASSED'});
  expect(f.stopped).toContain(run.id);await assertFaultRetainsOwnership(f);
},15000);
it.each(['candidate','evidence'])('rejects completion when %s changes after execution but before publication',async(kind)=>{
  const f=await fixture(),c=await candidate(f),stop=f.options.checks.executor.stop!;
  f.options.checks.executor.stop=async id=>{
    await stop(id);
    await writeFile(kind==='candidate'?path.join(f.work.repo.candidatePath(c.id),'src/App.tsx'):path.join(f.dataDirectory,'check-artifacts',id,'schema.json'),
      kind==='candidate'?'export default ()=> <main>Changed after execution</main>;':'{"changedAfterExecution":true}');
  };
  const run=await complete(f,c.id);
  expect(run.status).toBe('completed');expect(run.outcome).toBe('failed');expect(run.error?.code).not.toBe('PERSISTENCE_FAILED');
  expect(f.published.some(event=>event.type==='check.finished'&&(event.run as CheckRun).outcome==='passed')).toBe(false);
  const saved=JSON.parse(await readFile(path.join(f.dataDirectory,'tasks.json'),'utf8')).checkRuns.find((r:CheckRun)=>r.id===run.id);
  expect(saved.outcome).toBe('failed');
  await expect(f.work.adopt(c.id)).rejects.toMatchObject({code:'CHECKS_NOT_PASSED'});
},15000);
it('uses the latest failed rerun instead of falling back to an older green result',async()=>{
  const f=await fixture(),c=await candidate(f),passed=await complete(f,c.id);
  expect(passed.outcome).toBe('passed');
  f.options.checks.executor.schema=async ctx=>{
    const ref=await ctx.writeArtifact('schema.json','{"fixtureFailure":true}');
    return {name:'schema',status:'failed',evidence:ref.hash,message:'fixture check failure'};
  };
  const rerun=await f.work.startChecks(c.id,{rerun:true});expect(rerun.id).not.toBe(passed.id);
  await vi.waitFor(()=>expect(f.work.getCheckRun(rerun.id).status).toBe('completed'),{timeout:5000});
  expect(f.work.getCheckRun(rerun.id).outcome).toBe('failed');
  expect(f.work.getCandidate(c.id).latestCheckRunId).toBe(rerun.id);
  await expect(f.work.adopt(c.id)).rejects.toMatchObject({code:'CHECKS_NOT_PASSED'});
},15000);
it('serializes check execution across candidates and releases resources before starting the next',async()=>{
  const f=await fixture(),a=await candidate(f),b=await candidate(f);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const schemas:string[]=[];
  f.hook(async(name,ctx)=>{if(name==='schema'){schemas.push(ctx.runId);if(schemas.length===1)await gate;else expect(f.stopped).toContain(schemas[0]);}});
  try{
    const first=await f.work.startChecks(a.id),second=await f.work.startChecks(b.id);
    await vi.waitFor(()=>expect(schemas).toEqual([first.id]));
    expect(f.work.getCheckRun(second.id).status).toBe('queued');release();
    await vi.waitFor(()=>expect(f.work.getCheckRun(second.id).status).toBe('completed'),{timeout:10000});
    expect(f.work.getCheckRun(first.id).outcome).toBe('passed');expect(f.work.getCheckRun(second.id).outcome).toBe('passed');
  }finally{release();}
},20000);
it('trims an actively checked oldest candidate only after cancellation and cleanup',async()=>{
  const f=await fixture(),first=await candidate(f);
  f.hook(async(name,ctx)=>{if(name==='schema')await new Promise<void>((_resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true}));});
  const run=await f.work.startChecks(first.id);await vi.waitFor(()=>expect(f.calls).toContain('schema'));
  const original=f.work.repo.removeCandidate.bind(f.work.repo);
  vi.spyOn(f.work.repo,'removeCandidate').mockImplementation(async id=>{if(id===first.id)expect(f.stopped).toContain(run.id);await original(id);});
  for(let i=0;i<3;i++)await candidate(f);
  expect(f.work.getCandidate(first.id).decision).toBe('discarded');expect(f.work.getCheckRun(run.id).status).toBe('cancelled');
  expect(await f.work.repo.candidateExists(first.id)).toBe(false);
  expect(f.work.listCandidates().filter(c=>c.decision==='pending')).toHaveLength(3);
},20000);
it('does not expose an uncommitted terminal run while its durable save is blocked',async()=>{
  const f=await fixture(),c=await candidate(f);
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),atSave=new Promise<void>(resolve=>{entered=resolve;});
  const original=mutableSave(f.work).save.bind(f.work);
  vi.spyOn(mutableSave(f.work),'save').mockImplementation(async()=>{
    const state=Reflect.get(f.work,'state') as {checkRuns:CheckRun[]};
    if(state.checkRuns.some(run=>run.status==='completed'&&run.outcome==='passed')){entered();await gate;}
    await original();
  });
  try{
    const run=await f.work.startChecks(c.id);await atSave;
    expect(f.work.getCheckRun(run.id).status).toBe('running');
    const saved=JSON.parse(await readFile(path.join(f.dataDirectory,'tasks.json'),'utf8')).checkRuns.find((r:CheckRun)=>r.id===run.id);
    expect(saved.status).toBe('running');expect(f.published.some(event=>event.type==='check.finished')).toBe(false);
    release();await vi.waitFor(()=>expect(f.work.getCheckRun(run.id).outcome).toBe('passed'),{timeout:5000});
  }finally{release();}
},15000);

