import {it,expect} from 'vitest';
import {chromium,expect as browserExpect,type WebSocketRoute,type Browser,type BrowserContext,type BrowserServer,type Page} from '@playwright/test';
import {createServer as createVite,type ViteDevServer} from 'vite';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {installSpeechFakes} from './test-support/speech-fakes.ts';
import {speechBrowserVite,observeSpeechBootstrap,browserFailure,writeSpeechEvidence,speechPortClosed,type SpeechBootstrap} from './test-support/speech-browser-fixture.ts';
import {closeLoopbackServer,failSetup,listenOnEphemeralLoopback,openLoopback} from './test-support/safe-loopback.ts';

it('real App keeps review across cross-origin iframe pick pending and WS reconnect, then frees the submitted binding',async()=>{
 const cache=await mkdtemp(path.join(tmpdir(),'speech-real-app-'));let origin='';let previewOrigin='';let version='v1';const tasks:Array<Record<string,unknown>>=[];const posts:string[]=[];const denied:string[]=[];const errors:string[]=[];let holdVersion=false;let releaseVersion:(()=>void)|undefined;let socket:WebSocketRoute|undefined;
 const createPreview=()=>createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end(`<button id="A">A</button><button id="B">B</button><script>
 const parentOrigin=new URL(location.href).searchParams.get('studioOrigin');const styles=Object.fromEntries(['display','position','color','backgroundColor','fontSize','fontFamily','fontWeight','lineHeight','padding','margin','borderRadius','width','height'].map(key=>[key,'']));
 for(const button of document.querySelectorAll('button'))button.onclick=()=>parent.postMessage({type:'pick:result',payload:{cid:button.id,src:'src/'+button.id+'.tsx:1:1',bbox:[0,0,10,10],styles,instances:1,ancestors:[]}},parentOrigin);
 parent.postMessage({type:'ready'},parentOrigin);</script>`);});
 let vite:ViteDevServer|undefined;let browser:Browser|undefined;let native:BrowserServer|undefined;let context:BrowserContext|undefined;let casePage:Page|undefined;let bootstrap:SpeechBootstrap|undefined;let primary:unknown;let stage='preview-listen';let preview:ReturnType<typeof createPreview>|undefined;
 try{
 stage='preview-listen';const previewStarted=await openLoopback(async()=>{const server=createPreview();try{const port=await listenOnEphemeralLoopback(server);return{value:server,port,close:async()=>{server.closeAllConnections();await closeLoopbackServer(server);}};}catch(error){return failSetup(error,async()=>{server.closeAllConnections();await closeLoopbackServer(server);});}});preview=previewStarted.value;previewOrigin=previewStarted.origin;
 stage='vite-create';const viteStarted=await openLoopback(async()=>{const created=await createVite({...speechBrowserVite({entry:'src/test-support/speech-app.tsx'}),root:path.resolve(import.meta.dirname,'..'),cacheDir:cache,logLevel:'silent',define:{'import.meta.env.VITE_PREVIEW_ORIGIN':JSON.stringify(previewOrigin)},plugins:[{name:'real-app-speech-fixture',configureServer(server){server.middlewares.use((request,response,next)=>{if(request.url!=='/__speech_app__/')return next();response.setHeader('Content-Type','text/html');response.end('<div id="root"></div><script type="module" src="/src/test-support/speech-app.tsx"></script>');});}}],server:{host:'127.0.0.1',hmr:false,cors:false,watch:null}});try{const http=created.httpServer;if(!http)throw new Error('App fixture listener missing');const port=await listenOnEphemeralLoopback(http);return{value:created,port,close:async()=>{const server=created.httpServer as unknown as {closeAllConnections?:()=>void}|undefined;server?.closeAllConnections?.();await created.close();}};}catch(error){return failSetup(error,()=>created.close());}});vite=viteStarted.value;origin=viteStarted.origin;
 stage='chromium-create';native=await chromium.launchServer({headless:true,args:['--disable-background-networking']});browser=await chromium.connect(native.wsEndpoint());context=await browser.newContext();const page=await context.newPage();casePage=page;bootstrap=observeSpeechBootstrap(page,errors);
  await context.addInitScript(installSpeechFakes);await page.addInitScript(()=>window.addEventListener('blur',()=>{++window.__speechTest.parentBlurs;}));
  await page.routeWebSocket('**/events',route=>{socket=route;route.send(JSON.stringify({type:'ready',seq:0}));});
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());if(![origin,previewOrigin].includes(url.origin)){denied.push(url.origin);return route.abort();}
   const json=(value:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
   if(url.origin!==origin)return route.continue();
   if(url.pathname==='/version'){if(holdVersion)await new Promise<void>(resolve=>{releaseVersion=resolve;});return json({version});}
   if(['/candidates','/approvals','/assets'].includes(url.pathname))return json([]);
   if(url.pathname==='/events/history')return json({events:[],current:0,oldest:0,truncated:false});
   if(url.pathname==='/scene/model-provenance')return json({model:'',verified:false,provenance:{schemaVersion:1,kind:'unknown'}});
   if(url.pathname==='/speech/config')return json({enabled:true,provider:'aliyun',model:'qwen3-asr-flash',supportedMimeTypes:['audio/webm'],maxBytes:4194304,maxDurationMs:60000,notice:'mock'});
   if(url.pathname==='/speech/transcribe'){const id=route.request().headers()['x-speech-request-id'];posts.push(id);return json({requestId:id,text:'语音修改',provider:'aliyun',model:'qwen3-asr-flash'});}
   if(url.pathname==='/tasks'){if(route.request().method()==='POST'){const input=route.request().postDataJSON();const task={...input,id:'task-'+(tasks.length+1),status:'queued',events:[]};tasks.unshift(task);return json(task,202);}return json(tasks);}
   return route.continue();
  });
  stage='app-bootstrap';await bootstrap.run('navigate-real-app',()=>page.goto(origin+'/__speech_app__/'));
  await bootstrap.run('event-center-ready',async()=>{await browserExpect(page.getByTestId('events-status')).toHaveAttribute('data-status','connected');});bootstrap.ready();stage='interaction';await page.getByTestId('pick-toggle').click();
  const frame=page.frameLocator('[data-testid="preview-frame"]');await frame.getByRole('button',{name:'A',exact:true}).click();await browserExpect(page.getByTestId('pick-state')).toHaveAttribute('data-kind','ready');
  await page.getByTestId('speech-record').hover();await page.mouse.down();await expect.poll(()=>page.evaluate(()=>window.__speechTest.recorderStarts)).toBe(1);await page.mouse.up();await page.getByTestId('speech-review').waitFor();expect(tasks).toHaveLength(0);
  holdVersion=true;const blursBefore=await page.evaluate(()=>window.__speechTest.parentBlurs);await frame.getByRole('button',{name:'B',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.__speechTest.parentBlurs)).toBeGreaterThan(blursBefore);await browserExpect(page.getByTestId('pick-state')).toHaveAttribute('data-kind','pending');await browserExpect(page.getByTestId('speech-review')).toBeVisible();expect(await page.getByTestId('speech-use').isDisabled()).toBe(true);
  await expect.poll(()=>!!releaseVersion).toBe(true);holdVersion=false;releaseVersion!();await browserExpect(page.getByTestId('pick-state')).toHaveAttribute('data-kind','ready');await page.getByTestId('speech-selection-conflict').waitFor();
  socket!.close();await browserExpect(page.getByTestId('events-status')).toHaveAttribute('data-status','reconnecting');await browserExpect(page.getByTestId('speech-review')).toBeVisible();await browserExpect(page.getByTestId('events-status')).toHaveAttribute('data-status','connected');
  await page.getByTestId('speech-use-current').click();expect(tasks).toHaveLength(0);await page.getByTestId('generate-candidate').click();await expect.poll(()=>tasks.length).toBe(1);expect(tasks[0].selection).toMatchObject({cid:'B'});
  version='v2';await page.getByTestId('state-refresh').click();await browserExpect(page.getByTestId('pick-state')).toHaveAttribute('data-kind','none');await page.getByTestId('instruction-input').fill('后续纯文字');expect(await page.getByTestId('speech-binding-conflict').count()).toBe(0);await page.getByTestId('instruction-input').press('Control+Enter');await expect.poll(()=>tasks.length).toBe(2);expect(tasks[0].instruction).toBe('后续纯文字');expect(posts).toHaveLength(1);
  expect(errors).toEqual([]);bootstrap.assertHealthy();expect(denied).toEqual([]);expect(await page.evaluate(()=>window.__speechTest.liveTracks)).toBe(0);
  if(process.env.D2_RUN_DIR){await mkdir(path.join(process.env.D2_RUN_DIR,'real-app'),{recursive:true});await page.screenshot({path:path.join(process.env.D2_RUN_DIR,'real-app/iframe-review.png')});await writeFile(path.join(process.env.D2_RUN_DIR,'real-app/result.json'),JSON.stringify({realApp:true,realEventCenter:true,crossOriginPreview:previewOrigin,parentBlurs:await page.evaluate(()=>window.__speechTest.parentBlurs),blursBeforeCrossOriginPick:blursBefore,apiSubstitutes:true,tasks,posts,errors,denied},null,2));}
 }catch(error){primary=error;console.error('[speech real App failure]',JSON.stringify({stage,primary:browserFailure(error),bootstrap:bootstrap?.snapshot(),pageErrors:errors,denied}));}
 finally{
  releaseVersion?.();const cleanup:unknown[]=[];
  if(primary!==undefined&&process.env.D2_RUN_DIR&&casePage&&!casePage.isClosed())try{await mkdir(path.join(process.env.D2_RUN_DIR,'real-app'),{recursive:true});await casePage.screenshot({path:path.join(process.env.D2_RUN_DIR,'real-app/bootstrap-failure.png')});}catch(error){cleanup.push(error);}
  bootstrap?.dispose();
  for(const close of [()=>context?.close(),()=>browser?.close(),()=>native?.close(),()=>vite?.close(),async()=>{preview?.closeAllConnections();if(preview?.listening)await closeLoopbackServer(preview);}])try{await close();}catch(error){cleanup.push(error);}
  if(vite?.httpServer?.listening||preview?.listening)cleanup.push(new Error('Real App fixture listener remains open'));
  if(native&&native.process().exitCode===null&&native.process().signalCode===null)cleanup.push(new Error('Owned Chromium server has not exited'));
  for(const endpoint of [origin,previewOrigin,native?.wsEndpoint()])if(endpoint)try{await speechPortClosed(endpoint);}catch(error){cleanup.push(error);}
  if(primary===undefined&&!cleanup.length)try{await rm(cache,{recursive:true,force:true});}catch(error){cleanup.push(error);}
  if(process.env.D2_RUN_DIR)try{await writeSpeechEvidence(process.env.D2_RUN_DIR,'real-app-cleanup.json',{pid:process.pid,origin,previewOrigin,stage,primary:primary===undefined?null:browserFailure(primary),bootstrap:bootstrap?.snapshot(),pageErrors:errors,denied,chromiumPid:native?.process().pid,chromiumExit:native?.process().exitCode,chromiumSignal:native?.process().signalCode,serverListening:vite?.httpServer?.listening??false,previewListening:preview?.listening??false,cacheRetained:primary!==undefined||cleanup.length?cache:null,vite:{mode:vite?.config.mode,optimizeDeps:vite?.config.optimizeDeps.include},errors:cleanup.map(browserFailure)});}catch(error){cleanup.push(error);}
  if(primary!==undefined||cleanup.length){console.error('[speech real App cleanup]',JSON.stringify({primary:primary===undefined?null:browserFailure(primary),cleanup:cleanup.map(browserFailure),bootstrap:bootstrap?.snapshot()}));throw new AggregateError([...(primary===undefined?[]:[primary]),...cleanup],'Real App speech fixture/cleanup failed');}
 }
},60_000);
