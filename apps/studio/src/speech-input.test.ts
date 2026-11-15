import {afterEach,expect,it,vi} from 'vitest';
import {SpeechController,type SpeechPorts,type RecorderPort,type RecognitionPort,type StreamPort} from './speech-input.ts';
import {ApiError} from './api.ts';
import type {SpeechConfig} from '@spatial/shared';
const controllers:SpeechController[]=[];
const context={selection:null,version:'v1',revision:0,selectionEpoch:0};
const config:SpeechConfig={enabled:true,provider:'aliyun',model:'qwen3-asr-flash',supportedMimeTypes:['audio/webm'],maxBytes:4194304,maxDurationMs:60000,notice:''};
function fixture(){
 let chunk!:(blob:Blob)=>void;let stopped!:()=>void;let recognize!:(text:string)=>void;let end!:()=>void;
 const track={stop:vi.fn(),readyState:'live'};
 const recorder:RecorderPort={mimeType:'audio/webm;codecs=opus',start:vi.fn<RecorderPort['start']>((data,stop)=>{chunk=data;stopped=stop;}),stop:vi.fn(()=>{chunk(new Blob(['final']));stopped();}),detach:vi.fn()};
 const recognition:RecognitionPort={start:vi.fn<RecognitionPort['start']>((result,done)=>{recognize=result;end=done;}),stop:vi.fn(()=>{recognize('浏览器草稿');end();}),abort:vi.fn(),detach:vi.fn()};
 const transcribe=vi.fn(async(_blob:Blob,id:string,_signal:AbortSignal)=>({requestId:id,text:'原始转写',provider:'aliyun' as const,model:'qwen3-asr-flash' as const}));
 let sequence=0;const ports:SpeechPorts={secure:()=>true,getStream:vi.fn(async()=>({getTracks:()=>[track]})),supportsMime:()=>true,createRecorder:()=>recorder,supportsRecognition:()=>true,createRecognition:()=>recognition,transcribe,cancel:vi.fn(async()=>{}),uuid:()=>`request-${++sequence}`,setTimer:(work,ms)=>setTimeout(work,ms),clearTimer:timer=>clearTimeout(timer as ReturnType<typeof setTimeout>)};
 const controller=new SpeechController(ports);controllers.push(controller);
 return {controller,ports,track,recorder,recognition,transcribe,chunk:(data:Blob)=>chunk(data),lateStop:()=>stopped(),recognize:(text:string)=>recognize(text),end:()=>end()};
}
afterEach(()=>{for(const controller of controllers.splice(0))controller.dispose();vi.useRealTimers();});
it.each(['release','hidden','unmount'])('permission arriving after %s is stopped and never records or uploads',async reason=>{
 const f=fixture();let allow!:(stream:StreamPort)=>void;
 f.ports.getStream=()=>new Promise<StreamPort>(resolve=>{allow=resolve;});const starting=f.controller.start(context,'aliyun',config,true);if(reason==='release')f.controller.finish();else f.controller.cancel(reason);
 allow({getTracks:()=>[f.track]});await starting;expect(f.track.stop).toHaveBeenCalledOnce();expect(f.recorder.start).not.toHaveBeenCalled();expect(f.transcribe).not.toHaveBeenCalled();f.controller.dispose();
});
it.each(['blocked','hidden','blur','unmount','gate'])('%s cancels recording immediately and clears resources',async reason=>{
 vi.useFakeTimers();const f=fixture();await f.controller.start(context,'aliyun',config,true);f.controller.cancel(reason);
 expect(f.track.stop).toHaveBeenCalledOnce();expect(f.recorder.detach).toHaveBeenCalled();expect(f.recorder.stop).toHaveBeenCalledOnce();expect(f.transcribe).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);expect(f.controller.getSnapshot().phase).toBe('cancelled');
});
it('normal stop includes the final dataavailable once and goes only to editable review',async()=>{
 const f=fixture();await f.controller.start(context,'aliyun',config,true);f.chunk(new Blob(['first']));f.controller.finish();await vi.waitFor(()=>expect(f.controller.getSnapshot().phase).toBe('review'));
 expect(f.transcribe).toHaveBeenCalledOnce();expect(await f.transcribe.mock.calls[0][0].text()).toBe('firstfinal');expect(f.track.stop).toHaveBeenCalledOnce();f.controller.editReview('用户编辑');expect(f.controller.getSnapshot().review?.text).toBe('用户编辑');f.controller.dispose();
});
it('transcribing cancellation aborts POST and sends bounded DELETE; failure and late success cannot restore review',async()=>{
 const f=fixture();let result!:(value:Awaited<ReturnType<typeof f.transcribe>>)=>void;
 f.transcribe.mockImplementation((_blob,id,signal)=>new Promise(resolve=>{result=resolve;}));vi.mocked(f.ports.cancel).mockRejectedValue(new Error('fake private error'));
 await f.controller.start(context,'aliyun',config,true);f.controller.finish();const id=f.transcribe.mock.calls[0][1];const signal=f.transcribe.mock.calls[0][2];
 f.controller.cancel('影响模式');expect(signal.aborted).toBe(true);expect(f.ports.cancel).toHaveBeenCalledOnce();result({requestId:id,text:'late',provider:'aliyun',model:'qwen3-asr-flash'});
 await vi.waitFor(()=>expect(f.controller.getSnapshot().notice).toContain('未确认'));expect(f.controller.getSnapshot().review).toBeUndefined();f.controller.dispose();
});
it('every explicit retry has a new request UUID and cancelled code is understood independently of 499',async()=>{
 const f=fixture();f.transcribe.mockRejectedValue(new ApiError(499,'SPEECH_CANCELLED','unsafe body'));
 await f.controller.start(context,'aliyun',config,true);f.controller.finish();await vi.waitFor(()=>expect(f.controller.getSnapshot().phase).toBe('cancelled'));
 await f.controller.start(context,'aliyun',config,true);f.controller.finish();await vi.waitFor(()=>expect(f.transcribe).toHaveBeenCalledTimes(2));expect(f.transcribe.mock.calls[0][1]).not.toBe(f.transcribe.mock.calls[1][1]);expect(f.controller.getSnapshot().error??'').not.toContain('unsafe');f.controller.dispose();
});
it('60 seconds finishes normally, excessive chunks cancel without upload, MIME mismatch never requests a stream',async()=>{
 vi.useFakeTimers();const f=fixture();await f.controller.start(context,'aliyun',config,true);await vi.advanceTimersByTimeAsync(60000);expect(f.transcribe).toHaveBeenCalledOnce();expect(f.controller.getSnapshot().notice).toContain('上限');f.controller.dispose();
 const large=fixture();await large.controller.start(context,'aliyun',config,true);large.chunk(new Blob([new Uint8Array(4194305)]));expect(large.transcribe).not.toHaveBeenCalled();expect(large.track.stop).toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);large.controller.dispose();
 const unsupported=fixture();unsupported.ports.supportsMime=()=>false;await unsupported.controller.start(context,'aliyun',config,true);expect(unsupported.ports.getStream).not.toHaveBeenCalled();expect(unsupported.controller.getSnapshot().phase).toBe('error');unsupported.controller.dispose();
});
it('browser recognition is explicit, shares review, and cancellation discards saved late callbacks',async()=>{
 const f=fixture();expect(f.recognition.start).not.toHaveBeenCalled();await f.controller.start(context,'browser',config,true);expect(f.ports.getStream).not.toHaveBeenCalled();f.controller.finish();expect(f.controller.getSnapshot().review?.provider).toBe('browser');expect(f.controller.getSnapshot().review?.text).toBe('浏览器草稿');expect(f.transcribe).not.toHaveBeenCalled();
 f.controller.accept();await f.controller.start(context,'browser',config,true);f.controller.cancel('hidden');f.recognize('late');f.end();expect(f.recognition.abort).toHaveBeenCalled();expect(f.controller.getSnapshot().review).toBeUndefined();f.controller.dispose();
});
it('browser recognition with no final text reports no speech instead of an upstream outage',async()=>{
 const f=fixture();f.recognition.stop=vi.fn(()=>f.end());await f.controller.start(context,'browser',config,true);f.controller.finish();
 await vi.waitFor(()=>expect(f.controller.getSnapshot().phase).toBe('error'));expect(f.controller.getSnapshot().error).toBe('未识别到语音，请重新录音或使用文字输入。');expect(f.recognition.detach).toHaveBeenCalled();f.controller.dispose();
});
it('unavailable gates and invalid transcripts preserve typed path without automatic fallback',async()=>{
 const f=fixture();await f.controller.start(context,'aliyun',config,false);expect(f.ports.getStream).not.toHaveBeenCalled();
 f.transcribe.mockResolvedValue({requestId:'wrong',text:'x'.repeat(4001),provider:'aliyun',model:'qwen3-asr-flash'});await f.controller.start(context,'aliyun',config,true);f.controller.finish();await vi.waitFor(()=>expect(f.controller.getSnapshot().phase).toBe('error'));expect(f.recognition.start).not.toHaveBeenCalled();f.controller.dispose();
});
