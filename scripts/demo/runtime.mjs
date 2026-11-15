import path from 'node:path';
import {readPlainFile,assertPlainPath} from '../../apps/server/src/checks/paths.ts';
import {repository,descendant} from './safety.mjs';
export async function loadPlan(){
 if(!process.send)throw new Error('Demo child requires owned parent IPC');
 const file=path.resolve(process.env.DEMO_PLAN??'');const base=path.join(repository,'.data/demo-runs');
 if(!descendant(base,file)||path.basename(file)!=='plan.json')throw new Error('Demo plan outside isolated runs');
 const denied=()=>new Error('Demo plan path invalid');const plan=JSON.parse((await readPlainFile(file,32768,denied,denied)).toString('utf8'));
 const run=path.dirname(file);if(plan.run!==run||plan.work!==path.join(run,'work')||!['mock','real'].includes(plan.mode))throw new Error('Demo plan identity invalid');
 const names=['api','studio','main','preview','coding','lux3d','speech'];if(plan.schemaVersion!==1||!plan.ports||Object.keys(plan.ports).some(name=>!names.includes(name))||names.some(name=>!(name in plan.ports)))throw new Error('Demo port names invalid');
 const ports=Object.values(plan.ports);if(ports.length!==7||new Set(ports).size!==7||ports.some(port=>!Number.isInteger(port)||port<20000||port>65535))throw new Error('Demo port plan invalid');
 await assertPlainPath(plan.work,denied);return plan;
}
export function ownedLifetime(close){
 let closing;
 const stop=()=>closing??=(async()=>{try{await close();process.exitCode=0;}catch{process.exitCode=1;console.error('Demo shutdown failed; inspect retained run and owned process records.');}finally{if(process.connected)process.disconnect();}})();
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void stop());
 process.on('message',message=>{if(message?.type==='shutdown')void stop();});process.once('disconnect',()=>void stop());Object.defineProperty(stop,'closing',{get:()=>!!closing});return stop;
}
