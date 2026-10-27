import { describe, expect, it } from 'vitest';
import { createRoom } from '../src/server/room';
import type { GameCommand } from '../src/shared/contracts';
import type {StationId} from '../src/shared/contracts';
import {approachFor} from '../src/game/navigation';

function setup() {
  let time=0; const room=createRoom(()=>time);room.startRound();
  const command=(id='act'): GameCommand => {const s=room.getSnapshot();return {action_id:id,seat_id:'ai',seat_generation:s.seats.ai.generation,state_version:s.state_version,issued_at_ms:time,ttl_ms:1000,action:{type:'move_to',target:{x:540,y:320}}};};
  const wait=(action_id?:string,timeout_ms=1000) => {const s=room.getSnapshot();return {generation:s.seats.ai.generation,round_id:s.round_id,after_cursor:room.observe('ai').events_cursor,action_id,timeout_ms};};
  return {room,command,wait,advance:(value:number)=>{time=value;room.tick();}};
}
describe('external controller lease and event waits',()=>{
  it('lets a pot finish independently after the owner lease expires',()=>{let time=0,n=0;const room=createRoom(()=>time);room.startRound();room.claimExternal('owner');const submit=(action:GameCommand['action'])=>{const s=room.getSnapshot();expect(room.submit({action_id:`heat-${++n}`,seat_id:'human',seat_generation:s.seats.human.generation,state_version:s.state_version,issued_at_ms:time,ttl_ms:10000,action})).toMatchObject({receipt:{status:'accepted'}});};const station=(id:StationId)=>{submit({type:'move_to',target:approachFor(room.getSnapshot().seats.human.position,id)!});while(room.getSnapshot().seats.human.active_action){time+=50;room.tick();}};station('source_pumpkin');submit({type:'interact',target:'source_pumpkin'});station('chop');submit({type:'interact',target:'chop'});time+=2000;room.tick();submit({type:'interact',target:'chop'});station('burner_a');time=28000;room.tick();submit({type:'interact',target:'burner_a'});const pot=room.getSnapshot().slots.burner_a!,generation=room.getSnapshot().seats.ai.generation;time=30000;room.tick();expect(room.getControllerStatus().connected).toBe(false);expect(room.getSnapshot().seats.ai.generation).toBe(generation+1);time=34000;room.tick();expect(room.getSnapshot().items[pot]).toMatchObject({phase:'cooked_pumpkin',remaining_ms:0});room.close();});
  it('binds one owner and prevents plain external bypass or human impersonation',()=>{
    const {room,command}=setup();
    expect(room.claimExternal('a')).toHaveProperty('observation');
    expect(room.claimExternal('b')).toMatchObject({code:'FORBIDDEN'});
    expect(room.submit(command(),'external')).toMatchObject({code:'FORBIDDEN'});
    expect(room.submitExternal('b',command())).toMatchObject({code:'FORBIDDEN'});
    expect(room.submitExternal('a',{...command(),seat_id:'human'})).toMatchObject({code:'FORBIDDEN'});
    expect(room.submitExternal('a',command())).toMatchObject({receipt:{status:'accepted'}});
    room.takeover('ai');expect(room.submitExternal('a',command())).toMatchObject({code:'FORBIDDEN'});
    expect(room.claimExternal('a')).toMatchObject({code:'FORBIDDEN'});
  });
  it('expires at 30 seconds, cancels work and revokes generation',()=>{
    const {room,command,advance}=setup();room.claimExternal('a');
    room.submitExternal('a',{...command(),action:{type:'move_to',target:{x:20,y:20}}});
    const generation=room.getSnapshot().seats.ai.generation;
    advance(30000);expect(room.getSnapshot().seats.ai).toMatchObject({controller:'external',active_action:null,generation:generation+1});
    expect(room.getControllerStatus()).toEqual({connected:false,waiting:false});
  });
  it('returns already completed instantaneous actions and ignores ordinary ticks and accepted events',async()=>{
    const {room,command,wait,advance}=setup();room.claimExternal('a');
    const params=wait('instant');room.submitExternal('a',command('instant'));
    expect(await room.waitForChange('a',params)).toMatchObject({reason:'action_completed'});
    const later=wait('moving');let resolved=false;
    const pending=room.waitForChange('a',later).then(r=>{resolved=true;return r;});
    expect(room.getControllerStatus()).toEqual({connected:true,waiting:true});
    room.submitExternal('a',{...command('moving'),action:{type:'move_to',target:{x:600,y:320}}});
    advance(50);await Promise.resolve();expect(resolved).toBe(false);
    advance(1000);expect(await pending).toMatchObject({reason:'action_completed'});
  });
  it('cleans timeout, abort, duplicate wait, takeover, close and round invalidation',async()=>{
    const {room,wait,advance}=setup();room.claimExternal('a');
    expect(await room.waitForChange('a',wait(undefined,0))).toMatchObject({reason:'timeout'});
    const controller=new AbortController();const abort=room.waitForChange('a',wait(),controller.signal);
    expect(await room.waitForChange('a',wait())).toMatchObject({reason:'wait_limit'});
    controller.abort();expect(await abort).toMatchObject({reason:'aborted'});
    const takeover=room.waitForChange('a',wait());room.takeover('ai');expect(await takeover).toMatchObject({reason:'control_lost'});
    room.setDemoEnabled(false);room.claimExternal('a');const ended=room.waitForChange('a',wait());advance(90000);
    expect(await ended).toMatchObject({reason:'round_finished'});
    room.claimExternal('a');const old=wait();room.startRound();expect(await room.waitForChange('a',old)).toMatchObject({reason:'round_changed'});
    room.claimExternal('a');const closing=room.waitForChange('a',wait());room.close();expect(await closing).toMatchObject({reason:'closed'});
  });
  it('reports cursor gaps without leaking receipts',()=>{
    const {room,command}=setup();room.claimExternal('a');
    for(let n=0;n<150;n++) room.submitExternal('a',command(`event-${n}`));
    expect(room.eventsSince(0)).toMatchObject({truncated:true});
    expect(room.eventsSince(0).oldest_cursor).toBeGreaterThan(1);
    expect(room.observe('ai').snapshot).not.toHaveProperty('receipts');
  });
  it('finds retained terminal target even with advanced cursor, and reports cancellation/rejection',async()=>{
    const {room,command,wait}=setup();room.claimExternal('a');room.submitExternal('a',command('done'));
    expect(await room.waitForChange('a',wait('done'))).toMatchObject({reason:'action_completed'});
    room.submitExternal('a',{...command('moving'),action:{type:'move_to',target:{x:20,y:20}}});
    const cancelled=room.waitForChange('a',wait('moving'));room.submitExternal('a',{...command('stop'),action:{type:'cancel'}});
    expect(await cancelled).toMatchObject({reason:'action_cancelled'});
    const rejected=room.waitForChange('a',wait('reject'));room.submitExternal('a',{...command('reject'),state_version:0});
    expect(await rejected).toMatchObject({reason:'action_rejected'});
  });
  it('wakes on human completion, treats gaps explicitly, and rejects stale waits without refreshing lease',async()=>{
    const {room,command,wait,advance}=setup();room.claimExternal('a');const change=room.waitForChange('a',wait());
    const s=room.getSnapshot();room.submit({...command('human'),seat_id:'human',seat_generation:s.seats.human.generation,action:{type:'move_to',target:s.seats.human.position}});
    expect(await change).toMatchObject({reason:'action_completed'});
    for(let n=0;n<150;n++) room.submitExternal('a',command(`fill-${n}`));
    expect(await room.waitForChange('a',{...wait(),after_cursor:0})).toMatchObject({reason:'gap'});
    advance(29999);expect(await room.waitForChange('a',{...wait(),generation:0})).toMatchObject({reason:'control_lost'});
    advance(30000);expect(room.getControllerStatus().connected).toBe(false);
  });
  it('rejects mismatched owner generation and refreshes valid immediate waits',async()=>{
    let time=0;const room=createRoom(()=>time);room.startRound();room.claimExternal('a');
    const s=room.getSnapshot();const base:GameCommand={action_id:'stale-generation',seat_id:'ai',seat_generation:s.seats.ai.generation-1,state_version:s.state_version,issued_at_ms:0,ttl_ms:1000,action:{type:'cancel'}};
    expect(room.submitExternal('a',base)).toMatchObject({code:'FORBIDDEN'});
    time=29999;room.tick();
    expect(await room.waitForChange('a',{generation:s.seats.ai.generation,round_id:s.round_id,after_cursor:room.observe('ai').events_cursor,timeout_ms:0})).toMatchObject({reason:'timeout'});
    time=30000;room.tick();expect(room.getControllerStatus().connected).toBe(true);
    time=60000;expect(room.touchExternal('a')).toBe(false);expect(room.getControllerStatus().connected).toBe(false);
  });
  it('waits for the accepted action despite conflicting retries, including after completion',async()=>{
    const {room,command,wait,advance}=setup();room.claimExternal('a');
    const original={...command('moving'),action:{type:'move_to' as const,target:{x:600,y:320}}};
    expect(room.submitExternal('a',original)).toMatchObject({receipt:{status:'accepted'}});
    let resolved=false;const pending=room.waitForChange('a',wait('moving')).then(result=>{resolved=true;return result;});
    expect(room.submitExternal('a',{...original,state_version:room.getSnapshot().state_version})).toMatchObject({receipt:{error:'ACTION_ID_CONFLICT'}});
    await Promise.resolve();expect(resolved).toBe(false);
    advance(1000);expect(await pending).toMatchObject({reason:'action_completed'});
    expect(await room.waitForChange('a',wait('moving',0))).toMatchObject({reason:'action_completed'});
  });
  it('scopes target history to the claim generation and blocks prior-generation receipt replay from refreshing its lease',async()=>{
    const {room,command,wait,advance}=setup();room.claimExternal('a');const original=command('old');
    expect(room.submitExternal('a',original)).toMatchObject({receipt:{status:'accepted'}});
    const cursor=room.observe('ai').events_cursor;
    expect(room.submitExternal('a',original)).toMatchObject({receipt:{status:'accepted'}});
    expect(room.observe('ai').events_cursor).toBe(cursor);
    room.releaseExternal('a');advance(1);room.claimExternal('a');
    expect(await room.waitForChange('a',wait('old',0))).toMatchObject({reason:'timeout'});
    advance(29999);expect(room.submitExternal('a',original)).toMatchObject({code:'FORBIDDEN'});
    advance(30001);expect(room.getControllerStatus()).toEqual({connected:false,waiting:false});
  });
  it('wakes a general wait on a new order while no character is working',async()=>{const {room,wait,advance}=setup();room.claimExternal('a');const pending=room.waitForChange('a',wait());advance(12000);expect(await pending).toMatchObject({reason:'changed'});});
  it('does not end a targeted movement wait when a public order changes',async()=>{const {room,wait,advance,command}=setup();room.claimExternal('a');advance(11000);room.submitExternal('a',{...command('long'),action:{type:'move_to',target:{x:20,y:20}}});let ended=false;const pending=room.waitForChange('a',wait('long')).then(r=>{ended=true;return r;});advance(12000);await Promise.resolve();expect(ended).toBe(false);advance(20000);expect(await pending).toMatchObject({reason:'action_completed'});room.close();});
});
