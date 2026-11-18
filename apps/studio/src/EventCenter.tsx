import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Candidate, Task } from '@spatial/shared';
import { currentSync, collectRunResults, pendingRunIds, reconcileLiveEvent, reconcileSnapshot, type EventHistory } from './sync-state.ts';
import { emptyM2State, isCandidate, isTask, type IncomingEvent, type M2State } from './m2-state.ts';
import { isApproval, sortApprovals } from './approval-state.ts';
import { MutationLocks } from './mutation-locks.ts';

export type CenterEvent = { type: string; seq?: number; ts?: string } & Record<string, unknown>;
type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';
interface EventCenterValue {
  state: M2State;
  status: ConnectionStatus;
  syncReady: boolean;
  syncError: string;
  syncEpoch: number;
  lastSeq: number;
  subscribe: (listener: (event: CenterEvent) => void) => () => void;
  reload: (freshAnchor?: boolean) => Promise<void>;
  acquire: (keys: string[]) => symbol | undefined;
  awaiting: (token: symbol) => void;
  locked: (keys: string[]) => boolean;
}
const EventCenterContext = createContext<EventCenterValue | null>(null);
async function json<T>(url: string): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), cache: 'no-store' });
  if (!response.ok) throw new Error(`请求失败：${response.status}`);
  return response.json() as Promise<T>;
}
type History = EventHistory;

export function EventCenterProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<M2State>(emptyM2State);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [syncReady, setSyncReady] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [lastSeq, setLastSeq] = useState(0);
  const [syncEpoch, setSyncEpoch] = useState(0);
  const liveReady = useRef(false);
  const epochRef = useRef(0);
  const locks = useRef(new MutationLocks());
  const [, setLockRevision] = useState(0);
  const locked = useCallback((keys: string[]) => locks.current.blocked(keys), []);
  const acquire = useCallback((keys: string[]) => {
    if (!liveReady.current) return;
    const token = locks.current.acquire(keys);
    if (token) setLockRevision(value => value + 1);
    return token;
  }, []);
  const awaiting = useCallback((token: symbol) => {
    locks.current.awaiting(token, epochRef.current);
    setLockRevision(value => value + 1);
  }, []);
  const listeners = useRef(new Set<(event: CenterEvent) => void>());
  const reloadRef = useRef<(freshAnchor?: boolean) => Promise<void>>(async () => { throw new Error('事件尚未连接'); });
  const reload = useCallback((freshAnchor?: boolean) => reloadRef.current(freshAnchor), []);
  const subscribe = useCallback((listener: (event: CenterEvent) => void) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);

  useEffect(() => {
    let disposed = false;
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let connection = 0;
    let request = 0;
    let seq = 0;
    let currentState = emptyM2State;
    let initialized = false;
    let syncing = false;
    let readyReceived = false;
    let buffer: IncomingEvent[] = [];
    let overflow = false;
    const notify = (event: CenterEvent) => { for (const listener of listeners.current) listener(event); };
    const valid = (generation: number, operation: number) => currentSync(generation, operation, connection, request, socket?.readyState === WebSocket.OPEN, disposed);
    const history = (since: number) => json<History>(`/events/history?since=${since}`);

    async function synchronize(anchor = seq, freshAnchor = false) {
      const generation = connection;
      const operation = ++request;
      setSyncEpoch(++epochRef.current);
      syncing = true;
      liveReady.current = false;
      setSyncReady(false);
      setSyncError('');
      try {
        if (!readyReceived || socket?.readyState !== WebSocket.OPEN) throw new Error('事件连接不可用');
        // A bounded restart obtains a new server anchor after truncation, overflow or work switch.
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0 || freshAnchor) {
            const head = await history(0);
            if (!valid(generation, operation)) return;
            anchor = head.current;
            buffer = [];
            overflow = false;
            freshAnchor = false;
          }
          const [tasks, candidates, version, approvals] = await Promise.all([
            json<Task[]>('/tasks'), json<Candidate[]>('/candidates'), json<{ version: string }>('/version'), json<unknown[]>('/approvals'),
          ]);
          if (!valid(generation, operation)) return;
          if (!Array.isArray(tasks) || !tasks.every(isTask) || !Array.isArray(candidates) || !candidates.every(isCandidate) || typeof version.version !== 'string' || !Array.isArray(approvals) || !approvals.every(isApproval)) throw new Error('持久状态格式不完整');
          const ids = pendingRunIds(candidates);
          const latest = await Promise.allSettled(ids.map(id => json<unknown>(`/checks/${encodeURIComponent(id)}`)));
          if (!valid(generation, operation)) return;
          const { runs, failed } = collectRunResults(ids, latest);
          const replay = await history(anchor);
          if (!valid(generation, operation)) return;
          const snapshot: M2State = { tasks, candidates, version: version.version, approvals: sortApprovals(approvals), runs, checkIssues: {} };
          const result = reconcileSnapshot(snapshot, replay, buffer, anchor, overflow, failed);
          if (!result) continue;
          // Retry check inconsistencies only when check events crossed this snapshot.
          // Exhaustion keeps that candidate closed, never the entire Studio.
          if (result.retryChecks && attempt < 2) continue;
          const { events, cursor, state: next } = result;
          currentState = next;
          setState(next);
          seq = cursor;
          setLastSeq(seq);
          buffer = [];
          syncing = false;
          initialized = true;
          setStatus('connected');
          liveReady.current = true;
          locks.current.synchronized(epochRef.current);
          setSyncReady(true);
          for (const event of events) notify(event);
          notify({ type: 'state.reload' });
          return;
        }
        throw new Error('事件历史无法连续补齐，请刷新状态');
      } catch (cause) {
        if (!disposed && generation === connection && operation === request) {
          syncing = false;
          initialized = false;
          liveReady.current = false;
          setSyncReady(false);
          setSyncError(cause instanceof Error ? cause.message : '状态同步失败');
        }
        throw cause;
      }
    }
    reloadRef.current = (freshAnchor?: boolean) => synchronize(seq, freshAnchor === true);
    const startSync = (anchor?: number, freshAnchor = false) => { void synchronize(anchor, freshAnchor).catch(() => {}); };
    function connect() {
      if (disposed) return;
      const generation = ++connection;
      readyReceived = false;
      initialized = false;
      buffer = [];
      overflow = false;
      liveReady.current = false;
      setSyncReady(false);
      const active = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events`);
      socket = active;
      active.onmessage = message => {
        if (disposed || generation !== connection) return;
        let event: IncomingEvent;
        try { event = JSON.parse(String(message.data)); } catch { return; }
        if (!event || typeof event.type !== 'string' || !Number.isSafeInteger(event.seq) || event.seq < 0) return;
        if (event.type === 'ready') {
          readyReceived = true;
          const anchor = seq === 0 || event.seq < seq ? event.seq : seq;
          startSync(anchor);
          return;
        }
        if (!readyReceived) return;
        if (syncing || !initialized) {
          if (buffer.length >= 2000) { overflow = true; buffer = []; }
          buffer.push(event);
          return;
        }
        if (event.seq <= seq) return;
        if (event.type === 'work.changed') {
          buffer = [];
          overflow = false;
          seq = event.seq;
          setLastSeq(seq);
          notify(event);
          startSync(event.seq);
          return;
        }
        if (event.type === 'work.updated') {
          seq = event.seq;
          setLastSeq(seq);
          notify(event);
          return;
        }
        if (event.seq !== seq + 1 || event.type === 'version.changed' || event.type === 'check.started' || event.type === 'check.finished') {
          buffer.push(event);
          // Disable gates immediately; the triggering event is retained for replay.
          startSync();
          return;
        }
        const malformed = (event.type === 'task.updated' && !isTask(event.task)) ||
          (['candidate.ready', 'candidate.closed'].includes(event.type) && !isCandidate(event.candidate)) ||
          (['approval.requested', 'approval.resolved'].includes(event.type) && !isApproval(event.approval));
        if (malformed) { buffer.push(event); startSync(); return; }
        const next = reconcileLiveEvent(currentState, event);
        seq = event.seq;
        setLastSeq(seq);
        currentState = next;
        setState(next);
        notify(event);
      };
      active.onerror = () => active.close();
      active.onclose = () => {
        if (disposed || generation !== connection) return;
        ++connection;
        ++request;
        syncing = false;
        readyReceived = false;
        initialized = false;
        liveReady.current = false;
        setSyncReady(false);
        setStatus('reconnecting');
        retry = window.setTimeout(connect, 1000);
      };
    }
    connect();
    return () => {
      disposed = true;
      liveReady.current = false;
      ++request;
      ++connection;
      if (retry !== undefined) clearTimeout(retry);
      socket?.close();
      reloadRef.current = async () => { throw new Error('事件连接已关闭'); };
    };
  }, []);

  return <EventCenterContext.Provider value={{ state, status, syncReady, syncError, syncEpoch, lastSeq, subscribe, reload, acquire, awaiting, locked }}>{children}</EventCenterContext.Provider>;
}
export function useEventCenter() {
  const value = useContext(EventCenterContext);
  if (!value) throw new Error('useEventCenter 必须在 EventCenterProvider 内使用');
  return value;
}
