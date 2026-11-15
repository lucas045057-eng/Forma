import {expect,it} from 'vitest';
import {reviewDecision,bindingMatches,PressGesture,type SpeechContext} from './speech-review.ts';
const a:SpeechContext={selection:{src:'src/A.tsx:1:1',cid:'A',baseVersion:'v1'},version:'v1',revision:0,selectionEpoch:1};
const b:SpeechContext={...a,selection:{src:'src/B.tsx:2:1',cid:'B',baseVersion:'v1'},selectionEpoch:2};
it('A to B requires explicit current-object confirmation and never restores A',()=>{
 const result=reviewDecision(a,b,true,'改成圆角');expect(result.normal).toBe(false);expect(result.current).toBe(true);expect(result.selectionChanged).toBe(true);
 expect(bindingMatches(a,b)).toBe(false);
});
it('none to selected and selected to none both require explicit confirmation',()=>{
 const none={...a,selection:null,selectionEpoch:3};
 for(const [from,to]of [[a,none],[none,b]] as const){const result=reviewDecision(from,to,true,'修改');expect(result.normal).toBe(false);expect(result.current).toBe(true);}
});
it('version changes and pending picks block every confirmation',()=>{
 for(const ready of [true,false]){const result=reviewDecision(a,{...b,version:'v2'},ready,'修改');expect(result.normal||result.current||result.replace).toBe(false);expect(result.stale).toBe(true);}
 const pending=reviewDecision(a,b,false,'修改');expect(pending.current).toBe(false);
});
it('text edited since capture requires explicit replacement, never silent normal use',()=>{
 const result=reviewDecision(a,{...a,revision:4},true,'语音草稿');expect(result.normal).toBe(false);expect(result.replace).toBe(true);expect(result.instructionChanged).toBe(true);
 expect(reviewDecision(a,a,true,'   ').normal).toBe(false);expect(reviewDecision(a,a,true,'x'.repeat(4001)).normal).toBe(false);
});
it('confirmation followed by another pick, even an A B A cycle, cannot submit without reconfirming',()=>{
 expect(bindingMatches(a,a)).toBe(true);expect(bindingMatches(a,{...a,selectionEpoch:3})).toBe(false);expect(bindingMatches(a,{...a,revision:9})).toBe(true);
});
it('normal pointerup ignores lostcapture; abnormal capture and keyboard repeats cancel only one active press',()=>{
 const press=new PressGesture();expect(press.begin('pointer',7)).toBe(true);expect(press.begin('pointer',8)).toBe(false);
 expect(press.end('pointer',7)).toBe(true);expect(press.lost(7)).toBe(false);
 expect(press.begin('pointer',9)).toBe(true);expect(press.lost(9)).toBe(true);
 expect(press.begin('keyboard')).toBe(true);expect(press.begin('keyboard')).toBe(false);expect(press.end('keyboard')).toBe(true);expect(press.end('keyboard')).toBe(false);
});
