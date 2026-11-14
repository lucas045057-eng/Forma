import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type AppOptions } from '../app.ts';
import { CodingAgent } from '../agent/client.ts';
import type { CheckContext, CheckExecutor } from './runner.ts';
import type { CheckRun } from '@spatial/shared';
import type { WorkServiceOptions } from '../work/service.ts';
import { acquireInstanceLock } from '../assets/instance-lock.ts';
import { listenForFetch } from '../test-support/fetch-listener.ts';

const owned:{directory:string;instance:Awaited<ReturnType<typeof createApp>>}[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const f of owned.splice(0)){await f.instance.app.close();await rm(f.directory,{recursive:true,force:true});}});
async function fixture(){
  const directory=await mkdtemp(path.join(tmpdir(),'m3b-check-api-')),workRoot=path.join(directory,'work'),workDataDirectory=path.join(directory,'work-data');
  await mkdir(path.join(workRoot,'src'),{recursive:true});
  await writeFile(path.join(workRoot,'src/App.tsx'),'export default ()=> <main>Baseline</main>;\n');
  await writeFile(path.join(workRoot,'src/scene.config.json'),await readFile(new URL('../../../../templates/product-page/src/scene.config.json',import.meta.url)));
  vi.spyOn(CodingAgent.prototype,'run').mockImplementation(async({root})=>{
    await writeFile(path.join(root,'src/App.tsx'),'export default ()=> <main>Candidate</main>;\n');
    return {summary:'local mock edit',written:['src/App.tsx']};
  });
  const calls:string[]=[];let hook:((name:string,ctx:CheckContext)=>Promise<void>)|undefined;
  const phase=(name:'schema'|'build'|'smoke'|'occlusion')=>async(ctx:CheckContext)=>{
    calls.push(name);await hook?.(name,ctx);ctx.signal.throwIfAborted();
    if(name==='smoke'||name==='occlusion')await ctx.writeArtifact(name+'.png',Buffer.from('89504e470d0a1a0a','hex'));
    const ref=await ctx.writeArtifact(name==='build'?'build.log':name+'.json',name==='build'?'<script>TEST_ONLY_LOG_MARKUP</script>':JSON.stringify({fixture:true,name}));
    return {name,status:'passed' as const,evidence:ref.hash};
  };
  const executor:CheckExecutor={schema:phase('schema'),build:phase('build'),smoke:phase('smoke'),occlusion:phase('occlusion'),stop:async()=>{}};
  const options:AppOptions & {checks:NonNullable<WorkServiceOptions['checks']>}={
    workRoot,workDataDirectory,dataDirectory:path.join(directory,'assets'),historyDirectory:path.join(directory,'history'),
    base:'http://127.0.0.1:1',key:'mock-only',codingAgentBaseUrl:'http://127.0.0.1:1',codingAgentApiKey:'mock-only',codingAgentModel:'mock',
    checks:{executor,toolIdentity:'http-unit-trusted-tools'},
  };
  const instance=await createApp(options);owned.push({directory,instance});
  instance.work.previews.start=async id=>'/preview/c/'+id+'/';instance.work.previews.stop=async()=>{};instance.work.previews.stopAll=async()=>{};
  return {directory,instance,workRoot,workDataDirectory,calls,hook:(value:typeof hook)=>{hook=value;}};
}
async function candidate(f:Awaited<ReturnType<typeof fixture>>,selected=true){
  const baseVersion=(await f.instance.work.version()).version;
  const task=await f.instance.work.submit('local edit',selected?{src:'src/App.tsx:1:1',baseVersion,cid:'App',bbox:[0,0,1,1],styles:{} as any,instances:1,ancestors:[]}:undefined);
  await f.instance.work.idle();
  expect(f.instance.work.getTask(task.id).status).toBe(selected?'done':'awaiting_approval');
  return task.id;
}
async function start(f:Awaited<ReturnType<typeof fixture>>,id:string){
  const response=await f.instance.app.inject({method:'POST',url:'/candidates/'+id+'/checks'});
  expect(response.statusCode,response.body).toBe(202);return response.json() as CheckRun;
}
async function completed(f:Awaited<ReturnType<typeof fixture>>,id:string){
  const run=await start(f,id);
  await vi.waitFor(async()=>{
    const response=await f.instance.app.inject('/checks/'+run.id);expect(response.statusCode,response.body).toBe(200);
    expect(response.json().status).toBe('completed');
  },{timeout:8000,interval:25});
  return (await f.instance.app.inject('/checks/'+run.id)).json() as CheckRun;
}
it('exposes fixed check endpoints and serves hash-verified artifacts with safe headers',async()=>{
  const f=await fixture(),id=await candidate(f),app=f.instance.app;
  expect((await app.inject({method:'POST',url:'/candidates/'+id+'/adopt'})).statusCode).toBe(409);
  const run=await completed(f,id);expect(run.outcome).toBe('passed');expect(f.calls).toEqual(['schema','build','smoke','occlusion']);
  expect((await start(f,id)).id).toBe(run.id);
  for(const name of ['schema.json','build.log','smoke.png']){
    const result=await app.inject('/checks/'+run.id+'/artifacts/'+name);
    expect(result.statusCode,result.body).toBe(200);expect(result.headers['cache-control']).toBe('no-store');
    expect(result.headers['x-content-type-options']).toBe('nosniff');
    expect(String(result.headers['content-type'])).toMatch(name.endsWith('.json')?/application\/json/:name.endsWith('.png')?/image\/png/:/text\/plain/);
    if(name==='build.log')expect(result.body).toContain('<script>TEST_ONLY_LOG_MARKUP</script>');
  }
  expect((await app.inject('/checks/unknownrun')).statusCode).toBe(404);
  expect((await app.inject('/checks/'+run.id+'/artifacts/unknown.txt')).statusCode).toBe(404);
  expect((await app.inject('/checks/'+run.id+'/artifacts/..%2F..%2Ftasks.json')).statusCode).toBe(404);
  await writeFile(path.join(f.workDataDirectory,'check-artifacts',run.id,'schema.json'),'{"tampered":true}');
  const changed=await app.inject('/checks/'+run.id+'/artifacts/schema.json');
  expect(changed.statusCode).toBe(409);expect(changed.json().error.code).toBe('EVIDENCE_CHANGED');
  expect((await app.inject({method:'POST',url:'/candidates/'+id+'/adopt',payload:{force:true}})).statusCode).toBe(409);
},20000);
it('rejects raw coercions and extra fields before admission and applies Host Origin and private-staging guards',async()=>{
  const f=await fixture(),id=await candidate(f),app=f.instance.app,url='/candidates/'+id+'/checks';
  for(const value of [null,[],true,1,{rerun:'true'},{rerun:1},{rerun:null},{rerun:false,executor:'untrusted'},{contentDigest:'forged'},{buildTimeoutMs:999999}]){
    const response=await app.inject({method:'POST',url,headers:{'content-type':'application/json'},payload:JSON.stringify(value)});
    expect(response.statusCode,response.body).toBe(400);
  }
  expect(f.calls).toEqual([]);
  expect((await app.inject({method:'POST',url,headers:{host:'attacker.invalid'}})).statusCode).toBe(403);
  expect((await app.inject({method:'POST',url,headers:{origin:'http://attacker.invalid'}})).statusCode).toBe(403);
  const privateId=await candidate(f,false);
  expect((await app.inject({method:'POST',url:'/candidates/'+privateId+'/checks'})).statusCode).toBe(404);
  const run=await completed(f,id);expect(run.outcome).toBe('passed');
  const rerun=await app.inject({method:'POST',url,payload:{rerun:true}});
  expect(rerun.statusCode,rerun.body).toBe(202);expect(rerun.json().id).not.toBe(run.id);
},20000);
it('cancels exactly the addressed run and rejects cancel body overrides before mutating it',async()=>{
  const f=await fixture(),id=await candidate(f),app=f.instance.app;
  f.hook(async(name,ctx)=>{if(name==='schema')await new Promise<void>((_resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true}));});
  const run=await start(f,id);await vi.waitFor(()=>expect(f.calls).toContain('schema'));
  const url='/checks/'+run.id+'/cancel';
  expect((await app.inject({method:'POST',url,payload:{candidateId:id}})).statusCode).toBe(400);
  expect((await app.inject('/checks/'+run.id)).json().status).toBe('running');
  const response=await app.inject({method:'POST',url});
  expect(response.statusCode,response.body).toBe(200);expect(response.json().status).toBe('cancelled');
  expect((await app.inject({method:'POST',url})).json().status).toBe('cancelled');
  expect((await app.inject({method:'POST',url:'/checks/unknownrun/cancel'})).statusCode).toBe(404);
  expect(f.instance.work.getCandidate(id).decision).toBe('pending');
},15000);
it('drains an admitted real HTTP check cancellation before closing the event journal and releasing its lock',async()=>{
  const f=await fixture(),id=await candidate(f);
  f.hook(async(name,ctx)=>{if(name==='schema')await new Promise<void>((_resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(ctx.signal.reason),{once:true}));});
  const {baseUrl}=await listenForFetch(()=>({listen:(options:{host:string;port:number})=>f.instance.app.listen(options),close:()=>f.instance.app.close()}));
  const startResponse=await fetch(baseUrl+'/candidates/'+id+'/checks',{method:'POST',headers:{connection:'close'}});
  expect(startResponse.status).toBe(202);const run=await startResponse.json() as CheckRun;
  await vi.waitFor(()=>expect(f.calls).toContain('schema'));
  let release!:()=>void,admitted!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),atHandler=new Promise<void>(resolve=>{admitted=resolve;});
  const original=f.instance.work.cancelCheckRun.bind(f.instance.work);
  vi.spyOn(f.instance.work,'cancelCheckRun').mockImplementation(async runId=>{admitted();await gate;return original(runId);});
  let closing:Promise<void>|undefined;
  try{
    const response=fetch(baseUrl+'/checks/'+run.id+'/cancel',{method:'POST',headers:{connection:'close'}});await atHandler;
    let closed=false;closing=f.instance.app.close().then(()=>{closed=true;});
    await expect(acquireInstanceLock(f.workDataDirectory)).rejects.toMatchObject({code:'INSTANCE_LOCKED'});
    expect(closed).toBe(false);release();
    const cancelled=await response;expect(cancelled.status).toBe(200);expect((await cancelled.json() as CheckRun).status).toBe('cancelled');
    await closing;
    const saved=await readFile(path.join(f.workDataDirectory,'tasks.json'),'utf8'),journal=await readFile(path.join(f.workDataDirectory,'events.jsonl'),'utf8');
    expect(JSON.parse(saved).checkRuns.find((item:CheckRun)=>item.id===run.id).status).toBe('cancelled');
    expect(journal.split('\n').filter(Boolean).map(line=>JSON.parse(line)).some(event=>event.type==='check.finished'&&event.run.id===run.id&&event.run.status==='cancelled')).toBe(true);
    await f.instance.work.idle();expect(await readFile(path.join(f.workDataDirectory,'tasks.json'),'utf8')).toBe(saved);
    expect(await readFile(path.join(f.workDataDirectory,'events.jsonl'),'utf8')).toBe(journal);
    const unlock=await acquireInstanceLock(f.workDataDirectory);await unlock();
  }finally{release();await closing;}
},20000);

