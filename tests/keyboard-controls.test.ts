import { describe, expect, it } from 'vitest';
import { createKeyboardControls, type KeyboardControlContext } from '../src/client/keyboard-controls';
import { createMovementGate } from '../src/client/movement-gate';
import { createRoom } from '../src/server/room';
import type { GameCommand } from '../src/shared/contracts';
import type { HumanInputMessage, HumanInputResult } from '../src/shared/protocol';

class InputTarget {
  visibilityState = 'visible';
  private listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const listeners = this.listeners.get(type) ?? new Set();listeners.add(listener);this.listeners.set(type,listeners);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject) { this.listeners.get(type)?.delete(listener); }
  emit(type: string, fields: Record<string, unknown> = {}) {
    let prevented = false;
    const event = {type,code:'',repeat:false,isComposing:false,altKey:false,ctrlKey:false,metaKey:false,shiftKey:false,target:null,
      preventDefault() { prevented = true; },...fields} as unknown as Event;
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event);else listener.handleEvent(event);
    }
    return prevented;
  }
  get listenerCount() { return [...this.listeners.values()].reduce((count,listeners) => count+listeners.size,0); }
}

function setup(onInteract?: () => void,beforeMove?: (resume:()=>void)=>void) {
  const windowTarget = new InputTarget();const documentTarget = new InputTarget();
  let context: KeyboardControlContext = {connected:true,enabled:true,seat_id:'human',seat_generation:2,round_id:3};
  const sent: HumanInputMessage[] = [];const rejections: string[] = [];const actions: string[] = [];
  const intervals = new Set<() => void>();
  const controller = createKeyboardControls({
    beforeMove,
    windowTarget:windowTarget as unknown as Window,documentTarget:documentTarget as unknown as Document,
    getContext:() => context,send:message => {sent.push(message);return context.connected;},
    onInteract:() => { actions.push('interact');onInteract?.(); },onRejected:message => rejections.push(message.error ?? ''),
    timers:{setInterval(callback,delay) { expect(delay).toBe(100);intervals.add(callback);return callback; },
      clearInterval(timer) { intervals.delete(timer as () => void); }},
  });
  const ack = (message = sent.at(-1)!, status: HumanInputResult['status'] = 'accepted') => controller.handleResult({
    type:'human_input_result',seat_id:message.seat_id,sequence:message.sequence,status,
    ...(status === 'rejected' ? {error:'INPUT_OWNED' as const} : {}),
  });
  return {controller,windowTarget,documentTarget,sent,intervals,actions,rejections,ack,
    context:() => context,changeContext:(change: Partial<KeyboardControlContext>) => {context = {...context,...change};controller.updateContext();},
    tick:() => { for (const callback of [...intervals]) callback(); }};
}

describe('kitchen keyboard controls', () => {
  it('restarts a held direction before the release snapshot arrives instead of waiting on a stale cancel', () => {
    let now = 0;
    const room = createRoom(() => now); room.startRound(); room.setDemoEnabled(false);
    let snapshot = room.getSnapshot();
    const cancels: GameCommand[] = [], errors: string[] = [];
    const gate = createMovementGate({ getContext: () => ({ snapshot, connected: true, seat_id: 'human' }),
      sendCancel: seat => {
        const action_id = `cancel-${cancels.length}`;
        cancels.push({ action_id, seat_id: seat, seat_generation: snapshot.seats[seat].generation,
          state_version: snapshot.state_version, issued_at_ms: snapshot.server_time_ms, ttl_ms: 1000, action: { type: 'cancel' } });
        return action_id;
      } });
    const s = setup(undefined, resume => gate.request('human', resume, 'keyboard'));
    s.changeContext({ round_id: snapshot.round_id, seat_generation: snapshot.seats.human.generation });
    try {
      s.windowTarget.emit('keydown', { code: 'KeyD' });
      expect(room.setHumanInput('browser', s.sent[0])).toMatchObject({ status: 'accepted' });
      snapshot = room.getSnapshot(); s.ack(s.sent[0]);
      s.windowTarget.emit('keyup', { code: 'KeyD' });
      expect(room.setHumanInput('browser', s.sent[1])).toMatchObject({ status: 'accepted' });
      expect(room.getSnapshot().state_version).toBeGreaterThan(snapshot.state_version);
      // The socket has not delivered the release snapshot when the next key goes down.
      s.windowTarget.emit('keydown', { code: 'KeyW' });
      for (const command of cancels) {
        const result = room.submit(command);
        if (!('receipt' in result)) throw Error('missing command receipt');
        errors.push(result.receipt.error ?? 'accepted'); gate.receipt(result.receipt);
      }
      snapshot = room.getSnapshot(); gate.update(); s.tick();
      expect(s.sent.slice(2).map(message => message.direction), `cancel receipts: ${errors.join(',')}`)
        .toEqual([{ x: 0, y: -1 }, { x: 0, y: -1 }]);
      for (const message of s.sent.slice(2)) expect(room.setHumanInput('browser', message)).toMatchObject({ status: 'accepted' });
      now = 100; room.tick();
      expect(room.getSnapshot().seats.human.position.y).toBe(304);
      expect(s.intervals.size).toBe(1);
    } finally { s.controller.dispose(); room.close(); }
  });

  it('supersedes a pending click cancel before its delayed receipt and snapshot can resume the click', () => {
    const room = createRoom(() => 0); room.startRound(); room.setDemoEnabled(false);
    let snapshot = room.getSnapshot();
    room.submit({ action_id: 'original-click', seat_id: 'human', seat_generation: snapshot.seats.human.generation,
      state_version: snapshot.state_version, issued_at_ms: 0, ttl_ms: 1000, action: { type: 'move_to', target: { x: 320, y: 320 } } });
    snapshot = room.getSnapshot();
    let cancel: GameCommand | undefined, clicks = 0;
    const gate = createMovementGate({ getContext: () => ({ snapshot, connected: true, seat_id: 'human' }),
      sendCancel: seat => {
        cancel = { action_id: 'click-cancel', seat_id: seat, seat_generation: snapshot.seats[seat].generation,
          state_version: snapshot.state_version, issued_at_ms: 0, ttl_ms: 1000, action: { type: 'cancel' } };
        return cancel.action_id;
      } });
    const s = setup(undefined, resume => gate.request('human', resume, 'keyboard'));
    s.changeContext({ round_id: snapshot.round_id, seat_generation: snapshot.seats.human.generation });
    try {
      gate.request('human', () => { clicks++; });
      const result = room.submit(cancel!);
      if (!('receipt' in result)) throw Error('missing command receipt');
      expect(result.receipt.status).toBe('accepted');
      const delayedIdle = room.getSnapshot();
      s.windowTarget.emit('keydown', { code: 'KeyW' });
      expect(s.sent.map(message => message.direction)).toEqual([{ x: 0, y: -1 }]);
      expect(room.setHumanInput('browser', s.sent[0])).toMatchObject({ status: 'accepted' });
      snapshot = delayedIdle; gate.receipt(result.receipt); gate.update();
      expect(clicks).toBe(0); expect(s.sent).toHaveLength(1);
      s.tick(); expect(s.sent.at(-1)?.direction).toEqual({ x: 0, y: -1 });
      expect(room.getSnapshot().seats.human.active_action?.type).toBe('move_to');
    } finally { s.controller.dispose(); room.close(); }
  });

  it('waits for movement permission and invalidates late resumes on keyup or blur',()=>{for(const stop of ['keyup','blur','disconnect']){let resume=()=>{};const s=setup(undefined,callback=>{resume=callback;});s.windowTarget.emit('keydown',{code:'KeyD'});expect(s.sent).toEqual([]);if(stop==='keyup')s.windowTarget.emit('keyup',{code:'KeyD'});if(stop==='blur')s.windowTarget.emit('blur');if(stop==='disconnect')s.changeContext({connected:false});const count=s.sent.length;resume();s.tick();expect(s.sent).toHaveLength(count);expect(s.intervals.size).toBe(0);s.controller.dispose();}});
  it('merges physical aliases, opposing keys and diagonal components without duplicate moves', () => {
    const s = setup();
    expect(s.windowTarget.emit('keydown',{code:'KeyD',key:'ф'})).toBe(true);
    s.windowTarget.emit('keydown',{code:'ArrowRight'});
    expect(s.sent.map(message => message.direction)).toEqual([{x:1,y:0}]);
    s.windowTarget.emit('keydown',{code:'KeyW'});
    s.windowTarget.emit('keydown',{code:'KeyA'});
    s.windowTarget.emit('keyup',{code:'KeyD'});
    expect(s.sent.map(message => message.direction)).toEqual([{x:1,y:0},{x:1,y:-1},{x:0,y:-1}]);
    s.windowTarget.emit('keyup',{code:'ArrowRight'});
    expect(s.sent.at(-1)?.direction).toEqual({x:-1,y:-1});
    s.windowTarget.emit('keyup',{code:'KeyA'});s.windowTarget.emit('keyup',{code:'KeyW'});
    expect(s.sent.at(-1)?.direction).toEqual({x:0,y:0});
    expect(s.intervals.size).toBe(0);
    s.controller.dispose();
  });

  it('heartbeats the current intent with increasing sequences and stops on final keyup', () => {
    const s = setup();s.windowTarget.emit('keydown',{code:'ArrowDown'});s.tick();s.tick();
    expect(s.sent.map(message => message.sequence)).toEqual([1,2,3]);
    expect(s.sent.every(message => message.direction.y === 1 && message.round_id === 3 && message.seat_generation === 2)).toBe(true);
    s.windowTarget.emit('keyup',{code:'ArrowDown',ctrlKey:true,target:{tagName:'INPUT'}});s.tick();
    expect(s.sent.map(message => message.direction.y)).toEqual([1,1,1,0]);
    expect(s.intervals.size).toBe(0);s.controller.dispose();
  });

  it('suppresses repeats, composition, modifiers and editable targets for movement and E', () => {
    const s = setup();
    for (const code of ['KeyW','KeyE']) for (const extra of [
      {repeat:true},{isComposing:true},{altKey:true},{ctrlKey:true},{metaKey:true},{shiftKey:true},
      {target:{tagName:'INPUT'}},{target:{tagName:'TEXTAREA'}},{target:{tagName:'SELECT'}},{target:{isContentEditable:true}},
    ]) expect(s.windowTarget.emit('keydown',{code,...extra})).toBe(false);
    expect(s.sent).toEqual([]);expect(s.actions).toEqual([]);
    s.windowTarget.emit('keydown',{code:'KeyE'});expect(s.actions).toEqual(['interact']);s.controller.dispose();
  });

  it('waits for the matching release ack before E reads the newly delivered snapshot', () => {
    let snapshotVersion = 4;const observed: number[] = [];
    const s = setup(() => observed.push(snapshotVersion));
    s.windowTarget.emit('keydown',{code:'KeyD'});s.ack();
    s.windowTarget.emit('keydown',{code:'KeyE'});const release = s.sent.at(-1)!;
    expect(release.direction).toEqual({x:0,y:0});expect(observed).toEqual([]);
    snapshotVersion = 5;s.ack(release);
    expect(observed).toEqual([5]);expect(s.actions).toEqual(['interact']);expect(s.intervals.size).toBe(0);
    s.windowTarget.emit('keyup',{code:'KeyD'});expect(s.sent.at(-1)).toBe(release);
    s.windowTarget.emit('keydown',{code:'KeyW'});s.windowTarget.emit('keydown',{code:'KeyE'});
    expect(s.actions).toEqual(['interact']);s.ack();expect(s.actions).toEqual(['interact','interact']);s.controller.dispose();
  });

  it('keeps only the latest manual intent and ignores old acknowledgements', () => {
    const s = setup();s.windowTarget.emit('keydown',{code:'KeyD'});const movement = s.sent[0];
    s.controller.releaseThen(() => s.actions.push('old'));const firstRelease = s.sent.at(-1)!;
    s.controller.releaseThen(() => s.actions.push('latest'));s.ack(movement);
    expect(s.actions).toEqual([]);s.ack(firstRelease);expect(s.actions).toEqual(['latest']);
    s.windowTarget.emit('keydown',{code:'KeyA'});s.controller.releaseThen(() => s.actions.push('new'));
    s.ack(firstRelease);s.ack(firstRelease,'rejected');expect(s.actions).toEqual(['latest']);expect(s.rejections).toEqual([]);
    s.ack();expect(s.actions).toEqual(['latest','new']);s.controller.dispose();
  });

  it('abandons a waiting manual action when a fresh movement gesture takes over', () => {
    const s = setup();s.windowTarget.emit('keydown',{code:'KeyD'});
    s.controller.releaseThen(() => s.actions.push('superseded'));const oldRelease = s.sent.at(-1)!;
    s.windowTarget.emit('keydown',{code:'KeyW'});s.ack(oldRelease);
    expect(s.actions).toEqual([]);expect(s.intervals.size).toBe(1);
    s.controller.releaseThen(() => s.actions.push('current'));s.ack(oldRelease);expect(s.actions).toEqual([]);
    s.ack();expect(s.actions).toEqual(['current']);s.controller.dispose();
  });

  it('abandons a deferred action on rejection or disconnect and requires a fresh reconnect gesture', () => {
    const s = setup();s.windowTarget.emit('keydown',{code:'KeyD'});s.controller.releaseThen(() => s.actions.push('rejected'));
    s.ack(undefined,'rejected');expect(s.rejections).toEqual(['INPUT_OWNED']);expect(s.actions).toEqual([]);
    s.windowTarget.emit('keydown',{code:'KeyW'});s.controller.releaseThen(() => s.actions.push('disconnected'));const release = s.sent.at(-1)!;
    s.changeContext({connected:false});s.changeContext({connected:true});s.ack(release);s.tick();
    s.windowTarget.emit('keydown',{code:'KeyW',repeat:true});expect(s.actions).toEqual([]);expect(s.intervals.size).toBe(0);
    const count = s.sent.length;s.windowTarget.emit('keydown',{code:'KeyW'});expect(s.sent).toHaveLength(count+1);s.controller.dispose();
  });

  it('clears held keys and deferred actions when seat, round, generation or control changes', () => {
    const changes: Partial<KeyboardControlContext>[] = [{seat_id:'ai'},{round_id:4},{seat_generation:3},{enabled:false}];
    for (const change of changes) {
      const s = setup();s.windowTarget.emit('keydown',{code:'KeyD'});s.controller.releaseThen(() => s.actions.push('stale'));const release = s.sent.at(-1)!;
      s.changeContext(change);s.ack(release);s.tick();s.windowTarget.emit('keydown',{code:'KeyD',repeat:true});
      expect(s.actions).toEqual([]);expect(s.intervals.size).toBe(0);
      s.changeContext({enabled:true});const count = s.sent.length;s.windowTarget.emit('keydown',{code:'KeyW'});
      const {seat_id,seat_generation,round_id} = s.context();
      expect(s.sent).toHaveLength(count+1);expect(s.sent.at(-1)).toMatchObject({seat_id,seat_generation,round_id,direction:{x:0,y:-1}});
      s.controller.dispose();
    }
  });

  it('best-effort releases on blur, hidden document, pointer action and dispose without retained listeners', () => {
    const s = setup();
    for (const stop of [
      () => s.windowTarget.emit('blur'),
      () => {s.documentTarget.visibilityState = 'hidden';s.documentTarget.emit('visibilitychange');s.documentTarget.visibilityState = 'visible';},
      () => s.windowTarget.emit('pointerdown'),
    ]) {
      s.windowTarget.emit('keydown',{code:'KeyD'});stop();expect(s.sent.at(-1)?.direction).toEqual({x:0,y:0});expect(s.intervals.size).toBe(0);s.ack();
    }
    s.windowTarget.emit('keydown',{code:'KeyD'});s.controller.dispose();
    expect(s.sent.at(-1)?.direction).toEqual({x:0,y:0});expect(s.windowTarget.listenerCount+s.documentTarget.listenerCount).toBe(0);
    const count = s.sent.length;s.tick();s.windowTarget.emit('keydown',{code:'KeyW'});expect(s.sent).toHaveLength(count);
  });
});
