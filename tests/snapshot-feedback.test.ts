import {approachFor} from '../src/game/navigation';
import { describe, expect, it } from 'vitest';
import { applyCommand, createGame, observe, startRound, stepGame } from '../src/game/engine';
import { WORLD } from '../src/game/world';
import { SnapshotFeedbackTracker } from '../src/client/game/snapshot-feedback';
import type { GameCommand, GameState, SeatId, StationId } from '../src/shared/contracts';

let sequence = 0;
function command(state: GameState,seatId: SeatId,action: GameCommand['action']): GameCommand {
  return {action_id:`feedback-${++sequence}`,seat_id:seatId,seat_generation:state.seats[seatId].generation,
    state_version:state.state_version,issued_at_ms:state.server_time_ms,ttl_ms:10_000,action};
}
function act(state: GameState,seatId: SeatId,action: GameCommand['action']) {
  const result = applyCommand(state,command(state,seatId,action),state.server_time_ms);
  expect(result.receipt.status).toBe('accepted');return result.state;
}
function station(state: GameState,seatId: SeatId,target: StationId) {
  state = act(state,seatId,{type:'move_to',target:approachFor(state.seats[seatId].position,target)!});
  return stepGame(state,state.server_time_ms+5_000);
}
function interact(state: GameState,seatId: SeatId,target: StationId) {
  return act(state,seatId,{type:'interact',target});
}
const snapshot = (state: GameState) => observe(state,'human').snapshot;
function readyToDeliver(){const s=startRound(createGame(0),0);s.orders[0].phase='accepted';s.orders[0].delivery_deadline_ms=40000;s.seats.ai.position={x:624,y:100};s.items.plate={id:'plate',kind:'plate',contents:[],recipe_id:'pumpkin_salad'};s.seats.ai.held_item_id='plate';return s;}

describe('confirmed snapshot presentation feedback',()=>{
  it('ignores reference-only container copies while noticing actual handoff contents',()=>{const s=startRound(createGame(0),0);s.slots.handoff_a=s.slots.burner_a;s.slots.burner_a=null;const tracker=new SnapshotFeedbackTracker();tracker.observe(snapshot(s),0);const same=structuredClone(s);same.state_version++;expect(tracker.observe(snapshot(same),10).effects).toEqual([]);const changed=structuredClone(same),pot=changed.items[changed.slots.handoff_a!];if(pot.kind!=='pot')throw Error();pot.phase='cooked_pumpkin';changed.state_version++;expect(tracker.observe(snapshot(changed),20).effects).toEqual([{type:'handoff',target:'handoff_a'}]);});
  it('shows item pickup and both handoff directions, without replaying accepted retries or rejected takes',()=>{
    const tracker = new SnapshotFeedbackTracker();
    let state = station(startRound(createGame(0),0),'human','source_pumpkin');
    expect(tracker.observe(snapshot(state),100).effects).toEqual([]);
    const take = command(state,'human',{type:'interact',target:'source_pumpkin'});
    state = applyCommand(state,take,state.server_time_ms).state;
    expect(tracker.observe(snapshot(state),110).effects).toEqual([{type:'item_taken',seatId:'human'}]);
    expect(tracker.observe(snapshot(state),120).effects).toEqual([]);
    const retry = applyCommand(state,take,state.server_time_ms);
    expect(retry.receipt.status).toBe('accepted');
    expect(tracker.observe(snapshot(retry.state),130).effects).toEqual([]);
    const rejected = applyCommand(state,command(state,'human',{type:'interact',target:'plates'}),state.server_time_ms);
    expect(rejected.receipt.status).toBe('rejected');
    expect(tracker.observe(snapshot(rejected.state),140).effects).toEqual([]);
    state = station(rejected.state,'human','handoff_a');tracker.observe(snapshot(state),150);
    state = interact(state,'human','handoff_a');
    expect(tracker.observe(snapshot(state),160).effects).toEqual([{type:'handoff',target:'handoff_a'}]);
    state = station(state,'ai','handoff_a');tracker.observe(snapshot(state),170);
    state = interact(state,'ai','handoff_a');
    expect(tracker.observe(snapshot(state),180).effects).toEqual([{type:'item_taken',seatId:'ai'},{type:'handoff',target:'handoff_a'}]);
  });

  it('celebrates only the actual confirmed score increase, once across retries and no-op commands',()=>{
    const tracker = new SnapshotFeedbackTracker();let state = readyToDeliver();
    tracker.observe(snapshot(state),0);
    const delivery = command(state,'ai',{type:'interact',target:'delivery'});
    state = applyCommand(state,delivery,state.server_time_ms).state;
    expect(state.score).toBe(1);
    expect(tracker.observe(snapshot(state),10).effects).toEqual([{type:'delivered',delta:1}]);
    expect(tracker.observe(snapshot(applyCommand(state,delivery,state.server_time_ms).state),20).effects).toEqual([]);
    state = act(state,'human',{type:'cancel'});
    expect(tracker.observe(snapshot(state),30).effects).toEqual([]);
    const rejected = applyCommand(state,command(state,'ai',{type:'interact',target:'delivery'}),state.server_time_ms);
    expect(rejected.receipt.status).toBe('rejected');
    expect(tracker.observe(snapshot(rejected.state),40).effects).toEqual([]);
  });

  it('does not celebrate cancelled processing, rejected interactions or a no-op movement',()=>{
    let state = interact(station(startRound(createGame(0),0),'human','source_pumpkin'),'human','source_pumpkin');
    state = interact(station(state,'human','chop'),'human','chop');
    const tracker = new SnapshotFeedbackTracker();tracker.observe(snapshot(state),0);
    state = act(state,'human',{type:'cancel'});
    expect(tracker.observe(snapshot(state),10).effects).toEqual([]);
    state = stepGame(state,state.server_time_ms+2_000);
    expect(state.items[state.slots.chop!]).toMatchObject({preparation:'raw'});
    expect(tracker.observe(snapshot(state),20).effects).toEqual([]);
    state = act(state,'human',{type:'move_to',target:state.seats.human.position});
    expect(tracker.observe(snapshot(state),30).effects).toEqual([]);
    const rejected = applyCommand(state,command(state,'human',{type:'interact',target:'delivery'}),state.server_time_ms);
    expect(rejected.receipt.status).toBe('rejected');
    expect(tracker.observe(snapshot(rejected.state),40).effects).toEqual([]);
  });

  it('suppresses historical wins on initial/reconnected snapshots and resets its baseline on round changes',()=>{
    const before = readyToDeliver();const after = interact(before,'ai','delivery');
    const initial = new SnapshotFeedbackTracker();
    expect(initial.observe(snapshot(after),0).effects).toEqual([]);
    const tracker = new SnapshotFeedbackTracker();tracker.observe(snapshot(before),0);
    expect(tracker.observe(snapshot(after),2_000)).toMatchObject({accepted:true,reset:true,effects:[]});
    expect(tracker.observe(snapshot(after),2_010).effects).toEqual([]);
    expect(tracker.observe(snapshot(before),2_020).accepted).toBe(false);
    const ended = stepGame(after,90_000);
    expect(tracker.observe(snapshot(ended),2_030).effects).toEqual([]);
    const restarted = startRound(ended,90_000);
    expect(tracker.observe(snapshot(restarted),2_040)).toMatchObject({accepted:true,reset:true,effects:[]});
    expect(tracker.observe(snapshot(after),2_050).accepted).toBe(false);
    tracker.reset();
    expect(tracker.observe(snapshot(after),2_060)).toMatchObject({accepted:true,reset:true,effects:[]});
  });

  it('ignores stale movement ticks even when their state version is equal',()=>{
    const moving = act(startRound(createGame(0),0),'human',{type:'move_to',target:{x:600,y:320}});
    const earlier = stepGame(moving,100);const later = stepGame(earlier,200);
    expect(earlier.state_version).toBe(later.state_version);
    const tracker = new SnapshotFeedbackTracker();tracker.observe(snapshot(later),0);
    expect(tracker.observe(snapshot(earlier),10).accepted).toBe(false);
  });
});
