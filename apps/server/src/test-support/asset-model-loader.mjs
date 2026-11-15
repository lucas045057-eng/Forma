// Hold only the model library in the implementation-test worker. process-worker's own
// disconnect listener has already been installed before this dynamic import is evaluated.
export async function load(url,context,nextLoad){
 if(url.endsWith('/assets/process-model.ts'))return {format:'module',shortCircuit:true,source:'setInterval(()=>{},1000);process.send?.({fixtureModelBlocked:true});await new Promise(()=>{});export function processModel(){}'};
 return nextLoad(url,context);
}
