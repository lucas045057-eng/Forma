import {beforeAll,beforeEach,afterEach,afterAll,expect,it} from 'vitest';
import {chromium,type Browser,type BrowserServer,type BrowserContext,type Page} from '@playwright/test';
import {createServer,type ViteDevServer} from 'vite';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createConnection} from 'node:net';
import {installSpeechFakes} from './test-support/speech-fakes.ts';
import type {ServerResponse} from 'node:http';

const studio=path.resolve(import.meta.dirname,'..');
let vite:ViteDevServer;let native:BrowserServer;let browser:Browser;let context:BrowserContext;let page:Page;let cache:string;let origin:string;let serial=0;
const state={posts:[] as Array<{id:string;mime:string;bytes:number}>,deletes:[] as string[],tasks:[] as Array<Record<string,unknown>>,hold:false,deleteFailure:false,status:200,text:'把这个改成圆角',pending:new Map<string,ServerResponse>()};
const output=process.env.D2_RUN_DIR;
const pageErrors:string[]=[];const denied:string[]=[];
let ownedChrome:Array<{pid:number;parent:number;created:string}>=[];
function chromeProcesses(){return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',"ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o')} })"],{encoding:'utf8',timeout:10000})||'[]') as Array<{pid:number;parent:number;created:string}>;}
async function portClosed(endpoint:string){const url=new URL(endpoint);await new Promise<void>((resolve,reject)=>{const socket=createConnection({host:url.hostname,port:Number(url.port)});socket.once('connect',()=>{socket.destroy();reject(new Error('Owned component port still listening'));});socket.once('error',(error:NodeJS.ErrnoException)=>{socket.destroy();if(error.code==='ECONNREFUSED')resolve();else reject(error);});socket.setTimeout(1000,()=>{socket.destroy();reject(new Error('Component port close probe timed out'));});});}
function answer(response:ServerResponse,id:string){response.setHeader('Content-Type','application/json');response.statusCode=state.status;response.end(JSON.stringify(state.status===200?{requestId:id,text:state.text,provider:'aliyun',model:'qwen3-asr-flash'}:{error:{code:state.status===499?'SPEECH_CANCELLED':'SPEECH_UPSTREAM',message:'fake private upstream message'}}));}
beforeAll(async()=>{
 cache=await mkdtemp(path.join(tmpdir(),'speech-component-'));
 vite=await createServer({configFile:false,envFile:false,root:studio,cacheDir:cache,logLevel:'silent',esbuild:{jsx:'automatic'},optimizeDeps:{noDiscovery:true,include:['react','react-dom/client','react/jsx-runtime']},
  plugins:[{name:'speech-component-local-fixture',enforce:'pre',resolveId(source,importer){
   if(source==='./EventCenter.tsx'&&importer?.endsWith('/PointSpeak.tsx'))return path.join(studio,'src/test-support/speech-center.tsx').replaceAll('\\','/');
   if(source==='./speech-input.css')return '\0speech-component-css';
  },load(id){if(id==='\0speech-component-css')return 'export default {};';},configureServer(server){server.middlewares.use(async(request,response,next)=>{
   if(request.url==='/__speech_component__/'){
    const css=await readFile(path.join(studio,'src/speech-input.css'),'utf8');response.setHeader('Content-Type','text/html; charset=utf-8');response.end(`<html><head><meta charset="utf-8"><style>body{font-family:sans-serif;background:#17232d;color:#d7e4ee;padding:20px}button,select{margin:4px;padding:8px}textarea{display:block;width:600px}nav{display:flex}${css}</style></head><body><div id="root"></div><script type="module" src="/src/test-support/speech-harness.tsx"></script></body></html>`);return;
   }
   if(request.url==='/speech/config'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({enabled:true,provider:'aliyun',model:'qwen3-asr-flash',supportedMimeTypes:['audio/webm'],maxBytes:4194304,maxDurationMs:60000,notice:'mock only'}));return;}
   if(request.url==='/speech/transcribe'&&request.method==='POST'){
    let bytes=0;request.on('data',chunk=>{bytes+=chunk.length;});request.on('end',()=>{
     const id=String(request.headers['x-speech-request-id']);state.posts.push({id,mime:String(request.headers['content-type']),bytes});
     if(state.hold){state.pending.set(id,response);response.once('close',()=>state.pending.delete(id));}else answer(response,id);
    });return;
   }
   if(request.url?.startsWith('/speech/transcribe/')&&request.method==='DELETE'){
    const id=request.url.split('/').at(-1)!;state.deletes.push(id);response.setHeader('Content-Type','application/json');response.statusCode=state.deleteFailure?500:200;response.end(JSON.stringify(state.deleteFailure?{error:{code:'SPEECH_UPSTREAM',message:'fake failure'}}:{requestId:id,status:'cancelled'}));return;
   }
   if(request.url==='/tasks'){
    response.setHeader('Content-Type','application/json');
    if(request.method==='GET'){response.end(JSON.stringify(state.tasks));return;}
    if(request.method==='POST'){let body='';request.on('data',chunk=>{body+=chunk;});request.on('end',()=>{const input=JSON.parse(body);const task={...input,id:`task-${state.tasks.length+1}`,status:'queued',events:[]};state.tasks.unshift(task);response.statusCode=202;response.end(JSON.stringify(task));});return;}
   }
   next();
  });}}],server:{host:'127.0.0.1',cors:false,hmr:false,watch:null}});
 const http=vite.httpServer;if(!http)throw new Error('Component HTTP listener missing');
 await new Promise<void>((resolve,reject)=>{const error=(cause:Error)=>reject(cause);http.once('error',error);http.listen(0,'127.0.0.1',()=>{http.off('error',error);resolve();});});
 const address=http.address();if(!address||typeof address==='string')throw new Error('Component listener has no TCP address');origin=`http://127.0.0.1:${address.port}`;
 native=await chromium.launchServer({headless:true,args:['--disable-background-networking','--disable-component-update','--disable-features=MediaRouter,OptimizationHints,Translate']});
 browser=await chromium.connect(native.wsEndpoint());
},60_000);
beforeEach(async()=>{
 state.posts=[];state.deletes=[];state.tasks=[];state.hold=false;state.deleteFailure=false;state.status=200;state.text='把这个改成圆角';state.pending.clear();pageErrors.length=0;denied.length=0;
 context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(installSpeechFakes);
 await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===origin)return route.continue();denied.push(url.origin);return route.abort();});
 page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));await page.goto(origin+'/__speech_component__/');await page.getByTestId('speech-record').waitFor();await expect.poll(()=>page.getByTestId('speech-record').isEnabled()).toBe(true);
});
afterEach(async()=>{
 try {
  if(page&&!page.isClosed()){
   const beforeUnmount=await page.evaluate(()=>({...window.__speechTest,releasePermissions:undefined}));
   if(output){await mkdir(path.join(output,'component'),{recursive:true});await page.screenshot({path:path.join(output,`component/${++serial}.png`)});}
   if(await page.getByTestId('speech-input').count())await page.getByTestId('fixture-unmount').click();
   await expect.poll(()=>page.evaluate(()=>window.__speechTest.liveTracks)).toBe(0);
   if(output)await writeFile(path.join(output,`component/${serial}.json`),JSON.stringify({url:page.url(),apiSubstitutes:true,realChromium:true,beforeUnmount,afterUnmount:await page.evaluate(()=>({...window.__speechTest,releasePermissions:undefined})),posts:state.posts,deletes:state.deletes,tasks:state.tasks,pageErrors,denied},null,2));
  }
  expect(pageErrors).toEqual([]);expect(denied).toEqual([]);
 } finally {await context?.close();for(const response of state.pending.values())response.destroy();state.pending.clear();}
});
afterAll(async()=>{
 const errors:unknown[]=[];
 try{if(native){const processes=chromeProcesses();const ids=new Set([native.process().pid]);for(let count=0;count<processes.length;count++)for(const p of processes)if(ids.has(p.parent))ids.add(p.pid);ownedChrome=processes.filter(p=>ids.has(p.pid));expect(ownedChrome.some(p=>p.pid===native.process().pid)).toBe(true);}}catch(error){errors.push(error);}
 try{await browser?.close();}catch(error){errors.push(error);}try{await native?.close();}catch(error){errors.push(error);}
 try{if(vite){const http= vite.httpServer as unknown as {closeAllConnections?:()=>void}|undefined;http?.closeAllConnections?.();await vite.close();expect(vite.httpServer?.listening??false).toBe(false);}}catch(error){errors.push(error);}
 try{if(origin)await portClosed(origin);if(native)await portClosed(native.wsEndpoint());}catch(error){errors.push(error);}
 let remaining:typeof ownedChrome=[];
 try{remaining=chromeProcesses().filter(p=>ownedChrome.some(old=>old.pid===p.pid&&old.created===p.created));expect(remaining).toEqual([]);if(native)expect(native.process().exitCode!==null||native.process().signalCode!==null).toBe(true);}catch(error){errors.push(error);}
 if(!errors.length&&cache){try{await rm(cache,{recursive:true,force:true});}catch(error){errors.push(error);}}
 if(output)await writeFile(path.join(output,'component-cleanup.json'),JSON.stringify({pid:process.pid,origin,chromeVersion:browser?.version(),chrome:ownedChrome,chromeExitCode:native?.process().exitCode,chromeSignalCode:native?.process().signalCode,remaining,serverListening:vite?.httpServer?.listening??false,cacheRetained:errors.length?cache:null,errors:errors.map(String)},null,2));
 if(errors.length)throw new AggregateError(errors,'Speech component fixture cleanup failed');
},30_000);
async function record(){const button=page.getByTestId('speech-record');await button.hover();await page.mouse.down();await expect.poll(()=>page.evaluate(()=>window.__speechTest.recorderStarts)).toBe(1);await page.mouse.up();await page.getByTestId('speech-review').waitFor();}
it('real pointer release includes final audio once, editable review requires explicit B then generates only via original button',async()=>{
 await record();expect(state.posts).toHaveLength(1);expect(state.posts[0].bytes).toBe(5);expect(state.tasks).toHaveLength(0);
 await page.getByTestId('speech-review-text').fill('编辑后的语音指令');await page.getByTestId('fixture-B').click();await page.getByTestId('speech-selection-conflict').waitFor();
 expect(await page.getByTestId('speech-use').isDisabled()).toBe(true);expect(await page.getByTestId('generate-candidate').isDisabled()).toBe(true);
 expect(await page.getByTestId('speech-capture-object').textContent()).toContain('A');expect(await page.getByTestId('speech-current-object').textContent()).toContain('B');
 await page.getByTestId('speech-use-current').click();expect(await page.getByTestId('instruction-input').inputValue()).toBe('编辑后的语音指令');expect(state.tasks).toHaveLength(0);
 await page.getByTestId('generate-candidate').click();await expect.poll(()=>state.tasks.length).toBe(1);expect(state.tasks[0].selection).toMatchObject({cid:'B'});expect(state.tasks[0].instruction).toBe('编辑后的语音指令');expect(state.posts).toHaveLength(1);
},30_000);
it('Space repeat and synthetic click never double-record; changed accepted selection blocks Ctrl+Enter until reconfirmed',async()=>{
 await page.getByTestId('speech-record').focus();await page.keyboard.down('Space');await expect.poll(()=>page.evaluate(()=>window.__speechTest.recorderStarts)).toBe(1);await page.keyboard.down('Space');await page.keyboard.up('Space');await page.getByTestId('speech-review').waitFor();expect(state.posts).toHaveLength(1);
 await page.getByTestId('speech-use').click();await page.getByTestId('fixture-B').click();await page.getByTestId('speech-binding-conflict').waitFor();
 await page.getByTestId('instruction-input').press('Control+Enter');expect(state.tasks).toHaveLength(0);await page.getByTestId('speech-reconfirm').click();await page.getByTestId('instruction-input').press('Control+Enter');await expect.poll(()=>state.tasks.length).toBe(1);
},30_000);
it('hidden mode immediately stops active tracks even though PointSpeak stays mounted',async()=>{
 await page.getByTestId('speech-record').hover();await page.mouse.down();await expect.poll(()=>page.evaluate(()=>window.__speechTest.liveTracks)).toBe(1);
 await page.evaluate(()=>document.querySelector<HTMLButtonElement>('[data-testid="fixture-block"]')!.click());await expect.poll(()=>page.evaluate(()=>window.__speechTest.liveTracks)).toBe(0);await page.mouse.up();expect(state.posts).toHaveLength(0);
 expect(await page.getByTestId('speech-input').count()).toBe(1);await page.getByTestId('fixture-block').click();
},30_000);
it('abnormal native pointer-capture loss cancels without uploading',async()=>{
 await page.evaluate(()=>{const button=document.querySelector<HTMLButtonElement>('[data-testid="speech-record"]')!;button.addEventListener('pointerdown',event=>{button.dataset.fixturePointer=String(event.pointerId);},{once:true,capture:true});});
 await page.getByTestId('speech-record').hover();await page.mouse.down();await expect.poll(()=>page.evaluate(()=>window.__speechTest.liveTracks)).toBe(1);
 await page.evaluate(()=>{const button=document.querySelector<HTMLButtonElement>('[data-testid="speech-record"]')!;button.releasePointerCapture(Number(button.dataset.fixturePointer));});
 await page.mouse.move(20,20);await expect.poll(()=>page.evaluate(()=>window.__speechTest.liveTracks)).toBe(0);await page.mouse.up();expect(state.posts).toHaveLength(0);
},30_000);
it.each(['visibility','blur','gate','unmount'])('real %s event releases active resources and never uploads',async reason=>{
 await page.getByTestId('speech-record').hover();await page.mouse.down();await expect.poll(()=>page.evaluate(()=>window.__speechTest.liveTracks)).toBe(1);
 await page.evaluate(kind=>{if(kind==='visibility'){Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));}else if(kind==='blur')window.dispatchEvent(new Event('blur'));else document.querySelector<HTMLButtonElement>(`[data-testid="fixture-${kind}"]`)!.click();},reason);
 await expect.poll(()=>page.evaluate(()=>window.__speechTest.liveTracks)).toBe(0);await page.mouse.up();expect(state.posts).toHaveLength(0);
},30_000);
it('version changes prohibit review acceptance and require a fresh pick and recording',async()=>{
 await record();await page.getByTestId('fixture-version').click();expect(await page.getByTestId('speech-use').isDisabled()).toBe(true);expect(await page.getByTestId('speech-use-current').count()).toBe(0);await page.getByTestId('instruction-input').press('Control+Enter');expect(state.tasks).toHaveLength(0);
},30_000);
it('permission released before approval stops late tracks without starting recorder',async()=>{
 await page.evaluate(()=>{window.__speechTest.holdPermission=true;});await page.getByTestId('speech-record').hover();await page.mouse.down();await expect.poll(()=>page.getByTestId('speech-status').textContent()).toContain('申请权限');await page.mouse.up();
 await page.evaluate(()=>window.__speechTest.releasePermissions());await expect.poll(()=>page.evaluate(()=>window.__speechTest.streams)).toBe(1);await expect.poll(()=>page.evaluate(()=>window.__speechTest.liveTracks)).toBe(0);expect(await page.evaluate(()=>window.__speechTest.recorderStarts)).toBe(0);expect(state.posts).toHaveLength(0);
},30_000);
it('transcribing hidden cancellation sends DELETE despite its failure and never reopens review',async()=>{
 state.hold=true;state.deleteFailure=true;await page.getByTestId('speech-record').hover();await page.mouse.down();await expect.poll(()=>page.evaluate(()=>window.__speechTest.recorderStarts)).toBe(1);await page.mouse.up();await expect.poll(()=>state.posts.length).toBe(1);
 await page.getByTestId('fixture-block').click();await expect.poll(()=>state.deletes.length).toBe(1);await page.getByTestId('fixture-block').click();await expect.poll(()=>page.getByTestId('speech-status').textContent()).toContain('未确认');expect(await page.getByTestId('speech-review').count()).toBe(0);expect(await page.evaluate(()=>window.__speechTest.liveTracks)).toBe(0);
},30_000);
it('new text is not overwritten; none to A is explicit and each retry uses a new UUID',async()=>{
 await page.getByTestId('fixture-none').click();await record();await page.getByTestId('instruction-input').fill('用户后来输入的文字');await page.getByTestId('fixture-A').click();await page.getByTestId('speech-selection-conflict').waitFor();expect(await page.getByTestId('instruction-input').inputValue()).toBe('用户后来输入的文字');
 await page.getByTestId('speech-discard').click();await page.getByTestId('speech-record').hover();await page.mouse.down();await expect.poll(()=>page.evaluate(()=>window.__speechTest.recorderStarts)).toBe(2);await page.mouse.up();await page.getByTestId('speech-review').waitFor();expect(state.posts[0].id).not.toBe(state.posts[1].id);await page.getByTestId('speech-use').click();
 expect(state.tasks).toHaveLength(0);
},30_000);
it('selected to none requires explicit whole-page confirmation before task submission',async()=>{
 await record();await page.getByTestId('fixture-none').click();await page.getByTestId('speech-selection-conflict').waitFor();expect(await page.getByTestId('speech-use').isDisabled()).toBe(true);await page.getByTestId('speech-use-current').click();expect(state.tasks).toHaveLength(0);await page.getByTestId('generate-candidate').click();await expect.poll(()=>state.tasks.length).toBe(1);expect(state.tasks[0].selection).toBeUndefined();
},30_000);
it('original text edits survive until an explicit replacement is chosen',async()=>{
 await record();await page.getByTestId('instruction-input').fill('用户的新编辑');await page.getByTestId('speech-text-conflict').waitFor();expect(await page.getByTestId('speech-use').isDisabled()).toBe(true);expect(await page.getByTestId('instruction-input').inputValue()).toBe('用户的新编辑');
 await page.getByTestId('speech-review-text').fill('确认替换稿');await page.getByTestId('speech-replace').click();expect(await page.getByTestId('instruction-input').inputValue()).toBe('确认替换稿');expect(state.tasks).toHaveLength(0);
},30_000);
it('HTTP 499 cancellation is shown safely and a new press starts a fresh UUID',async()=>{
 state.status=499;await page.getByTestId('speech-record').hover();await page.mouse.down();await expect.poll(()=>page.evaluate(()=>window.__speechTest.recorderStarts)).toBe(1);await page.mouse.up();await expect.poll(()=>page.getByTestId('speech-status').textContent()).toContain('已取消');expect(await page.getByTestId('speech-error').textContent()).not.toContain('private');expect(state.tasks).toHaveLength(0);
 state.status=200;await page.getByTestId('speech-record').hover();await page.mouse.down();await expect.poll(()=>page.evaluate(()=>window.__speechTest.recorderStarts)).toBe(2);await page.mouse.up();await page.getByTestId('speech-review').waitFor();expect(state.posts).toHaveLength(2);expect(state.posts[0].id).not.toBe(state.posts[1].id);
},30_000);
it('browser recognition starts only after explicit provider choice and shares editable review',async()=>{
 expect(await page.evaluate(()=>window.__speechTest.vendorStarts)).toBe(0);await page.getByTestId('speech-provider').selectOption('browser');expect(await page.locator('.speech-disclosure').textContent()).toContain('浏览器厂商');
 await page.getByTestId('speech-record').focus();await page.keyboard.down('Space');await expect.poll(()=>page.evaluate(()=>window.__speechTest.vendorStarts)).toBe(1);await page.keyboard.up('Space');await page.getByTestId('speech-review').waitFor();expect(state.posts).toHaveLength(0);await page.getByTestId('speech-review-text').fill('浏览器编辑稿');await page.getByTestId('speech-use').click();expect(await page.getByTestId('instruction-input').inputValue()).toBe('浏览器编辑稿');expect(state.tasks).toHaveLength(0);
},30_000);
it('original task retry keeps its original selection and cannot run while a speech review is pending',async()=>{
 await page.getByTestId('instruction-input').fill('原任务指令');await page.getByTestId('generate-candidate').click();await expect.poll(()=>state.tasks.length).toBe(1);state.tasks[0].status='failed';state.tasks[0].error={code:'TASK_FAILED',message:'fake failure'};await page.getByTestId('fixture-refresh').click();await page.getByTestId('task-retry').waitFor();await page.getByTestId('fixture-B').click();
 await record();expect(await page.getByTestId('task-retry').isDisabled()).toBe(true);await page.getByTestId('speech-discard').click();await page.getByTestId('task-retry').click();await expect.poll(()=>state.tasks.length).toBe(2);expect(state.tasks[0].instruction).toBe('原任务指令');expect(state.tasks[0].selection).toMatchObject({cid:'A'});
},30_000);
it('the original plain typed instruction still submits without ever opening a recorder',async()=>{
 await page.getByTestId('instruction-input').fill('直接文字修改');await page.getByTestId('instruction-input').press('Control+Enter');await expect.poll(()=>state.tasks.length).toBe(1);expect(state.tasks[0].instruction).toBe('直接文字修改');expect(await page.evaluate(()=>window.__speechTest.recorderStarts)).toBe(0);expect(state.posts).toHaveLength(0);
},30_000);
