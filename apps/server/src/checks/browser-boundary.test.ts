import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { request } from 'node:http';
import { createSocket } from 'node:dgram';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createRealExecutor } from './worker.ts';
import { copyAudited } from './snapshot.ts';
import { readArtifact, writeArtifact } from './artifacts.ts';
import type { CheckContext, CheckExecutor } from './runner.ts';
import { listenHttpForFetch } from '../test-support/fetch-listener.ts';

const owned:{directory:string;ctx:CheckContext;executor:CheckExecutor;controller:AbortController}[]=[];
const traps:Awaited<ReturnType<typeof listenHttpForFetch>>[]=[];
afterEach(async(test)=>{
  for(const f of owned.splice(0)){
    f.controller.abort();await f.executor.stop?.(f.ctx.runId);
    if(process.env.CHECK_BROWSER_EVIDENCE_DIR){
      const target=path.join(process.env.CHECK_BROWSER_EVIDENCE_DIR,f.ctx.runId);await mkdir(target,{recursive:true});
      await cp(path.join(f.directory,'check-artifacts',f.ctx.runId),target,{recursive:true}).catch(error=>{if(error.code!=='ENOENT')throw error;});
      await writeFile(path.join(target,'test.json'),JSON.stringify({test:test.task.name,runId:f.ctx.runId},null,2));
    }
    await rm(f.directory,{recursive:true,force:true});
  }
  for(const trap of traps.splice(0)){trap.server.closeAllConnections();await new Promise<void>(resolve=>trap.server.close(()=>resolve()));}
  vi.restoreAllMocks();syncBuiltinESMExports();
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
async function fixture(source=app(),realTemplate=false,publicFiles:Record<string,string>={}){
  const directory=await mkdtemp(path.join(tmpdir(),'m3b-browser-'));
  const candidateRoot=path.join(directory,'candidate');await mkdir(path.join(candidateRoot,'src'),{recursive:true});
  if(realTemplate)await cp(new URL('../../../../templates/product-page/src/',import.meta.url),path.join(candidateRoot,'src'),{recursive:true});
  else{
    await writeFile(path.join(candidateRoot,'src/main.tsx'),"import {createRoot} from 'react-dom/client';import App from './App';createRoot(document.getElementById('root')!).render(<App/>);");
    await writeFile(path.join(candidateRoot,'src/App.tsx'),source);
    await writeFile(path.join(candidateRoot,'src/scene.config.json'),await readFile(new URL('../../../../templates/product-page/src/scene.config.json',import.meta.url)));
  }
  for(const [name,content] of Object.entries(publicFiles)){
    const file=path.join(candidateRoot,'public',name);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,content);
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
it.each(['RTCPeerConnection','webkitRTCPeerConnection'])('blocks %s before a real loopback STUN packet can leave Chromium',async(name)=>{
  const udp=createSocket('udp4');let packets=0;udp.on('message',()=>{packets++;});
  await new Promise<void>((resolve,reject)=>{udp.once('error',reject);udp.bind(0,'127.0.0.1',resolve);});
  try{
    const address=udp.address();
    const f=await fixture(app({effect:`try {const rtc=new window[${JSON.stringify(name)}]({iceServers:[{urls:'stun:127.0.0.1:${address.port}'}]});rtc.createDataChannel('probe');void rtc.createOffer().then(offer=>rtc.setLocalDescription(offer));}catch{}`}));
    const result=await f.executor.smoke(f.ctx),data=await report(f,'smoke');
    if(process.env.CHECK_BROWSER_EVIDENCE_DIR){
      const target=path.join(process.env.CHECK_BROWSER_EVIDENCE_DIR,'network-probes');await mkdir(target,{recursive:true});
      await writeFile(path.join(target,f.ctx.runId+'.json'),JSON.stringify({constructor:name,runId:f.ctx.runId,udpPort:address.port,receivedPackets:packets,status:result.status,blockedRequests:data.blockedRequests},null,2));
    }
    expect(result.status,JSON.stringify(data)).toBe('failed');
    expect(data.blockedRequests.some((entry:{kind:string})=>entry.kind==='webrtc')).toBe(true);
    expect(packets,'the real UDP decoy must receive zero packets').toBe(0);
  }finally{await new Promise<void>(resolve=>udp.close(()=>resolve()));}
},30000);
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
it('measures the initial coffee page even when the smoke click opens a booking dialog',async()=>{
  const coffee=await fixture(`import {useState} from 'react';
export default function App(){
  const [booking,setBooking]=useState(()=>localStorage.getItem('booking')==='open');
  return <main data-spatial-page="free-web"><h1>Coffee</h1><a id="menu" href="#beans">Beans</a>
    <button id="book" onClick={()=>{localStorage.setItem('booking','open');setBooking(true);}}>Book a tasting</button>
    {booking&&<div role="dialog" style={{position:'fixed',inset:0,background:'white'}}>
      <button id="dismiss" onClick={()=>{localStorage.removeItem('booking');setBooking(false);}}>Close</button>
    </div>}</main>;
}`);
  const smoke=await coffee.executor.smoke(coffee.ctx);
  expect(smoke.status,smoke.message).toBe('passed');
  const smokeReport=await report(coffee,'smoke');
  expect(smokeReport.spatialPage.interactiveVerified).toBe(true);
  expect(smokeReport.placedModules).toMatchObject({ count: 0, failed: 0 });
  const occlusion=await coffee.executor.occlusion(coffee.ctx);
  expect(occlusion.status,occlusion.message).toBe('passed');
  const baseline=await report(coffee,'occlusion');
  expect(baseline.url).toBe(smokeReport.url);
  expect(baseline.targets.map((target:{id:string})=>target.id)).toEqual(['menu','book']);
},30000);
it('rejects invisible placed modules even when the coffee illustration and another canvas are visible', async () => {
  const coffee = await fixture(`export default function App() {
    return <main data-spatial-page="free-web"><h1>Coffee</h1>
      <section data-spatial-module="visible"><canvas /></section>
      <svg viewBox="0 0 240 160" width="240" height="160">
        <path d="M20 20h60v40H20z" />
        <section data-spatial-module="cup"><canvas /></section>
      </svg>
      <section data-spatial-module="collapsed"><canvas style={{ width: 0 }} /></section>
      <section style={{opacity: 0}}><div data-spatial-module="transparent"><canvas /></div></section>
      <section data-spatial-module="missing"><p>Model</p></section>
      <section data-spatial-module="empty-buffer"><canvas width={0} style={{width: 120, height: 80}} /></section>
    </main>;
  }`);
  const smoke = await coffee.executor.smoke(coffee.ctx);
  expect(smoke.status).toBe('failed');
  expect(smoke.message).toContain('插图外层');
  const { placedModules } = await report(coffee, 'smoke');
  expect(placedModules).toMatchObject({ count: 6, failed: 5 });
  expect(placedModules.samples).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'visible', reason: null }),
    expect.objectContaining({ id: 'cup', reason: 'non-html-module', box: { width: 0, height: 0 } }),
    expect.objectContaining({ id: 'collapsed', reason: 'zero-size' }),
    expect.objectContaining({ id: 'transparent', reason: 'hidden' }),
    expect.objectContaining({ id: 'missing', reason: 'missing-canvas' }),
    expect.objectContaining({ id: 'empty-buffer', reason: 'empty-buffer' }),
  ]));
}, 30000);
it('accepts a placed module below the fold when its canvas finishes loading before interaction', async () => {
  const coffee = await fixture(`import {useEffect, useState} from 'react';
  export default function App() {
    const [ready, setReady] = useState(false);
    const [open, setOpen] = useState(true);
    useEffect(() => { const timer = setTimeout(() => setReady(true), 1500); return () => clearTimeout(timer); }, []);
    return <main data-spatial-page="free-web"><h1>Coffee</h1>
      <button onClick={() => setOpen(false)}>Book a tasting</button>
      {open && <section style={{ marginTop: 1300 }} data-spatial-module="below-fold">
        {ready && <canvas width={160} height={100} />}
      </section>}
    </main>;
  }`);
  const smoke = await coffee.executor.smoke(coffee.ctx);
  expect(smoke.status, smoke.message).toBe('passed');
  const evidence = await report(coffee, 'smoke');
  expect(evidence.placedModules).toMatchObject({
    count: 1, failed: 0, samples: [{ id: 'below-fold', reason: null, canvasBox: { width: 160, height: 100 } }],
  });
  expect(evidence.spatialPage.interactiveVerified).toBe(true);
}, 30000);
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
it('fails a covered secondary control even when the smoke click removes its cover',async()=>{
  const sample=await fixture(app({extra:'<div style={{position:"relative",width:120,height:50}}><button id="other">Other</button>{count===0&&<div style={{position:"absolute",inset:0,zIndex:2}}>Cover</div>}</div>'}));
  const smoke=await sample.executor.smoke(sample.ctx);expect(smoke.status,smoke.message).toBe('passed');
  const result=await sample.executor.occlusion(sample.ctx);expect(result.status).toBe('failed');
  expect((await report(sample,'occlusion')).targets).toContainEqual(expect.objectContaining({id:'other',passed:false}));
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


it('records a blocked service worker attempt before its script can contact another origin',async()=>{
  const backend=await trap();
  const f=await fixture(app({effect:"navigator.serviceWorker.register('/sw.js').catch(()=>{});"}),false,{
    'sw.js':"self.addEventListener('install',()=>{fetch("+JSON.stringify(backend.url+'/tasks')+").catch(()=>{});});"
  });
  const result=await f.executor.smoke(f.ctx);expect(result.status).toBe('failed');
  expect((await report(f,'smoke')).blockedRequests.some((item:any)=>item.kind==='serviceworker')).toBe(true);
  expect(backend.requests).toBe(0);
},30000);
it('rejects a worker-based WebSocket attempt at worker creation',async()=>{
  const backend=await trap();
  const workerCode='new WebSocket('+JSON.stringify(backend.url.replace('http:','ws:')+'/events')+');';
  const f=await fixture(app({effect:'new Worker(URL.createObjectURL(new Blob(['+JSON.stringify(workerCode)+"],{type:'text/javascript'})));"}));
  const result=await f.executor.smoke(f.ctx);expect(result.status).toBe('failed');
  expect((await report(f,'smoke')).blockedRequests.some((item:any)=>item.kind==='worker')).toBe(true);
  expect(backend.requests).toBe(0);
},30000);
it('blocks top-level navigation to another loopback origin with failure evidence',async()=>{
  const backend=await trap();
  const f=await fixture(app({effect:'window.location.replace('+JSON.stringify(backend.url+'/tasks')+');'}));
  const result=await f.executor.smoke(f.ctx);expect(result.status).toBe('failed');
  expect(result.evidence).toMatch(/^[a-f0-9]{64}$/);
  expect((await report(f,'smoke')).blockedRequests.length).toBeGreaterThan(0);
  expect(backend.requests).toBe(0);
},30000);
it('rejects a static directory replaced by a junction after the browser starts',async()=>{
  const f=await fixture();expect((await f.executor.smoke(f.ctx)).status).toBe('passed');
  const external=path.join(f.directory,'private');await mkdir(external);await writeFile(path.join(external,'canary.json'),'TEST_ONLY_STATIC_CANARY');
  await symlink(external,path.join(f.ctx.buildRoot,'dist','attack'),'junction');
  const result=await get((await report(f,'smoke')).url,'/attack/canary.json');
  expect(result.status).toBe(403);expect(result.body).not.toContain('TEST_ONLY_STATIC_CANARY');
},30000);
it('fails with evidence when its worker cannot access the installed browser',async()=>{
  const original=childProcess.spawn.bind(childProcess);
  vi.spyOn(childProcess,'spawn').mockImplementation(((command:unknown,...args:unknown[])=>{
    if(command===process.execPath && Array.isArray(args[0]) && args[0].some(arg=>String(arg).includes('worker-entry.'))){
      args[0]=args[0].filter(arg=>!String(arg).includes('ms-playwright'));
    }
    return Reflect.apply(original,childProcess,[command,...args]);
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  const f=await fixture();const result=await f.executor.smoke(f.ctx);
  expect(result.status).toBe('failed');expect(result.evidence).toMatch(/^[a-f0-9]{64}$/);
  expect((await report(f,'smoke')).error).toMatch(/browser|restricted|ACCESS_DENIED|Executable/i);
},30000);

