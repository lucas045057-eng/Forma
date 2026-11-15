import {afterEach,expect,it,vi} from 'vitest';
import {uploadSpeech,cancelSpeech,speechMessage,readSpeechConfig} from './speech-api.ts';
import {ApiError} from './api.ts';
afterEach(()=>vi.restoreAllMocks());
it.each([[503,'SPEECH_NOT_CONFIGURED'],[429,'SPEECH_BUSY'],[499,'SPEECH_CANCELLED'],[500,'SPEECH_UPSTREAM']] as const)('safe HTTP %i error keeps code %s and never retries or displays upstream payload',async(status,code)=>{
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({error:{code,message:'<script>private-unsafe-body</script>'}}),{status}));
 let result:unknown;try{await uploadSpeech(new Blob(['fake'],{type:'audio/webm'}),'id',new AbortController().signal);}catch(error){result=error;}
 expect(result).toBeInstanceOf(ApiError);expect((result as ApiError).code).toBe(code);expect(speechMessage(result)).not.toContain('private');expect(fetch).toHaveBeenCalledOnce();
});
it.each(['','x'.repeat(4001),null])('invalid transcript fails without silently truncating',async text=>{
 vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({requestId:'id',text,provider:'aliyun',model:'qwen3-asr-flash'})));
 await expect(uploadSpeech(new Blob(['fake'],{type:'audio/webm'}),'id',new AbortController().signal)).rejects.toMatchObject({code:'SPEECH_UPSTREAM'});
});
it('DELETE failure is exposed safely and config cannot silently enable an invalid audio format',async()=>{
 const fetch=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(JSON.stringify({error:{code:'SPEECH_UPSTREAM',message:'secret'}}),{status:500})).mockResolvedValueOnce(new Response(JSON.stringify({enabled:true,provider:'aliyun',model:'qwen3-asr-flash',supportedMimeTypes:['video/mpeg'],maxBytes:4194304,maxDurationMs:60000})));
 await expect(cancelSpeech('id',new AbortController().signal)).rejects.toMatchObject({code:'SPEECH_UPSTREAM'});
 await expect(readSpeechConfig(new AbortController().signal)).rejects.toMatchObject({code:'SPEECH_UPSTREAM'});
 expect(fetch.mock.calls[0][1]).toMatchObject({method:'DELETE',redirect:'error'});
});
