import { isPlacementPreviewMessage, type AssetPlacementTarget, type AssetPlacementSession } from '@spatial/shared';

export type PlacementSession = AssetPlacementSession;
export type PlacementMessageResult =
  | { cancelled: true }
  | { target: AssetPlacementTarget }
  | { slotRect: [number, number, number, number] | null; isVoidTag?: boolean };

export function placementMessage(
  event: { origin: string; source: unknown; data: unknown },
  input: { origin: string; frame: unknown; session: PlacementSession; version: string; now: number },
): PlacementMessageResult | undefined {
  if (
    event.origin !== input.origin ||
    event.source !== input.frame ||
    !isPlacementPreviewMessage(event.data) ||
    event.data.payload.sessionId !== input.session.sessionId ||
    input.now > input.session.expiresAt ||
    input.version !== input.session.baseVersion
  ) return;
  if (event.data.type === 'placement:cancelled') return { cancelled: true };
  if (event.data.type === 'placement:slot') {
    return {
      slotRect: event.data.payload.rect,
      ...(event.data.payload.isVoidTag !== undefined ? { isVoidTag: event.data.payload.isVoidTag } : {}),
    };
  }
  return { target: event.data.payload.target };
}
