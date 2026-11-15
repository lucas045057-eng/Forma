import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';

export function responseStamp(){return {at:new Date().toISOString(),monotonic:performance.now()};}
export function describeResponseError(error,depth=0){
 if(error===null||typeof error!=='object')return {value:String(error)};
 const result={name:error.name,message:error.message,stack:error.stack,code:error.code};
 if(depth>=6)return {...result,truncated:true};
 if(error.cause!==undefined)result.cause=describeResponseError(error.cause,depth+1);
 if(error.socket&&typeof error.socket==='object')result.socket=Object.fromEntries(['localAddress','localPort','remoteAddress','remotePort','remoteFamily','timeout','bytesWritten','bytesRead'].filter(key=>error.socket[key]!==undefined).map(key=>[key,error.socket[key]]));
 if(error instanceof AggregateError)result.errors=error.errors.map(value=>describeResponseError(value,depth+1));
 return result;
}
function naturalProduction(proof){
 const cleanup=proof?.after?.cleanup;const children=cleanup?.children;const states=proof?.ownership?.states;const events=proof?.roleEvents;
 return proof?.primaryAbsent===true&&proof.closed?.code===0&&proof.closed.signal===null&&proof.after?.status==='stopped'&&Array.isArray(cleanup?.problems)&&cleanup.problems.length===0&&Array.isArray(children)&&children.length===2&&['backend','frontends'].every(role=>children.some(item=>item.role===role&&item.exit===0&&item.signal===null&&item.forced===false))&&Array.isArray(events)&&['backend','frontends'].every(role=>['role:exit','role:close'].every(event=>{const matches=events.filter(item=>item.role===role&&item.event===event);return matches.length===1&&matches[0].childPid===children.find(item=>item.role===role)?.pid&&matches[0].code===0&&matches[0].signal===null;}))&&proof.ownership?.ok===true&&Array.isArray(states)&&states.length>=3&&[proof.driverPid,...children.map(item=>item.pid)].every(pid=>Number.isSafeInteger(pid)&&states.some(item=>item.pid===pid&&['gone','reused'].includes(item.state)))&&states.every(item=>['gone','reused'].includes(item.state))&&Array.isArray(proof.ownership.listeners)&&proof.ownership.listeners.length===0;
}
export function classifyRetainedTerminal(record,proof){
 if(record.terminal?.kind==='closed')return {expected:true,kind:record.cancelRequested?'closed-by-post-shutdown-release':'already-closed',checks:{terminalObserved:true}};
 if(record.terminal?.kind!=='errored')return {expected:false,kind:'not-terminal',checks:{terminalObserved:false}};
 const error=record.terminal.error;let url;try{url=new URL(record.requestUrl);}catch{}
 const socket=error?.cause?.socket;const checks={
  retainedStatusOnly:record.mode==='status-only'&&record.retained===true,
  associatedResponse:typeof record.id==='string'&&record.id.length>0&&record.responseUrl===record.requestUrl&&record.status===200&&url?.hostname==='127.0.0.1'&&proof?.ownedPorts?.includes(Number(url.port))===true,
  unconsumedAtShutdown:record.bodyUsedAtHeaders===false&&record.bodyUsedAtShutdown===false&&record.readCalls===0&&record.lockedAtShutdown===true,
  errorDuringOrAfterShutdown:Number.isFinite(record.shutdown?.monotonic)&&Number.isFinite(record.terminal.monotonic)&&record.terminal.monotonic>=record.shutdown.monotonic,
  noEarlyCancellation:!record.cancelRequested||record.cancelRequested.monotonic>=record.shutdown?.monotonic,
  originalSocketCause:error?.name==='TypeError'&&error?.cause?.code==='UND_ERR_SOCKET',
  socketEndpointConsistent:(!socket||socket.remotePort===undefined||socket.remotePort===Number(url?.port))&&(!socket||socket.remoteAddress===undefined||['127.0.0.1','::ffff:127.0.0.1'].includes(socket.remoteAddress)),
  productionNaturallyClosed:naturalProduction(proof)
 };
 return {expected:Object.values(checks).every(Boolean),kind:Object.values(checks).every(Boolean)?'server-shutdown-socket-terminal':'unexpected-stream-error',checks};
}
const bounded=async(promise,ms)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Retained reader cancellation did not settle')),ms);})]);}finally{clearTimeout(timer);}};

export function retainStatusOnlyResponse(response,requestUrl,id,onEvent=()=>{}){
 const canonical=new URL(requestUrl).href;assert.equal(response.url,canonical,'Retained reader must be bound to the exact successful request URL');assert.equal(response.status,200);assert.equal(response.bodyUsed,false);assert.ok(response.body,'A body stream is required');
 const reader=response.body.getReader();const record={id,mode:'status-only',retained:true,requestUrl:canonical,responseUrl:response.url,status:response.status,headersObserved:responseStamp(),headers:{connection:response.headers.get('connection'),contentLength:response.headers.get('content-length')},bodyUsedAtHeaders:response.bodyUsed,readCalls:0,lockedAfterAcquire:response.body.locked,state:'readable',events:[],observationErrors:[]};
 let originalError;let releasing=false;let released=false;let releasePromise;
 const note=(event,value={})=>{const entry={...responseStamp(),event,id,url:canonical,...value};record.events.push(entry);try{const writing=onEvent(entry);if(writing?.catch)writing.catch(error=>record.observationErrors.push(describeResponseError(error)));}catch(error){record.observationErrors.push(describeResponseError(error));}};
 reader.closed.then(()=>{record.state='closed';record.terminal={kind:'closed',...responseStamp()};note('reader-closed',{terminal:record.terminal});},error=>{if(releasing||released){note('reader-rejection-after-lock-release',{error:describeResponseError(error)});return;}originalError=error;record.state='errored';record.terminal={kind:'errored',...responseStamp(),error:describeResponseError(error)};note('reader-errored',{terminal:record.terminal});});
 note('reader-acquired-without-read',{bodyUsed:response.bodyUsed,locked:response.body.locked});
 return {
  record,
  markShutdown(stamp=responseStamp()){
   assert.equal(record.shutdown,undefined,'Response shutdown mark must be unique');record.shutdown=stamp;record.bodyUsedAtShutdown=response.bodyUsed;record.lockedAtShutdown=response.body.locked;note('shutdown-mark',{shutdown:stamp,bodyUsed:response.bodyUsed,locked:response.body.locked});
  },
  release(proof){return releasePromise??=(async()=>{
   const errors=[];record.releaseStarted=responseStamp();note('release-begin',{state:record.state,bodyUsed:response.bodyUsed,locked:response.body.locked});await Promise.resolve();
   try{
    if(record.state==='readable'){
     if(!record.shutdown||!naturalProduction(proof))errors.push(new Error('Readable retained response lacks verified completed production shutdown'));
     record.cancelRequested=responseStamp();note('reader-cancel-after-shutdown',{cancelRequested:record.cancelRequested});
     try{await bounded(reader.cancel(),2000);record.cancelCompleted=responseStamp();note('reader-cancel-completed');}catch(error){record.cancelError={...responseStamp(),error:describeResponseError(error)};note('reader-cancel-rejected',record.cancelError);await Promise.resolve();if(record.terminal?.kind!=='errored'||originalError!==error)errors.push(error);}
     await Promise.resolve();
    }
    record.classification=classifyRetainedTerminal(record,proof);note('terminal-classified',{classification:record.classification,terminal:record.terminal});
    if(!record.classification.expected)errors.push(originalError??new Error('Retained response terminal state is unverified'));
   }finally{
    releasing=true;try{reader.releaseLock();record.lockReleased=!response.body.locked;note('reader-lock-released',{locked:response.body.locked});assert.equal(record.lockReleased,true);}catch(error){record.lockReleaseError=describeResponseError(error);errors.push(error);}released=true;
   }
   await Promise.resolve();if(record.observationErrors.length)errors.push(new Error('Retained response observation or evidence write failed'));record.releaseFinished=responseStamp();note('release-finished',{errors:errors.map(error=>describeResponseError(error)),state:record.state,lockReleased:record.lockReleased});
   if(errors.length)throw new AggregateError(errors,'Retained response cleanup failed for '+canonical);
   return record;
  })();}
 };
}
