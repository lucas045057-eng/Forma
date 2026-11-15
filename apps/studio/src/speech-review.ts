import type {Selection} from '@spatial/shared';
export type SpeechIdentity=Pick<Selection,'src'|'cid'|'baseVersion'>;
export interface SpeechContext {selection:SpeechIdentity|null;version:string;revision:number;selectionEpoch:number}
export type ReviewMode='normal'|'replace'|'current';
export function identityLabel(value:SpeechIdentity|null){return value?`${value.cid} · ${value.src} · ${value.baseVersion}`:'未选中对象（整体修改）';}
export function sameIdentity(a:SpeechIdentity|null,b:SpeechIdentity|null){return a===null?b===null:b!==null&&a.src===b.src&&a.cid===b.cid&&a.baseVersion===b.baseVersion;}
export function bindingMatches(binding:SpeechContext,current:SpeechContext){return binding.version===current.version&&binding.selectionEpoch===current.selectionEpoch&&sameIdentity(binding.selection,current.selection);}
export function reviewDecision(capture:SpeechContext,current:SpeechContext,ready:boolean,text:string){
 const stale=capture.version!==current.version;
 const selectionChanged=!sameIdentity(capture.selection,current.selection)||capture.selectionEpoch!==current.selectionEpoch;
 const instructionChanged=capture.revision!==current.revision;
 const valid=ready&&!stale&&!!text.trim()&&text.length<=4000;
 return {stale,selectionChanged,instructionChanged,normal:valid&&!selectionChanged&&!instructionChanged,replace:valid&&!selectionChanged&&instructionChanged,current:valid&&selectionChanged};
}
export class PressGesture{
 private active?:{kind:'pointer'|'keyboard';id?:number};
 begin(kind:'pointer'|'keyboard',id?:number){if(this.active)return false;this.active={kind,id};return true;}
 end(kind:'pointer'|'keyboard',id?:number){if(this.active?.kind!==kind||this.active.id!==id)return false;this.active=undefined;return true;}
 lost(id:number){return this.end('pointer',id);}
 clear(){const value=this.active;this.active=undefined;return value;}
}
