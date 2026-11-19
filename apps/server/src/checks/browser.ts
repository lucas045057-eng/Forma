import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import type { CheckResult } from '@spatial/shared';
import type { CheckContext } from './runner.ts';
import { startStaticOrigin, type StaticOrigin } from './static-origin.ts';

const viewport={width:1440,height:900};
const safe=(value:string)=>value.replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,700);
const urlForEvidence=(value:string)=>{try{const url=new URL(value);return url.origin+url.pathname;}catch{return '<invalid-url>';}};
interface BrowserRun { origin:StaticOrigin; browser:Browser }
interface Session extends BrowserRun { context:BrowserContext; page:Page; pageErrors:string[]; blockedRequests:{kind:string;url:string}[] }
const runs=new Map<string,Promise<BrowserRun>>();
const stops=new Map<string,Promise<void>>();
async function initialize(ctx:CheckContext):Promise<BrowserRun>{
  ctx.signal.throwIfAborted();
  const origin=await startStaticOrigin(ctx.buildRoot);
  let browser:Browser|undefined;
  try{
    browser=await chromium.launch({headless:true,timeout:Math.min(15000,ctx.browserTimeoutMs),
      downloadsPath:path.join(ctx.buildRoot,'.tmp/downloads'),
      args:['--no-proxy-server','--force-webrtc-ip-handling-policy=disable_non_proxied_udp','--disable-background-networking','--disable-component-update','--disable-sync','--disable-domain-reliability']});
    ctx.signal.throwIfAborted();
    return {origin,browser};
  }catch(error){
    await browser?.close().catch(()=>{});await origin.close();throw error;
  }
}
async function session(ctx:CheckContext):Promise<Session>{
  if(stops.has(ctx.runId))throw new Error('BROWSER_STOPPED');
  let run=runs.get(ctx.runId);
  if(!run){run=initialize(ctx);runs.set(ctx.runId,run);}
  const {origin,browser}=await run;
  ctx.signal.throwIfAborted();
  const context=await browser.newContext({viewport,deviceScaleFactor:1,serviceWorkers:'block',acceptDownloads:false});
  try{
    const pageErrors:string[]=[],blockedRequests:{kind:string;url:string}[]=[];
    const blocked=(kind:string,url:string)=>{if(blockedRequests.length<100)blockedRequests.push({kind,url:urlForEvidence(url)});};
    // This template has no worker dependency. Deny worker creation itself because
    // browser request/WebSocket interception does not cover every worker target.
    await context.exposeBinding('__spatialChecksBlocked', (_source, payload: unknown) => {
      if (payload && typeof payload === 'object' && 'kind' in payload && 'url' in payload &&
          ['worker','sharedworker','serviceworker','webrtc'].includes(String(payload.kind)) && typeof payload.url === 'string') {
        blocked(String(payload.kind), payload.url);
      }
    });
    await context.addInitScript(() => {
      const notify=(globalThis as unknown as {__spatialChecksBlocked:(value:{kind:string;url:string})=>Promise<void>}).__spatialChecksBlocked;
      const deny=(kind:string,url:unknown) => {
        void notify({kind,url:String(url)}).catch(()=>{});
        return new DOMException('Worker creation is disabled during checks','SecurityError');
      };
      for(const [name,kind] of [['Worker','worker'],['SharedWorker','sharedworker']]) {
        Object.defineProperty(globalThis,name,{configurable:false,writable:false,value:class {
          constructor(url:unknown){throw deny(kind,url);}
        }});
      }
      // Route/WS interception cannot see STUN/TURN. This template needs no RTC;
      // deny both constructor names before candidate code runs in every frame.
      for(const name of ['RTCPeerConnection','webkitRTCPeerConnection']) {
        Object.defineProperty(globalThis,name,{configurable:false,writable:false,value:class {
          constructor(){throw deny('webrtc',location.href);}
        }});
      }
      if('serviceWorker' in navigator) Object.defineProperty(navigator.serviceWorker,'register',{
        configurable:false,writable:false,value:(url:unknown)=>Promise.reject(deny('serviceworker',url)),
      });
    });
    await context.route('**/*',async route=>{
      const request=route.request();
      const url=new URL(request.url());
      if(url.origin===new URL(origin.url).origin && ['GET','HEAD'].includes(request.method())){
        await route.continue();return;
      }
      blocked(request.resourceType(),request.url());await route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*',route=>{blocked('websocket',route.url());route.close({code:1008,reason:'Checks deny WebSocket connections'});});
    let primary:Page|undefined;
    context.on('page',page=>{
      page.on('pageerror',error=>{if(pageErrors.length<50)pageErrors.push(safe(error.message));});
      page.on('console',message=>{
        if(message.type()==='error' && /worker-src/.test(message.text())) blocked('worker-policy',page.url());
      });
      if(primary && page!==primary){blocked('popup',page.url());void page.close().catch(()=>{});}
    });
    const page=await context.newPage();primary=page;
    page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(Math.min(15000,ctx.browserTimeoutMs));
    ctx.signal.throwIfAborted();
    return {origin,browser,context,page,pageErrors,blockedRequests};
  }catch(error){
    await context.close();throw error;
  }
}
export async function stopBrowser(runId:string){
  let stopped=stops.get(runId);
  if(!stopped){
    const promise=runs.get(runId);
    runs.delete(runId);
    stopped=(async()=>{
      if(!promise)return;
      let run:BrowserRun;
      try{run=await promise;}catch{return;}
      try{await Promise.all(run.browser.contexts().map(context=>context.close()));}
      finally{try{await run.browser.close();}finally{await run.origin.close();}}
    })();
    stops.set(runId,stopped);
  }
  return stopped;
}
async function frames(page:Page){await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));}
async function navigate(s:Session){
  await s.page.goto(s.origin.url,{waitUntil:'load'});
  await s.page.locator('#root main').waitFor({state:'visible'});
  await frames(s.page);
  // Observe actual in-flight startup resources, including dedicated worker requests.
  await s.page.waitForLoadState('networkidle',{timeout:5000});
}
export async function checkBrowser(name:'smoke'|'occlusion',ctx:CheckContext):Promise<CheckResult>{
  const startedAt=Date.now();
  let s:Session|undefined;
  const data:Record<string,unknown>={name,viewport,url:'',pageErrors:[],blockedRequests:[]};
  let status:'passed'|'failed'='failed',message:string|undefined;
  const aborted=()=>{void stopBrowser(ctx.runId).catch(()=>{});};
  ctx.signal.addEventListener('abort',aborted,{once:true});
  try{
    ctx.signal.throwIfAborted();s=await session(ctx);
    Object.assign(data,{url:s.origin.url,browserVersion:s.browser.version()});
    await navigate(s);
    const isCustomSpatialPage = await s.page.locator('#root main[data-spatial-page]').count() > 0;
    if(name==='smoke'){
      const scene=s.page.getByTestId('product-scene');
      const sceneCount = await scene.count();
      if (!isCustomSpatialPage || sceneCount > 0) {
        const state=await scene.getAttribute('data-state');
        const placeholderVisible=await s.page.getByTestId('product-placeholder').isVisible().catch(()=>false);
        data.scene={present:true,state,placeholderVisible};
        if(state!=='ready' && !(state==='fallback'&&placeholderVisible))throw new Error('SCENE_NOT_READY_OR_VISIBLE_FALLBACK');
      } else {
        data.scene={present:false};
      }
      if (isCustomSpatialPage) {
        const mainEl = s.page.locator('#root main[data-spatial-page]').first();
        const visibleText = ((await mainEl.innerText().catch(() => '')) ?? '').trim();
        const mediaCount = await mainEl.locator('img,svg,canvas,video').count();
        if (!visibleText && mediaCount < 1) {
          throw new Error('PAGE_CONTENT_EMPTY');
        }
        const heading = s.page.locator('#root main h1, #root main h2, #root main [role="heading"]').first();
        const headingText = await heading.count() > 0
          ? ((await heading.textContent().catch(() => '')) ?? '').trim().slice(0, 120)
          : visibleText.slice(0, 120);
        const cta = s.page.locator('#root main button:not([disabled]):not([type="submit"])').first();
        let interactiveVerified = false;
        if (await cta.count() > 0 && await cta.isVisible()) {
          await cta.click();
          await frames(s.page);
          interactiveVerified = true;
        }
        data.spatialPage = { heading: headingText, interactiveVerified, has3DStage: sceneCount > 0 };
      } else {
        const buy=s.page.getByTestId('buy-button');
        if(await buy.count()!==1 || !await buy.isVisible() || !await buy.isEnabled())throw new Error('BUY_BUTTON_UNAVAILABLE');
        const output=s.page.getByTestId('action-status');
        const before=Number(await output.getAttribute('data-purchases'));
        if(!Number.isSafeInteger(before)||before<0)throw new Error('PURCHASE_COUNT_INVALID');
        await buy.click();
        await frames(s.page);
        const after=Number(await output.getAttribute('data-purchases'));
        const feedback=(await output.textContent()??'').trim();
        Object.assign(data,{purchases:{before,after},feedback});
        if(after!==before+1)throw new Error('PURCHASE_COUNT_DID_NOT_INCREMENT');
        if(!feedback)throw new Error('PURCHASE_FEEDBACK_EMPTY');
      }
    }else{
      const result=await s.page.evaluate(()=>{
        const targets:Record<string,unknown>[]=[],excluded:Record<string,unknown>[]=[];
        const describe=(element:Element|null)=>element?{tag:element.tagName.toLowerCase(),id:element.id,testId:element.getAttribute('data-testid')}:null;
        for(const element of document.querySelectorAll('button,a[href],input,select,textarea,[role="button"]')){
          const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
          const identity={...describe(element),rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}};
          let reason:string|undefined;
          if(element.hasAttribute('disabled')||element.getAttribute('aria-disabled')==='true')reason='disabled';
          else if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0||element.getClientRects().length===0)reason='hidden';
          else if(rect.width<=0||rect.height<=0)reason='zero-size';
          else if(rect.right<=0||rect.bottom<=0||rect.left>=innerWidth||rect.top>=innerHeight)reason='offscreen';
          if(reason){excluded.push({...identity,reason});continue;}
          const left=Math.max(0,rect.left),right=Math.min(innerWidth,rect.right),top=Math.max(0,rect.top),bottom=Math.min(innerHeight,rect.bottom);
          const insetX=Math.min(4,(right-left)/4),insetY=Math.min(4,(bottom-top)/4);
          const coords=[[(left+right)/2,(top+bottom)/2],[left+insetX,top+insetY],[right-insetX,top+insetY],[left+insetX,bottom-insetY],[right-insetX,bottom-insetY]];
          const unique=new Set<string>();
          const samples=coords.filter(([x,y])=>{const key=x+','+y;if(unique.has(key))return false;unique.add(key);return true;}).map(([x,y])=>{
            const hit=document.elementFromPoint(x,y);
            return {x,y,hit:describe(hit),hitSelf:hit===element||!!hit&&element.contains(hit)};
          });
          const centerHit=samples[0]?.hitSelf===true;
          const passed=element.getAttribute('data-testid')==='buy-button'?centerHit:samples.some(sample=>sample.hitSelf);
          targets.push({...identity,centerHit,passed,samples});
        }
        return {targets,excluded};
      });
      Object.assign(data,result);
      if(!result.targets.length && !isCustomSpatialPage)throw new Error('NO_INTERACTIVE_TARGETS');
      if(result.targets.some(target=>!target.passed))throw new Error('INTERACTIVE_TARGET_OCCLUDED');
    }
    await frames(s.page);
    if(s.pageErrors.length)throw new Error('UNCAUGHT_PAGE_ERROR');
    if(s.blockedRequests.length)throw new Error('BROWSER_NETWORK_DENIED');
    status='passed';
  }catch(error){
    message=safe(error instanceof Error?error.message:'BROWSER_CHECK_FAILED');
    data.error=message;
  }
  try{
    ctx.signal.throwIfAborted();
    if(s){
      Object.assign(data,{pageErrors:[...s.pageErrors],blockedRequests:[...s.blockedRequests]});
      if(s.pageErrors.length||s.blockedRequests.length)status='failed';
      const png=await s.page.screenshot({type:'png',fullPage:false,timeout:5000});
      await ctx.writeArtifact(name+'.png',png);
    }
    Object.assign(data,{status,durationMs:Date.now()-startedAt});
    const ref=await ctx.writeArtifact(name+'.json',JSON.stringify(data));
    return {name,status,message,evidence:ref.hash,durationMs:Date.now()-startedAt};
  }finally{
    ctx.signal.removeEventListener('abort',aborted);
    await s?.context.close();
  }
}

