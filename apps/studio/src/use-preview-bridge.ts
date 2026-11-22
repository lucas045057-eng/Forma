import { useEffect, useRef, useState } from 'react';
import { isPreviewMessage, type ApprovalCard, type StudioMessage } from '@spatial/shared';
import type { PreviewMode } from './CandidatePanel.tsx';
import { api } from './api.ts';
import { impactHighlightMessages, isImpactPickError, restorePicking, waiting } from './approval-state.ts';
import type { M2State } from './m2-state.ts';
import type { PickState } from './pick-state.ts';
import { previewOrigin } from './preview-origin.ts';
import type { SurfaceAction } from './surface-state.ts';

function syncScroll(frame: HTMLIFrameElement | null, at: number) {
  frame?.contentWindow?.postMessage({ type: 'scroll:to', payload: { at } }, previewOrigin);
}

export interface UsePreviewBridgeOptions {
  state: M2State;
  syncReady: boolean;
  showScene: boolean;
  mode: PreviewMode;
  activeCandidateId: string | undefined;
  onSetMode: (mode: PreviewMode) => void;
  onDispatchSurface: (action: SurfaceAction) => void;
  onError: (message: string) => void;
}

/** Coordinates postMessage handshakes, element picking, impact highlight, and bidirectional scroll sync. */
export function usePreviewBridge({
  state,
  syncReady,
  showScene,
  mode,
  activeCandidateId,
  onSetMode,
  onDispatchSurface,
  onError,
}: UsePreviewBridgeOptions) {
  const preview = useRef<HTMLIFrameElement>(null);
  const candidatePreview = useRef<HTMLIFrameElement>(null);
  const pickingRef = useRef(false);
  const pickRequest = useRef(0);
  const progressRef = useRef(0);
  const scrollLeaderRef = useRef<{ source: 'main' | 'candidate'; until: number } | null>(null);
  const canvasWidth = useRef(400);

  const [picking, setPicking] = useState(false);
  const [ready, setReady] = useState(false);
  const [candidateReady, setCandidateReady] = useState(false);
  const [pick, setPick] = useState<PickState>({ kind: 'none' });
  const [pickedAt, setPickedAt] = useState<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [impact, setImpact] = useState<{ id: string; src: string; baseVersion: string; wasPicking: boolean } | null>(null);
  const impactRef = useRef<typeof impact>(null);

  const onSetModeRef = useRef(onSetMode);
  onSetModeRef.current = onSetMode;
  const onDispatchSurfaceRef = useRef(onDispatchSurface);
  onDispatchSurfaceRef.current = onDispatchSurface;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const pickKindRef = useRef<PickState['kind']>('none');
  pickKindRef.current = pick.kind;

  const selection = pick.kind === 'ready' ? pick.selection : null;
  const selectionVersion = useRef(state.version);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const stateVersionRef = useRef(state.version);
  stateVersionRef.current = state.version;

  const send = (message: StudioMessage) => preview.current?.contentWindow?.postMessage(message, previewOrigin);
  const sendCandidate = (message: StudioMessage) => candidatePreview.current?.contentWindow?.postMessage(message, previewOrigin);

  useEffect(() => {
    const previous = selectionVersion.current;
    selectionVersion.current = state.version;
    if (!previous || previous === state.version) return;
    ++pickRequest.current;
    setPick({ kind: 'none' });
    pickingRef.current = false;
    setPicking(false);
    send({ type: 'pick:stop' });
    if (pickKindRef.current === 'ready' || pickKindRef.current === 'pending') {
      onErrorRef.current('页面已变化，请重新点选');
    }
  }, [state.version]);

  function exitImpact(restore = true) {
    const previous = impactRef.current;
    if (!previous) return;
    impactRef.current = null;
    setImpact(null);
    send({ type: 'pick:stop' });
    pickingRef.current = !!(restore && restorePicking(previous.wasPicking, selectionRef.current, stateVersionRef.current));
    setPicking(pickingRef.current);
    if (pickingRef.current && selectionRef.current) {
      send({ type: 'pick:start' });
      send({ type: 'highlight', payload: { src: selectionRef.current.src } });
    }
  }

  function highlight(card: ApprovalCard, src: string) {
    if (!syncReady || card.baseVersion !== state.version || !waiting(card)) return;
    ++pickRequest.current;
    if (pick.kind === 'pending') setPick({ kind: 'none' });
    const next = { id: card.id, src, baseVersion: card.baseVersion, wasPicking: impactRef.current?.wasPicking ?? pickingRef.current };
    impactRef.current = next;
    setImpact(next);
    onDispatchSurfaceRef.current({ type: 'impact-highlight' });
    onSetModeRef.current('current');
    pickingRef.current = false;
    setPicking(false);
    impactHighlightMessages(src).forEach(send);
  }

  useEffect(() => {
    if (!impact) return;
    const card = state.approvals.find(item => item.id === impact.id);
    if (!syncReady || showScene || mode !== 'current' || impact.baseVersion !== state.version || !card || !waiting(card)) {
      exitImpact(syncReady && !showScene);
    }
  }, [state, syncReady, showScene, mode, impact]);

  useEffect(() => {
    setCandidateReady(false);
  }, [activeCandidateId]);

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== previewOrigin || !isPreviewMessage(event.data)) return;
      const fromMain = event.source === preview.current?.contentWindow;
      const fromCandidate = event.source === candidatePreview.current?.contentWindow;
      if (!fromMain && !fromCandidate) return;
      if (fromCandidate) {
        if (event.data.type === 'ready') {
          setCandidateReady(true);
          sendCandidate({ type: 'pick:stop' });
          syncScroll(candidatePreview.current, progressRef.current);
        } else if (event.data.type === 'scroll:progress') {
          if (event.data.payload.sync !== false) {
            const now = performance.now();
            if (scrollLeaderRef.current?.source === 'main' && now < scrollLeaderRef.current.until) return;
            scrollLeaderRef.current = { source: 'candidate', until: now + 120 };
            syncScroll(preview.current, event.data.payload.at);
          }
          progressRef.current = event.data.payload.at;
          setProgress(event.data.payload.at);
        }
        // Candidate frames deliberately never enter picking mode or change Selection.
        return;
      }
      if (impactRef.current && (event.data.type === 'pick:result' || (event.data.type === 'error' && isImpactPickError(event.data.payload.message)))) {
        impactHighlightMessages(impactRef.current.src).forEach(send);
        return;
      }
      switch (event.data.type) {
        case 'ready':
          if (impactRef.current) {
            impactRef.current = null;
            setImpact(null);
            pickingRef.current = false;
            setPicking(false);
            send({ type: 'pick:stop' });
          }
          ++pickRequest.current;
          setReady(true);
          onErrorRef.current('');
          setPick({ kind: 'none' });
          send({ type: pickingRef.current ? 'pick:start' : 'pick:stop' });
          break;
        case 'pick:result': {
          if (impactRef.current || !pickingRef.current) return;
          const payload = event.data.payload;
          const requestId = ++pickRequest.current;
          send({ type: 'highlight', payload: { src: payload.src } });
          // The previous object stops being submittable the moment a new one is picked.
          setPick({ kind: 'pending', src: payload.src });
          setPickedAt(progressRef.current);
          onDispatchSurfaceRef.current({ type: 'pick-received' });
          void api<{ version: string }>('/version').then(result => {
            if (requestId !== pickRequest.current) return;
            setPick({ kind: 'ready', selection: { ...payload, baseVersion: result.version } });
            onErrorRef.current('');
          }).catch(() => {
            if (requestId !== pickRequest.current) return;
            setPick({ kind: 'failed', src: payload.src });
            onErrorRef.current('无法读取作品版本，请确认后端已启动后重新点选');
          });
          break;
        }
        case 'scroll:progress':
          // Only a real scroll moves the other artboard; a pick reports its position with sync: false.
          if (event.data.payload.sync !== false) {
            const now = performance.now();
            if (scrollLeaderRef.current?.source === 'candidate' && now < scrollLeaderRef.current.until) break;
            scrollLeaderRef.current = { source: 'main', until: now + 120 };
            syncScroll(candidatePreview.current, event.data.payload.at);
          }
          progressRef.current = event.data.payload.at;
          setProgress(event.data.payload.at);
          break;
        case 'viewport:size':
          canvasWidth.current = event.data.payload.width;
          break;
        case 'error':
          onErrorRef.current(event.data.payload.message);
          break;
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  function stopPicking() {
    pickingRef.current = false;
    setPicking(false);
    send({ type: 'pick:stop' });
  }

  function togglePicking() {
    if (impactRef.current) { exitImpact(); return; }
    if (mode === 'candidate') onSetMode('current');
    const next = !pickingRef.current;
    if (next) onDispatchSurface({ type: 'pick-started' });
    pickingRef.current = next;
    setPicking(next);
    send({ type: next ? 'pick:start' : 'pick:stop' });
    if (next && selection) send({ type: 'highlight', payload: { src: selection.src } });
  }

  function resetForWorkChange() {
    exitImpact(false);
    pickingRef.current = false;
    setPicking(false);
    setPick({ kind: 'none' });
  }

  function handleMainFrameLoad() {
    exitImpact(false);
    send({ type: pickingRef.current ? 'pick:start' : 'pick:stop' });
  }

  const previewSize = () => { send({ type: 'viewport:request' }); return canvasWidth.current; };

  return {
    preview,
    candidatePreview,
    picking,
    ready,
    setReady,
    candidateReady,
    pick,
    selection,
    pickedAt,
    progress,
    impact,
    send,
    exitImpact,
    highlight,
    stopPicking,
    togglePicking,
    previewSize,
    resetForWorkChange,
    handleMainFrameLoad,
  };
}
