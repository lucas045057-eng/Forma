import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {SpeechConfig} from '@spatial/shared';
import {readSpeechConfig,speechMessage} from './speech-api.ts';
import {identityLabel,PressGesture,reviewDecision,type ReviewMode,type SpeechContext} from './speech-review.ts';
import {speechBusy,type SpeechController,type SpeechProvider,type SpeechReview,type SpeechSnapshot} from './speech-input.ts';
import './speech-input.css';
interface Props {controller:SpeechController;snapshot:SpeechSnapshot;context:SpeechContext;allowed:boolean;onUse:(review:SpeechReview,mode:ReviewMode)=>void}
const phaseLabels:Record<SpeechSnapshot['phase'],string>={idle:'按住说话，松开转写',permission:'正在申请权限，松开可取消',recording:'正在录音，松开结束',transcribing:'正在转写，请稍候',review:'请编辑并确认转写',cancelled:'语音已取消',error:'语音输入未完成'};
export default function SpeechInput({controller,snapshot,context,allowed,onUse}:Props){
 const [config,setConfig]=useState<SpeechConfig>();const [configError,setConfigError]=useState('');const [provider,setProvider]=useState<SpeechProvider>('aliyun');
 const press=useRef(new PressGesture());const button=useRef<HTMLButtonElement>(null);const current=useRef(context);current.current=context;
 const gate=useRef(allowed);gate.current=allowed;
 function clearPress(){const held=press.current.clear();if(held?.kind==='pointer'&&held.id!==undefined&&button.current?.hasPointerCapture(held.id))button.current.releasePointerCapture(held.id);return held;}
 function cancel(reason:string){clearPress();controller.cancel(reason);}
 useEffect(()=>{
  const abort=new AbortController();const timer=setTimeout(()=>abort.abort(),5000);let active=true;
  void readSpeechConfig(abort.signal).then(value=>{if(active){setConfig(value);setConfigError('');}}).catch(cause=>{if(active)setConfigError(speechMessage(cause));}).finally(()=>clearTimeout(timer));
  return()=>{active=false;abort.abort();clearTimeout(timer);};
 },[]);
 useLayoutEffect(()=>{if(!allowed)cancel('当前模式或提交权限已变化。');},[allowed,controller]);
 useEffect(()=>{
  const hidden=()=>{if(document.visibilityState==='hidden')cancel('页面已隐藏。');};const blur=()=>cancel('窗口已失焦。');
  document.addEventListener('visibilitychange',hidden);window.addEventListener('blur',blur);
  return()=>{document.removeEventListener('visibilitychange',hidden);window.removeEventListener('blur',blur);clearPress();controller.dispose();};
 },[controller]);
 const unavailable=controller.availability(provider,config);
 const recordDisabled=!allowed||!!unavailable||['transcribing','review'].includes(snapshot.phase);
 const review=snapshot.review;const decision=review?reviewDecision(review.context,context,allowed,review.text):undefined;
 function start(kind:'pointer'|'keyboard',id?:number){
  if(provider==='browser'&&import.meta.env.VITE_DEMO_MODE==='mock')return;
  if(recordDisabled||!gate.current||!press.current.begin(kind,id))return;
  void controller.start(current.current,provider,config,gate.current);
 }
 return <div className="speech-input" data-testid="speech-input">
  <label>语音来源 <select data-testid="speech-provider" value={provider} onChange={event=>{cancel('语音来源已切换。');setProvider(event.target.value as SpeechProvider);}}>
   <option value="aliyun">阿里云百炼</option><option value="browser" disabled={import.meta.env.VITE_DEMO_MODE==='mock'}>浏览器备用{import.meta.env.VITE_DEMO_MODE==='mock'?'（离线模式禁用）':''}</option>
  </select></label>
  <p className="speech-disclosure">{provider==='aliyun'?(import.meta.env.VITE_DEMO_MODE==='mock'?'离线语音模拟只返回固定示例，不发送到阿里云百炼；转写需确认后提交。':'录音会发送到阿里云百炼识别，转写需确认后提交。'):'浏览器备用由浏览器提供，可能发送到浏览器厂商服务；转写需确认后提交。'} 取消或断网不保证未计费。</p>
  <button ref={button} type="button" data-testid="speech-record" disabled={recordDisabled}
   onPointerDown={event=>{if(event.button!==0||recordDisabled)return;event.currentTarget.setPointerCapture(event.pointerId);start('pointer',event.pointerId);}}
   onPointerUp={event=>{if(press.current.end('pointer',event.pointerId)){controller.finish();if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);}}}
   onPointerCancel={event=>{if(press.current.lost(event.pointerId))controller.cancel('指针操作已取消。');}}
   onLostPointerCapture={event=>{if(press.current.lost(event.pointerId)&&['permission','recording'].includes(controller.getSnapshot().phase))controller.cancel('录音指针捕获已丢失。');}}
   onKeyDown={event=>{if(event.code==='Space'){event.preventDefault();if(!event.repeat)start('keyboard');}else if(event.key==='Escape')cancel('已取消语音输入。');}}
   onKeyUp={event=>{if(event.code==='Space'){event.preventDefault();if(press.current.end('keyboard'))controller.finish();}}}
   onBlur={()=>{if(clearPress()&&['permission','recording'].includes(controller.getSnapshot().phase))controller.cancel('录音按钮已失焦。');}}
   onClick={event=>event.preventDefault()}>
   {snapshot.phase==='recording'?'松开结束录音':snapshot.phase==='permission'?'松开取消权限等待':'按住说话（或按住空格）'}
  </button>
  {speechBusy(snapshot)&&<button type="button" data-testid="speech-cancel" onClick={()=>cancel('已取消语音输入。')}>取消语音</button>}
  <p data-testid="speech-status" role="status">{phaseLabels[snapshot.phase]}{snapshot.notice&&` · ${snapshot.notice}`}</p>
  {(configError&&provider==='aliyun'||unavailable)&&<p role="status">{provider==='aliyun'&&configError||unavailable}</p>}
  {snapshot.error&&<p className="speech-error" role="alert" data-testid="speech-error">{snapshot.error}</p>}
  {review&&decision&&<section data-testid="speech-review" className="speech-review">
   <p>来源：{review.provider==='aliyun'?(import.meta.env.VITE_DEMO_MODE==='mock'?'本机语音模拟（阿里接口替身）':'阿里云百炼'):'浏览器备用'}</p>
   <label>确认前可编辑转写 <textarea data-testid="speech-review-text" value={review.text} maxLength={4000} onChange={event=>controller.editReview(event.target.value)}/></label>
   <p data-testid="speech-capture-object">录音时：{identityLabel(review.context.selection)}</p>
   <p data-testid="speech-current-object">当前：{identityLabel(context.selection)}</p>
   {decision.stale&&<p role="alert">页面版本已变化，请放弃本次转写，重新点选后录音。</p>}
   {decision.selectionChanged&&<p data-testid="speech-selection-conflict" role="alert">选中对象已变化。请明确确认当前对象，或放弃并重新点选录音时对象。</p>}
   {decision.instructionChanged&&<p data-testid="speech-text-conflict" role="alert">原指令已有新编辑，使用转写将替换当前指令。</p>}
   <button type="button" data-testid="speech-use" disabled={!decision.normal} onClick={()=>onUse(review,'normal')}>使用此文字</button>
   {decision.replace&&<button type="button" data-testid="speech-replace" onClick={()=>onUse(review,'replace')}>明确替换当前指令</button>}
   {decision.current&&<button type="button" data-testid="speech-use-current" onClick={()=>onUse(review,'current')}>用于当前对象{context.selection?.cid??'（整体修改）'}{decision.instructionChanged?'并替换当前指令':''}</button>}
   <button type="button" data-testid="speech-discard" onClick={()=>cancel('已放弃转写；请自行重新点选需要修改的对象。')}>放弃并重新点选录音时对象</button>
  </section>}
 </div>;
}
