import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { CodingAgent } from '../agent/client.ts';
import { createApp } from '../app.ts';
import type { CheckRun } from '@spatial/shared';

it('uses the default real checks through HTTP before adopting and reverting the actual template',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'m3b-real-service-')),workRoot=path.join(directory,'work'),data=path.join(directory,'data');
  await mkdir(workRoot);
  await cp(new URL('../../../../templates/product-page/src/',import.meta.url),path.join(workRoot,'src'),{recursive:true});
  const baseline=await readFile(path.join(workRoot,'src/App.tsx'),'utf8');
  const agent=vi.spyOn(CodingAgent.prototype,'run').mockImplementation(async({root})=>{
    const file=path.join(root,'src/App.tsx'),source=await readFile(file,'utf8'),changed=source.replace('给生活，','给生活一点松弛，');
    expect(changed).not.toBe(source);await writeFile(file,changed);
    return {summary:'mock one local heading edit',written:['src/App.tsx']};
  });
  let instance:Awaited<ReturnType<typeof createApp>>|undefined;
  let workflow:object={started:true};
  try{
    // No checks.executor/toolIdentity override: schema, compiler and Chromium are real.
    instance=await createApp({workRoot,workDataDirectory:data,dataDirectory:path.join(directory,'assets'),historyDirectory:path.join(directory,'history'),
      base:'http://127.0.0.1:1',key:'mock-only',codingAgentBaseUrl:'http://127.0.0.1:1',codingAgentApiKey:'mock-only',codingAgentModel:'mock'});
    const {app,work}=instance;
    // Existing M2 dev-preview lifecycle is independently tested; this exercises the new static check origin.
    work.previews.start=async id=>'/preview/c/'+id+'/';work.previews.stop=async()=>{};work.previews.stopAll=async()=>{};
    const baseVersion=(await app.inject('/version')).json().version;
    const created=await app.inject({method:'POST',url:'/tasks',payload:{instruction:'只修改当前标题',selection:{
      src:'src/App.tsx:1:1',baseVersion,cid:'App',bbox:[0,0,1,1],styles:{},instances:1,ancestors:[],
    }}});
    expect(created.statusCode,created.body).toBe(202);const candidateId=created.json().id;
    await work.idle();expect(work.getTask(candidateId).status,JSON.stringify(work.getTask(candidateId).error)).toBe('done');
    expect((await app.inject({method:'POST',url:'/candidates/'+candidateId+'/adopt'})).statusCode).toBe(409);
    const start=await app.inject({method:'POST',url:'/candidates/'+candidateId+'/checks'});
    expect(start.statusCode,start.body).toBe(202);const runId=start.json().id;
    await vi.waitFor(async()=>{
      const response=await app.inject('/checks/'+runId);expect(response.statusCode,response.body).toBe(200);
      expect(['completed','cancelled']).toContain(response.json().status);
    },{timeout:45000,interval:50});
    const run=(await app.inject('/checks/'+runId)).json() as CheckRun;
    workflow={candidateId,runId,run};
    expect(run.outcome,JSON.stringify(run)).toBe('passed');
    expect(run.checks.map(check=>[check.name,check.status])).toEqual([['schema','passed'],['build','passed'],['smoke','passed'],['occlusion','passed']]);
    expect(run.artifacts!.map(ref=>ref.name).sort()).toEqual(['schema.json','build.log','smoke.json','smoke.png','occlusion.json','occlusion.png'].sort());
    const smoke=await app.inject('/checks/'+runId+'/artifacts/smoke.json');
    expect(smoke.statusCode).toBe(200);expect(smoke.json()).toMatchObject({status:'passed',viewport:{width:1440,height:900},scene:{state:'fallback',placeholderVisible:true},purchases:{before:0,after:1},pageErrors:[],blockedRequests:[]});
    expect(smoke.json().browserVersion).toBeTypeOf('string');
    const image=await app.inject('/checks/'+runId+'/artifacts/smoke.png');expect(image.rawPayload.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
    await expect(fetch(smoke.json().url)).rejects.toBeDefined();
    await expect(stat(path.join(data,'check-builds',runId))).rejects.toMatchObject({code:'ENOENT'});
    const adopted=await app.inject({method:'POST',url:'/candidates/'+candidateId+'/adopt'});
    expect(adopted.statusCode,adopted.body).toBe(200);expect(adopted.json().version).not.toBe(baseVersion);
    expect(await readFile(path.join(workRoot,'src/App.tsx'),'utf8')).toContain('给生活一点松弛，');
    const reverted=await app.inject({method:'POST',url:'/version/revert'});expect(reverted.statusCode,reverted.body).toBe(200);
    expect(await readFile(path.join(workRoot,'src/App.tsx'),'utf8')).toBe(baseline);
    expect(agent).toHaveBeenCalledTimes(1);
    workflow={candidateId,runId,run,adopted:adopted.json(),reverted:reverted.json(),modelCalls:agent.mock.calls.length};
  }finally{
    await instance?.app.close();agent.mockRestore();
    if(process.env.CHECK_REAL_EVIDENCE_DIR){
      const target=path.join(process.env.CHECK_REAL_EVIDENCE_DIR,'default-real-service');await mkdir(target,{recursive:true});
      await writeFile(path.join(target,'workflow.json'),JSON.stringify(workflow,null,2));
      for(const name of ['tasks.json','events.jsonl','check-artifacts']){
        await cp(path.join(data,name),path.join(target,name),{recursive:true}).catch(error=>{if(error.code!=='ENOENT')throw error;});
      }
    }
    await rm(directory,{recursive:true,force:true});
  }
},60000);

