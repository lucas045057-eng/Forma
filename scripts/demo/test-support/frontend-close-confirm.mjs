import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,appendFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {repository,systemEnvironment} from '../safety.mjs';
import {retainStatusOnlyResponse,responseStamp,describeResponseError} from './retained-response.mjs';
const execute=promisify(execFile);const environment=systemEnvironment();
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const bounded=async(promise,ms,label)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}finally{clearTimeout(timer);}};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const errorDetail=error=>describeResponseError(error);
let cleanupUnconfirmed=false;
async function snapshot(ports=[]){
 const numbers=[...new Set(ports)];assert.ok(numbers.every(number=>Number.isInteger(number)&&number>0&&number<=65535));
 const script="$ErrorActionPreference='Stop'; $processes=@(Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;parent=$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o')} }); $ports=@("+numbers.join(',')+"); $listeners=@(); if($ports.Count){$listeners=@(Get-NetTCPConnection -State Listen | Where-Object { $ports -contains $_.LocalPort } | ForEach-Object { [pscustomobject]@{port=$_.LocalPort;pid=$_.OwningProcess;address=$_.LocalAddress} })}; [pscustomobject]@{processes=$processes;listeners=$listeners}|ConvertTo-Json -Depth 4 -Compress";
 try{return{ok:true,...JSON.parse((await execute('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{env:environment,encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:2*1024*1024})).stdout)};}catch(error){return{ok:false,error:errorDetail(error)};}
}
function family(table,root){const result=[{...root,depth:0}];for(let index=0;index<result.length;index++)for(const row of table)if(row.parent===result[index].pid&&Date.parse(row.created)>=Date.parse(result[index].created)&&!result.some(old=>old.pid===row.pid))result.push({...row,depth:result[index].depth+1});return result;}
function states(identities,current){return identities.map(old=>{if(!current.ok||!old.created)return{...old,state:'unknown'};const row=current.processes.find(item=>item.pid===old.pid);return{...old,state:!row?'gone':row.created===old.created?'alive':'reused'};});}
function ownRun(run){const base=path.join(repository,'.data/demo-runs');const relative=path.relative(base,path.resolve(run));assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative));return path.resolve(run);}
async function json(file){return JSON.parse(await readFile(file,'utf8'));}
async function waitFor(read,ms,label){const deadline=Date.now()+ms;while(Date.now()<deadline){const value=await read();if(value)return value;await delay(50);}throw new Error(label);}

async function proveHmr(record,log){
 let server,browser,context;const errors=[];const pageErrors=[];const denied=[];const frames=[];let initial;
 try{
  server=await chromium.launchServer({headless:true,host:'127.0.0.1',env:environment,args:['--disable-background-networking','--disable-component-update','--no-first-run']});const child=server.process();record.browser={pid:child.pid,events:[]};
  for(const event of ['exit','close','error'])child.on(event,(code,signal)=>record.browser.events.push({event,at:new Date().toISOString(),code:typeof code==='number'?code:undefined,signal,error:code?.message}));
  initial=await snapshot();assert.ok(initial.ok,'HMR browser identity query failed');const root=initial.processes.find(row=>row.pid===child.pid&&row.parent===process.pid);assert.ok(root,'Owned HMR Chromium root identity required');record.browser.identities=family(initial.processes,root);
  browser=await chromium.connect(server.wsEndpoint());context=await browser.newContext();
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(['data:','blob:'].includes(url.protocol)||url.hostname==='127.0.0.1')return route.continue();denied.push({origin:url.origin,path:url.pathname});return route.abort();});
  await context.routeWebSocket(url=>url.hostname!=='127.0.0.1',route=>{const url=new URL(route.url());denied.push({origin:url.origin,path:url.pathname,websocket:true});route.close();});
  const page=await context.newPage();let navigations=0;page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations++;});page.on('pageerror',error=>pageErrors.push(error.message));
  page.on('websocket',socket=>{const url=new URL(socket.url());socket.on('framereceived',frame=>{try{const data=JSON.parse(String(frame.payload));frames.push({at:new Date().toISOString(),origin:url.origin,path:url.pathname,type:data.type,updates:data.updates?.map(update=>({type:update.type,path:update.path,acceptedPath:update.acceptedPath}))});}catch{}});});
  await page.goto(`http://127.0.0.1:${record.plan.ports.preview}/preview/main/`,{waitUntil:'domcontentloaded',timeout:30000});
  await waitFor(()=>frames.some(frame=>frame.type==='connected'),15000,'Real Vite HMR socket did not connect');
  await page.waitForFunction(()=>document.querySelector('style[data-vite-dev-id*="style.css"]')!==null,{},{timeout:15000});
  const work=record.plan.work;const css=path.join(work,'src/style.css');assert.ok(path.relative(record.run,css)&&!path.relative(record.run,css).startsWith('..'));
  const before=await readFile(css);const marker='focused-'+Date.now();const after=Buffer.concat([before,Buffer.from(`\nhtml { --m4-focused-hmr: ${marker}; }\n`)]);const baseline=frames.length;const navigationBaseline=navigations;
  await writeFile(css,after);await page.waitForFunction(expected=>getComputedStyle(document.documentElement).getPropertyValue('--m4-focused-hmr').trim()===expected,marker,{timeout:15000});
  const updates=frames.slice(baseline).filter(frame=>frame.type==='update'&&frame.updates?.some(update=>update.path.includes('style.css')));assert.ok(updates.length,'CSS value changed without a matching real HMR update frame');assert.equal(navigations,navigationBaseline,'HMR must not be replaced by document reload');assert.deepEqual(denied,[],'Browser attempted non-loopback resources');
  record.hmr={marker,workCss:css,beforeHash:sha(before),afterHash:sha(after),updates,frames,pageErrors,denied,navigationsBefore:navigationBaseline,navigationsAfter:navigations,computedMarker:await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--m4-focused-hmr').trim()),scope:'Only new isolated demo work CSS changed; original template untouched'};await log('hmr-proven',record.hmr);
 }catch(error){errors.push(error);}
 finally{
  if(record.browser?.identities)try{const current=await snapshot();assert.ok(current.ok,'Pre-close HMR browser identity query failed');for(const ancestor of [...record.browser.identities])if(current.processes.some(item=>item.pid===ancestor.pid&&item.created===ancestor.created))for(const item of family(current.processes,ancestor))if(!record.browser.identities.some(old=>old.pid===item.pid&&old.created===item.created))record.browser.identities.push(item);}catch(error){errors.push(error);}
  try{if(context)await bounded(context.close(),10000,'HMR context close deadline');}catch(error){errors.push(error);}
  try{if(browser)await bounded(browser.close(),10000,'HMR browser connection close deadline');}catch(error){errors.push(error);}
  try{if(server)await bounded(server.close(),15000,'HMR browser server close deadline');}catch(error){errors.push(error);}
  if(record.browser?.identities){const current=await snapshot();record.browser.after=states(record.browser.identities,current);if(record.browser.after.some(item=>['alive','unknown'].includes(item.state)))errors.push(new Error('Owned HMR browser exit unconfirmed'));}
  record.hmr??={frames,pageErrors,denied,unverified:true};
 }
 if(errors.length)throw new AggregateError(errors,'Running HMR proof or its cleanup failed');
}

export async function confirmFrontendClose(kind){
 assert.ok(['no-request','consumed','status-only'].includes(kind));assert.equal(cleanupUnconfirmed,false,'Previous cleanup unknown; no further service is started');
 const base=process.env.FRONTEND_CLOSE_RUN_DIR;assert.ok(base&&path.isAbsolute(base),'Focused output directory required');const directory=path.join(base,kind);await mkdir(directory,{recursive:false});
 const record={kind,started:new Date().toISOString(),directory,identities:[],native:[],requests:[],fallbackKills:[],cleanupErrors:[]};const pendingWrites=[];
 const log=(event,value={})=>{const entry={...responseStamp(),event,...value};record.native.push(entry);const writing=appendFile(path.join(directory,'controller-events.jsonl'),JSON.stringify(entry)+'\n');pendingWrites.push(writing);writing.catch(()=>{});return writing;};
 const child=spawn(process.execPath,[fileURLToPath(new URL('./frontend-close-driver.mjs',import.meta.url))],{cwd:repository,env:{...environment,FRONTEND_CLOSE_CASE_DIR:directory},execArgv:[],stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});record.pid=child.pid;
 let closedResult;const closed=new Promise(resolve=>child.once('close',(code,signal)=>{closedResult={code,signal};record.nativeCloseObserved=responseStamp();resolve(closedResult);}));
 for(const event of ['spawn','exit','close','disconnect','error'])child.on(event,(code,signal)=>{void log(event,{pid:child.pid,code:typeof code==='number'?code:undefined,signal,error:code?.stack,exitCode:child.exitCode,signalCode:child.signalCode,connected:child.connected});});
 for(const name of ['stdout','stderr']){child[name].on('data',bytes=>{const writing=appendFile(path.join(directory,'driver.'+name+'.log'),bytes);pendingWrites.push(writing);writing.catch(()=>{});});for(const event of ['end','close','error'])child[name].on(event,error=>{void log(name+':'+event,{error:error?.stack,destroyed:child[name].destroyed,readableEnded:child[name].readableEnded,closed:child[name].closed});});}
 child.on('message',message=>{if(message?.type==='prepared'&&message.pid===child.pid)record.run=ownRun(message.run);void log('ipc-message',message);});
 const responses=[];const retentions=new Map();record.retainedResponses=[];let primary;let shutdown;
 const shutdownDemo=()=>shutdown??=(async()=>{if(!closedResult){assert.equal(child.connected,true,'Running driver IPC disappeared before shutdown request');record.shutdownRequestedStamp=responseStamp();record.shutdownRequested=record.shutdownRequestedStamp.at;for(const lease of retentions.values())lease.markShutdown(record.shutdownRequestedStamp);void log('production-shutdown-request',{shutdown:record.shutdownRequestedStamp});child.send({type:'sigint'});}const result=await bounded(closed,105000,'Focused native close observation deadline; product still uses 45s per role');record.closed=result;return result;})();
 try{
  const initial=await snapshot();record.initialQuery={ok:initial.ok,error:initial.error};assert.ok(initial.ok,'Initial process query failed');const root=initial.processes.find(item=>item.pid===child.pid&&item.parent===process.pid);assert.ok(root,'Focused launcher creation identity required');record.identities=family(initial.processes,root);
  await waitFor(async()=>{if(closedResult)throw new Error('Real demo closed before ready');if(!record.run)return false;try{const manifest=await json(path.join(record.run,'manifest.json'));if(manifest.status==='running'){record.before=manifest;record.plan=await json(path.join(record.run,'plan.json'));return true;}if(['cleanup_failed','stopped','interrupted'].includes(manifest.status))throw new Error('Real demo failed during startup');}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}return false;},75000,'Real production demo did not become ready');
  const ready=await snapshot(Object.values(record.plan.ports));assert.ok(ready.ok,'Ready PID/port query failed');const currentRoot=ready.processes.find(item=>item.pid===root.pid&&item.created===root.created);assert.ok(currentRoot,'Launcher identity changed');record.identities=family(ready.processes,currentRoot);record.listenersBefore=ready.listeners;
  for(const role of ['backend','frontends']){const owned=record.before.children.find(item=>item.role===role);assert.ok(owned&&record.identities.some(item=>item.pid===owned.pid&&item.parent===child.pid),'Ready production role ownership required');for(const key of role==='backend'?['api','preview','coding','lux3d','speech']:['studio','main'])assert.ok(ready.listeners.some(item=>item.port===record.plan.ports[key]&&item.pid===owned.pid),'Real role must own its own '+key+' port');}
  if(kind!=='no-request'){
   const external=path.join(repository,'packages/scene-renderer/src/index.tsx').replaceAll('\\','/');
   const urls=[`http://127.0.0.1:${record.plan.ports.studio}/`,`http://127.0.0.1:${record.plan.ports.api}/health`,`http://127.0.0.1:${record.plan.ports.preview}/preview/main/`,`http://127.0.0.1:${record.plan.ports.main}/preview/main/@fs/${encodeURI(external)}`];
   for(const url of urls){const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),15000);let response;try{response=await fetch(url,{signal:abort.signal});}finally{clearTimeout(timer);}responses.push(response);const request={url,status:response.status,bodyUsedAtHeaders:response.bodyUsed};record.requests.push(request);assert.equal(response.status,200,'Real endpoint/external module must load');if(kind==='consumed'){request.bytes=(await bounded(response.arrayBuffer(),15000,'Full response consumption deadline')).byteLength;request.bodyUsedAfter=response.bodyUsed;}else{const lease=retainStatusOnlyResponse(response,url,kind+':'+record.requests.length,event=>log('retained-response',{responseEvent:event}));retentions.set(response,lease);record.retainedResponses.push(lease.record);request.retained=true;request.retentionId=lease.record.id;request.bodyUsedAfter=response.bodyUsed;request.bodyLockedAfter=response.body.locked;}await log('http-response',request);}
   if(kind==='consumed')await proveHmr(record,log);
  }
  const preClose=await snapshot();assert.ok(preClose.ok,'Pre-close identities unavailable');for(const ancestor of [...record.identities])if(preClose.processes.some(item=>item.pid===ancestor.pid&&item.created===ancestor.created))for(const item of family(preClose.processes,ancestor))if(!record.identities.some(old=>old.pid===item.pid&&old.created===item.created))record.identities.push(item);
  const result=await shutdownDemo();assert.deepEqual(result,{code:0,signal:null},'Production driver must exit and close naturally');record.after=await json(path.join(record.run,'manifest.json'));assert.equal(record.after.status,'stopped');assert.deepEqual(record.after.cleanup.problems,[]);
  for(const role of record.after.cleanup.children){assert.equal(role.exit,0);assert.equal(role.signal,null);assert.equal(role.forced,false);}
  const roleEvents=(await readFile(path.join(directory,'driver-events.jsonl'),'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line));record.roleEvents=roleEvents;
  for(const role of ['backend','frontends'])for(const event of ['role:exit','role:close']){const actual=roleEvents.filter(item=>item.role===role&&item.event===event);assert.equal(actual.length,1,'One real '+role+' '+event+' required');assert.equal(actual[0].code,0);assert.equal(actual[0].signal,null);}
  const after=await snapshot(Object.values(record.plan.ports));record.afterIdentities=states(record.identities,after);record.responseOwnership={ok:after.ok,states:record.afterIdentities,listeners:after.listeners??null};assert.equal(after.ok,true,'Cleanup query unknown is not gone');assert.deepEqual(record.afterIdentities.filter(item=>['alive','unknown'].includes(item.state)),[]);assert.deepEqual(after.listeners,[],'Every owned demo port must be released');record.listenersAfter=after.listeners;
 }catch(error){primary=error;record.primary=errorDetail(error);}
 finally{
  try{if(!closedResult)await shutdownDemo();}catch(error){record.cleanupErrors.push(errorDetail(error));}
  const responseProof={primaryAbsent:primary===undefined,driverPid:record.pid,closed:record.closed,after:record.after,roleEvents:record.roleEvents,ownership:record.responseOwnership,ownedPorts:record.plan?Object.values(record.plan.ports):[]};
  for(const lease of retentions.values())try{await lease.release(responseProof);}catch(error){record.cleanupErrors.push({responseId:lease.record.id,url:lease.record.requestUrl,releaseObserved:responseStamp(),...errorDetail(error)});}
  for(const response of responses)if(!retentions.has(response)&&response.body&&!response.bodyUsed)try{await bounded(response.body.cancel(),2000,'Unobserved failed response cleanup deadline');}catch(error){record.cleanupErrors.push({url:response.url,releaseObserved:responseStamp(),...errorDetail(error)});}
  try{
   let current=await snapshot();assert.ok(current.ok,'Failure cleanup process query failed');
   if(!record.identities.some(item=>item.pid===child.pid)){const held=current.processes.find(item=>item.pid===child.pid&&item.parent===process.pid&&Date.parse(item.created)<=Date.parse(record.started));if(held&&child.exitCode===null&&child.signalCode===null)record.identities=family(current.processes,held);else throw new Error('Launcher creation identity unavailable; descendants remain unknown');}
   for(const ancestor of [...record.identities])if(current.processes.some(item=>item.pid===ancestor.pid&&item.created===ancestor.created))for(const item of family(current.processes,ancestor))if(!record.identities.some(old=>old.pid===item.pid&&old.created===item.created))record.identities.push(item);
   if(record.browser?.identities)for(const item of record.browser.identities)if(!record.identities.some(old=>old.pid===item.pid&&old.created===item.created))record.identities.push(item);
   for(const owned of [...record.identities].sort((a,b)=>b.depth-a.depth)){current=await snapshot();assert.ok(current.ok,'Failure cleanup revalidation failed');if(current.processes.some(item=>item.pid===owned.pid&&item.created===owned.created)){process.kill(owned.pid,'SIGKILL');record.fallbackKills.push({...owned,reason:'Failure cleanup only; never successful natural close'});}}
   await bounded(closed,5000,'Owned driver cleanup close deadline');const final=await snapshot(record.plan?Object.values(record.plan.ports):[]);record.remaining=states(record.identities,final).filter(item=>['alive','unknown'].includes(item.state));record.finalListeners=final.ok?final.listeners:null;assert.ok(final.ok,'Final process/port query unknown');assert.deepEqual(record.remaining,[]);assert.deepEqual(record.finalListeners,[]);assert.deepEqual(record.fallbackKills,[],'Forced fallback is never a successful confirmation');
  }catch(error){record.cleanupErrors.push(errorDetail(error));record.remaining??=[{state:'unknown'}];cleanupUnconfirmed=true;if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');record.fallbackKills.push({pid:child.pid,reason:'Direct owned handle only after failed identity cleanup'});}}
  const writes=await Promise.allSettled(pendingWrites);for(const result of writes)if(result.status==='rejected')record.cleanupErrors.push(errorDetail(result.reason));record.finished=new Date().toISOString();
  try{await writeFile(path.join(directory,'result.json'),JSON.stringify(record,null,2)+'\n');}catch(error){record.cleanupErrors.push(errorDetail(error));}
 }
 const errors=[...(primary?[primary]:[]),...record.cleanupErrors.map(value=>new Error(value.message))];if(errors.length)throw new AggregateError(errors,'Focused '+kind+' failed; raw evidence retained at '+directory);
 return record;
}
