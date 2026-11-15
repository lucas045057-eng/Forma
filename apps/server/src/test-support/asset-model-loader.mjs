// Let Node resolve arbitrary specifiers. Only the exact fixture target is intercepted;
// bare package names, builtins and data: parents are never parsed as relative URLs here.
const target=new URL('../assets/process-model.ts',import.meta.url).href;
const source=`
 const keepAlive=setInterval(()=>{},1000);
 if(!process.send||!process.connected)throw new Error('Fixture model barrier has no parent IPC');
 process.send({fixtureModelBlocked:true,pid:process.pid});
 await new Promise(()=>{});
 clearInterval(keepAlive);
 export function processModel(){}
`;
export function resolve(specifier,context,nextResolve){
 const resolved=nextResolve(specifier,context);
 if(resolved.url===target)return {url:'data:text/javascript,'+encodeURIComponent(source),format:'module',shortCircuit:true};
 return resolved;
}
