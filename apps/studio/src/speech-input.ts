import type {SpeechConfig,SpeechResult} from '@spatial/shared';
import {ApiError} from './api.ts';
import {cancelSpeech,speechMessage,uploadSpeech} from './speech-api.ts';
import type {SpeechContext} from './speech-review.ts';
export type SpeechProvider='aliyun'|'browser';
export interface StreamPort {getTracks:()=>Array<{stop:()=>void}>}
export interface RecorderPort {mimeType:string;start:(chunk:(value:Blob)=>void,stopped:()=>void,error:(cause:unknown)=>void)=>void;stop:()=>void;detach:()=>void}
export interface RecognitionPort {start:(result:(text:string)=>void,end:()=>void,error:(cause:unknown)=>void)=>void;stop:()=>void;abort:()=>void;detach:()=>void}
export interface SpeechPorts {
 secure:()=>boolean;getStream:()=>Promise<StreamPort>;supportsMime:(mime:string)=>boolean;createRecorder:(stream:StreamPort,mime:string)=>RecorderPort;
 supportsRecognition:()=>boolean;createRecognition:()=>RecognitionPort;
 transcribe:(audio:Blob,id:string,signal:AbortSignal)=>Promise<SpeechResult>;cancel:(id:string,signal:AbortSignal)=>Promise<unknown>;
 uuid:()=>string;setTimer:(work:()=>void,ms:number)=>unknown;clearTimer:(timer:unknown)=>void;
}
export interface SpeechReview {text:string;context:SpeechContext;provider:SpeechProvider}
export interface SpeechSnapshot {phase:'idle'|'permission'|'recording'|'transcribing'|'review'|'error'|'cancelled';review?:SpeechReview;error?:string;notice:string}
interface Session {token:number;context:SpeechContext;provider:SpeechProvider;id:string;config:SpeechConfig;stream?:StreamPort;recorder?:RecorderPort;recognition?:RecognitionPort;timer?:unknown;uploadTimer?:unknown;upload?:AbortController;sent:boolean;chunks:Blob[];bytes:number;finishing:boolean;notice:string;recognized:string}
const initial:SpeechSnapshot={phase:'idle',notice:''};
export function speechBusy(state:SpeechSnapshot){return ['permission','recording','transcribing','review'].includes(state.phase);}
export class SpeechController {
 private token=0;private active?:Session;private snapshot:SpeechSnapshot=initial;private listeners=new Set<()=>void>();
 constructor(private readonly ports:SpeechPorts){}
 getSnapshot=()=>this.snapshot;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private update(value:SpeechSnapshot){this.snapshot=value;for(const listener of this.listeners)listener();}
 private current(session:Session){return this.active===session&&this.token===session.token;}
 availability(provider:SpeechProvider,config?:SpeechConfig){
  if(!this.ports.secure())return '当前环境不支持安全录音，请使用文字输入。';
  if(provider==='browser')return this.ports.supportsRecognition()?'':'浏览器识别不可用，请使用文字输入。';
  if(!config?.enabled)return '语音识别未就绪或未配置，请使用文字输入。';
  return this.mime(config)?'':'没有可用的录音格式，请使用文字输入。';
 }
 private mime(config:SpeechConfig){return ['audio/webm;codecs=opus','audio/ogg;codecs=opus','audio/webm','audio/ogg','audio/wav'].find(value=>config.supportedMimeTypes.includes(value.split(';')[0])&&this.ports.supportsMime(value));}
 async start(context:SpeechContext,provider:SpeechProvider,config:SpeechConfig|undefined,allowed:boolean){
  if(!allowed||speechBusy(this.snapshot))return;
  const unavailable=this.availability(provider,config);
  if(unavailable){this.update({phase:'error',error:unavailable,notice:''});return;}
  const effective:SpeechConfig=config??{enabled:false,provider:'aliyun',model:'qwen3-asr-flash',maxBytes:4194304,maxDurationMs:60000,supportedMimeTypes:[],notice:''};
  const session:Session={token:++this.token,context:structuredClone(context),provider,id:this.ports.uuid(),config:effective,sent:false,chunks:[],bytes:0,finishing:false,notice:'',recognized:''};
  this.active=session;this.update({phase:'permission',notice:''});
  try{
   if(provider==='browser'){
    session.recognition=this.ports.createRecognition();
    session.recognition.start(text=>{if(this.current(session))session.recognized=text;},()=>{if(this.current(session))this.review(session,session.recognized);},cause=>{if(this.current(session))this.fail(session,cause);});
    if(this.current(session)){this.update({phase:'recording',notice:''});this.arm(session);}
    return;
   }
   const stream=await this.ports.getStream();
   if(!this.current(session)){for(const track of stream.getTracks())track.stop();return;}
   session.stream=stream;
   const mime=this.mime(effective)!;session.recorder=this.ports.createRecorder(stream,mime);
   const actual=session.recorder.mimeType;
   if(!effective.supportedMimeTypes.includes(actual.split(';')[0])||!this.ports.supportsMime(actual))throw new ApiError(415,'SPEECH_UNSUPPORTED_MEDIA','录音格式不匹配');
   session.recorder.start(blob=>{
    if(!this.current(session))return;session.bytes+=blob.size;
    if(session.bytes>Math.min(effective.maxBytes,4194304)){this.cancel('录音超过大小上限，已取消。');return;}
    session.chunks.push(blob);
   },()=>{if(this.current(session)&&session.finishing)void this.upload(session,actual);},cause=>{if(this.current(session))this.fail(session,cause);});
   if(this.current(session)){this.update({phase:'recording',notice:''});this.arm(session);}
  }catch(cause){if(this.current(session))this.fail(session,cause);}
 }
 private arm(session:Session){session.timer=this.ports.setTimer(()=>{if(this.current(session)){session.notice='已达到录音时长上限，录音已停止。';this.finish();}},Math.min(session.config.maxDurationMs,60000));}
 private clearTimer(session:Session,key:'timer'|'uploadTimer'){if(session[key]!==undefined){this.ports.clearTimer(session[key]);session[key]=undefined;}}
 private stopStream(session:Session){const stream=session.stream;session.stream=undefined;let failed=false;for(const track of stream?.getTracks()??[]){try{track.stop();}catch{failed=true;}}return failed;}
 private release(session:Session){
  this.clearTimer(session,'timer');this.clearTimer(session,'uploadTimer');
  let failed=false;
  const recorder=session.recorder;session.recorder=undefined;if(recorder){try{recorder.detach();}catch{failed=true;}try{recorder.stop();}catch{failed=true;}}
  const recognition=session.recognition;session.recognition=undefined;if(recognition){try{recognition.detach();}catch{failed=true;}try{recognition.abort();}catch{failed=true;}}
  failed=this.stopStream(session)||failed;session.chunks=[];session.bytes=0;return failed;
 }
 finish(){
  const session=this.active;if(!session||session.finishing)return;
  if(this.snapshot.phase==='permission'){this.cancel('权限尚未完成，录音已取消。');return;}
  if(this.snapshot.phase!=='recording')return;
  session.finishing=true;this.clearTimer(session,'timer');this.update({phase:'transcribing',notice:session.notice});
  try{if(session.provider==='browser')session.recognition?.stop();else{session.recorder?.stop();this.stopStream(session);}}
  catch(cause){if(this.current(session))this.fail(session,cause);}
 }
 private async upload(session:Session,mime:string){
  const recorder=session.recorder;session.recorder=undefined;recorder?.detach();this.stopStream(session);
  if(!session.bytes){this.fail(session,new ApiError(400,'SPEECH_INVALID_AUDIO','没有音频'));return;}
  const audio=new Blob(session.chunks,{type:mime});session.chunks=[];session.bytes=0;session.upload=new AbortController();session.sent=true;
  session.uploadTimer=this.ports.setTimer(()=>{if(this.current(session))this.cancel('转写等待超时，已停止本地等待。');},45000);
  try{
   const result=await this.ports.transcribe(audio,session.id,session.upload.signal);
   if(!this.current(session))return;
   if(result.requestId!==session.id||result.provider!=='aliyun'||result.model!=='qwen3-asr-flash')throw new ApiError(502,'SPEECH_UPSTREAM','转写结果无效');
   session.sent=false;this.review(session,result.text);
  }catch(cause){if(this.current(session)){session.sent=false;this.fail(session,cause);}}
 }
 private review(session:Session,text:string){
  if(typeof text!=='string'||!text.trim()||text.length>4000){this.fail(session,new ApiError(502,'SPEECH_UPSTREAM','转写文字无效'));return;}
  const failed=this.release(session);this.active=undefined;
  this.update({phase:'review',review:{text,context:session.context,provider:session.provider},notice:failed?'本地资源释放异常，请检查麦克风状态。':session.notice});
 }
 private fail(session:Session,cause:unknown){
  this.active=undefined;++this.token;session.upload?.abort();const failed=this.release(session);
  this.update({phase:cause instanceof ApiError&&cause.code==='SPEECH_CANCELLED'?'cancelled':'error',error:speechMessage(cause),notice:failed?'本地资源释放异常，请检查麦克风状态。':cause instanceof ApiError&&cause.code==='SPEECH_CANCELLED'?'取消或断网不保证未计费。':''});
 }
 cancel(reason='录音与转写已取消。'){
  const session=this.active;const hadReview=!!this.snapshot.review;++this.token;this.active=undefined;
  if(!session&&!hadReview)return;
  const failed=session?this.release(session):false;session?.upload?.abort();
  const cancellation=this.token;
  this.update({phase:'cancelled',notice:`${reason}${failed?' 本地资源释放异常，请检查麦克风。':''} 取消或断网不保证未计费。`});
  if(session?.sent){
   const abort=new AbortController();const timer=this.ports.setTimer(()=>abort.abort(),3000);
   void this.ports.cancel(session.id,abort.signal).catch(()=>{if(this.token===cancellation)this.update({phase:'cancelled',notice:'本地已取消，服务器取消未确认；取消或断网不保证未计费。'});}).finally(()=>this.ports.clearTimer(timer));
  }
 }
 editReview(text:string){if(this.snapshot.review)this.update({...this.snapshot,review:{...this.snapshot.review,text}});}
 accept(){if(this.snapshot.phase==='review'){++this.token;this.update(initial);}}
 dispose(){this.cancel('语音面板已关闭。');}
}
interface NativeRecognition {
 lang:string;continuous:boolean;interimResults:boolean;
 onresult:((event:{results:ArrayLike<{isFinal:boolean;0:{transcript:string}}>})=>void)|null;onend:(()=>void)|null;onerror:((event:{error:string})=>void)|null;
 start:()=>void;stop:()=>void;abort:()=>void;
}
function recognitionConstructor(){const browser=typeof window==='undefined'?undefined:window as unknown as {SpeechRecognition?:new()=>NativeRecognition;webkitSpeechRecognition?:new()=>NativeRecognition};return browser?.SpeechRecognition??browser?.webkitSpeechRecognition;}
export function nativeSpeechPorts():SpeechPorts{return{
 secure:()=>typeof window!=='undefined'&&window.isSecureContext,
 getStream:()=>navigator.mediaDevices.getUserMedia({audio:true}),supportsMime:mime=>typeof MediaRecorder!=='undefined'&&MediaRecorder.isTypeSupported(mime),
 createRecorder:(stream,mime)=>{
  const recorder=new MediaRecorder(stream as MediaStream,{mimeType:mime});let data:((event:BlobEvent)=>void)|undefined;let end:(()=>void)|undefined;let error:((event:Event)=>void)|undefined;
  return{mimeType:recorder.mimeType,start:(chunk,stopped,failed)=>{data=event=>chunk(event.data);end=stopped;error=failed;recorder.addEventListener('dataavailable',data);recorder.addEventListener('stop',end);recorder.addEventListener('error',error);recorder.start(250);},stop:()=>{if(recorder.state!=='inactive')recorder.stop();},detach:()=>{if(data)recorder.removeEventListener('dataavailable',data);if(end)recorder.removeEventListener('stop',end);if(error)recorder.removeEventListener('error',error);}};
 },
 supportsRecognition:()=>!!recognitionConstructor(),createRecognition:()=>{
  const Constructor=recognitionConstructor();if(!Constructor)throw new Error('Recognition unavailable');const recognition=new Constructor();recognition.lang='zh-CN';recognition.continuous=false;recognition.interimResults=true;
  return{start:(result,end,error)=>{recognition.onresult=event=>result(Array.from(event.results).filter(value=>value.isFinal).map(value=>value[0].transcript).join(''));recognition.onend=end;recognition.onerror=event=>{const cause=new Error('浏览器识别失败');cause.name=event.error;error(cause);};recognition.start();},stop:()=>recognition.stop(),abort:()=>recognition.abort(),detach:()=>{recognition.onresult=null;recognition.onend=null;recognition.onerror=null;}};
 },
 transcribe:uploadSpeech,cancel:cancelSpeech,uuid:()=>crypto.randomUUID(),setTimer:(work,ms)=>setTimeout(work,ms),clearTimer:timer=>clearTimeout(timer as ReturnType<typeof setTimeout>),
};}
