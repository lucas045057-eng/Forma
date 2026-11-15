import {installWatcherTrace} from './watcher-observer.mjs';
import {appendFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {realpath,readdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {repository} from '../../scripts/demo/safety.mjs';
import {loadPlan,ownedLifetime} from '../../scripts/demo/runtime.mjs';
const require=createRequire(path.join(repository,'apps/server/package.json'));const templateRequire=createRequire(path.join(repository,'templates/product-page/package.json'));

const diagFile=process.env.FRONTEND_DIAG_LOG;if(!diagFile)throw new Error('Missing diagnostic log');
const watcherTrace=installWatcherTrace({file:diagFile+'.watchers.jsonl'});
function handles(){return (process._getActiveHandles?.()??[]).map(handle=>({watcher:watcherTrace.identify(handle),type:handle.constructor?.name,pid:handle.pid,fd:handle.fd,localAddress:handle.localAddress,localPort:handle.localPort,remoteAddress:handle.remoteAddress,remotePort:handle.remotePort,listening:handle.listening,destroyed:handle.destroyed,readableEnded:handle.readableEnded,writableEnded:handle.writableEnded,hasRef:typeof handle.hasRef==='function'?handle.hasRef():undefined}));}
const log=(event,value={})=>{watcherTrace.setPhase(event,value.label);appendFileSync(diagFile,JSON.stringify({at:new Date().toISOString(),pid:process.pid,event,...value})+'\n');};
const serverNames=new Map();
function resources(){return {watchers:watcherTrace.snapshot(),handles:handles(),requests:(process._getActiveRequests?.()??[]).map(item=>item.constructor?.name),servers:[...serverNames].map(([server,name])=>({name,listening:server.httpServer?.listening,environments:Object.entries(server.environments).map(([key,environment])=>({key,pending:environment._pendingRequests?.size,pendingIds:environment._pendingRequests?[...environment._pendingRequests.keys()]:[],processing:environment.pluginContainer?._processesing?.size}))}))};}
function trace(object,key,label){if(!object||typeof object[key]!=='function')return;const original=object[key];object[key]=function(...args){log('stage-begin',{label,resources:resources()});try{const result=Reflect.apply(original,this,args);if(result&&typeof result.then==='function')result.then(()=>log('stage-end',{label,resources:resources()}),error=>log('stage-error',{label,error:error?.stack??String(error),resources:resources()}));else log('stage-return',{label});return result;}catch(error){log('stage-error',{label,error:error?.stack??String(error)});throw error;}};}
function observeServer(server,name){serverNames.set(server,name);trace(server,'close',name+':vite.close');trace(server.watcher,'close',name+':watcher.close');trace(server.ws,'close',name+':ws.close');for(const [key,environment]of Object.entries(server.environments)){trace(environment,'close',name+':'+key+':environment.close');trace(environment.pluginContainer,'close',name+':'+key+':pluginContainer.close');trace(environment.depsOptimizer,'close',name+':'+key+':depsOptimizer.close');}
 const http=server.httpServer;if(http){const original=http.close;http.close=function(...args){log('stage-begin',{label:name+':http.close',resources:resources()});const callback=typeof args[0]==='function'?args[0]:undefined;return Reflect.apply(original,this,[function(error){log('http-close-callback',{name,error:error?.stack,resources:resources()});callback?.(error);}]);};
 http.on('connection',socket=>{const connection={name,localPort:socket.localPort,remotePort:socket.remotePort};log('http-connection',connection);for(const event of ['end','close','error'])socket.on(event,value=>log('http-socket:'+event,{...connection,error:value?.message,destroyed:socket.destroyed,readableEnded:socket.readableEnded,writableEnded:socket.writableEnded}));});
 http.on('request',(request,response)=>{log('http-request',{name,url:request.url,method:request.method});for(const event of ['finish','close','error'])response.on(event,error=>log('http-response:'+event,{name,url:request.url,status:response.statusCode,error:error?.message}));});http.on('close',()=>log('native-http-close',{name}));}
}
for(const event of ['message','disconnect','beforeExit','exit'])process.on(event,value=>log('process:'+event,{messageType:event==='message'?value?.type:undefined,code:typeof value==='number'?value:undefined,resources:resources()}));

const servers=[];let stage='load-plan';const stop=ownedLifetime(async()=>{log('owned-close-begin',{resources:resources()});const timer=setInterval(()=>log('owned-close-pending',{resources:resources()}),1000);timer.unref();try{const errors=[];for(const server of servers.reverse())try{await server.close();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Demo frontends could not close');}finally{clearInterval(timer);log('owned-close-finished',{resources:resources()});}});
async function ownServer(server){if(stop.closing){await server.close();throw new Error('Demo shutdown already started');}servers.push(server);await server.listen();if(stop.closing){await server.close();throw new Error('Demo startup interrupted');}}
try{
 const plan=await loadPlan();const {ports}=plan;
 stage='dependencies';const {createServer}=await import(pathToFileURL(require.resolve('vite')).href);
 const {default:react}=await import(pathToFileURL(require.resolve('@vitejs/plugin-react')).href);
 const {default:sourceTag}=await import(pathToFileURL(templateRequire.resolve('@spatial/vite-plugin-source-tag')).href);
 const allow=new Set([plan.work]);
 async function packages(folder){for(const entry of await readdir(folder)){if(entry.startsWith('.'))continue;const location=path.join(folder,entry);if(entry.startsWith('@')){await packages(location);continue;}const actual=await realpath(location);allow.add(actual);const pieces=actual.split(path.sep);const index=pieces.lastIndexOf('.pnpm');if(index>=0)allow.add(pieces.slice(0,index+1).join(path.sep));}}
 await packages(path.join(plan.work,'node_modules'));
 const deny=['**/.env*','**/*.{pem,key,crt,p12,pfx,bak,tmp}','**/.git/**'];
 stage='preview-listen';const main=await createServer({root:plan.work,configFile:false,envFile:false,cacheDir:path.join(plan.run,'cache-main'),base:'/preview/main/',plugins:[sourceTag(),react()],server:{host:'127.0.0.1',port:ports.main,strictPort:true,fs:{strict:true,allow:[...allow],deny},hmr:{clientPort:ports.preview,path:'/hmr'}}});observeServer(main,'main');await ownServer(main);
 const target=`http://127.0.0.1:${ports.api}`;const proxy=Object.fromEntries(['/health','/speech','/scene','/assets','/tasks','/candidates','/version','/approvals','/checks','/events'].map(prefix=>[prefix,{target,...(prefix==='/events'?{ws:true}:{})}]));
 stage='studio-listen';const studio=await createServer({root:path.join(repository,'apps/studio'),configFile:false,envFile:false,cacheDir:path.join(plan.run,'cache-studio'),plugins:[react()],define:{'import.meta.env.VITE_PREVIEW_ORIGIN':JSON.stringify(`http://127.0.0.1:${ports.preview}`),'import.meta.env.VITE_DEMO_MODE':JSON.stringify(plan.mode)},server:{host:'127.0.0.1',port:ports.studio,strictPort:true,cors:false,headers:{'Cross-Origin-Resource-Policy':'same-origin'},proxy,fs:{strict:true,allow:[path.join(repository,'apps/studio'),path.join(repository,'packages'),path.join(repository,'node_modules')],deny}}});observeServer(studio,'studio');await ownServer(studio);
 if(process.connected)process.send({type:'ready',role:'frontends',pid:process.pid,ports:[ports.main,ports.studio],mode:plan.mode});
}catch(error){if(process.connected)process.send({type:'startup-error',role:'frontends',pid:process.pid,stage,code:typeof error?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:'DEMO_START_FAILED'});console.error('Demo frontends could not start. Ports, locked dependencies and retained run require inspection; env files were not loaded.');await stop();process.exitCode=1;}
