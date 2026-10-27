import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { createRoom } from '../src/server/room';
import { createGameMcpServer } from '../src/mcp/server';
import { RULESET_ID } from '../src/shared/ruleset';
import type { Observation, StationId, InteractionOperation, GameCommand } from '../src/shared/contracts';

type View = { observation: Observation; task_keys: Record<StationId, string>; control_token?: string; reason?: string; receipts?: Array<{status:string}> };
const cleanup: Array<() => Promise<void>> = [];
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.useRealTimers(); });

async function setup() {
  let now = 0, sequence = 0, moving = false;
  const room = createRoom(() => now); room.setDemoEnabled(false); room.startRound();
  const disconnect = new AbortController();
  const connect = async (id: string) => {
    const server = createGameMcpServer(room, id, () => disconnect.signal);
    const client = new Client({ name: id, version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    cleanup.push(async () => { room.close(); await client.close(); await server.close(); });
    return client;
  };
  const client = await connect('task-owner');
  const call = async (name: string, args: Record<string, unknown> = {}, via = client) => {
    const reply = await via.callTool({ name, arguments: args }).catch(error => ({ structuredContent: { reason: String(error) }, isError: true }));
    return { reply, data: (reply.structuredContent ?? { reason: 'unavailable_tool' }) as unknown as View };
  };
  const joined = (await call('game_join', { ruleset_id: RULESET_ID })).data;
  const advance = async (ms: number) => {
    now += ms;
    if (moving) {
      const s = room.getSnapshot();
      expect(room.setHumanInput('live-human', { type: 'human_input', ruleset_id: RULESET_ID, seat_id: 'human',
        seat_generation: s.seats.human.generation, round_id: s.round_id, sequence: ++sequence,
        direction: { x: sequence % 2 ? 1 : -1, y: 0 } }).status).toBe('accepted');
    }
    room.tick(); await vi.advanceTimersByTimeAsync(ms);
  };
  const settle = async <T>(promise: Promise<T>, budgetMs = 12000) => {
    let done = false; void promise.then(() => { done = true; }, () => { done = true; });
    for (let n = 0; n < budgetMs/50 && !done; n++) await advance(50);
    expect(done, 'selected work should settle within its simulated budget').toBe(true);
    return promise;
  };
  const args = (view: View, target: StationId, operation: InteractionOperation) => ({
    ruleset_id: RULESET_ID, control_token: joined.control_token,
    round_id: view.observation.snapshot.round_id, seat_generation: view.observation.snapshot.seats.ai.generation,
    state_version: view.observation.snapshot.state_version, issued_at_ms: view.observation.server_time_ms, ttl_ms: 10000,
    target, operation, expected_key: view.task_keys?.[target] ?? '0'.repeat(64),
  });
  const submit = (action: GameCommand['action']) => {
    const s = room.getSnapshot();
    expect(room.submit({ action_id: `human-${++sequence}`, seat_id: 'human', seat_generation: s.seats.human.generation,
      state_version: s.state_version, issued_at_ms: now, ttl_ms: 1000, action })).toMatchObject({ receipt: { status: 'accepted' } });
  };
  return { room, call, joined, advance, settle, args, submit, connect, disconnect, moveHuman: () => { moving = true; },
    jump: (ms:number) => { now+=ms; room.tick(); } };
}

function host(f: Awaited<ReturnType<typeof setup>>, view: View, clockOffset = 0) {
  const modulePath = fileURLToPath(new URL('./fixtures/game-host-runtime.mjs', import.meta.url));
  const functions = JSON.parse(execFileSync(process.execPath, [modulePath], {encoding:'utf8'})) as Record<string,string>;
  const memory = new Map<string,unknown>(Object.entries(functions));
  memory.set('playState', view); memory.set('playToken', f.joined.control_token);
  memory.set('playReceivedAt', view.observation.server_time_ms);
  memory.set('playContext', {round:view.observation.snapshot.round_id,generation:view.observation.snapshot.seats.ai.generation});
  const calls: Array<Record<string,unknown>> = [], waits: Array<Record<string,unknown>> = [], observations: View[] = [];
  type Notice = {event?:string;stopped?:string|null;target?:string;operation?:string};
  const notices: Notice[] = [];
  let onNotice: ((value: Notice) => void) | undefined;
  let onTaskReply: ((args:Record<string,unknown>,view:View) => Promise<void>) | undefined;
  let onWaitReply: (() => Promise<void>) | undefined;
  const context = createContext({
    load:(key:string) => memory.get(key), store:(key:string,value:unknown) => memory.set(key,value),
    Date:{now:() => f.room.getSnapshot().server_time_ms + clockOffset}, yield_control:async () => {},
    notify:(value:Notice) => { notices.push(value); onNotice?.(value); }, text:(value:Notice) => notices.push(value),
    tools:{
      game_join:async (args:Record<string,unknown>) => (await f.call('game_join',args)).reply,
      game_observe:async (args:Record<string,unknown>) => {
        expect(args).toEqual({control_token:f.joined.control_token,compact:true});
        const result = await f.call('game_observe', args); observations.push(result.data); return result.reply;
      },
      game_task:async (args:Record<string,unknown>) => {
        const {control_token: _token, ...safeArgs} = args;
        calls.push(safeArgs); const result=await f.call('game_task', args);
        await onTaskReply?.(safeArgs,result.data); return result.reply;
      },
      game_wait:async (args:Record<string,unknown>) => {
        const {control_token: _token, ...safeArgs} = args;
        waits.push(safeArgs); const result=await f.call('game_wait', args);
        await onWaitReply?.(); return result.reply;
      },
    },
  });
  return {memory,calls,waits,observations,notices,
    onNotice(callback: (value:Notice) => void) { onNotice = callback; },
    onTaskReply(callback: (args:Record<string,unknown>,view:View) => Promise<void>) { onTaskReply = callback; },
    onWaitReply(callback: () => Promise<void>) { onWaitReply = callback; },
    run:runInContext('('+functions.playRun+')',context) as (target:string,operation:string,guard:(s:Observation['snapshot'],now:number)=>boolean)=>Promise<unknown>,
    group:runInContext('('+functions.playGroup+')',context) as (input:unknown)=>Promise<void>,
    startup:runInContext('('+functions.playStartup+')',context) as ()=>Promise<void>,
  };
}

async function preparedServe(recipe: 'pumpkin_salad' | 'pumpkin_soup', soupStage: 'ready'|'cooking'|'human_cream'|'cooking_pumpkin' = 'ready') {
  const f = await setup(); let view = f.joined;
  const task = async (target: StationId, operation: InteractionOperation) => {
    const result = await f.settle(f.call('game_task', f.args(view,target,operation)));
    expect(result.data.reason).toBe('completed'); view = result.data;
  };
  await task('orders','accept_order');
  await task('source_pumpkin','source');
  const pumpkin = view.observation.snapshot.seats.ai.held_item_id!;
  await task('chop','chop'); await task('chop','take');
  if(soupStage==='cooking_pumpkin') {
    await f.advance(Math.max(0,12000-f.room.getSnapshot().server_time_ms));
    view=(await f.call('game_observe',{control_token:f.joined.control_token})).data;
    await task('orders','accept_order');
  }
  await task('burner_a','add_ingredient');
  if (recipe === 'pumpkin_salad') {
    await task('source_cucumber','source'); await task('chop','chop'); await task('chop','take');
    await task('counter_left','place'); await task('plates','take_plate'); await task('counter_left','add_ingredient');
  } else {
    if(soupStage!=='cooking_pumpkin')await f.advance(6000);
    view = (await f.call('game_observe',{control_token:f.joined.control_token})).data;
    if(soupStage!=='cooking_pumpkin')await task('orders','accept_order');
    if(soupStage==='human_cream'||soupStage==='cooking_pumpkin') {
      f.submit({type:'move_to',target:{x:176,y:350}}); await f.advance(2000);
      f.submit({type:'interact',target:'source_cream'});
    } else {
      await task('source_cream','source'); await task('burner_a','add_ingredient');
      if(soupStage==='ready')await f.advance(3000);
    }
    view = (await f.call('game_observe',{control_token:f.joined.control_token})).data;
  }
  const s = view.observation.snapshot, order = s.orders.find(o => o.phase === 'accepted' && o.recipe_id === recipe)!;
  expect(order).toBeDefined();
  return { f,view,task,input:{kind:'serve',round:s.round_id,generation:s.seats.ai.generation,
    burner:'burner_a',pot:s.slots.burner_a!,pumpkin,order:order.id,plate:s.seats.ai.held_item_id} };
}

async function preparedCream(cooked=false) {
  const f=await setup(); await f.settle(f.call('game_task',f.args(f.joined,'orders','accept_order')));
  f.submit({type:'move_to',target:{x:176,y:190}}); await f.advance(2000);f.submit({type:'interact',target:'source_pumpkin'});
  f.submit({type:'move_to',target:{x:194,y:366}}); await f.advance(2000);f.submit({type:'interact',target:'chop'});
  await f.advance(2000);f.submit({type:'interact',target:'chop'});
  const pumpkin=f.room.getSnapshot().seats.human.held_item_id!;
  await f.advance(Math.max(0,12000-f.room.getSnapshot().server_time_ms));
  let view=(await f.call('game_observe',{control_token:f.joined.control_token})).data;
  view=(await f.settle(f.call('game_task',f.args(view,'orders','accept_order')))).data;
  if(cooked) {
    f.submit({type:'move_to',target:{x:624,y:330}});await f.advance(4000);f.submit({type:'interact',target:'burner_b'});await f.advance(6000);
    view=(await f.call('game_observe',{control_token:f.joined.control_token})).data;
  }
  const s=view.observation.snapshot;
  return {f,view,input:{kind:'cream',round:s.round_id,generation:s.seats.ai.generation,pumpkin,
    order:s.orders.find(o=>o.phase==='accepted'&&o.recipe_id==='pumpkin_soup')!.id,finish:{kind:'serve'}}};
}

describe('one model-selected station task over MCP', () => {
  it('allows a newly selected cream flow when the existing cream is already contained in another soup pot',async()=>{
    const {f,view:before}=await preparedServe('pumpkin_soup');
    const otherPot=before.observation.snapshot.slots.burner_a!,original=before.observation.snapshot.items[otherPot];
    f.submit({type:'move_to',target:{x:176,y:190}});await f.advance(2000);f.submit({type:'interact',target:'source_pumpkin'});
    f.submit({type:'move_to',target:{x:194,y:366}});await f.advance(2000);f.submit({type:'interact',target:'chop'});
    await f.advance(2000);f.submit({type:'interact',target:'chop'});
    const view=(await f.call('game_observe',{control_token:f.joined.control_token})).data,s=view.observation.snapshot,h=host(f,view);
    const work=h.group({kind:'cream',round:s.round_id,generation:s.seats.ai.generation,
      pumpkin:s.seats.human.held_item_id,order:s.orders.find(o=>o.phase==='accepted'&&o.recipe_id==='pumpkin_soup')!.id,finish:{kind:'serve'}});
    await f.advance(50);f.submit({type:'move_to',target:{x:624,y:330}});await f.advance(4000);f.submit({type:'interact',target:'burner_b'});
    await f.settle(work,24000);
    expect(h.notices.at(-1)?.stopped).toBeNull();expect(h.calls).toHaveLength(5);
    expect(f.room.getSnapshot().score).toBe(1);expect(f.room.getSnapshot().items[otherPot]).toEqual(original);
  });

  it.each(['burner_a','burner_b'] as const)('sources its own cream while the human brings the selected chopped pumpkin to %s, then serves in five tasks', async burner=>{
    const {f,view,input}=await preparedCream(),h=host(f,view),work=h.group(input);
    await f.advance(50);f.submit({type:'move_to',target:{x:624,y:burner==='burner_a'?220:330}});
    await f.advance(4000);f.submit({type:'interact',target:burner});
    await f.settle(work,24000);
    expect(h.notices.at(-1)).toMatchObject({event:'group_done',stopped:null});
    expect(h.calls.map(a=>[a.target,a.operation])).toEqual([
      ['source_cream','source'],[burner,'add_ingredient'],['plates','take_plate'],[burner,'pour'],['delivery','deliver'],
    ]);
    expect(f.room.getSnapshot()).toMatchObject({score:1,revenue:40});
    expect(h.waits.length).toBeLessThanOrEqual(14);
  });

  it.each(['complete','legacy'] as const)('uses a fixed cooked pumpkin pot for %s cream work',async mode=>{
    const {f,view,input}=await preparedCream(true),h=host(f,view);
    await f.settle(h.group({...input,burner:'burner_b',pot:view.observation.snapshot.slots.burner_b,
      ...(mode==='legacy'?{finish:undefined}:{})}),24000);
    expect(h.notices.at(-1)?.stopped).toBeNull();expect(h.calls).toHaveLength(mode==='legacy'?2:5);
    expect(f.room.getSnapshot().score).toBe(mode==='legacy'?0:1);
    if(mode==='legacy')expect(h.waits).toEqual([]);
  });

  it.each(['timeout','late_reply','diverted','free_cream','source_race','human_bowl','takeover'] as const)('stops complete cream preparation on %s without adding cream',async mode=>{
    const {f,input}=await preparedCream(['free_cream','source_race','human_bowl'].includes(mode));
    if(mode==='free_cream'||mode==='source_race') {
      f.submit({type:'move_to',target:{x:176,y:350}});await f.advance(4000);
      if(mode==='free_cream')f.submit({type:'interact',target:'source_cream'});
    }
    if(mode==='human_bowl') {f.submit({type:'move_to',target:{x:354,y:366}});await f.advance(2500);}
    const view=(await f.call('game_observe',{control_token:f.joined.control_token})).data,h=host(f,view);
    if(mode==='late_reply')h.onWaitReply(async()=>{f.jump(8001);});
    if(mode==='human_bowl')h.onTaskReply(async(args,reply)=>{
      if(args.operation!=='source')return;
      f.submit({type:'interact',target:'plates'});
      const fresh=(await f.call('game_observe',{control_token:f.joined.control_token})).data;
      reply.observation=fresh.observation;reply.task_keys=fresh.task_keys;
    });
    const work=h.group(input);await f.advance(50);
    if(mode==='diverted') {
      f.submit({type:'move_to',target:{x:274,y:366}});await f.advance(1000);f.submit({type:'interact',target:'counter_left'});
    } else if(mode==='source_race')f.submit({type:'interact',target:'source_cream'});
    else if(mode==='takeover')f.room.takeover('ai');
    await f.settle(work);
    expect(h.notices.at(-1)?.stopped).toBeTruthy();expect(h.calls.filter(a=>a.operation!=='source')).toEqual([]);
    if(mode==='free_cream') {expect(h.calls).toEqual([]);expect(h.notices.at(-1)?.stopped).toBe('selected_intent_changed');}
    else expect(h.calls).toHaveLength(1);
    if(mode==='source_race')expect(h.notices.at(-1)?.stopped).toBe('target_changed');
    if(mode==='timeout'||mode==='late_reply')expect(h.notices.at(-1)?.stopped).toBe('pumpkin_ready_timeout');
    expect(h.waits.length).toBeLessThanOrEqual(6);
  });

  it.each(['after_source','after_add','invalid'] as const)('freezes the cream order pool before sourcing and keeps it through %s',async mode=>{
    const {f,input}=await preparedCream(true);
    await f.advance(43000-f.room.getSnapshot().server_time_ms);
    let view=(await f.call('game_observe',{control_token:f.joined.control_token})).data;
    view=(await f.settle(f.call('game_task',f.args(view,'orders','accept_order')))).data;
    const primary=view.observation.snapshot.orders.find(o=>o.id===input.order)!;
    const fallback=view.observation.snapshot.orders.find(o=>o.recipe_id==='pumpkin_soup'&&o.id!==input.order)!;
    const h=host(f,view);
    h.onTaskReply(async(args,reply)=>{
      if(args.operation!==(mode==='after_source'?'source':'add_ingredient'))return;
      f.jump(primary.delivery_deadline_ms!-f.room.getSnapshot().server_time_ms);
      const fresh=(await f.call('game_observe',{control_token:f.joined.control_token})).data;
      reply.observation=fresh.observation;reply.task_keys=fresh.task_keys;
    });
    await f.settle(h.group({...input,burner:'burner_b',pot:view.observation.snapshot.slots.burner_b,
      fallbackOrders:[mode==='invalid'?'unapproved':fallback.id]}),24000);
    if(mode==='invalid') {expect(h.notices.at(-1)?.stopped).toBeTruthy();expect(h.calls).toEqual([]);}
    else {
      expect(h.notices.at(-1)?.stopped).toBeNull();expect(h.calls).toHaveLength(5);expect(f.room.getSnapshot().score).toBe(1);
      expect(f.room.observe('ai').events.some(e=>e.type==='order_completed'&&e.order_id===fallback.id)).toBe(true);
    }
  });

  it.each(['human_cream','cooking_pumpkin','cooking','ready'] as const)('waits only for the selected soup from %s and then serves continuously', async stage => {
    const {f,view,input}=await preparedServe('pumpkin_soup',stage),s=view.observation.snapshot,h=host(f,view);
    const cream=Object.values(s.items).find(i=>i.kind==='ingredient'&&i.ingredient==='cream')!.id;
    const work=h.group({...input,waitForSoup:{cream}});
    if(stage==='cooking_pumpkin')expect(s.items[input.pot]).toMatchObject({phase:'cooking_pumpkin'});
    if(stage==='human_cream'||stage==='cooking_pumpkin') {
      await f.advance(50); f.submit({type:'move_to',target:{x:624,y:220}}); await f.advance(4000);
      f.submit({type:'interact',target:'burner_a'});
    }
    await f.settle(work);
    expect(h.notices.at(-1)).toMatchObject({event:'group_done',stopped:null});
    expect(h.calls.map(a=>[a.target,a.operation])).toEqual([['plates','take_plate'],['burner_a','pour'],['delivery','deliver']]);
    expect(f.room.getSnapshot()).toMatchObject({score:1,revenue:40});
    if(stage==='ready')expect(h.waits).toEqual([]);else expect(h.waits.length).toBeGreaterThan(0);
    expect(h.waits.length).toBeLessThanOrEqual(8);
    expect(h.waits.every(a=>!('action_id' in a)&&Number(a.timeout_ms)<=10000)).toBe(true);
  });

  it.each(['timeout','diverted','human_bowl','takeover','late_reply'] as const)('stops bounded soup readiness on %s without taking a bowl', async mode => {
    const stage=mode==='human_bowl'||mode==='late_reply'?'cooking':'human_cream';
    const {f,view,input}=await preparedServe('pumpkin_soup',stage),h=host(f,view);
    const cream=Object.values(view.observation.snapshot.items).find(i=>i.kind==='ingredient'&&i.ingredient==='cream')!.id;
    if(mode==='late_reply')h.onWaitReply(async()=>{f.jump(10001);});
    const work=h.group({...input,waitForSoup:{cream}}); await f.advance(50);
    if(mode==='diverted') {
      f.submit({type:'move_to',target:{x:274,y:366}}); await f.advance(1500);
      f.submit({type:'interact',target:'counter_left'});
    } else if(mode==='human_bowl') {
      f.submit({type:'move_to',target:{x:354,y:366}}); await f.advance(2000);
      f.submit({type:'interact',target:'plates'});
    } else if(mode==='takeover') f.room.takeover('ai');
    await f.settle(work);
    expect(h.notices.at(-1)?.stopped).toBeTruthy(); expect(h.calls).toEqual([]);
    expect(h.waits.length).toBeGreaterThan(0);expect(h.waits.length).toBeLessThanOrEqual(8);
    expect(f.room.getSnapshot().seats.ai.held_item_id).toBeNull();
    if(mode==='late_reply'||mode==='timeout')expect(h.notices.at(-1)?.stopped).toBe('soup_ready_timeout');
  });

  it.each(['after_plate','after_pour','removed_early','unknown_earlier','invalid_fallback','stale_delivery_key'] as const)('keeps soup order continuation inside the approved pool: %s', async mode => {
    const {f,input}=await preparedServe('pumpkin_soup');
    await f.advance(43000-f.room.getSnapshot().server_time_ms);
    let view=(await f.call('game_observe',{control_token:f.joined.control_token})).data;
    const accepted=await f.settle(f.call('game_task',f.args(view,'orders','accept_order')));
    expect(accepted.data.reason).toBe('completed');view=accepted.data;
    const orders=view.observation.snapshot.orders.filter(o=>o.phase==='accepted'&&o.recipe_id==='pumpkin_soup');
    expect(orders).toHaveLength(2);
    const primary=orders.find(o=>o.id===input.order)!,fallback=orders.find(o=>o.id!==input.order)!;
    const h=host(f,view);
    if(mode==='stale_delivery_key')h.onNotice(n=>{
      if(n.operation==='pour')f.jump(primary.delivery_deadline_ms!-f.room.getSnapshot().server_time_ms);
    });
    h.onTaskReply(async(args,reply)=>{
      if(mode==='stale_delivery_key')return;
      const boundary=mode==='after_plate'?'take_plate':'pour';
      if(args.operation!==boundary)return;
      if(mode==='removed_early') {
        reply.observation.snapshot.orders=reply.observation.snapshot.orders.filter(o=>o.id!==primary.id);
        return;
      }
      f.jump(primary.delivery_deadline_ms!-f.room.getSnapshot().server_time_ms);
      const fresh=(await f.call('game_observe',{control_token:f.joined.control_token})).data;
      reply.observation=fresh.observation;reply.task_keys=fresh.task_keys;
      if(mode==='unknown_earlier')reply.observation.snapshot.orders.push({...fallback,id:'unapproved-order',delivery_deadline_ms:fallback.delivery_deadline_ms!-1});
    });
    await f.settle(h.group({...input,fallbackOrders:[mode==='invalid_fallback'?'not-accepted':fallback.id]}));
    if(mode==='after_plate'||mode==='after_pour') {
      expect(h.notices.at(-1)).toMatchObject({event:'group_done',stopped:null});
      expect(h.calls.map(a=>a.operation)).toEqual(['take_plate','pour','deliver']);
      expect(f.room.getSnapshot().score).toBe(1);
      expect(f.room.observe('ai').events.some(e=>e.type==='order_completed'&&e.order_id===fallback.id)).toBe(true);
    } else {
      expect(h.notices.at(-1)?.stopped).toBeTruthy();expect(f.room.getSnapshot().score).toBe(0);
      expect(h.calls.filter(a=>a.operation==='deliver')).toEqual([]);
      if(mode==='invalid_fallback')expect(h.calls).toEqual([]);
    }
  });

  it('continues the same salad from an observed human pumpkin chop to its eventual burner without a new model choice', async () => {
    const f=await setup(); await f.settle(f.call('game_task',f.args(f.joined,'orders','accept_order')));
    f.submit({type:'move_to',target:{x:176,y:190}}); await f.advance(2000);
    f.submit({type:'interact',target:'source_pumpkin'});
    f.submit({type:'move_to',target:{x:194,y:366}}); await f.advance(2000);
    f.submit({type:'interact',target:'chop'});
    const view=(await f.call('game_observe',{control_token:f.joined.control_token})).data, s=view.observation.snapshot;
    const pumpkin=s.slots.chop!, action=s.seats.human.active_action!.action_id, h=host(f,view);
    let release!:()=>void, replyHeld=false;
    const delayedReply=new Promise<void>(resolve=>{release=resolve;});
    h.onTaskReply(async args=>{
      if(args.target==='chop'&&args.operation==='chop') {replyHeld=true; await delayedReply;}
    });
    const work=h.group({kind:'cut',ingredient:'cucumber',round:s.round_id,generation:s.seats.ai.generation,
      order:s.orders.find(o=>o.phase==='accepted')!.id,boardRelease:{item:pumpkin,action},
      finish:{kind:'plate',serve:{pumpkin}}});
    await f.advance(2100); f.submit({type:'interact',target:'chop'});
    f.submit({type:'move_to',target:{x:624,y:330}});
    await f.advance(3500); f.submit({type:'interact',target:'burner_b'});
    // One delayed transport reply allows the independently running human/cooking
    // timeline to advance; the host itself never waits for the pumpkin to cook.
    for(let n=0;n<100&&!replyHeld;n++)await f.advance(50);
    expect(replyHeld).toBe(true); await f.advance(6000); release();
    await f.settle(work);
    expect(h.notices.at(-1)).toMatchObject({event:'group_done',stopped:null});
    expect(h.calls.map(args=>[args.target,args.operation])).toEqual([
      ['source_cucumber','source'],['chop','chop'],['plates','take_plate'],['chop','add_ingredient'],['burner_b','pour'],['delivery','deliver'],
    ]);
    expect(f.room.getSnapshot()).toMatchObject({score:1,revenue:30});
    expect(f.room.getSnapshot().items[pumpkin]).toBeUndefined();
    expect(h.notices.filter(notice=>notice.event==='group_done')).toHaveLength(1);
  });

  it.each(['deliver','unavailable','missing','wrong_kind','expired','takeover'] as const)('continues the selected cucumber bowl through its exact pumpkin: %s', async mode => {
    const f = await setup(); let view = f.joined;
    const task = async (target:StationId, operation:InteractionOperation) => {
      const result = await f.settle(f.call('game_task',f.args(view,target,operation)));
      expect(result.data.reason).toBe('completed'); view = result.data;
    };
    await task('orders','accept_order'); await task('source_pumpkin','source');
    const pumpkin = view.observation.snapshot.seats.ai.held_item_id!;
    await task('chop','chop'); await task('chop','take'); await task('burner_b','add_ingredient');
    await f.advance(6000);
    if (mode === 'unavailable') {
      f.submit({type:'move_to',target:{x:624,y:330}}); await f.advance(3500);
      f.submit({type:'interact',target:'burner_b'});
    }
    view = (await f.call('game_observe',{control_token:f.joined.control_token})).data;
    const s = view.observation.snapshot, h = host(f,view);
    h.onNotice(notice => {
      if (notice.target !== 'chop' || notice.operation !== 'add_ingredient') return;
      if (mode === 'takeover') f.room.takeover('ai');
      if (mode === 'expired') {
        const cached = h.memory.get('playState') as View;
        const selected = cached.observation.snapshot.orders.find(o=>o.phase==='accepted'&&o.recipe_id==='pumpkin_salad')!;
        f.jump(selected.delivery_deadline_ms!-f.room.getSnapshot().server_time_ms);
      }
    });
    await f.settle(h.group({kind:'cut',ingredient:'cucumber',round:s.round_id,generation:s.seats.ai.generation,
      order:s.orders.find(o=>o.phase==='accepted')!.id,finish:{kind:'plate',serve:{pumpkin:mode==='missing'?'missing-pumpkin':mode==='wrong_kind'?s.slots.burner_a:pumpkin}}}));
    const after = f.room.getSnapshot();
    if (mode === 'deliver') {
      expect(h.notices.at(-1)).toMatchObject({event:'group_done',stopped:null});
      expect(h.calls.map(args=>[args.target,args.operation])).toEqual([
        ['source_cucumber','source'],['chop','chop'],['plates','take_plate'],['chop','add_ingredient'],['burner_b','pour'],['delivery','deliver'],
      ]);
      expect(after).toMatchObject({score:1,revenue:30}); expect(after.seats.ai.held_item_id).toBeNull();
      expect(h.notices.filter(n=>n.event==='group_done')).toHaveLength(1);
    } else {
      expect(h.notices.at(-1)?.stopped).toBeTruthy(); expect(after.score).toBe(0);
      expect(h.calls.filter(args=>args.operation==='deliver')).toEqual([]);
      if (mode !== 'takeover') expect(h.calls.filter(args=>args.operation==='pour')).toEqual([]);
      if (mode === 'missing'||mode === 'wrong_kind') expect(h.calls).toEqual([]);
      else {
        const bowl=after.items[after.seats.ai.held_item_id!];
        expect(bowl).toMatchObject({kind:'plate',recipe_id:null});
        if (bowl.kind!=='plate') throw Error('expected held bowl');
        expect(bowl.contents).not.toContain(pumpkin);
      }
      if (mode === 'takeover') {
        expect(after.seats.ai.controller).toBe('human');
        expect(h.notices.at(-1)?.stopped).toBe('control_lost');
      }
    }
    expect(h.waits).toEqual([]);
  });

  it('yields soup serving before taking a bowl when the human already carries one', async () => {
    const {f,input} = await preparedServe('pumpkin_soup');
    f.submit({type:'move_to',target:{x:354,y:366}}); await f.advance(4000);
    f.submit({type:'interact',target:'plates'});
    const view = (await f.call('game_observe',{control_token:f.joined.control_token})).data, h = host(f,view);
    await f.settle(h.group(input));
    expect(h.notices.at(-1)?.stopped).toBe('selected_intent_changed'); expect(h.calls).toEqual([]);
    expect(f.room.getSnapshot().seats.ai.held_item_id).toBeNull();
  });

  it.each(['walking','atomic'] as const)('stops duplicate bowl pickup when the human takes one at the %s boundary', async mode => {
    const {f,input} = await preparedServe('pumpkin_soup');
    f.submit({type:'move_to',target:{x:354,y:366}}); await f.advance(4000);
    const view = (await f.call('game_observe',{control_token:f.joined.control_token})).data, h = host(f,view);
    let raced = false;
    if (mode === 'atomic') {
      const original = f.room.submitExternalTaskAction;
      vi.spyOn(f.room,'submitExternalTaskAction').mockImplementation((session,intent,guard,token)=>{
        if (!raced&&intent.action.type==='interact'&&intent.action.target==='plates') {
          raced=true; f.submit({type:'interact',target:'plates'});
        }
        return original(session,intent,guard,token);
      });
    }
    const work = h.group(input); await f.advance(50);
    if (mode === 'walking') {
      expect(f.room.getSnapshot().seats.ai.active_action?.type).toBe('move_to');
      raced=true; f.submit({type:'interact',target:'plates'});
    }
    await f.settle(work);
    expect(raced).toBe(true); expect(h.notices.at(-1)?.stopped).toBe('target_changed');
    expect(h.calls.map(args=>args.operation)).toEqual(['take_plate']);
    const after=f.room.getSnapshot(); expect(after.seats.ai.held_item_id).toBeNull();
    expect(Object.values(after.items).filter(item=>item.kind==='plate')).toHaveLength(1);
    expect(after.items[after.seats.human.held_item_id!]).toMatchObject({kind:'plate'});
  });

  it('does not take an isolated empty plate merely because an order is accepted', async () => {
    const f = await setup(), view = (await f.settle(f.call('game_task',f.args(f.joined,'orders','accept_order')))).data;
    const h = host(f,view);
    await expect(f.settle(h.run('plates','take_plate',s=>s.orders.some(o=>o.phase==='accepted')))).rejects.toThrow('selected_intent_changed');
    expect(h.calls).toEqual([]); expect(f.room.getSnapshot().seats.ai.held_item_id).toBeNull();
  });

  it('cuts cucumber and collects that exact board item into one new plate in four tasks', async () => {
    const f = await setup(), view = (await f.settle(f.call('game_task',f.args(f.joined,'orders','accept_order')))).data;
    const s = view.observation.snapshot, h = host(f,view);
    await f.settle(h.group({kind:'cut',ingredient:'cucumber',round:s.round_id,generation:s.seats.ai.generation,
      order:s.orders.find(o=>o.phase==='accepted')!.id,finish:{kind:'plate'}}));
    expect(h.notices.at(-1)).toMatchObject({event:'group_done',stopped:null});
    expect(h.calls.map(args=>[args.target,args.operation])).toEqual([
      ['source_cucumber','source'],['chop','chop'],['plates','take_plate'],['chop','add_ingredient'],
    ]);
    const after = f.room.getSnapshot(), plate = after.items[after.seats.ai.held_item_id!];
    expect(plate).toMatchObject({kind:'plate',recipe_id:null});
    if (plate.kind !== 'plate') throw Error('expected plate');
    const cucumber = Object.values(after.items).filter(item=>item.kind==='ingredient'&&item.ingredient==='cucumber');
    expect(cucumber).toHaveLength(1); expect(plate.contents).toEqual([cucumber[0].id]);
    expect(cucumber[0]).toMatchObject({preparation:'chopped'}); expect(after.slots.chop).toBeNull();
    expect(h.waits).toEqual([]);
  });

  it.each(['released','budget','deadline','interrupted'] as const)('bounds the selected human board release: %s', async mode => {
    const f = await setup(), accepted = (await f.settle(f.call('game_task',f.args(f.joined,'orders','accept_order')))).data;
    const order = accepted.observation.snapshot.orders.find(o=>o.phase==='accepted')!;
    f.submit({type:'move_to',target:{x:176,y:190}}); await f.advance(2000); f.submit({type:'interact',target:'source_pumpkin'});
    f.submit({type:'move_to',target:{x:194,y:366}}); await f.advance(2000);
    if (mode === 'deadline') {
      await f.advance(20000); await f.call('game_observe',{control_token:f.joined.control_token});
      await f.advance(order.delivery_deadline_ms!-f.room.getSnapshot().server_time_ms-1800);
    }
    f.submit({type:'interact',target:'chop'});
    const view = (await f.call('game_observe',{control_token:f.joined.control_token})).data, s = view.observation.snapshot, h = host(f,view);
    const work = h.group({kind:'cut',ingredient:'cucumber',round:s.round_id,generation:s.seats.ai.generation,order:order.id,
      finish:{kind:'plate'},boardRelease:{item:s.slots.chop,action:s.seats.human.active_action!.action_id}});
    await f.advance(50);
    expect(h.calls[0]).toMatchObject({target:'source_cucumber',operation:'source'});
    expect(f.room.getSnapshot().seats.human.active_action?.type).toBe('chop');
    expect(f.room.getSnapshot().seats.ai.active_action?.type).toBe('move_to');
    if (mode === 'interrupted') f.submit({type:'cancel'});
    if (mode === 'released') {
      await f.advance(2100);
      expect(f.room.getSnapshot().items[s.slots.chop!]).toMatchObject({preparation:'chopped'});
      f.submit({type:'interact',target:'chop'});
    }
    await f.settle(work);
    const after = f.room.getSnapshot();
    if (mode === 'released') {
      expect(h.notices.at(-1)?.stopped).toBeNull(); expect(h.calls).toHaveLength(4);
      expect(after.items[after.seats.ai.held_item_id!]).toMatchObject({kind:'plate'});
      expect(after.seats.human.held_item_id).toBe(s.slots.chop);
    } else {
      expect(h.notices.at(-1)?.stopped).toBeTruthy(); expect(h.calls).toHaveLength(1);
      expect(after.items[after.seats.ai.held_item_id!]).toMatchObject({ingredient:'cucumber',preparation:'raw'});
      expect(after.slots.chop).toBe(s.slots.chop);
      expect(after.server_time_ms-s.server_time_ms).toBeLessThan(5000);
    }
    expect(h.waits.length).toBeLessThanOrEqual(6);
    if (mode !== 'interrupted') expect(h.waits.length).toBeGreaterThan(0);
    expect(h.waits.every(args=>!('action_id' in args)&&Number(args.timeout_ms)<=3000)).toBe(true);
  });

  it('stops bowl finishing if the human takes the exact cucumber while the AI walks for its plate', async () => {
    const f = await setup(); await f.settle(f.call('game_task',f.args(f.joined,'orders','accept_order')));
    f.submit({type:'move_to',target:{x:194,y:366}}); await f.advance(3000);
    const view = (await f.call('game_observe',{control_token:f.joined.control_token})).data, s = view.observation.snapshot, h = host(f,view);
    const work = h.group({kind:'cut',ingredient:'cucumber',round:s.round_id,generation:s.seats.ai.generation,
      order:s.orders.find(o=>o.phase==='accepted')!.id,finish:{kind:'plate'}});
    for (let n=0;n<120&&h.calls.length<3;n++) await f.advance(50);
    expect(h.calls[2]).toMatchObject({target:'plates',operation:'take_plate'});
    const cucumber = f.room.getSnapshot().slots.chop!;
    f.submit({type:'interact',target:'chop'});
    await f.settle(work);
    expect(h.notices.at(-1)?.stopped).toBeTruthy();
    const after = f.room.getSnapshot();
    expect(after.seats.human.held_item_id).toBe(cucumber);
    expect(Object.values(after.items).filter(item=>item.kind==='ingredient'&&item.ingredient==='cucumber')).toHaveLength(1);
    expect(Object.values(after.items).filter(item=>item.kind==='plate').every(item=>item.contents.length===0)).toBe(true);
    expect(f.room.observe('ai').events.some(e=>e.type==='item_transferred'&&e.seat_id==='ai'&&e.reason==='add_ingredient')).toBe(false);
  });

  it('cuts pumpkin and immediately adds the exact new item to the model-selected empty pot', async () => {
    const f = await setup(), view = (await f.settle(f.call('game_task',f.args(f.joined,'orders','accept_order')))).data;
    const s = view.observation.snapshot, h = host(f,view);
    await f.settle(h.group({kind:'cut',ingredient:'pumpkin',round:s.round_id,generation:s.seats.ai.generation,
      order:s.orders.find(o=>o.phase==='accepted')!.id,finish:{target:'burner_b',pot:s.slots.burner_b}}));
    expect(h.notices.at(-1)).toMatchObject({event:'group_done',stopped:null});
    expect(h.calls.map(args=>[args.target,args.operation])).toEqual([
      ['source_pumpkin','source'],['chop','chop'],['chop','take'],['burner_b','add_ingredient'],
    ]);
    const after = f.room.getSnapshot(), pot = after.items[s.slots.burner_b!];
    expect(pot).toMatchObject({kind:'pot',phase:'cooking_pumpkin'});
    if (pot.kind !== 'pot') throw Error('expected pot');
    expect(pot.contents).toHaveLength(1);
    expect(after.items[pot.contents[0]]).toMatchObject({ingredient:'pumpkin',preparation:'chopped'});
    expect(after.items[s.slots.burner_a!]).toMatchObject({phase:'empty',contents:[]});
    expect(after.seats.ai.held_item_id).toBeNull();
  });

  it('stops cut finishing when the selected pot is taken after chopping, without choosing another burner', async () => {
    const f = await setup(), accepted = (await f.settle(f.call('game_task',f.args(f.joined,'orders','accept_order')))).data;
    f.submit({type:'move_to',target:{x:624,y:220}}); await f.advance(4000);
    const view = (await f.call('game_observe',{control_token:f.joined.control_token})).data, s = view.observation.snapshot, h = host(f,view);
    h.onNotice(value => { if (value.target === 'chop' && value.operation === 'take') f.submit({type:'interact',target:'burner_a'}); });
    await f.settle(h.group({kind:'cut',ingredient:'pumpkin',round:s.round_id,generation:s.seats.ai.generation,
      order:accepted.observation.snapshot.orders.find(o=>o.phase==='accepted')!.id,finish:{target:'burner_a',pot:s.slots.burner_a}}));
    expect(h.notices.at(-1)?.stopped).toBeTruthy();
    // The last response predates the teammate's pickup: an attempted task may be
    // rejected by its existing atomic target key, but no interaction may occur.
    expect(h.calls.filter(args=>args.operation==='add_ingredient').every(args=>args.target==='burner_a')).toBe(true);
    expect(f.room.observe('ai').events.some(e=>e.type==='item_transferred'&&e.seat_id==='ai'&&e.reason==='add_ingredient')).toBe(false);
    expect(f.room.getSnapshot().items[s.slots.burner_b!]).toMatchObject({phase:'empty',contents:[]});
    expect(f.room.getSnapshot().seats.ai.held_item_id).not.toBeNull();
  });

  it.each(['hand','board'] as const)('does not source a default cut when the human already has that ingredient on the %s', async location => {
    const f = await setup(); await f.settle(f.call('game_task',f.args(f.joined,'orders','accept_order')));
    f.submit({type:'move_to',target:{x:176,y:270}}); await f.advance(2000);
    f.submit({type:'interact',target:'source_cucumber'});
    if (location === 'board') {
      f.submit({type:'move_to',target:{x:194,y:366}}); await f.advance(2000); f.submit({type:'interact',target:'chop'});
    }
    const view = (await f.call('game_observe',{control_token:f.joined.control_token})).data, s = view.observation.snapshot, h = host(f,view);
    await f.settle(h.group({kind:'cut',ingredient:'cucumber',round:s.round_id,generation:s.seats.ai.generation,
      order:s.orders.find(o=>o.phase==='accepted')!.id}));
    expect(h.notices.at(-1)?.stopped).toBe('selected_intent_changed');
    expect(h.calls).toEqual([]); expect(f.room.getSnapshot().seats.ai.held_item_id).toBeNull();
  });

  it.each(['exact','missing','duplicate','invalid'] as const)('requires an %s explicit existing-ingredient list before preparing another portion', async mode => {
    const f = await setup(); await f.settle(f.call('game_task',f.args(f.joined,'orders','accept_order')));
    f.submit({type:'move_to',target:{x:176,y:270}}); await f.advance(2000); f.submit({type:'interact',target:'source_cucumber'});
    const view = (await f.call('game_observe',{control_token:f.joined.control_token})).data, s = view.observation.snapshot, existing = s.seats.human.held_item_id!, h = host(f,view);
    const existingIngredients = mode === 'exact' ? [existing] : mode === 'missing' ? [] : mode === 'duplicate' ? [existing,existing] : [12];
    await f.settle(h.group({kind:'cut',ingredient:'cucumber',round:s.round_id,generation:s.seats.ai.generation,
      order:s.orders.find(o=>o.phase==='accepted')!.id,existingIngredients}));
    const after = f.room.getSnapshot();
    if (mode === 'exact') {
      expect(h.notices.at(-1)?.stopped).toBeNull(); expect(h.calls).toHaveLength(3);
      expect(after.seats.ai.held_item_id).not.toBe(existing);
      expect(after.items[after.seats.ai.held_item_id!]).toMatchObject({ingredient:'cucumber',preparation:'chopped'});
    } else { expect(h.notices.at(-1)?.stopped).toBeTruthy(); expect(h.calls).toEqual([]); }
    expect(after.seats.human.held_item_id).toBe(existing);
    expect(after.items[existing]).toMatchObject({ingredient:'cucumber',preparation:'raw'});
  });

  it.each(['cucumber','pumpkin'] as const)('handles a human sourcing %s during the AI cucumber walk without duplicate AI sourcing', async ingredient => {
    const f = await setup();
    f.submit({type:'move_to',target:{x:176,y:ingredient==='cucumber'?270:190}}); await f.advance(2000);
    const view = (await f.call('game_observe',{control_token:f.joined.control_token})).data;
    const work = f.call('game_task',f.args(view,'source_cucumber','source'));
    await f.advance(50);
    const ownMove = f.room.getSnapshot().seats.ai.active_action;
    expect(ownMove?.type).toBe('move_to');
    f.submit({type:'interact',target:ingredient==='cucumber'?'source_cucumber':'source_pumpkin'});
    const result = await f.settle(work), after = f.room.getSnapshot();
    if (ingredient === 'cucumber') {
      expect(result.data.reason).toBe('target_changed');
      expect(after.seats.ai).toMatchObject({held_item_id:null,active_action:null});
      expect(f.room.observe('ai').events.some(e=>e.type==='action_cancelled'&&e.action_id===ownMove!.action_id)).toBe(true);
      expect(f.room.observe('ai').events.some(e=>e.type==='item_transferred'&&e.seat_id==='ai'&&e.target==='source_cucumber')).toBe(false);
    } else {
      expect(result.data.reason).toBe('completed');
      expect(after.items[after.seats.ai.held_item_id!]).toMatchObject({ingredient:'cucumber'});
    }
  });

  it('returns existing accepted work on host startup without taking another pending order', async () => {
    const f = await setup(); await f.settle(f.call('game_task',f.args(f.joined,'orders','accept_order'))); await f.advance(12000);
    const view = (await f.call('game_observe',{control_token:f.joined.control_token})).data, h = host(f,view);
    expect(view.observation.snapshot.orders.some(o=>o.phase==='pending')).toBe(true);
    await f.settle(h.startup());
    expect(h.calls).toEqual([]);
    expect(f.room.getSnapshot().orders.filter(o=>o.phase==='accepted')).toHaveLength(1);
  });

  it('refreshes a thirteen-second-old host selection once and submits the exact observed server timestamp', async () => {
    const f = await setup(), h = host(f,f.joined);
    await f.advance(13000);
    await f.settle(h.run('source_cucumber','source',s => s.seats.ai.held_item_id === null));
    expect(h.observations).toHaveLength(1); expect(h.calls).toHaveLength(1);
    expect(h.calls[0].issued_at_ms).toBe(h.observations[0].observation.server_time_ms);
    expect(h.calls[0].expected_key).toBe(f.joined.task_keys.source_cucumber);
    expect(f.room.getSnapshot().seats.ai.held_item_id).not.toBeNull();
  });

  it('never manufactures a later server timestamp from host elapsed time', async () => {
    const f = await setup(), h = host(f,f.joined,250);
    await f.settle(h.run('source_cucumber','source',s => s.seats.ai.held_item_id === null));
    expect(h.observations).toHaveLength(0);
    expect(h.calls[0].issued_at_ms).toBe(f.joined.observation.server_time_ms);
  });

  it('stops a stale host selection after refresh changes the target, without submitting a replacement task', async () => {
    const f = await setup();
    f.submit({type:'move_to',target:{x:176,y:270}}); await f.advance(2000);
    f.submit({type:'interact',target:'source_cucumber'});
    f.submit({type:'move_to',target:{x:274,y:366}}); await f.advance(2000);
    f.submit({type:'interact',target:'counter_left'});
    const before = (await f.call('game_observe',{control_token:f.joined.control_token})).data, h = host(f,before);
    f.submit({type:'interact',target:'counter_left'}); await f.advance(13000);
    await expect(f.settle(h.run('counter_left','take',() => true))).rejects.toThrow('selected_intent_changed');
    expect(h.observations).toHaveLength(1); expect(h.calls).toEqual([]);
    expect(f.room.getSnapshot().seats.ai.active_action).toBeNull();
  });

  it.each(['pumpkin_salad','pumpkin_soup'] as const)('serves the selected %s through the real host group and room', async recipe => {
    const {f,view,input} = await preparedServe(recipe), h = host(f,view);
    await f.settle(h.group(input));
    expect(h.notices.at(-1)).toMatchObject({event:'group_done',stopped:null});
    expect(h.calls.map(args => [args.target,args.operation])).toEqual([
      ...(recipe === 'pumpkin_soup' ? [['plates','take_plate']] : []), ['burner_a','pour'], ['delivery','deliver'],
    ]);
    expect(f.room.getSnapshot().score).toBe(1);
    expect(f.room.observe('ai').events.some(event => event.type === 'order_completed' && event.order_id === input.order)).toBe(true);
    expect(f.room.getSnapshot().seats.ai.held_item_id).toBeNull();
  });

  it('stops serve when the teammate takes the selected pot before the next step', async () => {
    const {f,view,input} = await preparedServe('pumpkin_soup'), h = host(f,view);
    f.submit({type:'move_to',target:{x:624,y:220}}); await f.advance(4000);
    f.submit({type:'interact',target:'burner_a'});
    await f.settle(h.group(input));
    expect(h.notices.at(-1)).toMatchObject({event:'group_done',stopped:'selected_intent_changed'});
    expect(h.calls).toEqual([]); expect(f.room.getSnapshot().score).toBe(0);
  });

  it('does not deliver after the selected order expires during the walk to pour', async () => {
    const {f,view,input} = await preparedServe('pumpkin_salad');
    const deadline = view.observation.snapshot.orders.find(order => order.id === input.order)!.delivery_deadline_ms!;
    await f.advance(deadline - f.room.getSnapshot().server_time_ms - 300);
    const fresh = (await f.call('game_observe',{control_token:f.joined.control_token})).data, h = host(f,fresh);
    await f.settle(h.group(input));
    expect(h.calls.map(args => args.operation)).toEqual(['pour']);
    expect(h.notices.at(-1)?.stopped).toBe('selected_intent_changed');
    expect(f.room.getSnapshot().score).toBe(0);
    expect(f.room.getSnapshot().seats.ai.held_item_id).toBe(input.plate);
  });

  it.each([
    {target:'handoff_a',other:'handoff_b',point:{x:400,y:116}},
    {target:'handoff_b',other:'handoff_a',point:{x:400,y:324}},
  ] as const)('places and retakes the same item at the outer edge of $target', async ({target,other,point}) => {
    const f = await setup();
    f.submit({type:'move_to',target:{x:176,y:270}}); await f.advance(2000);
    f.submit({type:'interact',target:'source_cucumber'});
    const item = f.room.getSnapshot().seats.human.held_item_id!;
    f.submit({type:'move_to',target:point}); await f.advance(4000);
    expect(f.room.getSnapshot().seats.human.position).toEqual(point);
    expect(f.room.observe('human').interaction_previews[other]).toMatchObject({allowed:false,error:'OUT_OF_RANGE'});
    expect(f.room.observe('human').interaction_previews[target]).toMatchObject({allowed:true,operation:'place'});
    f.submit({type:'interact',target});
    expect(f.room.getSnapshot().slots[target]).toBe(item);
    expect(f.room.getSnapshot().seats.human.held_item_id).toBeNull();
    expect(f.room.observe('human').interaction_previews[target]).toMatchObject({allowed:true,operation:'take'});
    f.submit({type:'interact',target});
    expect(f.room.getSnapshot().seats.human.held_item_id).toBe(item);
    expect(f.room.getSnapshot().slots[target]).toBeNull();
    expect(f.room.getSnapshot().items[item]).toMatchObject({ingredient:'cucumber',preparation:'raw'});
  });

  it('runs the CLI host collect group against real MCP item semantics', async () => {
    const f = await setup();
    let view = f.joined;
    const task = async (target: StationId, operation: InteractionOperation) => {
      const result = await f.settle(f.call('game_task', f.args(view, target, operation)));
      expect(result.data.reason).toBe('completed');
      view = result.data;
    };
    await task('orders', 'accept_order');
    await task('source_cucumber', 'source');
    const cucumber = view.observation.snapshot.seats.ai.held_item_id!;
    await task('chop', 'chop');
    await task('chop', 'take');
    await task('counter_left', 'place');
    const snapshot = view.observation.snapshot;
    const order = snapshot.orders.find(o => o.phase === 'accepted' && o.recipe_id === 'pumpkin_salad')!;
    expect(snapshot.seats.ai.held_item_id).toBeNull();
    expect(snapshot.items[cucumber]).toMatchObject({ingredient:'cucumber',preparation:'chopped'});

    const modulePath = fileURLToPath(new URL('./fixtures/game-host-runtime.mjs', import.meta.url));
    const functions = JSON.parse(execFileSync(process.execPath, [modulePath], {encoding:'utf8'})) as Record<string,string>;
    const memory = new Map<string,unknown>(Object.entries(functions));
    memory.set('playState', view); memory.set('playToken', f.joined.control_token);
    memory.set('playReceivedAt', view.observation.server_time_ms);
    memory.set('playContext', {round:snapshot.round_id,generation:snapshot.seats.ai.generation});
    const calls: Array<[unknown,unknown]> = [], notices: Array<{event?:string;stopped?:string|null}> = [];
    let plate: string | null = null;
    const context = createContext({
      load:(key:string) => memory.get(key), store:(key:string,value:unknown) => memory.set(key,value),
      Date:{now:() => f.room.getSnapshot().server_time_ms}, yield_control:async () => {},
      notify:(value:{event?:string;stopped?:string|null}) => notices.push(value),
      tools:{game_task:async (args:Record<string,unknown>) => {
        calls.push([args.target,args.operation]);
        const result = await f.call('game_task', args);
        if (args.target === 'plates') plate = result.data.observation.snapshot.seats.ai.held_item_id;
        return result.reply;
      }},
    });
    const group = runInContext('('+functions.playGroup+')', context) as (input:unknown) => Promise<void>;
    await f.settle(group({round:snapshot.round_id,generation:snapshot.seats.ai.generation,
      kind:'collect',item:cucumber,target:'counter_left',place:'counter_right',order:order.id}));
    expect(notices.find(value => value.event === 'group_done')?.stopped).toBeNull();
    expect(calls).toEqual([['plates','take_plate'],['counter_left','add_ingredient'],['counter_right','place']]);
    const after = f.room.getSnapshot();
    expect(plate).not.toBeNull();
    expect(after.slots.counter_left).toBeNull();
    expect(after.slots.counter_right).toBe(plate);
    expect(after.items[plate!]).toMatchObject({kind:'plate',contents:[cucumber],recipe_id:null});
    expect(after.items[cucumber]).toMatchObject({ingredient:'cucumber',preparation:'chopped'});
    expect(after.seats.ai.held_item_id).toBeNull();
  });

  it('sources and chops while the human keeps moving, despite 4.3s old model state', async () => {
    const f = await setup(); f.moveHuman(); await f.advance(4300);
    expect(f.room.getSnapshot().state_version).toBeGreaterThan(f.joined.observation.snapshot.state_version);
    const source = await f.settle(f.call('game_task', f.args(f.joined, 'source_cucumber', 'source')));
    expect(source.data.reason).toBe('completed');
    expect(source.data.receipts?.map(r => r.status)).toEqual(['accepted', 'accepted']);
    const id = source.data.observation.snapshot.seats.ai.held_item_id!;
    expect(source.data.observation.snapshot.items[id]).toMatchObject({ ingredient: 'cucumber', preparation: 'raw' });
    const chopped = await f.settle(f.call('game_task', f.args(source.data, 'chop', 'chop')));
    expect(chopped.data.reason).toBe('completed');
    expect(chopped.data.observation.snapshot.items[id]).toMatchObject({ preparation: 'chopped' });
    expect(chopped.data.observation.snapshot.slots.chop).toBe(id);
    expect(chopped.data.observation.events).toEqual([]);
    expect(f.room.getSnapshot().seats.human.controller).toBe('human');
  });

  it('rejects a changed shared target before moving, even if the operation would still be take', async () => {
    const f = await setup();
    // The public engine fixtures are immutable snapshots: construct shared items through human actions.
    f.submit({ type: 'move_to', target: { x: 176, y: 270 } }); await f.advance(2000);
    f.submit({ type: 'interact', target: 'source_cucumber' });
    f.submit({ type: 'move_to', target: { x: 274, y: 366 } }); await f.advance(2000);
    f.submit({ type: 'interact', target: 'counter_left' });
    const before = (await f.call('game_observe', { control_token: f.joined.control_token })).data;
    f.submit({ type: 'interact', target: 'counter_left' });
    const result = await f.call('game_task', f.args(before, 'counter_left', 'take'));
    expect(result.data.reason).toBe('target_changed');
    expect(f.room.getSnapshot().seats.ai.active_action).toBeNull();
    expect(f.room.getSnapshot().seats.ai.held_item_id).toBeNull();
  });

  it('serializes tasks across transports without claiming another controller', async () => {
    const f = await setup(), second = await f.connect('second-transport');
    const first = f.call('game_task', f.args(f.joined, 'source_cucumber', 'source'));
    await f.advance(50);
    const busy = await f.call('game_task', f.args(f.joined, 'source_cucumber', 'source'), second);
    expect(busy.data.reason).toBe('busy');
    expect((await f.settle(first)).data.reason).toBe('completed');
    const denied = await f.call('game_task', { ...f.args(f.joined, 'source_cucumber', 'source'), control_token: 'wrong-owner' }, second);
    expect(denied.reply.isError).toBe(true);
  });

  it('cancels only its own walk when the selected item is taken during travel', async () => {
    const f = await setup();
    f.submit({ type: 'move_to', target: { x: 176, y: 270 } }); await f.advance(2000);
    f.submit({ type: 'interact', target: 'source_cucumber' });
    f.submit({ type: 'move_to', target: { x: 274, y: 366 } }); await f.advance(2000);
    f.submit({ type: 'interact', target: 'counter_left' });
    const before = (await f.call('game_observe', { control_token: f.joined.control_token })).data;
    const pending = f.call('game_task', f.args(before, 'counter_left', 'take'));
    await f.advance(50);
    f.submit({ type: 'interact', target: 'counter_left' });
    const result = await f.settle(pending);
    expect(result.data.reason).toBe('target_changed');
    expect(f.room.getSnapshot().seats.ai).toMatchObject({ held_item_id: null, active_action: null });
  });

  it('binds the contents and phase of the same pot, not only its item ID', async () => {
    const f = await setup();
    f.submit({ type: 'move_to', target: { x: 176, y: 190 } }); await f.advance(2000);
    f.submit({ type: 'interact', target: 'source_pumpkin' });
    f.submit({ type: 'move_to', target: { x: 194, y: 366 } }); await f.advance(2000);
    f.submit({ type: 'interact', target: 'chop' }); await f.advance(2000);
    f.submit({ type: 'interact', target: 'chop' });
    f.submit({ type: 'move_to', target: { x: 624, y: 220 } }); await f.advance(5000);
    f.submit({ type: 'interact', target: 'burner_a' });
    const before = (await f.call('game_observe', { control_token: f.joined.control_token })).data;
    await f.advance(6000);
    expect(f.room.getSnapshot().slots.burner_a).toBe(before.observation.snapshot.slots.burner_a);
    const result = await f.call('game_task', f.args(before, 'burner_a', 'pour'));
    expect(result.data.reason).toBe('target_changed');
    expect(f.room.getSnapshot().seats.ai.active_action).toBeNull();
  });

  it('aborts a disconnected task before any station interaction', async () => {
    const f = await setup();
    const pending = f.call('game_task', f.args(f.joined, 'source_cucumber', 'source'));
    await f.advance(50); f.disconnect.abort();
    const result = await f.settle(pending);
    expect(result.data.reason).toBe('aborted');
    expect(f.room.getSnapshot().seats.ai).toMatchObject({ held_item_id: null, active_action: null });
    expect(f.room.getSnapshot().items).toHaveProperty('r1-pot-a');
    expect(Object.values(f.room.getSnapshot().items).filter(item => item.kind === 'ingredient')).toEqual([]);
  });

  it.each(['takeover', 'finish'] as const)('stops on %s without automatically reclaiming or taking an ingredient', async mode => {
    const f = await setup();
    const pending = f.call('game_task', f.args(f.joined, 'source_cucumber', 'source'));
    await f.advance(50);
    if (mode === 'takeover') f.room.takeover('ai'); else await f.advance(90000);
    const result = await f.settle(pending);
    expect(result.data.reason).toBe(mode === 'takeover' ? 'control_lost' : 'round_finished');
    expect(f.room.getSnapshot().seats.ai.held_item_id).toBeNull();
    expect(f.room.getSnapshot().seats.ai.controller).toBe(mode === 'takeover' ? 'human' : 'external');
  });

  it.each(['expired', 'future_version', 'old_generation'] as const)('rejects %s task metadata before mutation', async mode => {
    const f = await setup(); const args = f.args(f.joined, 'source_cucumber', 'source');
    if (mode === 'expired') await f.advance(10000);
    if (mode === 'future_version') args.state_version += 100;
    if (mode === 'old_generation') args.seat_generation -= 1;
    const result = await f.call('game_task', args);
    expect(result.reply.isError).toBe(true);
    expect(result.data.reason).toBe(mode === 'expired' ? 'EXPIRED' : mode === 'future_version' ? 'STALE_STATE' : 'STALE_GENERATION');
    expect(f.room.getSnapshot().seats.ai.active_action).toBeNull();
    expect(f.room.getSnapshot().seats.ai.held_item_id).toBeNull();
  });

  it('offers explicit compact observations without changing legacy event history or command metadata', async () => {
    const f = await setup();
    for (let n = 0; n < 120; n++) f.submit({ type: 'move_to', target: f.room.getSnapshot().seats.human.position });
    const full = await f.call('game_observe', {}), compact = await f.call('game_observe', { compact: true });
    expect(compact.reply.isError).not.toBe(true);
    expect(full.data.observation.events.length).toBeGreaterThan(100);
    expect(compact.data.observation.events).toEqual([]);
    expect(compact.data.observation.snapshot).toEqual(full.data.observation.snapshot);
    expect(compact.data.observation.interaction_previews).toEqual(full.data.observation.interaction_previews);
    expect(compact.data.observation.events_cursor).toBe(full.data.observation.events_cursor);
    expect(compact.data.task_keys).toEqual(full.data.task_keys);
    expect(JSON.stringify(compact.reply).length).toBeLessThan(JSON.stringify(full.reply).length / 2);
    expect(f.room.observe('ai').events.length).toBe(full.data.observation.events.length);
  });
});
