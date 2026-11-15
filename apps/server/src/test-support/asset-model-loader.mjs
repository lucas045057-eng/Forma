// Resolve to an ordinary JavaScript module, not replacement source for a native TS load.
// Its body is evaluated in the worker application thread after process-worker registered IPC.
const source=`
 const keepAlive=setInterval(()=>{},1000);
 if(!process.send||!process.connected)throw new Error('Fixture model barrier has no parent IPC');
 process.send({fixtureModelBlocked:true,pid:process.pid});
 await new Promise(()=>{});
 clearInterval(keepAlive);
 export function processModel(){}
`;
export function resolve(specifier,context,nextResolve){
 if(context.parentURL&&new URL(specifier,context.parentURL).pathname.endsWith('/assets/process-model.ts'))return {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
 return nextResolve(specifier,context);
}
