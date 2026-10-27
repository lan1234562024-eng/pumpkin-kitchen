import { describe, expect, it, vi } from 'vitest';
import { connectDemoRoom, type DemoWorker } from '../src/client/demo-connection';
import { createDemoSession } from '../src/client/demo-session';
import { RULESET_ID } from '../src/shared/ruleset';
import type { ServerMessage } from '../src/shared/protocol';

const firstSnapshot = () => {
  let message: ServerMessage | undefined;
  const session = createDemoSession({ now:() => 1000, emit:m => { message = m; } });
  session.close(); return message!;
};
describe('browser worker connection lifecycle', () => {
  it('requires a matching snapshot, drops old worker callbacks, and terminates on dispose', () => {
    const worker: DemoWorker = { onmessage:null, onerror:null, postMessage:vi.fn(), terminate:vi.fn() };
    const onSnapshot = vi.fn(), onResult = vi.fn(), onStatus = vi.fn();
    const connection = connectDemoRoom('', onSnapshot, onResult, { workerFactory:() => worker, onStatus });
    expect(connection.send({ type:'start_round', ruleset_id:RULESET_ID })).toBe(false);
    worker.onmessage!({ data:firstSnapshot() } as MessageEvent);
    expect(onStatus).toHaveBeenLastCalledWith('connected');
    expect(connection.send({ type:'start_round', ruleset_id:RULESET_ID })).toBe(true);
    const old = worker.onmessage!;
    connection.dispose(); connection.dispose();
    old({ data:firstSnapshot() } as MessageEvent);
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(connection.send({ type:'start_round', ruleset_id:RULESET_ID })).toBe(false);
  });
  it('rejects incompatible snapshots and reports worker creation failures without a blank page', () => {
    const worker: DemoWorker = { onmessage:null, onerror:null, postMessage:vi.fn(), terminate:vi.fn() };
    const result = vi.fn();
    const connection = connectDemoRoom('', vi.fn(), result, { workerFactory:() => worker });
    const snapshot = firstSnapshot() as Extract<ServerMessage, {type:'snapshot'}>;
    worker.onmessage!({ data:{ ...snapshot, snapshot:{ ...snapshot.snapshot, ruleset_id:'wrong' } } } as MessageEvent);
    expect(result).toHaveBeenLastCalledWith(expect.objectContaining({ code:'RULESET_MISMATCH' }));
    expect(connection.send({ type:'start_round', ruleset_id:RULESET_ID })).toBe(false);
    connection.dispose();
    const failure = connectDemoRoom('', vi.fn(), result, { workerFactory:() => { throw new Error('workers blocked'); } });
    expect(result).toHaveBeenLastCalledWith(expect.objectContaining({ code:'DEMO_UNAVAILABLE' }));
    expect(failure.send({ type:'start_round', ruleset_id:RULESET_ID })).toBe(false);
    failure.dispose();
  });
});
