import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { AssetPlacementSession, AssetPlacementTarget, StudioMessage } from '@spatial/shared';
import { api, ApiError, mutation } from './api.ts';
import { placementMessage, type PlacementSession } from './placement-state.ts';
import { previewOrigin } from './preview-origin.ts';

export async function placementRequest<T>(url: string, method: 'GET' | 'POST' | 'PUT', body?: unknown): Promise<T> {
  try {
    return await api<T>(url, method === 'GET' ? undefined : mutation(method, body));
  } catch (cause) {
    if (cause instanceof ApiError) {
      throw new Error(cause.message || '放置结果未确认，请刷新状态');
    }
    throw new Error('放置请求未确认，请刷新状态后重试');
  }
}

export interface UsePlacementSessionOptions {
  assetId: string;
  frame: HTMLIFrameElement | null;
  initialSession?: PlacementSession;
  syncReady: boolean;
  status: string;
  stateVersion: string;
  confirmedRef: MutableRefObject<boolean>;
  widthPercent: number;
  align: 'start' | 'center' | 'end';
  onClose: () => void;
  onError: (message: string) => void;
  onTargetSelected?: () => void;
}

/** Manages placement session lifecycle, preview iframe handshake, target picking, and layout sync. */
export function usePlacementSession({
  assetId,
  frame,
  initialSession,
  syncReady,
  status,
  stateVersion,
  confirmedRef,
  widthPercent,
  align,
  onClose,
  onError,
  onTargetSelected,
}: UsePlacementSessionOptions) {
  const [session, setSession] = useState<AssetPlacementSession | undefined>(() => initialSession);
  const [target, setTarget] = useState<AssetPlacementTarget>();
  const [slotRect, setSlotRect] = useState<[number, number, number, number] | null>(null);
  const [isVoidTag, setIsVoidTag] = useState(false);

  const currentVersionRef = useRef(stateVersion);
  currentVersionRef.current = stateVersion;
  const targetRef = useRef(target);
  targetRef.current = target;
  const layoutRef = useRef({ widthPercent, align });
  layoutRef.current = { widthPercent, align };
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onTargetSelectedRef = useRef(onTargetSelected);
  onTargetSelectedRef.current = onTargetSelected;

  const send = (message: StudioMessage) => frame?.contentWindow?.postMessage(message, previewOrigin);

  useEffect(() => {
    if (initialSession && initialSession.expiresAt > Date.now() && session?.sessionId !== initialSession.sessionId) {
      setSession(initialSession);
      onErrorRef.current('');
      return;
    }
    let active = true;
    if (confirmedRef.current || !syncReady || status !== 'connected' || !frame || !stateVersion) return;
    if (session) {
      frame.contentWindow?.postMessage({ type: 'pick:stop' }, previewOrigin);
      frame.contentWindow?.postMessage({ type: 'placement:start', payload: session }, previewOrigin);
      frame.contentWindow?.postMessage({
        type: 'placement:preview-layout',
        payload: { sessionId: session.sessionId, target: targetRef.current ?? null, layout: layoutRef.current },
      }, previewOrigin);
      return;
    }
    void placementRequest<AssetPlacementSession>('/assets/placements/sessions', 'POST', {
      assetId,
      baseVersion: stateVersion,
    })
      .then(result => {
        if (!active) return;
        setSession(result);
        frame.contentWindow?.postMessage({ type: 'pick:stop' }, previewOrigin);
        frame.contentWindow?.postMessage({ type: 'placement:start', payload: result }, previewOrigin);
        frame.contentWindow?.postMessage({
          type: 'placement:preview-layout',
          payload: { sessionId: result.sessionId, target: null, layout: layoutRef.current },
        }, previewOrigin);
      })
      .catch(cause => {
        if (active) onErrorRef.current(cause instanceof Error ? cause.message : '放置会话未创建');
      });
    return () => { active = false; };
  }, [initialSession, assetId, frame, syncReady, status, stateVersion, session]);

  // Sync live layout (position / widthPercent / align) into the webpage's in-flow preview slot.
  useEffect(() => {
    if (!session || !frame) return;
    send({
      type: 'placement:preview-layout',
      payload: {
        sessionId: session.sessionId,
        target: target ?? null,
        layout: { widthPercent, align },
      },
    });
  }, [session, frame, target, widthPercent, align]);

  useEffect(() => {
    if (!session) return;
    const receive = (event: MessageEvent<unknown>) => {
      const result = placementMessage(event, {
        origin: previewOrigin,
        frame: frame?.contentWindow,
        session,
        version: currentVersionRef.current,
        now: Date.now(),
      });
      if (!result) return;
      if ('cancelled' in result) {
        onCloseRef.current();
        return;
      }
      if ('slotRect' in result) {
        setSlotRect(result.slotRect);
        if (result.isVoidTag !== undefined) setIsVoidTag(result.isVoidTag);
        return;
      }
      onErrorRef.current('');
      setTarget(result.target);
      onTargetSelectedRef.current?.();
    };
    window.addEventListener('message', receive);
    const timer = setTimeout(() => {
      onErrorRef.current('放置会话已过期，请重新放入');
      setTarget(undefined);
      setSlotRect(null);
      send({ type: 'placement:stop', payload: { sessionId: session.sessionId } });
    }, Math.max(1, session.expiresAt - Date.now()));
    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', receive);
      send({ type: 'placement:stop', payload: { sessionId: session.sessionId } });
    };
  }, [session, frame]);

  useEffect(() => {
    if (session && (stateVersion !== session.baseVersion || !syncReady)) {
      setTarget(undefined);
      setSlotRect(null);
      if (stateVersion !== session.baseVersion) onErrorRef.current('作品版本已变化，请重新放置');
    }
  }, [stateVersion, syncReady, session]);

  function clearTarget() {
    setTarget(undefined);
    setSlotRect(null);
  }

  return { session, target, setTarget, slotRect, isVoidTag, clearTarget, send };
}
