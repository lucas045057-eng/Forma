import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createMockServer, type MockScenario } from './mock-server.ts';
import { Lux3DClient } from './lux3d.ts';
import { AssetService } from './service.ts';
import { createApp } from '../app.ts';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import { listenForFetch } from '../test-support/fetch-listener.ts';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); const errors:unknown[]=[];for (const close of cleanups.splice(0).reverse())try{await close();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Recovery fixture cleanup failed'); });
async function setup(scenario: MockScenario = 'success') {
  const root = resolve(import.meta.dirname, '../../../../.data');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'recovery-test-'));
  const removeDirectory=()=>rm(directory, { recursive: true, force: true });cleanups.push(removeDirectory);
  const { mock, baseUrl: base } = await listenForFetch(() => createMockServer({ scenario }));
  cleanups.push(() => mock.close());
  const client = new Lux3DClient({ base, key: 'mock-only' });
  return { root, directory, mock, base, client, removeDirectory };
}

it('processes despite stale temporary files, repairs missing ready output without a paid create, and changes its URL', async () => {
  const { directory, mock, base } = await setup();
  const { app, service } = await createApp({ dataDirectory: directory, base, key: 'mock-only', pollMs: 1 });
  cleanups.push(() => app.close());
  await mkdir(join(directory, '123'));
  await writeFile(join(directory, '123', 'model.glb.tmp'), 'crash residue');
  await writeFile(join(directory, '123', 'raw.glb.tmp'), 'crash residue');
  const first = (await app.inject({ method: 'POST', url: '/assets/lux3d/import', payload: { taskId: '123' } })).json();
  await service.idle();
  const ready = service.get(first.id)!;
  expect(ready.status).toBe('ready');
  expect((await app.inject(ready.modelUrl!)).statusCode).toBe(200);
  const file = service.modelPath(first.id)!;
  await rm(file);
  expect((await app.inject(ready.modelUrl!)).json().error.code).toBe('MODEL_MISSING');
  const gets = (await mock.inject('/__stats')).json().gets;
  const repaired = await service.importTask('123');
  expect(repaired.id).toBe(first.id);
  await service.idle();
  expect(service.get(first.id)?.status).toBe('ready');
  expect(service.get(first.id)?.modelUrl).not.toBe(ready.modelUrl);
  expect((await app.inject(service.get(first.id)!.modelUrl!)).statusCode).toBe(200);
  expect((await mock.inject('/__stats')).json()).toEqual({ creates: 0, gets: gets + 1 });
  const names = await readdir(join(directory, '123'));
  expect(names.filter(name => name.endsWith('.tmp')).sort()).toEqual(['model.glb.tmp', 'raw.glb.tmp']);
});
it('detects missing ready models on restart and allows re-import', async () => {
  const { directory, client, mock } = await setup();
  const first = new AssetService({ directory, client, pollMs: 1 });
  await first.init();
  const asset = await first.importTask('123');
  await first.idle(); await first.close();
  await rm(join(directory, '123', 'model.glb'));
  const second = new AssetService({ directory, client, pollMs: 1 });
  cleanups.push(() => second.close());
  await second.init();
  expect(second.get(asset.id)).toMatchObject({ status: 'failed', error: { code: 'MODEL_MISSING' } });
  await second.importTask('123'); await second.idle();
  expect(second.get(asset.id)?.status).toBe('ready');
  expect((await mock.inject('/__stats')).json().creates).toBe(0);
});
it('never repeats a paid request after upstream accepts it but loses the response', async () => {
  const { directory, client, mock } = await setup('response-lost');
  const first = new AssetService({ directory, client });
  await first.init();
  const input = { prompt: 'bottle', version: 'G1-Turbo' as const };
  const asset = await first.submit(input, 'lost-response');
  expect(asset.status).toBe('submit_unknown');
  await first.close();
  const restarted = new AssetService({ directory, client });
  cleanups.push(() => restarted.close());
  await restarted.init();
  expect((await restarted.submit(input, 'lost-response')).id).toBe(asset.id);
  expect((await mock.inject('/__stats')).json().creates).toBe(1);
});
it('does not resubmit after taskId persistence fails, even after restart', async () => {
  const { directory, client, mock, base, removeDirectory } = await setup();
  const env:NodeJS.ProcessEnv={};for(const name of ['SystemRoot','WINDIR','PATH','TEMP','TMP'])if(process.env[name])env[name]=process.env[name];
  const child=spawn(process.execPath,['--import',fileURLToPath(new URL('../test-support/asset-persistence-register.mjs',import.meta.url)),fileURLToPath(new URL('../test-support/asset-persistence-parent.ts',import.meta.url)),directory,base],{env,stdio:['ignore','pipe','pipe','ipc']});
  let diagnostics='';let childError:Error|undefined;let held:Record<string,unknown>|undefined;
  child.stdout!.on('data',chunk=>{diagnostics+=String(chunk);});child.stderr!.on('data',chunk=>{diagnostics+=String(chunk);});child.once('error',error=>{childError=error;});
  child.on('message',(value:unknown)=>{if(value&&typeof value==='object'&&'type'in value&&value.type==='persistence-failure-held')held=value as Record<string,unknown>;});
  const closed=new Promise<void>(resolveClose=>child.once('close',()=>resolveClose()));
  const awaitClosed=async()=>{let timer:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([closed,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error(`Owned persistence fixture did not close: ${diagnostics}`)),5000);})]);}finally{clearTimeout(timer);}};
  const identity=()=>{
    if(!child.pid)return undefined;
    const text=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}' | ForEach-Object { [pscustomobject]@{pid=$_.ProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o')} } | ConvertTo-Json -Compress`],{encoding:'utf8',timeout:5000});
    return text.trim()?JSON.parse(text) as {pid:number;created:string}:undefined;
  };
  let owner:{pid:number;created:string}|undefined;
  try{
    await vi.waitFor(()=>{if(childError)throw childError;expect(child.pid).toBeTypeOf('number');owner=identity();expect(owner).toBeDefined();expect(owner?.pid).toBe(child.pid);});
    await vi.waitFor(()=>{if(childError||child.exitCode!==null||child.signalCode!==null)throw new Error(`Persistence fixture exited early: ${childError?.message??''} ${diagnostics}`);expect(held).toBeDefined();},{timeout:5000});
    expect(held).toMatchObject({pid:child.pid,submitError:'disk full',idleError:'disk full',closeError:'disk full',lockPid:child.pid,blockedCode:'INSTANCE_LOCKED'});
    const liveProbe=new AssetService({directory,client});await expect(liveProbe.init()).rejects.toMatchObject({code:'INSTANCE_LOCKED'});
    expect(JSON.parse(await readFile(join(directory,'index.json'),'utf8'))[0].status).toBe('submitting');
    expect((await mock.inject('/__stats')).json().creates).toBe(1);
    child.kill('SIGKILL');await awaitClosed();expect(identity()?.created).not.toBe(owner!.created);
    // No removal of the still-existing lock: init must detect the genuinely dead owner.
    expect(JSON.parse(await readFile(join(directory,'.instance.lock'),'utf8')).pid).toBe(owner!.pid);
    const input={prompt:'bottle',version:'G1' as const};const restarted=new AssetService({directory,client,pollMs:1});cleanups.push(()=>restarted.close());await restarted.init();
    expect((await restarted.submit(input,'disk-failure')).status).toBe('submit_unknown');expect((await mock.inject('/__stats')).json().creates).toBe(1);
    await restarted.importTask('9000001');await restarted.idle();expect(restarted.get('lux3d-9000001')?.status).toBe('ready');expect((await mock.inject('/__stats')).json().creates).toBe(1);
  }finally{
    try{
      if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await awaitClosed();
      if(owner)expect(identity()?.created).not.toBe(owner.created);
    }catch(error){const index=cleanups.indexOf(removeDirectory);if(index!==-1)cleanups.splice(index,1);throw new AggregateError([error],`Persistence fixture cleanup failed; retained ${directory}`);}
  }
},15_000);
it.each(['drip', 'timeout'] as const)('app.close stops %s work and persists a restartable record', async scenario => {
  const { directory, mock, base } = await setup(scenario);
  const { app, service } = await createApp({ dataDirectory: directory, base, key: 'mock-only', pollMs: scenario === 'timeout' ? 60_000 : 1, downloadTimeoutMs: 60_000 });
  cleanups.push(() => app.close());
  let downloading = false;
  mock.server.on('request', request => { if (request.url === '/output/model.glb') downloading = true; });
  const asset = await service.importTask('123');
  await vi.waitFor(async () => {
    if (scenario === 'drip') expect(downloading).toBe(true);
    else expect((await mock.inject('/__stats')).json().gets).toBeGreaterThan(0);
  });
  const start = Date.now();
  await app.close();
  expect(Date.now() - start).toBeLessThan(2000);
  const stored = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'))[0];
  expect(stored).toMatchObject({ id: asset.id, status: 'polling', error: { code: 'SERVICE_STOPPED' } });
  expect((await mock.inject('/__stats')).json().creates).toBe(0);
  if (scenario === 'drip') expect(await readdir(join(directory, '123'))).toEqual([]);
  const { mock: resumedMock, baseUrl: resumedBase } = await listenForFetch(() => createMockServer());
  cleanups.push(() => resumedMock.close());
  const resumed = new AssetService({ directory, client: new Lux3DClient({ base: resumedBase, key: 'mock-only' }), pollMs: 1 });
  cleanups.push(() => resumed.close());
  await resumed.init(); await resumed.idle();
  expect(resumed.get(asset.id)?.status).toBe('ready');
  expect((await resumedMock.inject('/__stats')).json().creates).toBe(0);
});
it('rejects truncated mock output without publishing a model', async () => {
  const { directory, client } = await setup('truncated');
  const service = new AssetService({ directory, client, pollMs: 1 });
  cleanups.push(() => service.close()); await service.init();
  const asset = await service.importTask('123'); await service.idle();
  expect(service.get(asset.id)).toMatchObject({ status: 'failed', error: { code: 'INVALID_GLB' } });
  expect(await readdir(join(directory, '123'))).toEqual([]);
});
