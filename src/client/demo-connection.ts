import { isServerMessage, type Connection, type ConnectionOptions } from './connection';
import type { ServerMessage } from '../shared/protocol';
import { RULESET_ID } from '../shared/ruleset';

export interface DemoWorker {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

export function connectDemoRoom(
  _url: string,
  onSnapshot: (message: Extract<ServerMessage, {type:'snapshot'}>) => void,
  onResult: (message: Exclude<ServerMessage, {type:'snapshot'}>) => void,
  options: ConnectionOptions & { workerFactory?: () => DemoWorker } = {},
): Connection {
  let disposed = false, compatible = false;
  const status = options.onStatus ?? (() => undefined);
  status('connecting');
  let worker: DemoWorker;
  try {
    worker = (options.workerFactory ?? (() => new Worker(new URL('./demo.worker.ts', import.meta.url), { type:'module' }) as unknown as DemoWorker))();
  } catch {
    status('disconnected');
    onResult({ type:'error', code:'DEMO_UNAVAILABLE', message:'浏览器无法启动网页试玩，请刷新页面，或使用完整本地版。' });
    return { send:() => false, dispose:() => undefined };
  }
  worker.onmessage = event => {
    if (disposed) return;
    const value: unknown = event.data;
    if (!isServerMessage(value)) return;
    if (value.type === 'snapshot') {
      if (value.snapshot.ruleset_id !== RULESET_ID) {
        compatible = false; status('disconnected');
        onResult({ type:'error', code:'RULESET_MISMATCH', message:'厨房版本不匹配，请刷新网页。' }); return;
      }
      if (!compatible) { compatible = true; status('connected'); }
      const start = performance.now(); onSnapshot(value);
      options.diagnostics?.snapshot(performance.now() - start);
    } else {
      if (value.type === 'human_input_result') options.diagnostics?.inputAck(value.sequence);
      onResult(value);
    }
  };
  worker.onerror = () => {
    if (disposed) return;
    compatible = false; status('disconnected');
    onResult({ type:'error', code:'DEMO_UNAVAILABLE', message:'网页试玩加载失败，请刷新页面，或使用完整本地版。' });
  };
  const release = () => { if (!disposed) worker.postMessage({ type:'release_input' }); };
  const visibility = () => { if (document.hidden) release(); };
  if (typeof window !== 'undefined') window.addEventListener('blur', release);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', visibility);
  return {
    send(message) {
      if (disposed || !compatible) return false;
      try {
        worker.postMessage(message);
        if (message.type === 'human_input') options.diagnostics?.inputSent(message.sequence);
        return true;
      } catch { return false; }
    },
    dispose() {
      if (disposed) return;
      disposed = true; compatible = false;
      if (typeof window !== 'undefined') window.removeEventListener('blur', release);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', visibility);
      worker.onmessage = null; worker.onerror = null;
      worker.postMessage({ type:'dispose' }); worker.terminate(); status('disconnected');
    },
  };
}
