import type {SpeechConfig,SpeechResult} from '@spatial/shared';
import {ApiError} from './api.ts';
const safeMessages:Record<string,string>={SPEECH_NOT_CONFIGURED:'尚未配置语音识别，请继续使用文字输入。',SPEECH_BUSY:'另一个语音请求正在处理，请稍后重新录音。',SPEECH_CANCELLED:'语音识别已取消。',SPEECH_TOO_LARGE:'录音超过大小上限，请缩短录音。',SPEECH_UNSUPPORTED_MEDIA:'此录音格式不可用，请使用文字输入。',SPEECH_INVALID_AUDIO:'录音无效，请重新录音或使用文字输入。',SPEECH_TIMEOUT:'语音识别超时，请重新录音或使用文字输入。',SPEECH_UPSTREAM:'语音识别服务暂不可用，请使用文字输入。',SPEECH_CLOSING:'语音服务正在关闭，请使用文字输入。',SPEECH_REQUEST_CONFLICT:'请求编号冲突，请重新录音。'};
export function speechMessage(cause:unknown){
 if(cause instanceof ApiError)return safeMessages[cause.code]??'无法读取语音结果，请使用文字输入。';
 const name=cause instanceof Error?cause.name:'';
 if(['NotAllowedError','SecurityError','not-allowed','service-not-allowed'].includes(name))return '无法获得录音权限，请使用文字输入。';
 if(['NotFoundError','DevicesNotFoundError','audio-capture'].includes(name))return '没有可用麦克风，请使用文字输入。';
 return '语音输入不可用，请重新录音或使用文字输入。';
}
async function json(url:string,init:RequestInit){
 const response=await fetch(url,{...init,cache:'no-store',redirect:'error'});
 const result=await response.json().catch(()=>null);
 if(!response.ok)throw new ApiError(response.status,typeof result?.error?.code==='string'?result.error.code:'SPEECH_UPSTREAM','语音请求未成功');
 return result;
}
export async function readSpeechConfig(signal:AbortSignal):Promise<SpeechConfig>{
 const value=await json('/speech/config',{signal});
 if(typeof value?.enabled!=='boolean'||value.provider!=='aliyun'||value.model!=='qwen3-asr-flash'||!Array.isArray(value.supportedMimeTypes)||value.supportedMimeTypes.some((mime:unknown)=>!['audio/webm','audio/ogg','audio/wav'].includes(String(mime)))||!Number.isFinite(value.maxBytes)||value.maxBytes<=0||value.maxBytes>4194304||!Number.isFinite(value.maxDurationMs)||value.maxDurationMs<=0||value.maxDurationMs>60000)throw new ApiError(502,'SPEECH_UPSTREAM','语音配置无效');
 return value as SpeechConfig;
}
export async function uploadSpeech(audio:Blob,id:string,signal:AbortSignal):Promise<SpeechResult>{
 const result=await json('/speech/transcribe',{method:'POST',headers:{'Content-Type':audio.type,'X-Speech-Request-Id':id},body:audio,signal});
 if(result?.requestId!==id||result.provider!=='aliyun'||result.model!=='qwen3-asr-flash'||typeof result.text!=='string'||!result.text.trim()||result.text.length>4000)throw new ApiError(502,'SPEECH_UPSTREAM','语音结果无效');
 return result as SpeechResult;
}
export async function cancelSpeech(id:string,signal:AbortSignal){
 const result=await json(`/speech/transcribe/${encodeURIComponent(id)}`,{method:'DELETE',signal});
 if(result?.requestId!==id||!['cancelled','completed'].includes(result.status))throw new ApiError(502,'SPEECH_UPSTREAM','取消结果未确认');
}
