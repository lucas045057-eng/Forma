import type { PlacementSession } from './placement-state.ts';

export type SessionSnapshot = Readonly<Record<string, PlacementSession>>;

/** A cached session may only authorize a drag before its server-issued expiry. */
export function liveSession(sessions: SessionSnapshot, assetId: string, now = Date.now()): PlacementSession | undefined {
  const session = sessions[assetId];
  return session && session.expiresAt > now ? session : undefined;
}

/**
 * Drag sessions requested by the workbench's active interactions (pointer enter, focus, click).
 *
 * - A live cache entry is returned without calling the API again.
 * - An expired or missing entry is prepared again; the expired value is never reused.
 * - Concurrent interactions for the same asset share one in-flight request, so a single card
 *   cannot burn several of the server's session slots.
 * - This only re-requests on user interaction; it never renews in the background and never
 *   extends the server TTL.
 */
export class DragSessionCache {
  private sessions: Record<string, PlacementSession> = {};
  private inflight = new Map<string, Promise<PlacementSession>>();

  snapshot(): Record<string, PlacementSession> { return this.sessions; }

  live(assetId: string, now = Date.now()): PlacementSession | undefined {
    return liveSession(this.sessions, assetId, now);
  }

  async ensure(assetId: string, prepare: () => Promise<PlacementSession>): Promise<PlacementSession> {
    const live = this.live(assetId);
    if (live) return live;
    const pending = this.inflight.get(assetId);
    if (pending) return pending;
    const request = prepare()
      .then(session => {
        this.sessions = { ...this.sessions, [assetId]: session };
        return session;
      })
      .finally(() => {
        if (this.inflight.get(assetId) === request) this.inflight.delete(assetId);
      });
    this.inflight.set(assetId, request);
    return request;
  }
}
