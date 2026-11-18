import path from 'node:path';
import {createApp} from '../../apps/server/src/app.ts';
import {createPreviewOrigin} from '../../apps/server/src/work/preview-origin.ts';
import {createMockServer} from '../../apps/server/src/assets/mock-server.ts';
import {codingMock,speechMock} from './mocks.mjs';
import {repository,assertMockEndpoint} from './safety.mjs';
import {loadPlan,ownedLifetime} from './runtime.mjs';
const closers=[];let stage='load-plan';
const stop=ownedLifetime(async()=>{const errors=[];for(const close of closers.reverse())try{await close();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Demo close failed');});
async function own(close){if(stop.closing){await close();throw new Error('Demo shutdown already started');}closers.push(close);}
async function listenOwned(app,port){await own(()=>app.close());await app.listen({host:'127.0.0.1',port});if(stop.closing){await app.close();throw new Error('Demo startup interrupted');}}
try{
 const plan=await loadPlan();const {ports}=plan;
 const options={workRoot:plan.work,dataDirectory:path.join(plan.run,'assets'),workDataDirectory:path.join(plan.run,'work-data'),historyDirectory:path.join(plan.run,'scene-history'),fallbackDirectory:path.join(repository,'fallback'),logger:false};
 if(plan.mode==='mock'){
  stage='mock-start';
  const endpoints={coding:`http://127.0.0.1:${ports.coding}`,lux3d:`http://127.0.0.1:${ports.lux3d}`,speech:`http://127.0.0.1:${ports.speech}/compatible-mode/v1`};
  for(const value of Object.values(endpoints))assertMockEndpoint(value);
  const coding=codingMock();await listenOwned(coding,ports.coding);
  const lux3d=await createMockServer({key:'mock-only',blockSize:1024*1024});await listenOwned(lux3d,ports.lux3d);
  const speech=speechMock();await listenOwned(speech,ports.speech);
  Object.assign(options,{base:endpoints.lux3d,key:'mock-only',pollMs:80,timeoutMs:60000,mockAssets:true,codingAgentBaseUrl:endpoints.coding,codingAgentApiKey:'mock-only',codingAgentModel:'mock-coder',speech:{baseUrl:endpoints.speech,apiKey:'mock-only',model:'qwen3-asr-flash',testLoopback:true}});
 }
 stage='app-init';const {app,workspace}=await createApp(options);await own(()=>app.close());
 workspace.enableDynamicMainPreview(ports.main);
 const preview=createPreviewOrigin(()=>workspace.current().work.previews,{mainPort:()=>workspace.activeMainPort()??ports.main,studioOrigin:`http://127.0.0.1:${ports.studio}`});
 const sockets=new Set();preview.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});
 const closePreview=async()=>{for(const socket of sockets)socket.destroy();preview.closeAllConnections();if(preview.listening)await new Promise((resolve,reject)=>preview.close(error=>error?reject(error):resolve()));};await own(closePreview);
 stage='listen';await new Promise((resolve,reject)=>{preview.once('error',reject);preview.listen(ports.preview,'127.0.0.1',resolve);});await app.listen({host:'127.0.0.1',port:ports.api});
 if(stop.closing){await closePreview();await app.close();throw new Error('Startup interrupted');}
 if(process.connected)process.send({type:'ready',role:'backend',pid:process.pid,ports:[ports.api,ports.preview],mode:plan.mode});
}catch(error){if(process.connected)process.send({type:'startup-error',role:'backend',pid:process.pid,stage,code:typeof error?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(error.code)?error.code:'DEMO_START_FAILED'});console.error('Demo backend could not start. Check safe configuration and retained run; no existing workspace was reset.');await stop();process.exitCode=1;}
