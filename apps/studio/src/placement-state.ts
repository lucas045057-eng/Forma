import {isPlacementPreviewMessage,type AssetPlacementTarget,type AssetPlacementSession} from '@spatial/shared';
export type PlacementSession = AssetPlacementSession;
export function placementMessage(event:{origin:string;source:unknown;data:unknown},input:{origin:string;frame:unknown;session:PlacementSession;version:string;now:number}):{cancelled:true}|{target:AssetPlacementTarget}|undefined{
 if(event.origin!==input.origin||event.source!==input.frame||!isPlacementPreviewMessage(event.data)||event.data.payload.sessionId!==input.session.sessionId||input.now>input.session.expiresAt||input.version!==input.session.baseVersion)return;
 return event.data.type==='placement:cancelled'?{cancelled:true}:{target:event.data.payload.target};
}
