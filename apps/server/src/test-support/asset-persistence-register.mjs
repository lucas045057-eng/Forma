import {registerHooks} from 'node:module';

const target=new URL('../assets/atomic-file.ts',import.meta.url).href;
const original=new URL(target);original.searchParams.set('fixture-original','1');
const source=`
 import {writeAtomic as actual} from ${JSON.stringify(original.href)};
 if(process.connected)process.send({type:'persistence-preload-stage',pid:process.pid,stage:'atomic-wrapper-evaluated'});
 export async function writeAtomic(filename,contents,signal){
  if(filename.endsWith('index.json')&&JSON.parse(String(contents)).some(entry=>entry.taskId))throw new Error('disk full');
  return actual(filename,contents,signal);
 }
`;
// Test-only wrapper; queries and all non-target modules retain Node's original resolution.
registerHooks({resolve(specifier,context,nextResolve){
 const resolved=nextResolve(specifier,context);
 if(resolved.url===target){
  if(process.connected)process.send({type:'persistence-preload-stage',pid:process.pid,stage:'atomic-target-resolved'});
  return {url:'data:text/javascript,'+encodeURIComponent(source),format:'module',shortCircuit:true};
 }
 return resolved;
}});
if(process.connected)process.send({type:'persistence-preload-stage',pid:process.pid,stage:'installed'});
