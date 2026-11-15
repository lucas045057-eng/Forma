import {registerHooks} from 'node:module';

// Test-only disk-full wrapper in a disposable process. Ordinary writes still use the real
// implementation. The original TS module is imported through a distinct, non-intercepted URL.
registerHooks({resolve(specifier,context,nextResolve){
 if(context.parentURL){
  const target=new URL(specifier,context.parentURL);
  if(target.pathname.endsWith('/assets/atomic-file.ts')&&!target.search){
   const original=new URL(target);original.searchParams.set('fixture-original','1');
   const source=`
    import {writeAtomic as actual} from ${JSON.stringify(original.href)};
    export async function writeAtomic(filename,contents,signal){
     if(filename.endsWith('index.json')&&JSON.parse(String(contents)).some(entry=>entry.taskId))throw new Error('disk full');
     return actual(filename,contents,signal);
    }
   `;
   return {url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true};
  }
 }
 return nextResolve(specifier,context);
}});
