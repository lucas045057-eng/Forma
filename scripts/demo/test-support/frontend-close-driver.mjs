import {appendFileSync} from 'node:fs';
import {channel} from 'node:diagnostics_channel';
import path from 'node:path';
import {launch} from '../launch.mjs';
import {prepareDemo} from '../prepare.mjs';
import {repository} from '../safety.mjs';

const directory=process.env.FRONTEND_CLOSE_CASE_DIR;
if(!directory||!path.isAbsolute(directory)||!process.send)throw new Error('Focused driver requires its own evidence directory and parent IPC');
const log=(event,value={})=>appendFileSync(path.join(directory,'driver-events.jsonl'),JSON.stringify({at:new Date().toISOString(),pid:process.pid,event,...value})+'\n');
const entries=new Map(['backend','frontends'].map(role=>[path.join(repository,'scripts/demo',role+'.mjs').replaceAll('\\','/'),role]));
const onChild=({process:child})=>child.once('spawn',()=>{
 const role=child.spawnargs.map(arg=>String(arg).replaceAll('\\','/')).map(arg=>entries.get(arg)).find(Boolean);if(!role)return;
 const note=(event,value={})=>log('role:'+event,{role,childPid:child.pid,exitCode:child.exitCode,signalCode:child.signalCode,connected:child.connected,...value});
 note('spawn');for(const event of ['exit','close','disconnect','error'])child.on(event,(code,signal)=>note(event,{code:typeof code==='number'?code:undefined,signal,error:code?.stack}));
 if(child.stderr){child.stderr.on('data',bytes=>appendFileSync(path.join(directory,role+'.stderr.log'),bytes));for(const event of ['end','close','error'])child.stderr.on(event,error=>note('stderr:'+event,{error:error?.stack}));}
});
channel('child_process').subscribe(onChild);
const onMessage=message=>{if(message?.type==='sigint'){log('sigint-simulation');process.emit('SIGINT');}};
process.on('message',onMessage);for(const event of ['exit','beforeExit','disconnect'])process.on(event,code=>log(event,{code}));
try{
 log('launch-begin');
 await launch('mock',[],{prepare:async mode=>{const prepared=await prepareDemo(mode);log('real-prepare-returned',{run:prepared.run});if(process.connected)process.send({type:'prepared',pid:process.pid,run:prepared.run});return prepared;}});
 log('launch-returned',{code:process.exitCode??0});
}catch(error){log('launch-error',{message:error.message,stack:error.stack});process.exitCode=1;}
finally{process.off('message',onMessage);channel('child_process').unsubscribe(onChild);if(process.connected){log('disconnect-called');process.disconnect();}}
