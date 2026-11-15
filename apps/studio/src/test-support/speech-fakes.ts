export interface SpeechFakeState {streams:number;liveTracks:number;recorderStarts:number;recorderStops:number;vendorStarts:number;vendorAborts:number;holdPermission:boolean;mimeSupported:boolean;releasePermissions:()=>void}
declare global {interface Window {__speechTest:SpeechFakeState}}
/** Browser API substitutes only; no real microphone or recognition service is requested. */
export function installSpeechFakes(){
 const pending:Array<()=>void>=[];
 const state:SpeechFakeState={streams:0,liveTracks:0,recorderStarts:0,recorderStops:0,vendorStarts:0,vendorAborts:0,holdPermission:false,mimeSupported:true,releasePermissions:()=>{for(const resolve of pending.splice(0))resolve();}};
 window.__speechTest=state;
 function stream(){++state.streams;++state.liveTracks;const track={readyState:'live',stop(){if(this.readyState==='live'){this.readyState='ended';--state.liveTracks;}}};return {getTracks:()=>[track]} as unknown as MediaStream;}
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:()=>new Promise<MediaStream>(resolve=>{const done=()=>resolve(stream());if(state.holdPermission)pending.push(done);else done();})}});
 class FakeRecorder extends EventTarget {
  static isTypeSupported(){return state.mimeSupported;}
  state='inactive';mimeType:string;
  constructor(_stream:MediaStream,options:{mimeType:string}){super();this.mimeType=options.mimeType;}
  start(){this.state='recording';++state.recorderStarts;}
  stop(){if(this.state==='inactive')return;this.state='inactive';++state.recorderStops;queueMicrotask(()=>{this.dispatchEvent(new BlobEvent('dataavailable',{data:new Blob([new Uint8Array([0x1a,0x45,0xdf,0xa3,1])],{type:this.mimeType})}));this.dispatchEvent(new Event('stop'));});}
 }
 Object.defineProperty(window,'MediaRecorder',{configurable:true,value:FakeRecorder});
 class FakeRecognition {
  lang='';continuous=false;interimResults=false;onresult:((event:unknown)=>void)|null=null;onend:(()=>void)|null=null;onerror:((event:unknown)=>void)|null=null;
  start(){++state.vendorStarts;}
  stop(){const result=this.onresult;const end=this.onend;queueMicrotask(()=>{result?.({results:[{isFinal:true,0:{transcript:'浏览器替身转写'}}]});end?.();});}
  abort(){++state.vendorAborts;}
 }
 Object.defineProperty(window,'SpeechRecognition',{configurable:true,value:FakeRecognition});Object.defineProperty(window,'webkitSpeechRecognition',{configurable:true,value:FakeRecognition});
}
