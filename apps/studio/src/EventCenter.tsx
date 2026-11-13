import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Candidate, Task } from '@spatial/shared';
import { emptyM2State, historyTruncated, newEventsInOrder, reduceM2Event, type IncomingEvent, type M2State } from './m2-state.ts';

export type CenterEvent = { type: string; seq?: number; ts?: string } & Record<string, unknown>;
type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';
interface EventCenterValue {
  state: M2State;
  status: ConnectionStatus;
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

export function EventCenterProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<M2State>(emptyM2State);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [lastSeq, setLastSeq] = useState(0);
  const seqRef = useRef(0);
  const listeners = useRef(new Set<(event: CenterEvent) => void>());
  const mounted = useRef(true);

  const notify = useCallback((event: CenterEvent) => {
    for (const listener of listeners.current) listener(event);
  }, []);
  const reload = useCallback(async () => {
    const [tasks, candidates, version] = await Promise.all([json<Task[]>('/tasks'), json<Candidate[]>('/candidates'), json<{ version: string }>('/version')]);
    if (!mounted.current) return;
    setState({ tasks, candidates, version: version.version });
    notify({ type: 'state.reload' });
  }, [notify]);
  const subscribe = useCallback((listener: (event: CenterEvent) => void) => {
    listeners.current.add(listener);
    return () => { listeners.current.delete(listener); };
  }, []);

  useEffect(() => {
    mounted.current = true;
    let socket: WebSocket | undefined;
    let retry: number | undefined;
    let initialized = false;
    let queue: Promise<void> = Promise.resolve();

    const accept = (event: IncomingEvent) => {
      if (!mounted.current) return;
      seqRef.current = Math.max(seqRef.current, event.seq);
      setLastSeq(seqRef.current);
      setState(previous => reduceM2Event(previous, event));
      notify(event);
    };
    const catchUp = async () => {
      const since = seqRef.current;
      const history = await json<{ events: IncomingEvent[]; current: number; oldest: number; truncated: boolean }>(`/events/history?since=${since}`);
      if (history.truncated || historyTruncated(history.oldest, since)) await reload();
      else for (const event of newEventsInOrder(history.events, since)) accept(event);
      if (mounted.current) {
        seqRef.current = Math.max(seqRef.current, history.current);
        setLastSeq(seqRef.current);
      }
    };
    const handle = async (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const event = value as CenterEvent;
      if (event.type === 'ready') {
        if (seqRef.current === 0) {
          await reload();
          if (typeof event.seq === 'number' && Number.isSafeInteger(event.seq)) {
            seqRef.current = Math.max(seqRef.current, event.seq);
            setLastSeq(seqRef.current);
          }
        } else await catchUp();
        initialized = true;
        if (mounted.current) setStatus('connected');
        return;
      }
      if (typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq)) return;
      if (!initialized || event.seq <= seqRef.current) return;
      if (event.seq > seqRef.current + 1) await catchUp();
      else accept(event as IncomingEvent);
    };
    const connect = () => {
      if (!mounted.current) return;
      setStatus(seqRef.current ? 'reconnecting' : 'connecting');
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/events`);
      socket.onmessage = message => {
        let parsed: unknown;
        try { parsed = JSON.parse(String(message.data)); } catch { return; }
        queue = queue.then(() => handle(parsed)).catch(() => { socket?.close(); });
      };
      socket.onerror = () => socket?.close();
      socket.onclose = () => {
        if (!mounted.current) return;
        setStatus('reconnecting');
        retry = window.setTimeout(connect, 1000);
      };
    };
    connect();
    return () => {
      mounted.current = false;
      if (retry !== undefined) clearTimeout(retry);
      socket?.close();
      listeners.current.clear();
    };
  }, [notify, reload]);

  return <EventCenterContext.Provider value={{ state, status, lastSeq, subscribe, reload }}>
    {children}
  </EventCenterContext.Provider>;
}

export function useEventCenter() {
  const value = useContext(EventCenterContext);
  if (!value) throw new Error('useEventCenter 必须在 EventCenterProvider 内使用');
  return value;
}
