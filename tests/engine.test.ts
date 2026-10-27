import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { applyCommand, createGame, observe, setController, startRound, stepGame } from '../src/game/engine';
import { WORLD } from '../src/game/world';
import { chooseDemoCommand } from '../src/game/demo';
import {approachFor} from '../src/game/navigation';
import type { GameCommand, GameState, SeatId, StationId } from '../src/shared/contracts';

let sequence = 0;
function command(state: GameState, seat_id: SeatId, action: GameCommand['action'], now = state.server_time_ms): GameCommand {
  return { action_id: `test-${++sequence}`, seat_id, seat_generation: state.seats[seat_id].generation, state_version: state.state_version, issued_at_ms: now, ttl_ms: 10000, action };
}
function act(state: GameState, seat: SeatId, action: GameCommand['action']) { const r = applyCommand(state, command(state, seat, action), state.server_time_ms); expect(r.receipt.status).toBe('accepted'); return r.state; }
function station(state: GameState, seat: SeatId, target: StationId) {
  state = act(state, seat, {type:'move_to',target:approachFor(state.seats[seat].position,target)!});
  while(state.seats[seat].active_action)state=stepGame(state,state.server_time_ms+50);
  return state;
}
function interact(state: GameState, seat: SeatId, target: StationId) { return act(state,seat,{type:'interact',target}); }
function dish(state: GameState) {
  state=interact(station(state,'human','orders'),'human','orders');
  state=interact(station(state,'human','source_pumpkin'),'human','source_pumpkin');
  state=interact(station(state,'human','chop'),'human','chop');
  state=stepGame(state,state.server_time_ms+2000);
  state=interact(state,'human','chop');
  state=interact(station(state,'human','handoff_a'),'human','handoff_a');
  state=interact(station(state,'ai','handoff_a'),'ai','handoff_a');
  state=interact(station(state,'ai','burner_a'),'ai','burner_a');
  state=stepGame(state,state.server_time_ms+6000);
  state=interact(station(state,'ai','plates'),'ai','plates');
  state=interact(station(state,'ai','burner_a'),'ai','burner_a');
  state=interact(station(state,'ai','counter_right'),'ai','counter_right');
  state=interact(station(state,'ai','source_cucumber'),'ai','source_cucumber');
  state=interact(station(state,'ai','chop'),'ai','chop');
  state=stepGame(state,state.server_time_ms+1500);state=interact(state,'ai','chop');
  state=interact(station(state,'ai','counter_right'),'ai','counter_right');state=interact(state,'ai','counter_right');
  return station(state,'ai','delivery');
}
describe('deterministic game core',()=>{
  it('lets exactly one seat take a shared object and keeps frozen input isolated',()=>{const s=startRound(createGame(0),0);s.seats.human.position={x:328,y:180};s.seats.ai.position={x:472,y:180};s.items.shared={id:'shared',kind:'ingredient',ingredient:'pumpkin',preparation:'raw',chop_remaining_ms:2000};s.slots.handoff_a='shared';const first=command(s,'human',{type:'interact',target:'handoff_a'}),second=command(s,'ai',{type:'interact',target:'handoff_a'});const freeze=(value:unknown)=>{if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}};freeze(s);const taken=applyCommand(s,first,0);expect(taken.receipt.status).toBe('accepted');expect(applyCommand(taken.state,second,0).receipt.error).toBe('STALE_STATE');expect(applyCommand(taken.state,command(taken.state,'ai',{type:'interact',target:'handoff_a'}),0).receipt.error).toBe('INVALID_INTERACTION');expect(taken.state.seats.human.held_item_id).toBe('shared');expect(taken.state.seats.ai.held_item_id).toBeNull();expect(s.slots.handoff_a).toBe('shared');const o=observe(taken.state,'human');o.snapshot.items.shared.id='changed';expect(taken.state.items.shared.id).toBe('shared');});
  it('records true movement arrival time independently of tick cadence',()=>{
    const moving=act(startRound(createGame(0),0),'human',{type:'move_to',target:{x:420,y:320}});
    for(const completed of [stepGame(moving,3000),stepGame(stepGame(moving,1000),3000)]) {
      expect(completed.seats.human.position).toEqual({x:420,y:320});
      expect(completed.events.find(e=>e.type==='action_completed')?.at_ms).toBe(1000);
    }
  });
  it('finishes a route around the island with a real epoch clock without blocking the room',()=>{
    // A separate bounded process lets this test fail safely if the room spins at a waypoint.
    const script=`import {createGame,startRound,applyCommand,stepGame} from './src/game/engine.ts';
      const now=1792300000000;let state=startRound(createGame(now),now);
      state.seats.human.position={x:328,y:180};
      state=applyCommand(state,{action_id:'epoch-route',seat_id:'human',seat_generation:state.seats.human.generation,state_version:state.state_version,issued_at_ms:now,ttl_ms:10000,action:{type:'move_to',target:{x:400,y:350}}},now).state;
      for(let elapsed=50;elapsed<=5000;elapsed+=50)state=stepGame(state,now+elapsed);
      console.log(JSON.stringify({position:state.seats.human.position,active:state.seats.human.active_action,completions:state.events.filter(e=>e.type==='action_completed'&&e.action_id==='epoch-route').length}));`;
    const actual=JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{cwd:new URL('..',import.meta.url),encoding:'utf8',timeout:5000}));
    expect(actual).toEqual({position:{x:400,y:350},active:null,completions:1});
  },10000);
  it('starts in lobby, finishes at exactly 90 seconds, cannot reset a playing round',()=>{
    const lobby=createGame(100); expect(lobby.phase).toBe('lobby');
    const s=startRound(lobby,100); expect(startRound(s,200)).toEqual(s);
    expect(stepGame(s,90099).phase).toBe('playing'); expect(stepGame(s,90100).phase).toBe('finished');
  });
  it('shares a raw item across seats, processes for two seconds, delivers once without rollback on retry',()=>{
    let s=dish(startRound(createGame(0),0)); expect(s.items[s.seats.ai.held_item_id!]).toMatchObject({recipe_id:'pumpkin_salad'});
    const c=command(s,'ai',{type:'interact',target:'delivery'}); const before=structuredClone(s);
    const r=applyCommand(s,c,s.server_time_ms); expect(s).toEqual(before); expect(r.state.score).toBe(1);
    const newer=act(r.state,'human',{type:'move_to',target:{x:400,y:340}});
    const retry=applyCommand(newer,c,newer.server_time_ms); expect(retry.receipt).toEqual(r.receipt); expect(retry.state).toBe(newer); expect(retry.state.score).toBe(1);
    expect(applyCommand(newer,{...c,action:{type:'cancel'}},newer.server_time_ms).receipt.error).toBe('ACTION_ID_CONFLICT');
  });
  it('rejects distance, expired, future, stale version and generation',()=>{
    const s=startRound(createGame(0),0), base=command(s,'human',{type:'interact',target:'delivery'});
    expect(applyCommand(s,base,0).receipt.error).toBe('OUT_OF_RANGE');
    expect(applyCommand(s,{...base,issued_at_ms:-10,ttl_ms:10},0).receipt.error).toBe('EXPIRED');
    expect(applyCommand(s,{...base,issued_at_ms:1},0).receipt.error).toBe('FUTURE_COMMAND');
    expect(applyCommand(s,{...base,state_version:0},0).receipt.error).toBe('STALE_STATE');
    expect(applyCommand(s,{...base,seat_generation:0},0).receipt.error).toBe('STALE_GENERATION');
  });
  it('cancels movement and interpolates without changing the version',()=>{
    let s=startRound(createGame(0),0); s=act(s,'human',{type:'move_to',target:{x:600,y:320}});
    const version=s.state_version; s=stepGame(s,1000); expect(s.state_version).toBe(version); expect(s.seats.human.position.x).toBe(420);
    s=act(s,'human',{type:'cancel'}); const p=s.seats.human.position; s=stepGame(s,2000); expect(s.seats.human.position).toEqual(p);
  });
  it('takeover cancels processing, retains raw item and blocks old generation; restart preserves increasing generations',()=>{
    let s=startRound(createGame(0),0); s=interact(station(s,'ai','source_pumpkin'),'ai','source_pumpkin'); s=interact(station(s,'ai','chop'),'ai','chop');
    const old=command(s,'ai',{type:'cancel'}); const generation=s.seats.ai.generation;
    s=setController(s,'ai','human',s.server_time_ms); s=stepGame(s,s.server_time_ms+3000);
    expect(s.items[s.slots.chop!]).toMatchObject({preparation:'raw',chop_remaining_ms:2000}); expect(s.seats.ai.active_action).toBeNull(); expect(s.seats.ai.generation).toBe(generation+1);
    expect(applyCommand(s,old,s.server_time_ms).receipt.error).toBe('STALE_GENERATION');
    s=stepGame(s,90000); s=startRound(s,90000); expect(s.seats.ai.generation).toBe(generation+2);
    expect(applyCommand(s,{...old,action_id:'restart-old',issued_at_ms:90000},90000).receipt.error).toBe('STALE_GENERATION');
  });
  it('cannot score after deadline and exposes legal observation',()=>{
    let s=dish(startRound(createGame(0),0)); const c=command(s,'ai',{type:'interact',target:'delivery'},90000);
    const r=applyCommand(s,c,90000); expect(r.state.phase).toBe('finished'); expect(r.state.score).toBe(0); expect(r.receipt.error).toBe('NOT_PLAYING');
    const o=observe(r.state,'ai'); expect(o.snapshot.phase).toBe('finished'); expect(o.legal_actions).toEqual([]); expect(o.server_time_ms).toBe(90000);
  });
  it('validates finite numeric inputs, bounds, TTL and unknown command shapes safely',()=>{
    const s=startRound(createGame(0),0), c=command(s,'human',{type:'move_to',target:{x:800,y:500}});
    for(const bad of [null,{}, {...c,ttl_ms:0},{...c,ttl_ms:10001},{...c,issued_at_ms:NaN},{...c,action:{type:'move_to',target:{x:Infinity,y:1}}},{...c,action:{type:'move_to',target:{x:801,y:1}}}]) expect(applyCommand(s,bad as GameCommand,0).receipt.status).toBe('rejected');
  });
  it('processes only at 2 seconds, refuses a second action, and snapshots are isolated',()=>{
    let s=startRound(createGame(0),0); s=interact(station(s,'ai','source_pumpkin'),'ai','source_pumpkin'); s=interact(station(s,'ai','chop'),'ai','chop');
    const started=s.server_time_ms, version=s.state_version;
    expect(applyCommand(s,command(s,'ai',{type:'move_to',target:{x:0,y:0}}),started).receipt.error).toBe('SEAT_BUSY');
    s=stepGame(s,started+1999);expect(s.items[s.slots.chop!]).toMatchObject({preparation:'raw'});expect(s.state_version).toBe(version);
    s=stepGame(s,started+2000);expect(s.items[s.slots.chop!]).toMatchObject({preparation:'chopped'});expect(s.seats.ai.active_action).toBeNull();
    const o=observe(s,'ai');o.snapshot.seats.ai.position.x=0;expect(s.seats.ai.position.x).toBe(WORLD.stations.chop.approach_points[0].x);
    expect(o.legal_actions.some(a=>a.type==='move_to')).toBe(true);
  });
  it('demo controller completes the same legal action path, stops on takeover',()=>{
    let s=startRound(createGame(0),0);
    for(let t=0;t<=60000;t+=100) {
      s=stepGame(s,t);const c=chooseDemoCommand(s,t);
      if(c) {const r=applyCommand(s,c,t);expect(r.receipt.status).toBe('accepted');s=r.state;}
    }
    expect(s.score).toBeGreaterThan(0);
    s=setController(s,'ai','human',60000);expect(chooseDemoCommand(s,60000)).toBeNull();
  });
  it('rejects reused IDs even when replacement content is malformed, and rejects unknown fields',()=>{
    const s=startRound(createGame(0),0), c=command(s,'human',{type:'cancel'});
    const accepted=applyCommand(s,c,0).state;
    expect(applyCommand(accepted,{...c,action:{type:'unknown'}} as unknown as GameCommand,0).receipt.error).toBe('ACTION_ID_CONFLICT');
    expect(applyCommand(s,{...c,extra:'ignored?'} as GameCommand,0).receipt.error).toBe('INVALID_COMMAND');
    expect(applyCommand(s,{...c,action:{type:'cancel',target:'orders'}} as GameCommand,0).receipt.error).toBe('INVALID_COMMAND');
  });
  it('keeps receipt capacity bounded without evicting old IDs, events monotonic',()=>{
    let s=startRound(createGame(0),0); const first=command(s,'human',{type:'cancel'}); s=applyCommand(s,first,0).state;
    for(let i=1;i<4096;i++) s=applyCommand(s,command(s,'human',{type:'cancel'}),0).state;
    expect(Object.keys(s.receipts)).toHaveLength(4096);
    expect(applyCommand(s,command(s,'human',{type:'cancel'}),0).receipt.error).toBe('RECEIPT_CAPACITY');
    expect(applyCommand(s,first,0).receipt.status).toBe('accepted'); expect(s.events.length).toBeLessThanOrEqual(256);
    expect(s.events.at(-1)!.id).toBeGreaterThan(s.events[0].id);
  },30000); // The full4096-entry stress shares CPU with protocol integration tests.
});
