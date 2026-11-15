import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFrontendWatchGate} from './frontend-watch-gate.mjs';

test('frontend watch gate preserves live add receiver, arguments and chain return',()=>{
 const calls=[];const watcher={add(...paths){calls.push({receiver:this,paths});return this;}};const gate=createFrontendWatchGate();
 assert.equal(gate.attach(watcher),watcher);const paths=['one.ts','two.ts'];const options={marker:'unchanged'};
 assert.equal(watcher.add(paths,options),watcher);assert.equal(calls.length,1);assert.equal(calls[0].receiver,watcher);assert.equal(calls[0].paths[0],paths);assert.equal(calls[0].paths[1],options);assert.equal(gate.closing,false);
});
test('sealing is synchronous and blocks late registration on every owned watcher during an awaited close',async context=>{
 const calls=[];const gate=createFrontendWatchGate();const watchers=['main','studio'].map(name=>({add(file){calls.push({name,file});return this;}}));for(const watcher of watchers)gate.attach(watcher);
 for(const watcher of watchers)watcher.add('live.ts');assert.equal(calls.length,2);
 let release;const barrier=new Promise(resolve=>release=resolve);
 const stop=async()=>{gate.seal();await barrier;};const stopped=stop();assert.equal(gate.closing,true);
 await Promise.resolve();for(const watcher of watchers)assert.equal(watcher.add('late.ts').add('later.ts'),watcher);assert.equal(calls.length,2);
 release();await stopped;for(const watcher of watchers)assert.equal(watcher.add('after-close.ts'),watcher);assert.equal(calls.length,2);
 context.diagnostic(JSON.stringify({sealed:gate.closing,liveDelegations:calls,delegationsAfterLateAdds:calls.length,ownedWatchers:watchers.length}));
});
test('a watcher attached after shutdown started is sealed before any late add',context=>{
 const gate=createFrontendWatchGate();gate.seal();let registrations=0;const watcher={add(){registrations++;return this;}};
 gate.attach(watcher);assert.equal(watcher.add('late-create-server.ts'),watcher);assert.equal(registrations,0);context.diagnostic(JSON.stringify({attachedAfterSeal:true,registrations,sealed:gate.closing}));
});
test('live watcher add exceptions propagate without replacement',()=>{
 const expected=new Error('original add failed');const gate=createFrontendWatchGate();const watcher={add(){throw expected;}};gate.attach(watcher);
 assert.throws(()=>watcher.add('live.ts'),error=>error===expected);gate.seal();assert.equal(watcher.add('sealed.ts'),watcher);
});
test('sealing one frontend gate does not affect another independent lifecycle',()=>{
 const first=createFrontendWatchGate();const second=createFrontendWatchGate();let calls=0;const watcher={add(){calls++;return this;}};second.attach(watcher);first.seal();
 assert.equal(watcher.add('still-live.ts'),watcher);assert.equal(calls,1);assert.equal(second.closing,false);
});
