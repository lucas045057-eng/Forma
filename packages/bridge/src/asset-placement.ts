import type { AssetPlacementTarget, PlacementPreviewMessage } from '@spatial/shared';
import { isStudioMessage } from '@spatial/shared';
const mime='application/x-spatial-asset';
export function installAssetPlacement(origin:string):()=>void{
 let session:{sessionId:string;assetId:string;baseVersion:string}|undefined;let hover:Element|null=null;const tabStops=new Map<Element,string|null>();
 const overlay=document.createElement('div');overlay.dataset.placementOverlay='true';overlay.style.cssText='position:fixed;pointer-events:none;z-index:2147483646;border:3px solid #67e5d5;background:#67e5d533;color:#092c2e;font:14px sans-serif;display:none;';document.body.append(overlay);
 const send=(message:PlacementPreviewMessage)=>{if(window.parent!==window)window.parent.postMessage(message,origin);};
 const stop=()=>{session=undefined;hover=null;overlay.style.display='none';for(const [element,previous]of tabStops){if(previous===null)element.removeAttribute('tabindex');else element.setAttribute('tabindex',previous);}tabStops.clear();};
 const target=(element:Element):AssetPlacementTarget|null=>{
  const mainSlot=element.closest('[data-testid="product-scene"]');
  const module=element.closest('[data-spatial-module]');
  if(module){
   const instanceId=module.getAttribute('data-spatial-module');if(!instanceId||!/^[a-f0-9]{32}$/.test(instanceId))return null;
   const ancestors:string[]=[];let parent=module.parentElement;while(parent&&ancestors.length<3){const source=parent.getAttribute('data-src');if(source)ancestors.push(source);parent=parent.parentElement;}
   return{kind:'replace-module',instanceId,src:'src/spatial-module.tsx:1:1',cid:'SpatialModule',ancestors,position:'inside'};
  }
  let node=mainSlot??element.closest('[data-src]');if(!node)return null;
  if(!mainSlot){const marked=Array.from(document.querySelectorAll('[data-src]'));while(node&&marked.filter(item=>item.getAttribute('data-src')===node?.getAttribute('data-src')).length>1)node=node.parentElement?.closest('[data-src]')??null;}
  const src=node?.getAttribute('data-src');if(!src||!node)return null;
  const ancestors:string[]=[];let parent=node.parentElement;while(parent&&ancestors.length<3){const source=parent.getAttribute('data-src');if(source)ancestors.push(source);parent=parent.parentElement;}
  return{kind:mainSlot?'replace':'insert',src,cid:node.getAttribute('data-cid')??'Node',ancestors,position:mainSlot?'inside':'after'};
 };
 const draw=(element:Element)=>{const data=target(element);if(!data){overlay.style.display='none';return;}hover=element;const anchor=data.kind==='replace-module'?element.closest('[data-spatial-module]')??element:Array.from(document.querySelectorAll('[data-src]')).find(item=>item.getAttribute('data-src')===data.src);if(!anchor)return;const box=anchor.getBoundingClientRect();Object.assign(overlay.style,{display:'block',left:box.x+'px',top:box.y+'px',width:box.width+'px',height:box.height+'px',transform:'none'});overlay.textContent=data.kind==='replace'?'替换此3D模型（松开后确认）':data.kind==='replace-module'?'替换此实例的模型（松开后确认）':'在此添加3D模块（松开后确认）';};
 const receive=(event:MessageEvent<unknown>)=>{if(event.origin!==origin||event.source!==window.parent||!isStudioMessage(event.data))return;if(event.data.type==='placement:start'){stop();session=event.data.payload;for(const element of Array.from(document.querySelectorAll('[data-src]')).slice(0,300)){if(element instanceof HTMLElement&&!element.hasAttribute('tabindex')){tabStops.set(element,null);element.setAttribute('tabindex','0');}}return;}if(event.data.type==='placement:stop'&&session?.sessionId===event.data.payload.sessionId)stop();};
 const move=(event:PointerEvent)=>{if(session&&event.target instanceof Element)draw(event.target);};
 const dragOver=(event:DragEvent)=>{if(!event.dataTransfer)return;
  if(!session){if(Array.from(event.dataTransfer.types).includes('Files')){event.preventDefault();event.dataTransfer.dropEffect='none';overlay.style.display='block';overlay.style.left='50%';overlay.style.top='16px';overlay.style.width='auto';overlay.style.height='auto';overlay.style.transform='translateX(-50%)';overlay.textContent='外部文件不能直接放到网页；请回到工作台的“从图片创作 3D”上传区';}return;}
  event.preventDefault();if(!event.dataTransfer.types.includes(mime)){event.dataTransfer.dropEffect='none';return;}event.dataTransfer.dropEffect='copy';if(event.target instanceof Element)draw(event.target);};
 const choose=(element:Element)=>{if(!session)return;const data=target(element);if(!data)return;send({type:'placement:target',payload:{sessionId:session.sessionId,target:data}});overlay.style.display='none';};
 const drop=(event:DragEvent)=>{if(!event.dataTransfer)return;if(!session){if(Array.from(event.dataTransfer.types).includes('Files')){event.preventDefault();event.stopImmediatePropagation();overlay.style.display='none';}return;}event.preventDefault();event.stopImmediatePropagation();let data:unknown;try{data=JSON.parse(event.dataTransfer.getData(mime));}catch{return;}const item=data as {sessionId?:unknown;assetId?:unknown};if(item.sessionId!==session.sessionId||item.assetId!==session.assetId)return;event.preventDefault();event.stopImmediatePropagation();if(event.target instanceof Element)choose(event.target);};
 const click=(event:MouseEvent)=>{if(!session||!(event.target instanceof Element))return;event.preventDefault();event.stopImmediatePropagation();choose(event.target);};
 const key=(event:KeyboardEvent)=>{if(!session)return;if(event.key==='Escape'){send({type:'placement:cancelled',payload:{sessionId:session.sessionId,reason:'已取消放置'}});stop();}else if((event.key==='Enter'||event.key===' ')&&event.target instanceof Element){event.preventDefault();choose(event.target);}};
 const focus=(event:FocusEvent)=>{if(session&&event.target instanceof Element)draw(event.target);};
 const dragLeave=()=>{if(!session)overlay.style.display='none';};
 const scroll=()=>{if(session&&hover?.isConnected)draw(hover);};
 window.addEventListener('focusin',focus,true);window.addEventListener('message',receive);window.addEventListener('pointermove',move,true);window.addEventListener('dragleave',dragLeave,true);window.addEventListener('dragover',dragOver,true);window.addEventListener('drop',drop,true);window.addEventListener('click',click,true);window.addEventListener('keydown',key,true);window.addEventListener('scroll',scroll,true);window.addEventListener('resize',scroll);
 return()=>{stop();overlay.remove();window.removeEventListener('focusin',focus,true);window.removeEventListener('message',receive);window.removeEventListener('pointermove',move,true);window.removeEventListener('dragover',dragOver,true);window.removeEventListener('dragleave',dragLeave,true);window.removeEventListener('drop',drop,true);window.removeEventListener('click',click,true);window.removeEventListener('keydown',key,true);window.removeEventListener('scroll',scroll,true);window.removeEventListener('resize',scroll);};
}
