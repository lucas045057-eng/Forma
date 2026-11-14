import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Candidate, CheckRun, Task } from '@spatial/shared';
import { associatedRun, consistentChecks, isCheckRun } from './check-state.ts';
import { emptyM2State, contiguousReplay, reduceM2Event, type IncomingEvent, type M2State } from './m2-state.ts';
import { isApproval, sortApprovals } from './approval-state.ts';

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
  reload: () => Promise<void>;
}
const EventCenterContext = createContext<EventCenterValue | null>(null);
async function json<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`请求失败：${response.status}`);
  return response.json() as Promise<T>;
}
type History = { events: IncomingEvent[]; current: number; oldest: number; truncated: boolean };

export function EventCenterProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<M2State>(emptyM2State);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [syncReady, setSyncReady] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [lastSeq, setLastSeq] = useState(0);
  const [syncEpoch, setSyncEpoch] = useState(0);
  const listeners = useRef(new Set<(event: CenterEvent) => void>());
  const reloadRef = useRef<() => Promise<void>>(async () => { throw new Error('事件尚未连接'); });
  const reload = useCallback(() => reloadRef.current(), []);
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
    const valid = (generation: number, operation: number) => !disposed && generation === connection && operation === request && socket?.readyState === WebSocket.OPEN;
    const history = (since: number) => json<History>(`/events/history?since=${since}`);

    async function synchronize(anchor = seq) {
      const generation = connection;
      const operation = ++request;
      setSyncEpoch(value => value + 1);
      syncing = true;
      setSyncReady(false);
      setSyncError('');
      try {
        if (!readyReceived || socket?.readyState !== WebSocket.OPEN) throw new Error('事件连接不可用');
        // A bounded restart obtains a new server anchor after truncation or overflow.
        for (let attempt = 0; attempt < 3; attempt++) {
          if (attempt > 0) {
            const head = await history(0);
            if (!valid(generation, operation)) return;
            anchor = head.current;
            buffer = [];
            overflow = false;
          }
          const [tasks, candidates, version, approvals] = await Promise.all([
            json<Task[]>('/tasks'), json<Candidate[]>('/candidates'), json<{ version: string }>('/version'), json<unknown[]>('/approvals'),
          ]);
          if (!valid(generation, operation)) return;
          if (!Array.isArray(tasks) || !Array.isArray(candidates) || typeof version.version !== 'string' || !Array.isArray(approvals) || !approvals.every(isApproval)) throw new Error('持久状态格式不完整');
          const latest = await Promise.all([...new Set(candidates.map(candidate => candidate.latestCheckRunId).filter((id): id is string => !!id))].map(async id => {
            const run = await json<unknown>(`/checks/${encodeURIComponent(id)}`);
            if (!isCheckRun(run) || run.id !== id) throw new Error('检查状态不完整，请刷新状态');
            return run;
          }));
          if (!valid(generation, operation)) return;
          const runs: Record<string, CheckRun> = Object.fromEntries(latest.map(run => [run.id, run]));
          const replay = await history(anchor);
          if (!valid(generation, operation)) return;
          if (overflow || replay.truncated || replay.oldest > anchor + 1 || replay.current < anchor) continue;
          const ordered = contiguousReplay([...replay.events, ...buffer], anchor, replay.current);
          if (!ordered) continue;
          const { events, cursor } = ordered;
          const snapshot: M2State = { tasks, candidates, version: version.version, approvals: sortApprovals(approvals), runs };
          const next = events.reduce(reduceM2Event, snapshot);
          // A run started during the non-atomic snapshot requires fresh latest pointers.
          if (events.some(event => event.type === 'check.started' && isCheckRun(event.run) && !runs[event.run.id])) continue;
          if (next.candidates.some(candidate => candidate.latestCheckRunId && (!associatedRun(candidate, next.runs[candidate.latestCheckRunId]) || !consistentChecks(candidate, next.runs[candidate.latestCheckRunId])))) continue;
          currentState = next;
          setState(next);
          seq = cursor;
          setLastSeq(seq);
          buffer = [];
          syncing = false;
          initialized = true;
          setStatus('connected');
          setSyncReady(true);
          for (const event of events) notify(event);
          notify({ type: 'state.reload' });
          return;
        }
        throw new Error('事件历史变化过快或不完整，请刷新状态');
      } catch (cause) {
        if (!disposed && generation === connection && operation === request) {
          syncing = false;
          initialized = false;
          setSyncReady(false);
          setSyncError(cause instanceof Error ? cause.message : '状态同步失败');
        }
        throw cause;
      }
    }
    reloadRef.current = () => synchronize();
    const startSync = (anchor?: number) => { void synchronize(anchor).catch(() => {}); };
    function connect() {
      if (disposed) return;
      const generation = ++connection;
      readyReceived = false;
      initialized = false;
      buffer = [];
      overflow = false;
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
        if (event.seq !== seq + 1 || event.type === 'version.changed' || event.type === 'check.started' || event.type === 'check.finished') {
          buffer.push(event);
          // Disable gates immediately; the triggering event is retained for replay.
          startSync();
          return;
        }
        const next = reduceM2Event(currentState, event);
        if (event.type === 'check.updated' && (!isCheckRun(event.run) || next.candidates.some(candidate => candidate.latestCheckRunId && !consistentChecks(candidate, next.runs[candidate.latestCheckRunId])))) {
          buffer.push(event);
          startSync();
          return;
        }
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
        setSyncReady(false);
        setStatus('reconnecting');
        retry = window.setTimeout(connect, 1000);
      };
    }
    connect();
    return () => {
      disposed = true;
      ++request;
      ++connection;
      if (retry !== undefined) clearTimeout(retry);
      socket?.close();
      reloadRef.current = async () => { throw new Error('事件连接已关闭'); };
    };
  }, []);

  return <EventCenterContext.Provider value={{ state, status, syncReady, syncError, syncEpoch, lastSeq, subscribe, reload }}>{children}</EventCenterContext.Provider>;
}
export function useEventCenter() {
  const value = useContext(EventCenterContext);
  if (!value) throw new Error('useEventCenter 必须在 EventCenterProvider 内使用');
  return value;
}
