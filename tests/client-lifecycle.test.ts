import {createGame,observe} from '../src/game/engine';
import {RULESET_ID} from '../src/shared/ruleset';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectRoom, type RoomSocket } from '../src/client/connection';
import type { ServerMessage } from '../src/shared/protocol';

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closeCount = 0;
  send(value: string) { this.sent.push(value); }
  close() { this.closeCount++; this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  message(message: ServerMessage) { this.onmessage?.({data:JSON.stringify(message)}); }
  remoteClose() { this.readyState = 3; this.onclose?.(); }
}

const snapshot=(version:number):ServerMessage=>{const state=createGame(1000);state.state_version=version;const human=observe(state,'human');return {type:'snapshot',snapshot:human.snapshot,events:[],events_cursor:version,controller_status:{connected:false,waiting:false},interaction_previews:{human:human.interaction_previews,ai:observe(state,'ai').interaction_previews}};};

function setup() {
  const sockets: FakeSocket[] = [];
  const socketFactory = vi.fn((_url: string) => {
    const socket = new FakeSocket();sockets.push(socket);return socket as unknown as RoomSocket;
  });
  const timeouts: Array<{callback: () => void; delay: number; cancelled: boolean}> = [];
  const timers = {
    setTimeout(callback: () => void, delay: number) {
      const timer = {callback,delay,cancelled:false};timeouts.push(timer);return timer;
    },
    clearTimeout(timer: unknown) { if (timer) (timer as {cancelled:boolean}).cancelled = true; },
    runNext() {
      const timer = timeouts.find(value => !value.cancelled);
      if (timer) {timer.cancelled = true;timer.callback();}
    },
  };
  return {sockets,socketFactory,timers};
}

afterEach(() => vi.useRealTimers());

describe('client room connection lifecycle', () => {
  it('disables all sends for an old ruleset snapshot and reports the mismatch',()=>{const {sockets,socketFactory,timers}=setup();const onSnapshot=vi.fn(),onResult=vi.fn();const connection=connectRoom('ws://room/game-ws',onSnapshot,onResult,{socketFactory,timers});const socket=sockets[0];socket.open();const valid=snapshot(1);socket.onmessage?.({data:JSON.stringify({...valid,snapshot:{ruleset_id:'old'}})});expect(onSnapshot).not.toHaveBeenCalled();expect(onResult).toHaveBeenCalledWith(expect.objectContaining({code:'RULESET_MISMATCH'}));expect(connection.send({type:'start_round',ruleset_id:RULESET_ID})).toBe(false);socket.message(valid);expect(connection.send({type:'start_round',ruleset_id:RULESET_ID})).toBe(true);connection.dispose();});
  it('delivers validated keyboard acknowledgements after the preceding release snapshot', () => {
    const {sockets,socketFactory,timers} = setup();const received: string[] = [];
    connectRoom('ws://room/game-ws',message => received.push(`snapshot:${message.snapshot.state_version}`),
      message => received.push(message.type),{socketFactory,timers});
    const socket = sockets[0];socket.open();socket.message(snapshot(8));
    socket.message({type:'human_input_result',seat_id:'human',sequence:3,status:'accepted'});
    socket.message({type:'human_input_result',seat_id:'ai',sequence:4,status:'rejected',error:'INPUT_OWNED'});
    for (const invalid of [
      {seat_id:'other',sequence:3,status:'accepted'}, {seat_id:'human',sequence:-1,status:'accepted'},
      {seat_id:'human',sequence:1.5,status:'accepted'}, {seat_id:'human',sequence:3,status:'unknown'},
      {seat_id:'human',sequence:3,status:'rejected',error:'unknown'},
      {seat_id:'human',sequence:3,status:'accepted',extra:true},
    ]) socket.onmessage?.({data:JSON.stringify({type:'human_input_result',...invalid})});
    expect(received).toEqual(['snapshot:8','human_input_result','human_input_result']);
  });

  it('ignores keyboard acknowledgements from a disconnected socket after reconnect', () => {
    const {sockets,socketFactory,timers} = setup();const received: ServerMessage[] = [];
    connectRoom('ws://room/game-ws',() => undefined,message => received.push(message),{socketFactory,timers});
    const old = sockets[0];old.open();old.remoteClose();timers.runNext();sockets[1].open();
    const result = {type:'human_input_result',seat_id:'human',sequence:7,status:'accepted'} as const;
    old.message(result);sockets[1].message(result);expect(received).toEqual([result]);
  });

  it('stops listening and reconnecting after dispose', () => {
    const {sockets,socketFactory,timers} = setup();
    const onSnapshot = vi.fn();
    const connection = connectRoom('ws://room/game-ws',onSnapshot,vi.fn(),{socketFactory,timers});
    const first = sockets[0];first.open();first.remoteClose();
    connection.dispose();
    first.message(snapshot(1));timers.runNext();
    expect(onSnapshot).not.toHaveBeenCalled();
    expect(socketFactory).toHaveBeenCalledTimes(1);
    expect(first.closeCount).toBe(0);
    expect(connection.send({type:'start_round',ruleset_id:RULESET_ID})).toBe(false);
  });

  it('ignores messages from an older socket after reconnect', () => {
    const {sockets,timers} = setup();
    const onSnapshot = vi.fn();
    connectRoom('ws://room/game-ws',onSnapshot,vi.fn(),{socketFactory:setupSocketFactory(sockets),timers});
    const oldSocket = sockets[0];oldSocket.open();oldSocket.remoteClose();timers.runNext();
    const currentSocket = sockets[1];currentSocket.open();
    oldSocket.message(snapshot(90));
    currentSocket.message(snapshot(2));
    expect(onSnapshot).toHaveBeenCalledTimes(1);
    expect(onSnapshot.mock.calls[0][0].snapshot.state_version).toBe(2);
  });

  it('reconnects to observe state without replaying commands', () => {
    const {sockets,socketFactory,timers} = setup();
    const connection = connectRoom('ws://room/game-ws',vi.fn(),vi.fn(),{socketFactory,timers});
    const first = sockets[0];first.open();first.message(snapshot(1));
    expect(connection.send({type:'start_round',ruleset_id:RULESET_ID})).toBe(true);
    expect(first.sent.map(x=>JSON.parse(x))).toEqual([{type:'start_round',ruleset_id:RULESET_ID}]);
    first.remoteClose();timers.runNext();
    const reconnected = sockets[1];reconnected.open();
    expect(reconnected.sent).toEqual([]);
  });

});

function setupSocketFactory(sockets: FakeSocket[]) {
  return (_url: string) => {
    const socket = new FakeSocket();sockets.push(socket);return socket as unknown as RoomSocket;
  };
}
