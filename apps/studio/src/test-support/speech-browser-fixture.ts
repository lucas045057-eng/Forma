import type {Page} from '@playwright/test';
import type {InlineConfig} from 'vite';
import {mkdir,writeFile} from 'node:fs/promises';
import {createConnection} from 'node:net';
import path from 'node:path';

// Real installed React entry points; esbuild follows their CJS dependencies (including scheduler).
export function speechBrowserVite():InlineConfig{return {
 mode:'development',configFile:false,envFile:false,
 esbuild:{jsx:'automatic',jsxDev:true},
 optimizeDeps:{noDiscovery:true,include:['react','react-dom','react-dom/client','react/jsx-runtime','react/jsx-dev-runtime']},
};}
export function browserFailure(error:unknown):unknown{
 if(error instanceof AggregateError)return {name:error.name,message:error.message,stack:error.stack,errors:error.errors.map(browserFailure)};
 if(error instanceof Error)return {name:error.name,message:error.message,stack:error.stack,...('cause'in error&&error.cause!==error?{cause:browserFailure(error.cause)}:{})};
 if(error&&typeof error==='object'&&'message'in error)return {name:'name'in error?String(error.name):'Error',message:String(error.message),stack:'stack'in error?String(error.stack):undefined};
 return String(error);
}
export function observeSpeechBootstrap(page:Page,pageErrors:string[]){
 let phase='page-created';let ready=false;let fatal:Error|undefined;
 const errors:Array<{phase:string;url:string;message:string;stack?:string}>=[];
 const resources:Array<{phase:string;url:string;message:string}>=[];
 const phases:Array<{phase:string;ms:number}>=[];const start=performance.now();const waiters=new Set<(error:Error)=>void>();
 const fault=(error:Error)=>{fatal??=error;for(const reject of waiters)reject(error);};
 const pageError=(error:Error)=>{pageErrors.push(error.message);errors.push({phase,url:page.url(),message:error.message,stack:error.stack});fault(error);};
 const crashed=()=>fault(new Error(`Speech fixture page crashed at ${phase}: ${page.url()}`));
 const requestFailed=(request:import('@playwright/test').Request)=>{
  if(!['script','document'].includes(request.resourceType()))return;
  const value={phase,url:request.url(),message:request.failure()?.errorText??'Module/document request failed'};resources.push(value);fault(new Error(JSON.stringify(value)));
 };
 const responseFailed=(response:import('@playwright/test').Response)=>{
  if(response.status()<400||!['script','document'].includes(response.request().resourceType()))return;
  const value={phase,url:response.url(),message:`HTTP ${response.status()}`};resources.push(value);fault(new Error(JSON.stringify(value)));
 };
 page.on('pageerror',pageError);page.on('crash',crashed);page.on('requestfailed',requestFailed);page.on('response',responseFailed);
 const snapshot=()=>({phase,url:page.url(),ready,phases,errors,resources});
 return {
  snapshot,
  async run<T>(name:string,work:()=>Promise<T>):Promise<T>{
   phase=name;phases.push({phase,ms:performance.now()-start});
   let rejectFault:((error:Error)=>void)|undefined;
   try{
    if(fatal)throw fatal;
    const broken=new Promise<never>((_resolve,reject)=>{rejectFault=reject;waiters.add(reject);});
    return await Promise.race([broken,Promise.resolve().then(work)]);
   }catch(error){throw new Error(`Speech fixture bootstrap failed: ${error instanceof Error?error.message:String(error)}; ${JSON.stringify(snapshot())}`,{cause:error});}
   finally{if(rejectFault)waiters.delete(rejectFault);}
  },
  ready(){if(fatal)throw fatal;ready=true;phase='interaction';phases.push({phase,ms:performance.now()-start});},
  assertHealthy(){if(fatal)throw new Error(`Speech fixture browser error: ${JSON.stringify(snapshot())}`,{cause:fatal});},
  dispose(){page.off('pageerror',pageError);page.off('crash',crashed);page.off('requestfailed',requestFailed);page.off('response',responseFailed);waiters.clear();},
 };
}
export type SpeechBootstrap=ReturnType<typeof observeSpeechBootstrap>;
export async function writeSpeechEvidence(base:string,relative:string,value:unknown){const file=path.join(base,relative);await mkdir(path.dirname(file),{recursive:true});await writeFile(file,JSON.stringify(value,null,2)+'\n');}
export async function speechPortClosed(endpoint:string){const url=new URL(endpoint);await new Promise<void>((resolve,reject)=>{
 const socket=createConnection({host:url.hostname,port:Number(url.port)});
 socket.once('connect',()=>{socket.destroy();reject(new Error('Owned speech fixture port still listening'));});
 socket.once('error',(error:NodeJS.ErrnoException)=>{socket.destroy();if(error.code==='ECONNREFUSED')resolve();else reject(error);});
 socket.setTimeout(1000,()=>{socket.destroy();reject(new Error('Speech fixture port close probe timed out'));});
});}
