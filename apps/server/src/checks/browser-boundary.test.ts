import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createRealExecutor } from './worker.ts';
import { copyAudited } from './snapshot.ts';
import { readArtifact, writeArtifact } from './artifacts.ts';
import type { CheckContext, CheckExecutor } from './runner.ts';
import { listenHttpForFetch } from '../test-support/fetch-listener.ts';

const owned:{directory:string;ctx:CheckContext;executor:CheckExecutor;controller:AbortController}[]=[];
const traps:Awaited<ReturnType<typeof listenHttpForFetch>>[]=[];
afterEach(async()=>{
  for(const f of owned.splice(0)){f.controller.abort();await f.executor.stop?.(f.ctx.runId);await rm(f.directory,{recursive:true,force:true});}
  for(const trap of traps.splice(0)){trap.server.closeAllConnections();await new Promise<void>(resolve=>trap.server.close(()=>resolve()));}
});
function app(options:{effect?:string;buy?:string;extra?:string;scene?:string}={}){
  return `import {useEffect,useState} from 'react';
export default function App(){const [count,setCount]=useState(0);const [feedback,setFeedback]=useState('');
useEffect(()=>{${options.effect??''}},[]);
return <main><h1>Browser fixture</h1>
<div data-testid="product-scene" data-state="fallback">${options.scene??'<div data-testid="product-placeholder">Visible product fallback</div>'}</div>
<button data-testid="buy-button" onClick={()=>{${options.buy??"setCount(c=>c+1);setFeedback('Added');"}}}>Buy</button>
<output data-testid="action-status" data-purchases={count}>{feedback}</output>
${options.extra??''}</main>}`;
}
async function fixture(source=app(),realTemplate=false){
  const directory=await mkdtemp(path.join(tmpdir(),'m3b-browser-'));
  const candidateRoot=path.join(directory,'candidate');await mkdir(path.join(candidateRoot,'src'),{recursive:true});
  if(realTemplate)await cp(new URL('../../../../templates/product-page/src/',import.meta.url),path.join(candidateRoot,'src'),{recursive:true});
  else{
    await writeFile(path.join(candidateRoot,'src/main.tsx'),"import {createRoot} from 'react-dom/client';import App from './App';createRoot(document.getElementById('root')!).render(<App/>);");
    await writeFile(path.join(candidateRoot,'src/App.tsx'),source);
    await writeFile(path.join(candidateRoot,'src/scene.config.json'),await readFile(new URL('../../../../templates/product-page/src/scene.config.json',import.meta.url)));
  }
  const buildRoot=path.join(directory,'snapshot'),snapshot=await copyAudited(candidateRoot,buildRoot),controller=new AbortController();
  const executor=createRealExecutor();
  const ctx:CheckContext={runId:randomUUID().replaceAll('-',''),candidateRoot,buildRoot,snapshot,signal:controller.signal,
    buildTimeoutMs:120000,browserTimeoutMs:30000,artifactsDir:directory,writeArtifact:(name,data)=>writeArtifact(directory,ctx.runId,name,data)};
  const f={directory,ctx,executor,controller};owned.push(f);
  const schema=await executor.schema(ctx),build=await executor.build(ctx);
  expect(schema.status,schema.message).toBe('passed');expect(build.status,build.message).toBe('passed');
  return f;
}
async function report(f:Awaited<ReturnType<typeof fixture>>,name:'smoke'|'occlusion'){
  const {buffer}=await readArtifact(f.ctx.artifactsDir,f.ctx.runId,name+'.json');
  return JSON.parse(buffer.toString());
}
async function trap(){
  let requests=0;
  const t=await listenHttpForFetch((_req,res)=>{requests++;res.writeHead(200,{'content-type':'text/plain'});res.end('TEST_ONLY_BACKEND_CANARY');});
  traps.push(t);return {url:t.baseUrl,get requests(){return requests;}};
}
it('runs real Chromium smoke and occlusion against one built static page with evidence',async()=>{
  const f=await fixture();
  const smoke=await f.executor.smoke(f.ctx);expect(smoke.status,smoke.message).toBe('passed');
  const data=await report(f,'smoke');
  expect(data.viewport).toEqual({width:1440,height:900});
  expect(data.browserVersion).toBeTypeOf('string');
  expect(data.purchases.after).toBe(data.purchases.before+1);
  expect(data.feedback.trim().length).toBeGreaterThan(0);
  expect(data.pageErrors).toEqual([]);expect(data.blockedRequests).toEqual([]);
  expect(data.scene).toMatchObject({state:'fallback',placeholderVisible:true});
  expect((await f.executor.occlusion(f.ctx)).status).toBe('passed');
  const targets=(await report(f,'occlusion')).targets;
  expect(targets.length).toBeGreaterThan(0);
  expect(targets.find((target:any)=>target.testId==='buy-button').centerHit).toBe(true);
  for(const name of ['smoke','occlusion']){
    const json=await readArtifact(f.ctx.artifactsDir,f.ctx.runId,name+'.json');
    const png=await readArtifact(f.ctx.artifactsDir,f.ctx.runId,name+'.png');
    expect(png.buffer.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.ref.bytes).toBeGreaterThan(100);
    if(name==='smoke')expect(smoke.evidence).toBe(json.ref.hash);
  }
},30000);
it('checks the real product template with its explicit missing-asset fallback',async()=>{
  const f=await fixture('',true);
  const result=await f.executor.smoke(f.ctx);
  expect(result.status,result.message).toBe('passed');
  expect((await report(f,'smoke')).scene.state).toBe('fallback');
},30000);
it('fails on an uncaught page error even when the purchase UI exists',async()=>{
  const f=await fixture(app({effect:"setTimeout(()=>{throw new Error('TEST_ONLY_BROWSER_CRASH')},0);"}));
  const result=await f.executor.smoke(f.ctx);expect(result.status).toBe('failed');
  expect((await report(f,'smoke')).pageErrors.join(' ')).toContain('TEST_ONLY_BROWSER_CRASH');
},30000);
it.each([
  {label:'purchase count does not increment',options:{buy:"setFeedback('Added');"}},
  {label:'purchase feedback is empty',options:{buy:'setCount(c=>c+1);'}},
  {label:'fallback is not visible',options:{scene:'<div style={{display:"none"}} data-testid="product-placeholder">Hidden</div>'}},
])('fails smoke when $label',async({options})=>{
  const f=await fixture(app(options));const result=await f.executor.smoke(f.ctx);
  expect(result.status).toBe('failed');expect(result.evidence).toMatch(/^[a-f0-9]{64}$/);
},30000);
it('fails a covered purchase center using real hit testing',async()=>{
  const f=await fixture(app({extra:'<div id="cover" style={{position:"fixed",inset:0,zIndex:9999}}>Cover</div>'}));
  const result=await f.executor.occlusion(f.ctx);expect(result.status).toBe('failed');
  const buy=(await report(f,'occlusion')).targets.find((target:any)=>target.testId==='buy-button');
  expect(buy.centerHit).toBe(false);expect(buy.samples.some((sample:any)=>sample.hit?.id==='cover')).toBe(true);
},30000);
it('fails a covered secondary control even when the purchase button is usable',async()=>{
  const f=await fixture(app({extra:'<div style={{position:"relative",width:120,height:50}}><button id="other">Other</button><div style={{position:"absolute",inset:0,zIndex:2}}>Cover</div></div>'}));
  const result=await f.executor.occlusion(f.ctx);expect(result.status).toBe('failed');
  expect((await report(f,'occlusion')).targets.find((target:any)=>target.id==='other').passed).toBe(false);
},30000);
it('rejects an empty interactive target set',async()=>{
  const f=await fixture('export default ()=> <main>No interactive targets</main>');
  const result=await f.executor.occlusion(f.ctx);expect(result.status).toBe('failed');
  expect((await report(f,'occlusion')).targets).toEqual([]);
},30000);
it('records disabled and offscreen exclusions without counting them as passing targets',async()=>{
  const f=await fixture(app({extra:'<button id="disabled" disabled>Disabled</button><button id="offscreen" style={{position:"absolute",top:2000}}>Below</button>'}));
  const result=await f.executor.occlusion(f.ctx);expect(result.status,result.message).toBe('passed');
  const data=await report(f,'occlusion');
  expect(data.excluded.find((target:any)=>target.id==='disabled').reason).toBe('disabled');
  expect(data.excluded.find((target:any)=>target.id==='offscreen').reason).toBe('offscreen');
  expect(data.targets.some((target:any)=>['disabled','offscreen'].includes(target.id))).toBe(false);
},30000);
it.each(['fetch','websocket','popup','worker'])('blocks %s access to a different loopback origin before it reaches the server',async(kind)=>{
  const backend=await trap();
  const url=JSON.stringify(backend.url+'/tasks');
  const effect=kind==='fetch'?`fetch(${url}).catch(()=>{});`:
    kind==='websocket'?`new WebSocket(${JSON.stringify(backend.url.replace('http:','ws:')+'/events')});`:
    kind==='popup'?`window.open(${url},'_blank');`:
    `new Worker(URL.createObjectURL(new Blob([${JSON.stringify('fetch('+url+').catch(()=>{});')}],{type:'text/javascript'})));`;
  const f=await fixture(app({effect}));
  const result=await f.executor.smoke(f.ctx);expect(result.status).toBe('failed');
  expect((await report(f,'smoke')).blockedRequests.length).toBeGreaterThan(0);
  expect(backend.requests).toBe(0);
},30000);
it('continues checking the actual build bytes after the live candidate changes',async()=>{
  const f=await fixture();
  await writeFile(path.join(f.ctx.candidateRoot,'src/App.tsx'),"throw new Error('LIVE_CANDIDATE_MUST_NOT_EXECUTE');");
  expect((await f.executor.smoke(f.ctx)).status).toBe('passed');
  expect((await report(f,'smoke')).pageErrors).toEqual([]);
},30000);
function get(origin:string,pathname:string,host?:string):Promise<{status:number;body:string}>{
  return new Promise((resolve,reject)=>{
    const req=request(new URL(origin),{path:pathname,headers:host?{host}:{}},res=>{
      let body='';res.setEncoding('utf8');res.on('data',data=>{body+=data;});res.on('end',()=>resolve({status:res.statusCode??0,body}));
    });req.on('error',reject);req.end();
  });
}
it('serves only build output on a separate static origin and releases it on stop',async()=>{
  const f=await fixture();expect((await f.executor.smoke(f.ctx)).status).toBe('passed');
  const url=(await report(f,'smoke')).url;expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  expect((await get(url,'/tasks')).status).toBe(404);
  expect((await get(url,'/%2e%2e%2fsrc/scene.config.json')).status).toBeGreaterThanOrEqual(400);
  expect((await get(url,'/','attacker.invalid')).status).toBe(403);
  await f.executor.stop?.(f.ctx.runId);
  await expect(get(url,'/')).rejects.toBeDefined();
},30000);

