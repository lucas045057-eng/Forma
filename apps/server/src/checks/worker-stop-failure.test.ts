import cp, { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createRealExecutor } from './worker.ts';
import { copyAudited } from './snapshot.ts';
import { writeArtifact } from './artifacts.ts';
import type { CheckContext } from './runner.ts';

// No OS process is started/killed. Only the trusted child_process transport is replaced.
it.each(['denied','no-exit','command-hung'])('rejects stop within a bound when forced termination is %s, without pretending exit',async(mode)=>{
  const dir=await mkdtemp(path.join(tmpdir(),'m3b-stop-failure-'));
  const child=Object.assign(new EventEmitter(),{pid:123456789,stdout:new PassThrough(),stderr:new PassThrough(),exitCode:null,signalCode:null,
    send:(message:{kind:string;token?:number;name?:string})=>{
      if(message.kind==='run')queueMicrotask(()=>child.emit('message',{kind:'result',requestToken:message.token,result:{name:message.name,status:'failed',message:'transport fixture'}}));
      return true;
    }}) as unknown as ChildProcess;
  let stopping:Promise<void>|undefined,settlement='pending',failure:unknown;
  try{
    const candidate=path.join(dir,'candidate');await mkdir(path.join(candidate,'src'),{recursive:true});
    await writeFile(path.join(candidate,'src/main.tsx'),'export {};');
    const buildRoot=path.join(dir,'snapshot'),snapshot=await copyAudited(candidate,buildRoot);
    const ctx:CheckContext={runId:'a'.repeat(32),candidateRoot:candidate,buildRoot,snapshot,signal:new AbortController().signal,
      buildTimeoutMs:120000,browserTimeoutMs:30000,artifactsDir:dir,writeArtifact:(name,data)=>writeArtifact(dir,ctx.runId,name,data)};
    vi.spyOn(cp,'spawn').mockImplementation((()=>{queueMicrotask(()=>child.emit('message',{kind:'ready'}));return child;}) as typeof cp.spawn);
    const kill=vi.spyOn(cp,'execFile').mockImplementation(((...args:unknown[])=>{
      const callback=args.at(-1) as (error:Error|null,stdout:string,stderr:string)=>void;
      if(mode!=='command-hung')queueMicrotask(()=>callback(mode==='denied'?Object.assign(new Error('injected taskkill denied'),{code:'EACCES'}):null,'',''));
      return new EventEmitter();
    }) as typeof cp.execFile);
    syncBuiltinESMExports();
    const executor=createRealExecutor();expect((await executor.schema(ctx)).status).toBe('failed');
    vi.useFakeTimers();
    stopping=executor.stop!(ctx.runId);
    void stopping.then(()=>{settlement='resolved';},error=>{settlement='rejected';failure=error;});
    await vi.advanceTimersByTimeAsync(12000);
    expect(kill).toHaveBeenCalled();
    expect(settlement,'failed taskkill or a successful command without child exit must settle explicitly').toBe('rejected');
    expect(failure).toMatchObject({code:'CLEANUP_FAILED',pid:123456789,exitConfirmed:false,spawnedAt:expect.any(String)});
    expect(child.exitCode).toBeNull();expect(child.signalCode).toBeNull();
    await expect(executor.stop!(ctx.runId)).rejects.toMatchObject({code:'CLEANUP_FAILED'});
  }finally{
    child.emit('close',0,null);await stopping?.catch(()=>{});
    vi.useRealTimers();vi.restoreAllMocks();syncBuiltinESMExports();
    await rm(dir,{recursive:true,force:true});
  }
},15000);
