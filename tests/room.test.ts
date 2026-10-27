import { describe, expect, it } from 'vitest';
import { createRoom } from '../src/server/room';
import type { GameCommand, GameSnapshot, SeatId } from '../src/shared/contracts';

let sequence = 0;
function command(s: GameSnapshot, seat_id: SeatId = 'human'): GameCommand {
  return {action_id:`room-${++sequence}`,seat_id,seat_generation:s.seats[seat_id].generation,state_version:s.state_version,issued_at_ms:s.server_time_ms,ttl_ms:1000,action:{type:'move_to',target:{x:176,y:100}}};
}
describe('authoritative room',()=>{
  it.each([true,false])('leaves active work and generation unchanged when demo enabled is already %s',enabled=>{
    const room=createRoom(()=>0);room.startRound();
    if(!enabled) room.setDemoEnabled(false);
    const actor=enabled?'demo':'external';
    if(!enabled) room.claimExternal('test');
    expect(enabled?room.submit(command(room.getSnapshot(),'ai'),actor):room.submitExternal('test',command(room.getSnapshot(),'ai'))).toMatchObject({receipt:{status:'accepted'}});
    const before=room.getSnapshot();
    expect(before.seats.ai.active_action).not.toBeNull();
    room.setDemoEnabled(enabled);
    expect(room.getSnapshot()).toEqual(before);
  });
  it('isolates snapshots, observations and command results from room authority',()=>{
    const room=createRoom(()=>100); room.startRound();
    const snapshot=room.getSnapshot(); expect(snapshot).not.toHaveProperty('receipts');
    snapshot.seats.human.position.x=999;
    const observation=room.observe('human'); observation.snapshot.seats.human.position.x=999;
    const result=room.submit(command(room.getSnapshot()));
    expect('receipt' in result && result.receipt.status).toBe('accepted');
    if('state' in result) result.state.seats.human.position.x=999;
    expect(room.getSnapshot().seats.human.position.x).toBe(260);
  });
  it('isolates nested receipts and events in returned results from authoritative retries',()=>{const room=createRoom(()=>0);room.startRound();const c=command(room.getSnapshot());const result=room.submit(c);if(!('state' in result))throw Error();result.state.receipts[c.action_id].receipt.status='rejected';result.state.events[0].type='action_rejected';expect(room.submit(c)).toMatchObject({receipt:{status:'accepted'}});expect(room.observe('human').events[0].type).toBe('round_started');room.close();});
  it('runs the demo through commands once per tick and blocks forged browser AI actions',()=>{
    let now=0; const room=createRoom(()=>now);room.startRound();
    expect(room.submit(command(room.getSnapshot(),'ai'))).toMatchObject({code:'FORBIDDEN'});
    for(now=0;now<=60000;now+=100) room.tick();
    expect(room.getSnapshot().score).toBeGreaterThan(0);
    expect(room.observe('ai').events.some(e=>e.action_id?.startsWith('demo-'))).toBe(true);
    const playing=room.getSnapshot(); room.startRound();expect(room.getSnapshot()).toEqual(playing);
  });
  it('takeover and demo toggle cancel actions, bump generations and block late actors',()=>{
    let now=0;const room=createRoom(()=>now);room.startRound();room.tick();
    const old=command(room.getSnapshot(),'ai'); const generation=old.seat_generation;
    room.takeover('ai');expect(room.getSnapshot().seats.ai).toMatchObject({controller:'human',generation:generation+1,active_action:null});
    expect(room.submit(old,'demo')).toMatchObject({code:'FORBIDDEN'});
    const stale=room.submit(old);expect('receipt' in stale && stale.receipt.error).toBe('STALE_GENERATION');
    now=100;room.tick();expect(room.getSnapshot().seats.ai.active_action).toBeNull();
    room.setDemoEnabled(true);expect(room.getSnapshot().seats.ai.controller).toBe('demo');
    const staleDemo=room.submit(old,'demo');expect('receipt' in staleDemo && staleDemo.receipt.error).toBe('STALE_GENERATION');room.tick();
    room.setDemoEnabled(false);expect(room.getSnapshot().seats.ai).toMatchObject({controller:'external',active_action:null});
    expect(room.submit(command(room.getSnapshot(),'ai'),'demo')).toMatchObject({code:'FORBIDDEN'});
    expect(room.submit(command(room.getSnapshot(),'human'),'external')).toMatchObject({code:'FORBIDDEN'});
    const human=room.getSnapshot().seats.human;room.takeover('human');expect(room.getSnapshot().seats.human).toEqual(human);
    now=90000;room.tick();room.startRound();expect(room.getSnapshot().phase).toBe('playing');
  });
});
