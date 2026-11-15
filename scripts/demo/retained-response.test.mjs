import {test} from 'node:test';
import assert from 'node:assert/strict';
import {retainStatusOnlyResponse,responseStamp} from './test-support/retained-response.mjs';
const url='http://127.0.0.1:29991/resource';
const flush=async()=>{await Promise.resolve();await Promise.resolve();};
function proof(){return {primaryAbsent:true,driverPid:1,closed:{code:0,signal:null},after:{status:'stopped',cleanup:{problems:[],children:[{role:'backend',pid:2,exit:0,signal:null,forced:false},{role:'frontends',pid:3,exit:0,signal:null,forced:false}]}},roleEvents:['backend','frontends'].flatMap((role,index)=>['role:exit','role:close'].map(event=>({role,childPid:index+2,event,code:0,signal:null}))),ownership:{ok:true,states:[1,2,3].map(pid=>({pid,state:'gone'})),listeners:[]},ownedPorts:[29991]};}
function socketError(port=29991){const cause=new Error('socket closed');cause.name='SocketError';cause.code='UND_ERR_SOCKET';cause.socket={remoteAddress:'127.0.0.1',remotePort:port,localAddress:'127.0.0.1',localPort:49999};return new TypeError('text is not the classification key',{cause});}
function fixture({closed=false,cancelError}={}){let controller;let cancels=0;const body=new ReadableStream({start(value){controller=value;if(closed)value.close();},cancel(){cancels++;if(cancelError)throw cancelError;}});const response=new Response(body,{status:200,headers:{connection:'keep-alive'}});Object.defineProperty(response,'url',{value:url});const lease=retainStatusOnlyResponse(response,url,'unit-response');return {response,lease,controller,cancels:()=>cancels};}

test('already closed retained response releases its reader lock without cancellation',async()=>{
 const current=fixture({closed:true});await flush();current.lease.markShutdown();const result=await current.lease.release(proof());assert.equal(result.classification.kind,'already-closed');assert.equal(current.cancels(),0);assert.equal(result.lockReleased,true);assert.equal(current.response.body.locked,false);assert.equal(result.readCalls,0);
});
test('observed post-shutdown socket terminal keeps original cause and releases without cancelling again',async context=>{
 const current=fixture();current.lease.markShutdown();const original=socketError();current.controller.error(original);await flush();const result=await current.lease.release(proof());
 assert.equal(result.classification.kind,'server-shutdown-socket-terminal');assert.equal(result.terminal.error.cause.code,'UND_ERR_SOCKET');assert.equal(result.terminal.error.cause.socket.remotePort,29991);assert.ok(result.terminal.monotonic>=result.shutdown.monotonic);assert.equal(current.cancels(),0);assert.equal(result.lockReleased,true);assert.equal(current.response.body.locked,false);
 context.diagnostic(JSON.stringify({classification:result.classification,terminal:result.terminal,shutdown:result.shutdown,lockReleased:result.lockReleased}));
});
test('socket failure observed before shutdown remains a failure while the lock is released',async()=>{
 const current=fixture();const original=socketError();current.controller.error(original);await flush();current.lease.markShutdown();await assert.rejects(current.lease.release(proof()),error=>error instanceof AggregateError&&error.errors.includes(original));assert.equal(current.lease.record.classification.checks.errorDuringOrAfterShutdown,false);assert.equal(current.cancels(),0);assert.equal(current.response.body.locked,false);
});
test('unknown causes, missing association, mismatched socket and unverified shutdown are never exempted',async context=>{
 const cases=[
  {name:'message-only terminated',error:()=>new TypeError('terminated')},
  {name:'other I/O cause',error:()=>{const cause=new Error('disk or other I/O');cause.code='EIO';return new TypeError('terminated',{cause});}},
  {name:'different remote endpoint',error:()=>socketError(29992)},
  {name:'unassociated response',error:()=>socketError(),changeRecord:record=>record.responseUrl=url+'-other'},
  {name:'forced role',error:()=>socketError(),changeProof:value=>value.after.cleanup.children[1].forced=true},
  {name:'native close absent',error:()=>socketError(),changeProof:value=>value.roleEvents=[]},
  {name:'identity query unknown',error:()=>socketError(),changeProof:value=>value.ownership.ok=false},
  {name:'primary failure exists',error:()=>socketError(),changeProof:value=>value.primaryAbsent=false},
  {name:'shutdown time absent',error:()=>socketError(),noMark:true}
 ];const outcomes=[];
 for(const item of cases){const current=fixture();if(!item.noMark)current.lease.markShutdown();const original=item.error();current.controller.error(original);await flush();if(item.changeRecord)item.changeRecord(current.lease.record);const facts=proof();if(item.changeProof)item.changeProof(facts);await assert.rejects(current.lease.release(facts),error=>error instanceof AggregateError&&error.errors.includes(original));assert.equal(current.lease.record.classification.expected,false,item.name);assert.equal(current.response.body.locked,false,item.name);assert.equal(current.cancels(),0,item.name);outcomes.push({name:item.name,checks:current.lease.record.classification.checks});}
 context.diagnostic(JSON.stringify(outcomes));
});
test('a still-readable retained stream is cancelled only after shutdown and its lock is released',async()=>{
 const current=fixture();await flush();assert.equal(current.response.bodyUsed,false);assert.equal(current.response.body.locked,true);assert.equal(current.cancels(),0);current.lease.markShutdown(responseStamp());const result=await current.lease.release(proof());assert.equal(current.cancels(),1);assert.equal(result.classification.kind,'closed-by-post-shutdown-release');assert.ok(result.cancelRequested.monotonic>=result.shutdown.monotonic);assert.equal(result.readCalls,0);assert.equal(result.bodyUsedAtShutdown,false);assert.equal(current.response.body.locked,false);
});
test('a new cancellation I/O rejection is not waived even when its message says terminated',async()=>{
 const cause=new Error('release failed');cause.code='EIO';const original=new TypeError('terminated',{cause});const current=fixture({cancelError:original});current.lease.markShutdown();await assert.rejects(current.lease.release(proof()),error=>error instanceof AggregateError&&error.errors.includes(original));assert.equal(current.lease.record.cancelError.error.cause.code,'EIO');assert.equal(current.response.body.locked,false);assert.equal(current.cancels(),1);
});
