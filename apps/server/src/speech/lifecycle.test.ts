import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { createApp } from '../app.ts';
import { listenHttpForFetch } from '../test-support/fetch-listener.ts';
const audio=Buffer.from([0x1a,0x45,0xdf,0xa3,1]);

function post(origin:string,id:string) {
 const request=httpRequest(`${origin}/speech/transcribe`,{method:'POST',headers:{'content-type':'audio/webm','x-speech-request-id':id,'content-length':audio.length}});
 const result=new Promise<{status?:number;text?:string;aborted?:boolean}>((resolve,reject)=>{
  request.once('error',(error:NodeJS.ErrnoException)=>error.code==='ECONNRESET'?resolve({aborted:true}):reject(error));
  request.once('response',response=>{let text='';response.on('data',chunk=>{text+=chunk;});response.once('end',()=>resolve({status:response.statusCode,text}));response.once('error',reject);});
 });
 request.end(audio);return {request,result};
}
async function fixture() {
 const root=await mkdtemp(path.join(tmpdir(),'speech-lifecycle-'));
 let respond!:()=>void;let interrupt!:()=>void;let received!:()=>void;let calls=0;
 const ready=new Promise<void>(resolve=>{received=resolve;});
 const interrupted=new Promise<void>(resolve=>{interrupt=resolve;});
 const upstream=await listenHttpForFetch((request,response)=>{
  ++calls;request.resume();request.once('end',()=>{
   response.writeHead(200,{'content-type':'application/json'});response.flushHeaders();
   respond=()=>response.end(JSON.stringify({choices:[{message:{content:'成功'}}]}));
   response.once('close',()=>{if(!response.writableFinished) interrupt();});received();
  });
 });
 let instance: Awaited<ReturnType<typeof createApp>> | undefined;
 try {
  const workRoot=path.join(root,'work');await mkdir(path.join(workRoot,'src'),{recursive:true});await writeFile(path.join(workRoot,'src/app.ts'),'export const value=1;');
  instance=await createApp({workRoot,workDataDirectory:path.join(root,'data'),dataDirectory:path.join(root,'assets'),historyDirectory:path.join(root,'history'),base:'http://127.0.0.1:9',key:'mock-only',
   speech:{baseUrl:`${upstream.baseUrl}/compatible-mode/v1`,apiKey:'speech-fake-only',testLoopback:true}});
  const owner=instance;
  const origin=await owner.app.listen({host:'127.0.0.1',port:0});
  return {...owner,origin,ready,interrupted,get calls(){return calls;},respond:()=>respond(),async dispose(){
   const errors:unknown[]=[];
   try {await owner.app.close();} catch(error){errors.push(error);}
   try {upstream.server.closeAllConnections();if(upstream.server.listening)await new Promise<void>((resolve,reject)=>upstream.server.close(error=>error?reject(error):resolve()));expect(upstream.server.listening).toBe(false);expect(owner.app.server.listening).toBe(false);}
   catch(error){errors.push(error);}
   if(!errors.length) {try {await rm(root,{recursive:true,force:true});}catch(error){errors.push(error);}}
   if(process.env.D1_RUN_DIR)await writeFile(path.join(process.env.D1_RUN_DIR,`${path.basename(root)}-cleanup.json`),JSON.stringify({pid:process.pid,at:new Date().toISOString(),origin,upstream:upstream.baseUrl,appListening:owner.app.server.listening,upstreamListening:upstream.server.listening,calls,retainedDirectory:errors.length?root:null,errors:errors.map(String)},null,2));
   if(errors.length)throw new AggregateError(errors,'Speech lifecycle cleanup failed; fixture retained');
  }};
 } catch(error) {
  try {await instance?.app.close();}
  finally {try {upstream.server.closeAllConnections();if(upstream.server.listening)await new Promise<void>((resolve,reject)=>upstream.server.close(cause=>cause?reject(cause):resolve()));}
   finally {await rm(root,{recursive:true,force:true});}}
  throw error;
 }
}
it('real duplicate HTTP consumers: one disconnect keeps the other alive and normal close stays completed',async()=>{
 const f=await fixture();const id=randomUUID();const join=vi.spyOn(f.speech,'join');
 const a=post(f.origin,id);const b=post(f.origin,id);
 try {
  await f.ready;await vi.waitFor(()=>expect(join).toHaveBeenCalledTimes(2));
  a.request.destroy();await a.result;
  expect(f.calls).toBe(1);f.respond();
  const answer=await b.result;expect(answer.status).toBe(200);expect(JSON.parse(answer.text!).text).toBe('成功');
  expect(await f.speech.cancel(id)).toEqual({requestId:id,status:'completed'});
 } finally {a.request.destroy();b.request.destroy();await f.dispose();}
},10_000);
it('real last HTTP disconnect aborts the shared upstream transport',async()=>{
 const f=await fixture();const id=randomUUID();const join=vi.spyOn(f.speech,'join');const a=post(f.origin,id);const b=post(f.origin,id);
 try {
  await f.ready;await vi.waitFor(()=>expect(join).toHaveBeenCalledTimes(2));a.request.destroy();b.request.destroy();
  await Promise.all([a.result,b.result]);await f.interrupted;
  expect(f.calls).toBe(1);expect(await f.speech.cancel(id)).toEqual({requestId:id,status:'cancelled'});
 } finally {a.request.destroy();b.request.destroy();await f.dispose();}
},10_000);
it('real DELETE cancels both HTTP consumers without changing the cancellation terminal',async()=>{
 const f=await fixture();const id=randomUUID();const join=vi.spyOn(f.speech,'join');const a=post(f.origin,id);const b=post(f.origin,id);
 try {
  await f.ready;await vi.waitFor(()=>expect(join).toHaveBeenCalledTimes(2));
  const deleted=await new Promise<{status?:number;body:string}>((resolve,reject)=>{
   const request=httpRequest(`${f.origin}/speech/transcribe/${id}`,{method:'DELETE'},response=>{
    let body='';response.on('data',chunk=>{body+=chunk;});response.once('error',reject);response.once('end',()=>resolve({status:response.statusCode,body}));
   });request.once('error',reject);request.end();
  });
  expect(deleted.status).toBe(200);expect(JSON.parse(deleted.body)).toEqual({requestId:id,status:'cancelled'});
  await f.interrupted;
  for(const result of await Promise.all([a.result,b.result])) {expect(result.status).toBe(499);expect(JSON.parse(result.text!).error.code).toBe('SPEECH_CANCELLED');}
  expect(f.calls).toBe(1);
 } finally {a.request.destroy();b.request.destroy();await f.dispose();}
},10_000);
it('real preClose interrupts response reading instead of waiting the production 35 second budget',async()=>{
 const f=await fixture();const pending=post(f.origin,randomUUID());
 try {
  await f.ready;const started=performance.now();await f.app.close();
  expect(performance.now()-started).toBeLessThan(5_000);await f.interrupted;
  const response=await pending.result;expect(response.status).toBe(499);expect(JSON.parse(response.text!).error.code).toBe('SPEECH_CANCELLED');
  expect(f.app.server.listening).toBe(false);
 } finally {pending.request.destroy();await f.dispose();}
},10_000);
