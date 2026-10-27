import type { ClientMessage, ServerMessage } from '../shared/protocol';
import {RULESET_ID} from '../shared/ruleset';
import type { ClientPerformanceReport } from '../shared/performance';

export interface RoomSocket {
  readonly readyState: number;
  onopen: ((event: Event) => unknown) | null;
  onmessage: ((event: MessageEvent) => unknown) | null;
  onclose: ((event: CloseEvent) => unknown) | null;
  onerror: ((event: Event) => unknown) | null;
  send(data: string): void;
  close(): void;
}

export interface Connection {
  send(message: ClientMessage | ClientPerformanceReport): boolean;
  dispose(): void;
}

export interface ConnectionOptions {
  diagnostics?: { snapshot(handlerMs: number): void; inputSent(sequence: number): void; inputAck(sequence: number): void };
  onStatus?: (status: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => void;
  /** Internal seams keep lifecycle tests independent from browser networking and time. */
  socketFactory?: (url: string) => RoomSocket;
  timers?: {
    setTimeout(callback: () => void, delay: number): unknown;
    clearTimeout(timer: unknown): void;
  };
}

const OPEN = 1;
const INITIAL_RETRY_MS = 250;
const MAX_RETRY_MS = 5_000;
const INPUT_ERRORS = new Set([
  'INVALID_COMMAND','INVALID_TIME','OUT_OF_BOUNDS','FUTURE_COMMAND','EXPIRED','STALE_STATE','STALE_GENERATION',
  'NOT_PLAYING','SEAT_BUSY','OUT_OF_RANGE','INVALID_INTERACTION','ACTION_ID_CONFLICT','RECEIPT_CAPACITY',
  'ROUND_CHANGED','STALE_INPUT','INPUT_OWNED','FORBIDDEN','TARGET_BLOCKED','NO_PATH',
]);

export function isServerMessage(value: unknown): value is ServerMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.type === 'snapshot') {
    return !!message.snapshot && typeof message.snapshot === 'object' &&
      Array.isArray(message.events) && Number.isSafeInteger(message.events_cursor);
  }
  if (message.type === 'result') {
    return !!message.receipt && typeof message.receipt === 'object';
  }
  if (message.type === 'human_input_result') {
    return Object.keys(message).every(key => ['type','seat_id','sequence','status','error'].includes(key)) &&
      (message.seat_id === 'human' || message.seat_id === 'ai') &&
      Number.isSafeInteger(message.sequence) && (message.sequence as number) >= 0 &&
      (message.status === 'accepted' || message.status === 'rejected') &&
      (message.error === undefined || typeof message.error === 'string' && INPUT_ERRORS.has(message.error));
  }
  return message.type === 'error' && typeof message.code === 'string' && typeof message.message === 'string';
}

export function connectRoom(
  url: string,
  onSnapshot: (message: Extract<ServerMessage, {type:'snapshot'}>) => void,
  onResult: (message: Exclude<ServerMessage, {type:'snapshot'}>) => void,
  options: ConnectionOptions = {},
): Connection {
  const factory = options.socketFactory ?? (value => new WebSocket(value) as unknown as RoomSocket);
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, delay: number) => globalThis.setTimeout(callback,delay),
    clearTimeout: (timer: unknown) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
  };
  let disposed = false;
  let compatible=false;
  let current: RoomSocket | undefined;
  let reconnectTimer: unknown;
  let retryDelay = INITIAL_RETRY_MS;
  let generation = 0;
  const status = options.onStatus ?? (() => undefined);

  const clearReconnect = () => {
    if (reconnectTimer !== undefined) {
      timers.clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const openSocket = (reconnecting: boolean) => {
    if (disposed) return;
    const socketGeneration = ++generation;
    status(reconnecting ? 'reconnecting' : 'connecting');
    let socket: RoomSocket;
    try {
      socket = factory(url);
    } catch {
      scheduleReconnect(socketGeneration);
      return;
    }
    current = socket;
    socket.onopen = () => {
      if (disposed || generation !== socketGeneration || current !== socket) return;
      retryDelay = INITIAL_RETRY_MS;
      status('connected');
    };
    socket.onmessage = event => {
      if (disposed || generation !== socketGeneration || current !== socket) return;
      const startedAt = options.diagnostics ? performance.now() : 0;
      let value: unknown;
      try { value = JSON.parse(String(event.data)); } catch { return; }
      if(value&&typeof value==='object'&&'type' in value&&value.type==='snapshot'){
        const s=(value as {snapshot?:{ruleset_id?:unknown}}).snapshot;
        if(s?.ruleset_id!==RULESET_ID){compatible=false;onResult({type:'error',code:'RULESET_MISMATCH',message:'厨房版本不匹配，请更新客户端和服务端。'});return;}
      }
      if (!isServerMessage(value)) return;
      if (value.type === 'snapshot') {
        compatible=true;onSnapshot(value);
        options.diagnostics?.snapshot(performance.now()-startedAt);
      } else {
        if (value.type === 'human_input_result') options.diagnostics?.inputAck(value.sequence);
        onResult(value);
      }
    };
    socket.onclose = () => {
      if (disposed || generation !== socketGeneration || current !== socket) return;
      current = undefined;
      compatible=false;
      scheduleReconnect(socketGeneration);
    };
    socket.onerror = () => {
      // Browsers report the authoritative lifecycle transition through close.
    };
  };

  function scheduleReconnect(closedGeneration: number) {
    if (disposed || generation !== closedGeneration || reconnectTimer !== undefined) return;
    status('disconnected');
    const delay = retryDelay;
    retryDelay = Math.min(MAX_RETRY_MS,retryDelay * 2);
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = undefined;
      if (!disposed && generation === closedGeneration) openSocket(true);
    },delay);
  }

  openSocket(false);
  return {
    send(message) {
      if (disposed || !compatible || !current || current.readyState !== OPEN) return false;
      try {
        current.send(JSON.stringify(message));
        if (message.type === 'human_input') options.diagnostics?.inputSent(message.sequence);
        return true;
      } catch { return false; }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      clearReconnect();
      status('disconnected');
      const socket = current;
      current = undefined;
      if (socket) {
        socket.onopen = null;socket.onmessage = null;socket.onclose = null;socket.onerror = null;
        try { socket.close(); } catch { /* Already closed. */ }
      }
    },
  };
}

