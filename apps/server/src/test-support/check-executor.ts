import type { CheckExecutor, CheckContext } from '../checks/runner.ts';

/** Internal unit-fixture executor only. It exercises evidence/gating, not compilation or Chromium. */
export function createMockCheckOptions() {
  const phase=(name:'schema'|'build'|'smoke'|'occlusion')=>async(ctx:CheckContext)=>{
    ctx.signal.throwIfAborted();
    if(name==='smoke'||name==='occlusion')await ctx.writeArtifact(name+'.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8YQAAAAASUVORK5CYII=','base64'));
    const ref=await ctx.writeArtifact(name==='build'?'build.log':name+'.json',JSON.stringify({fixture:true,name}));
    return {name,status:'passed' as const,evidence:ref.hash};
  };
  const executor:CheckExecutor={schema:phase('schema'),build:phase('build'),smoke:phase('smoke'),occlusion:phase('occlusion'),stop:async()=>{}};
  return {executor,toolIdentity:'unit-evidence-executor-v1'};
}

