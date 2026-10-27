import {RULESET_ID} from '../src/shared/ruleset';
import { describe, expect, it } from 'vitest';
import { createRoom } from '../src/server/room';
import { WORLD } from '../src/game/world';
import type { GameCommand, SeatId, SemanticAction } from '../src/shared/contracts';
import type { HumanInputMessage } from '../src/shared/protocol';

function setup() {
  let time = 0, commandId = 0;
  const room = createRoom(() => time);
  room.startRound();room.setDemoEnabled(false);
  const input = (sequence: number, direction: HumanInputMessage['direction'], seat_id: SeatId = 'human'): HumanInputMessage => {
    const snapshot = room.getSnapshot();
    return {type:'human_input',ruleset_id:RULESET_ID,seat_id,seat_generation:snapshot.seats[seat_id].generation,round_id:snapshot.round_id,sequence,direction};
  };
  const command = (action: SemanticAction, seat_id: SeatId = 'human'): GameCommand => {
    const snapshot = room.getSnapshot();
    return {action_id:`semantic-${++commandId}`,seat_id,seat_generation:snapshot.seats[seat_id].generation,state_version:snapshot.state_version,issued_at_ms:time,ttl_ms:1000,action};
  };
  return {room,input,command,setTime:(value: number) => {time = value;},tick:(value: number) => {time = value;room.tick();}};
}

describe('bounded human keyboard control', () => {
  it('stops a held direction at the counter without bending around it or restarting',()=>{const {room,input,command,tick}=setup();room.submit(command({type:'move_to',target:{x:600,y:320}}));tick(3000);room.setHumanInput('a',input(1,{x:1,y:0}));tick(3300);expect(room.getSnapshot().seats.human.position.x).toBeCloseTo(633.999,3);expect(room.getSnapshot().seats.human.position.y).toBe(320);const stopped=room.getSnapshot().seats.human.position;tick(5000);expect(room.getSnapshot().seats.human.position).toEqual(stopped);});
  it.each([{x:1,y:0},{x:1,y:1}] as const)('moves at 160 px/s using semantic movement for %j', direction => {
    const {room,input,tick} = setup();
    expect(room.setHumanInput('a',input(1,direction))).toMatchObject({status:'accepted',sequence:1});
    expect(room.getSnapshot().seats.human.active_action).toMatchObject({type:'move_to'});
    tick(100);
    const p = room.getSnapshot().seats.human.position;
    expect(Math.hypot(p.x-260,p.y-320)).toBeCloseTo(16,8);
    if(direction.y) expect(p.x-260).toBeCloseTo(p.y-320,8);
  });

  it('changes direction and releases only its exact owned action', () => {
    const {room,input,tick} = setup();
    room.setHumanInput('a',input(1,{x:1,y:0}));tick(100);
    const first = room.getSnapshot().seats.human.active_action!.action_id;
    expect(room.setHumanInput('a',input(2,{x:0,y:1}))).toMatchObject({status:'accepted'});tick(200);
    expect(room.getSnapshot().seats.human.position).toEqual({x:276,y:336});
    expect(room.getSnapshot().seats.human.active_action!.action_id).not.toBe(first);
    room.setHumanInput('a',input(3,{x:0,y:0}));tick(800);
    expect(room.getSnapshot().seats.human).toMatchObject({position:{x:276,y:336},active_action:null});
  });

  it('stops at the exact 300ms expiry even when a tick arrives much later', () => {
    const {room,input,tick} = setup();
    room.setHumanInput('a',input(1,{x:1,y:0}));
    const action = room.getSnapshot().seats.human.active_action!.action_id;
    tick(1000);
    expect(room.getSnapshot().seats.human).toMatchObject({position:{x:308,y:320},active_action:null});
    expect(room.observe('human').events).toContainEqual(expect.objectContaining({type:'action_cancelled',action_id:action,at_ms:300}));
    expect(room.getSnapshot().server_time_ms).toBe(1000);
  });

  it('advances expiry before external submissions without changing their metadata', () => {
    const {room,input,command,setTime} = setup();room.claimExternal('mcp');
    room.setHumanInput('a',input(1,{x:1,y:0}));
    const external = {...command({type:'move_to',target:{x:600,y:320}},'ai'),ttl_ms:2000};
    setTime(1000);
    expect(room.submitExternal('mcp',external)).toMatchObject({receipt:{status:'rejected',error:'STALE_STATE'}});
    expect(room.getSnapshot().seats.human.position.x).toBe(308);
    expect(room.getSnapshot().seats.human.active_action).toBeNull();
  });

  it('renews the lease without receipt, version or event churn and never restarts a boundary arrival', () => {
    const {room,input,command,tick,setTime} = setup();
    room.submit(command({type:'move_to',target:{x:633.999,y:320}}));tick(4000);
    room.setHumanInput('a',input(1,{x:1,y:0}));
    const before = room.getSnapshot();const cursor = room.observe('human').events_cursor;
    setTime(4200);expect(room.setHumanInput('a',input(2,{x:1,y:0}))).toMatchObject({status:'accepted'});
    expect(room.getSnapshot().state_version).toBe(before.state_version);
    expect(room.observe('human').events_cursor).toBe(cursor);
    expect(room.getSnapshot().seats.human.active_action).toBeNull();
    tick(4600);expect(room.getSnapshot().seats.human.position).toEqual({x:633.999,y:320});
    expect(room.observe('human').events_cursor).toBe(cursor);
    const result = room.submit(command({type:'cancel'}));
    if(!('state' in result)) throw Error('missing command state');
    expect(Object.keys(result.state.receipts)).toHaveLength(3);
  });

  it('retains sequence protection after release but forgets it on socket disconnect', () => {
    const {room,input} = setup();
    room.setHumanInput('a',input(10,{x:1,y:0}));room.setHumanInput('a',input(11,{x:0,y:0}));
    expect(room.setHumanInput('a',input(10,{x:1,y:0}))).toMatchObject({status:'rejected',error:'STALE_INPUT'});
    room.releaseHumanInput('a');
    expect(room.setHumanInput('a',input(1,{x:1,y:0}))).toMatchObject({status:'accepted'});
  });

  it('rejects stale rounds and generations and prevents keyboard control of external AI', () => {
    const {room,input} = setup();const current = input(1,{x:1,y:0});
    expect(room.setHumanInput('a',{...current,round_id:current.round_id-1})).toMatchObject({error:'ROUND_CHANGED'});
    expect(room.setHumanInput('a',{...current,sequence:2,seat_generation:current.seat_generation-1})).toMatchObject({error:'STALE_GENERATION'});
    expect(room.setHumanInput('a',input(3,{x:1,y:0},'ai'))).toMatchObject({error:'FORBIDDEN'});
    room.takeover('ai');expect(room.setHumanInput('a',input(4,{x:1,y:0},'ai'))).toMatchObject({status:'accepted'});
    room.setDemoEnabled(false);
    expect(room.getSnapshot().seats.ai.active_action).toBeNull();
    expect(room.setHumanInput('a',input(5,{x:1,y:0},'ai'))).toMatchObject({error:'FORBIDDEN'});
  });

  it('never cancels processing when keyboard input starts or a zero arrives', () => {
    const {room,input,command,tick} = setup();
    room.submit(command({type:'move_to',target:WORLD.stations.source_pumpkin.approach_points[0]}));tick(2000);
    room.submit(command({type:'interact',target:'source_pumpkin'}));
    room.submit(command({type:'move_to',target:WORLD.stations.chop.approach_points[0]}));tick(6000);
    expect(room.submit(command({type:'interact',target:'chop'}))).toMatchObject({receipt:{status:'accepted'}});
    const process = room.getSnapshot().seats.human.active_action;
    expect(room.setHumanInput('a',input(1,{x:1,y:0}))).toMatchObject({status:'rejected',error:'SEAT_BUSY'});
    expect(room.setHumanInput('a',input(2,{x:0,y:0}))).toMatchObject({status:'accepted'});
    expect(room.getSnapshot().seats.human.active_action).toEqual(process);
  });

  it('keeps one socket owner per seat and ignores nonowner zero input', () => {
    const {room,input} = setup();room.setHumanInput('a',input(1,{x:1,y:0}));
    const before = room.getSnapshot().seats.human.active_action;
    expect(room.setHumanInput('b',input(1,{x:-1,y:0}))).toMatchObject({error:'INPUT_OWNED'});
    expect(room.setHumanInput('b',input(2,{x:0,y:0}))).toMatchObject({error:'INPUT_OWNED'});
    expect(room.getSnapshot().seats.human.active_action).toEqual(before);
    room.releaseHumanInput('a');
    expect(room.getSnapshot().seats.human.active_action).toBeNull();
    expect(room.setHumanInput('b',input(3,{x:-1,y:0}))).toMatchObject({status:'accepted'});
  });

  it('retires ownership after a semantic cancel so stale zero cannot stop newer work', () => {
    const {room,input,command} = setup();room.setHumanInput('a',input(1,{x:1,y:0}));
    expect(room.submit(command({type:'cancel'}))).toMatchObject({receipt:{status:'accepted'}});
    expect(room.submit(command({type:'move_to',target:{x:176,y:100}}))).toMatchObject({receipt:{status:'accepted'}});
    const newer = room.getSnapshot().seats.human.active_action;
    expect(room.setHumanInput('a',input(2,{x:0,y:0}))).toMatchObject({status:'accepted'});
    room.releaseHumanInput('a');
    expect(room.getSnapshot().seats.human.active_action).toEqual(newer);
  });

  it('replaces a semantic move with a real keyboard move but does not cancel it on a semantic receipt replay', () => {
    const {room,input,command} = setup();const original=command({type:'move_to',target:{x:176,y:100}});
    room.submit(original);room.setHumanInput('a',input(1,{x:1,y:0}));
    const keyboard=room.getSnapshot().seats.human.active_action;
    expect(keyboard?.action_id).not.toBe(original.action_id);
    expect(room.submit(original)).toMatchObject({receipt:{status:'accepted'}});
    room.setHumanInput('a',input(2,{x:0,y:0}));
    expect(room.getSnapshot().seats.human.active_action).toBeNull();
  });

  it('renews a moving action without producing semantic receipts or accepted events', () => {
    const {room,input,tick,setTime} = setup();room.setHumanInput('a',input(1,{x:1,y:0}));
    const version=room.getSnapshot().state_version,cursor=room.observe('human').events_cursor;
    setTime(200);room.setHumanInput('a',input(2,{x:1,y:0}));
    expect(room.getSnapshot().state_version).toBe(version);
    expect(room.observe('human').events_cursor).toBe(cursor);
    tick(600);expect(room.getSnapshot().seats.human).toMatchObject({position:{x:340,y:320},active_action:null});
  });

  it.each(['submit','claim','touch','release','takeover','demo','close'] as const)('advances keyboard expiry before the %s mutation path', operation => {
    const {room,input,command,setTime}=setup();
    if(operation==='touch'||operation==='release') room.claimExternal('mcp');
    room.setHumanInput('a',input(1,{x:1,y:0}));
    const semantic={...command({type:'cancel'}),ttl_ms:2000};setTime(1000);
    if(operation==='submit') room.submit(semantic);
    if(operation==='claim') room.claimExternal('mcp');
    if(operation==='touch') room.touchExternal('mcp');
    if(operation==='release') room.releaseExternal('mcp');
    if(operation==='takeover') room.takeover('ai');
    if(operation==='demo') room.setDemoEnabled(true);
    if(operation==='close') room.close();
    expect(room.getSnapshot().seats.human).toMatchObject({position:{x:308,y:320},active_action:null});
    expect(room.observe('human').events).toContainEqual(expect.objectContaining({type:'action_cancelled',seat_id:'human',at_ms:300}));
  });

  it('advances two human seat leases through their individual expiry times', () => {
    const {room,input,setTime,tick}=setup();room.takeover('ai');
    room.setHumanInput('a',input(1,{x:1,y:0}));
    setTime(100);room.setHumanInput('b',input(1,{x:-1,y:0},'ai'));tick(1000);
    expect(room.getSnapshot().seats.human.position).toEqual({x:308,y:320});
    expect(room.getSnapshot().seats.ai.position).toEqual({x:492,y:320});
    expect(room.observe('human').events.filter(event=>event.type==='action_cancelled').map(event=>event.at_ms)).toEqual([300,400]);
  });

  it('stops keyboard movement at receipt capacity on exact lease expiry', () => {
    const {room,input,command,tick} = setup();room.setHumanInput('a',input(1,{x:1,y:0}));
    const generation=room.getSnapshot().seats.human.generation;
    // Real rejected commands fill the finite receipt store without mutating the
    // movement, reproducing another controller exhausting it during this lease.
    for(let n=0;n<4095;n++) room.submit({...command({type:'cancel'}),state_version:0});
    tick(1000);
    expect(room.getSnapshot().seats.human).toMatchObject({position:{x:308,y:320},active_action:null,generation:generation+1,controller:'human'});
  },30000);
});
