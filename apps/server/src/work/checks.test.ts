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
const owned:{directory:string;work:IntegratedWork}[]=[];
afterEach(async()=>{
  vi.restoreAllMocks();
  for(const f of owned.splice(0)){await f.work.close();await rm(f.directory,{recursive:true,force:true});}
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
  const f={directory,workRoot,dataDirectory,options,calls,stopped,published,durableEvents,work:new WorkService(options) as IntegratedWork,
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

