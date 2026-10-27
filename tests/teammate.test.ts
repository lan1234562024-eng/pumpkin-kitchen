import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRoom } from '../src/server/room';
import { createGameMcpServer } from '../src/mcp/server';
import { TeammateController, compactObservation, taskIntentKey } from '../src/mcp/teammate';
import { approachFor } from '../src/game/navigation';
import type { GameCommand, SeatId, StationId } from '../src/shared/contracts';

type ToolRequest = Parameters<Client['callTool']>[0];
const cleanup: Array<() => Promise<void>> = [];

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.useRealTimers();
});

async function setup() {
  let now = 0;
  let sequence = 0;
  const room = createRoom(() => now);
  room.setDemoEnabled(false);
  room.startRound();
  const server = createGameMcpServer(room, 'teammate-test');
  const client = new Client({ name: 'teammate-integration-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanup.push(async () => { room.close(); await client.close(); await server.close(); });

  const calls: ToolRequest[] = [];
  let beforeCall: ((request: ToolRequest) => void | Promise<void>) | undefined;
  const forwardingClient: Pick<Client, 'callTool'> = {
    callTool: (async (...args: Parameters<Client['callTool']>) => {
      calls.push(structuredClone(args[0]));
      await beforeCall?.(args[0]);
      return client.callTool(...args);
    }) as Client['callTool'],
  };
  const controller = new TeammateController(forwardingClient);
  const advance = async (ms: number) => {
    now += ms;
    room.tick();
    await vi.advanceTimersByTimeAsync(ms);
  };
  const settle = async <T>(promise: Promise<T>): Promise<T> => {
    let done = false;
    void promise.then(() => { done = true; }, () => { done = true; });
    for (let n = 0; n < 200 && !done; n++) await advance(50);
    expect(done, 'semantic task should finish within ten simulated seconds').toBe(true);
    return promise;
  };
  const submit = (seat: SeatId, action: GameCommand['action']) => {
    const snapshot = room.getSnapshot();
    const command: GameCommand = {
      action_id: `fixture-${++sequence}`, seat_id: seat,
      seat_generation: snapshot.seats[seat].generation,
      state_version: snapshot.state_version, issued_at_ms: now, ttl_ms: 1000, action,
    };
    const result = room.submit(command);
    expect(result).toMatchObject({ receipt: { status: 'accepted' } });
    return command;
  };
  const station = async (target: StationId, seat: SeatId = 'human') => {
    const point = approachFor(room.getSnapshot().seats[seat].position, target);
    expect(point).not.toBeNull();
    submit(seat, { type: 'move_to', target: point! });
    for (let n = 0; n < 200 && room.getSnapshot().seats[seat].active_action; n++) await advance(50);
    expect(room.getSnapshot().seats[seat].active_action).toBeNull();
  };
  return {
    room, controller, calls, advance, settle, submit, station,
    onCall(hook: typeof beforeCall) { beforeCall = hook; },
  };
}

function actions(calls: ToolRequest[]) {
  return calls.filter(call => call.name === 'game_act').map(call => call.arguments!.action as GameCommand['action']);
}

function cancellations(calls: ToolRequest[]) {
  return calls.filter(call => call.name === 'game_cancel' || (call.name === 'game_act' && (call.arguments?.action as GameCommand['action'])?.type === 'cancel'));
}

describe('model-selected semantic teammate tasks through the standard MCP SDK', () => {
  it('binds human bowl identity and contents for empty-handed plate pickup, ignoring movement, timers and other held items', async () => {
    const f=await setup(), observation=await f.controller.join(), s=observation.snapshot;
    const baseline=taskIntentKey(observation,'plates');
    s.seats.human.position.x+=10; s.server_time_ms+=1000;
    s.items.food={id:'food',kind:'ingredient',ingredient:'pumpkin',preparation:'raw',chop_remaining_ms:2000};
    s.seats.human.held_item_id='food';
    expect(taskIntentKey(observation,'plates')).toBe(baseline);
    s.items.food.chop_remaining_ms=10;
    expect(taskIntentKey(observation,'plates')).toBe(baseline);
    s.items.bowl={id:'bowl',kind:'plate',recipe_id:null,contents:[]}; s.seats.human.held_item_id='bowl';
    const held=taskIntentKey(observation,'plates'); expect(held).not.toBe(baseline);
    s.items.bowl.contents=['food'];
    expect(taskIntentKey(observation,'plates')).not.toBe(held);
    s.seats.ai.held_item_id='bowl'; const returning=taskIntentKey(observation,'plates');
    s.seats.human.held_item_id=null;
    expect(taskIntentKey(observation,'plates')).toBe(returning);
  });

  it.each(['unrelated_order', 'selected_order_expiry'] as const)('handles %s while carrying a completed salad to delivery', async change => {
    const f = await setup();
    await f.station('orders');
    f.submit('human', { type: 'interact', target: 'orders' });
    const selected = f.room.getSnapshot().orders.find(order => order.phase === 'accepted')!;
    const interact = async (target: StationId) => {
      await f.station(target);
      f.submit('human', { type: 'interact', target });
    };
    await interact('source_pumpkin');
    await interact('chop'); await f.advance(2000);
    f.submit('human', { type: 'interact', target: 'chop' });
    await interact('burner_a'); await f.advance(6000);
    await interact('plates'); await interact('burner_a'); await interact('counter_right');
    await interact('source_cucumber'); await interact('chop'); await f.advance(1500);
    f.submit('human', { type: 'interact', target: 'chop' });
    await interact('counter_right');
    f.submit('human', { type: 'interact', target: 'counter_right' });
    await interact('handoff_b');
    const plate = f.room.getSnapshot().slots.handoff_b!;
    expect(f.room.getSnapshot().items[plate]).toMatchObject({ recipe_id: 'pumpkin_salad' });
    f.room.takeover('ai');
    await f.station('handoff_b', 'ai');
    f.submit('ai', { type: 'interact', target: 'handoff_b' });
    f.room.setDemoEnabled(false);
    const start = change === 'unrelated_order' ? 35900 : selected.delivery_deadline_ms! - 800;
    expect(f.room.getSnapshot().server_time_ms).toBeLessThan(start);
    await f.advance(start - f.room.getSnapshot().server_time_ms);
    const before = await f.controller.join();
    const result = await f.settle(f.controller.perform('delivery', 'deliver'));
    if (change === 'unrelated_order') {
      expect(result.reason).toBe('completed');
      expect(f.room.getSnapshot()).toMatchObject({ score: 1, revenue: 30 });
      expect(f.room.getSnapshot().seats.ai.held_item_id).toBeNull();
      expect(result.observation.events.some(event => event.type === 'order_completed' && event.order_id === selected.id)).toBe(true);
      expect(result.observation.events.some(event => event.type === 'order_created' && event.at_ms > before.server_time_ms)).toBe(true);
      expect(cancellations(f.calls)).toEqual([]);
    } else {
      expect(result.reason).toBe('target_changed');
      expect(f.room.getSnapshot().score).toBe(0);
      expect(f.room.getSnapshot().seats.ai.held_item_id).toBe(plate);
      expect(actions(f.calls).filter(action => action.type === 'interact')).toEqual([]);
    }
  });

  it('accepts the selected pending order when an unrelated order appears during the walk', async () => {
    const f = await setup();
    await f.advance(11000);
    const initial = await f.controller.join();
    const selected = initial.snapshot.orders[0].id;
    const result = await f.settle(f.controller.perform('orders', 'accept_order'));
    expect(result.reason).toBe('completed');
    expect(result.observation.snapshot.orders.find(order => order.id === selected)?.phase).toBe('accepted');
    expect(result.observation.snapshot.orders.some(order => order.id !== selected && order.phase === 'pending')).toBe(true);
    expect(cancellations(f.calls)).toEqual([]);
  });

  it('stops instead of accepting a replacement when the selected pending order expires', async () => {
    const f = await setup();
    await f.advance(17000);
    await f.controller.join();
    const result = await f.settle(f.controller.perform('orders', 'accept_order'));
    expect(result.reason).toBe('target_changed');
    expect(result.observation.snapshot.orders.every(order => order.phase === 'pending')).toBe(true);
    expect(actions(f.calls).filter(action => action.type === 'interact')).toEqual([]);
  });

  it('binds delivery to the matching earliest accepted order, not unrelated orders', async () => {
    const f = await setup();
    const observation = await f.controller.join();
    const s = observation.snapshot;
    s.items.plate = { id: 'plate', kind: 'plate', contents: [], recipe_id: 'pumpkin_salad' };
    s.seats.ai.held_item_id = 'plate';
    s.orders = [
      { id: 'chosen', recipe_id: 'pumpkin_salad', phase: 'accepted', appeared_at_ms: 0, pending_deadline_ms: 18000, delivery_deadline_ms: 40000 },
      { id: 'unrelated', recipe_id: 'pumpkin_soup', phase: 'pending', appeared_at_ms: 0, pending_deadline_ms: 18000, delivery_deadline_ms: null },
    ];
    const expected = taskIntentKey(observation, 'delivery');
    s.orders.pop();
    expect(taskIntentKey(observation, 'delivery')).toBe(expected);
    s.orders.push({ id: 'later', recipe_id: 'pumpkin_salad', phase: 'accepted', appeared_at_ms: 0, pending_deadline_ms: 18000, delivery_deadline_ms: 50000 });
    expect(taskIntentKey(observation, 'delivery')).toBe(expected);
    s.orders[1].delivery_deadline_ms = 39000;
    expect(taskIntentKey(observation, 'delivery')).not.toBe(expected);
    s.orders[1].delivery_deadline_ms = 40000;
    s.orders[1].id = 'a-tie-breaker';
    expect(taskIntentKey(observation, 'delivery')).not.toBe(expected);
    s.orders.pop();
    s.orders[0].delivery_deadline_ms = 39999;
    expect(taskIntentKey(observation, 'delivery')).not.toBe(expected);
    s.orders[0].delivery_deadline_ms = 40000;
    s.server_time_ms = 40000;
    expect(taskIntentKey(observation, 'delivery')).not.toBe(expected);
    s.server_time_ms = 0;
    s.orders = [];
    expect(taskIntentKey(observation, 'delivery')).not.toBe(expected);
  });

  it('binds acceptance to the first pending order and capacity availability', async () => {
    const f = await setup();
    const observation = await f.controller.join();
    const s = observation.snapshot;
    const selected = s.orders[0];
    const expected = taskIntentKey(observation, 'orders');
    const accepted = { ...selected, id: 'accepted-1', phase: 'accepted' as const, delivery_deadline_ms: 40000 };
    s.orders.push(accepted);
    expect(taskIntentKey(observation, 'orders')).toBe(expected);
    s.orders.push({ ...accepted, id: 'accepted-2' });
    expect(taskIntentKey(observation, 'orders')).not.toBe(expected);
    s.orders.pop();
    s.orders.unshift({ ...selected, id: 'new-first' });
    expect(taskIntentKey(observation, 'orders')).not.toBe(expected);
  });

  it('takes one cucumber using only a move and one interaction', async () => {
    const f = await setup();
    await f.controller.join();
    const result = await f.settle(f.controller.perform('source_cucumber', 'source'));
    expect(result.reason).toBe('completed');
    expect(actions(f.calls)).toEqual([
      { type: 'move_to', target: expect.any(Object) },
      { type: 'interact', target: 'source_cucumber' },
    ]);
    expect(result.receipts).toHaveLength(2);
    expect(result.receipts.every(receipt => receipt.status === 'accepted')).toBe(true);
    const held = result.observation.snapshot.seats.ai.held_item_id;
    expect(held).not.toBeNull();
    expect(result.observation.snapshot.items[held!]).toMatchObject({ kind: 'ingredient', ingredient: 'cucumber', preparation: 'raw' });
    expect(f.calls.filter(call => call.name === 'game_wait').every(call => !call.arguments?.action_id && Number(call.arguments?.timeout_ms) <= 1000)).toBe(true);
    expect(f.calls.filter(call => call.name === 'game_join')).toHaveLength(1);
  });

  it('finishes the model-selected chopping task and leaves the same cucumber on the board', async () => {
    const f = await setup();
    await f.controller.join();
    const sourced = await f.settle(f.controller.perform('source_cucumber', 'source'));
    expect(sourced.reason).toBe('completed');
    const cucumberId = sourced.observation.snapshot.seats.ai.held_item_id;
    expect(cucumberId).not.toBeNull();

    const firstTaskCallCount = f.calls.length;
    const result = await f.settle(f.controller.perform('chop', 'chop'));
    const secondTaskCalls = f.calls.slice(firstTaskCallCount);
    expect(result.reason).toBe('completed');
    expect(result.observation.snapshot.slots.chop).toBe(cucumberId);
    expect(result.observation.snapshot.items[cucumberId!]).toMatchObject({
      kind: 'ingredient', ingredient: 'cucumber', preparation: 'chopped', chop_remaining_ms: 0,
    });
    expect(result.observation.snapshot.seats.ai).toMatchObject({ held_item_id: null, active_action: null });
    expect(actions(secondTaskCalls)).toEqual([
      { type: 'move_to', target: expect.any(Object) },
      { type: 'interact', target: 'chop' },
    ]);
    const interaction = secondTaskCalls.find(call => call.name === 'game_act' && (call.arguments?.action as GameCommand['action'])?.type === 'interact');
    expect(interaction?.arguments?.action_id).toEqual(expect.any(String));
    expect(secondTaskCalls.filter(call => call.name === 'game_wait' && call.arguments?.action_id === interaction?.arguments?.action_id).length).toBeGreaterThan(0);
    expect(f.room.getSnapshot().slots.chop).toBe(cucumberId);
    expect(f.room.getSnapshot().seats.ai.held_item_id).toBeNull();
  });

  it('cancels its own movement when the human takes the selected target item', async () => {
    const f = await setup();
    await f.station('source_cucumber');
    f.submit('human', { type: 'interact', target: 'source_cucumber' });
    await f.station('counter_left');
    f.submit('human', { type: 'interact', target: 'counter_left' });
    const targetItem = f.room.getSnapshot().slots.counter_left;
    await f.controller.join();
    let changed = false;
    f.onCall(request => {
      if (request.name !== 'game_wait' || changed) return;
      expect(f.room.getSnapshot().seats.ai.active_action?.type).toBe('move_to');
      changed = true;
      f.submit('human', { type: 'interact', target: 'counter_left' });
    });
    const result = await f.settle(f.controller.perform('counter_left', 'take'));
    expect(changed).toBe(true);
    expect(result.reason).toBe('target_changed');
    expect(actions(f.calls).filter(action => action.type === 'interact')).toEqual([]);
    expect(cancellations(f.calls)).toHaveLength(1);
    expect(f.room.getSnapshot().seats.ai.active_action).toBeNull();
    expect(f.room.getSnapshot().seats.human.held_item_id).toBe(targetItem);
    expect(f.room.getSnapshot().seats.ai.held_item_id).toBeNull();
  });

  it('reports a stale cancellation receipt without retrying or claiming the movement stopped', async () => {
    const f = await setup();
    await f.station('source_cucumber');
    f.submit('human', { type: 'interact', target: 'source_cucumber' });
    await f.station('counter_left');
    f.submit('human', { type: 'interact', target: 'counter_left' });
    await f.controller.join();
    let targetTaken = false;
    let cancellationRaced = false;
    f.onCall(request => {
      if (request.name === 'game_wait' && !targetTaken) {
        expect(f.room.getSnapshot().seats.ai.active_action?.type).toBe('move_to');
        targetTaken = true;
        f.submit('human', { type: 'interact', target: 'counter_left' });
      }
      if (cancellations([request]).length && !cancellationRaced) {
        cancellationRaced = true;
        f.submit('human', { type: 'move_to', target: { x: 300, y: 366 } });
      }
    });
    const result = await f.settle(f.controller.perform('counter_left', 'take'));
    expect(targetTaken).toBe(true);
    expect(cancellationRaced).toBe(true);
    expect(result.reason).toBe('cancel_rejected');
    expect(result.receipts[result.receipts.length - 1]).toMatchObject({ status: 'rejected', error: 'STALE_STATE' });
    expect(cancellations(f.calls)).toHaveLength(1);
    expect(actions(f.calls).filter(action => action.type === 'interact')).toEqual([]);
  });

  it('ignores an unrelated human move and completes its selected interaction', async () => {
    const f = await setup();
    await f.controller.join();
    let moved = false;
    f.onCall(request => {
      if (request.name !== 'game_wait' || moved) return;
      moved = true;
      f.submit('human', { type: 'move_to', target: { x: 280, y: 320 } });
    });
    const result = await f.settle(f.controller.perform('source_cucumber', 'source'));
    expect(moved).toBe(true);
    expect(result.reason).toBe('completed');
    expect(cancellations(f.calls)).toEqual([]);
    expect(actions(f.calls).filter(action => action.type === 'interact')).toEqual([{ type: 'interact', target: 'source_cucumber' }]);
    expect(f.room.getSnapshot().seats.human.position).toEqual({ x: 280, y: 320 });
  });

  it.each(['control_lost', 'round_finished'] as const)('blocks interaction after %s and never reclaims control', async reason => {
    const f = await setup();
    await f.controller.join();
    let interrupted = false;
    f.onCall(async request => {
      if (request.name !== 'game_wait' || interrupted) return;
      interrupted = true;
      if (reason === 'control_lost') f.room.takeover('ai');
      else await f.advance(90000);
    });
    const result = await f.settle(f.controller.perform('source_cucumber', 'source'));
    expect(interrupted).toBe(true);
    expect(result.reason).toBe(reason);
    expect(actions(f.calls).filter(action => action.type === 'interact')).toEqual([]);
    expect(cancellations(f.calls)).toEqual([]);
    expect(f.calls.filter(call => call.name === 'game_join')).toHaveLength(1);
    expect(f.room.getSnapshot().seats.ai.held_item_id).toBeNull();
    if (reason === 'control_lost') expect(f.room.getSnapshot().seats.ai.controller).toBe('human');
    else expect(f.room.getSnapshot().phase).toBe('finished');
  });

  it('rejects a mismatched expected operation without interacting', async () => {
    const f = await setup();
    await f.controller.join();
    const result = await f.settle(f.controller.perform('source_cucumber', 'take'));
    expect(result.reason).toBe('operation_changed');
    expect(actions(f.calls).filter(action => action.type === 'interact')).toEqual([]);
    expect(f.room.getSnapshot().seats.ai.held_item_id).toBeNull();
  });

  it('does not wait after an instantaneous interaction when already at its station', async () => {
    const f = await setup();
    f.room.takeover('ai');
    await f.station('source_cucumber', 'ai');
    f.room.setDemoEnabled(false);
    await f.controller.join();
    const result = await f.controller.perform('source_cucumber', 'source');
    expect(result.reason).toBe('completed');
    expect(actions(f.calls).filter(action => action.type === 'interact')).toEqual([{ type: 'interact', target: 'source_cucumber' }]);
    expect(f.calls.filter(call => call.name === 'game_wait')).toEqual([]);
    expect(result.observation.snapshot.seats.ai.active_action).toBeNull();
  });

  it('reobserves a target changed during model thinking and sends no move', async () => {
    const f = await setup();
    await f.station('source_cucumber');
    f.submit('human', { type: 'interact', target: 'source_cucumber' });
    await f.station('counter_left');
    f.submit('human', { type: 'interact', target: 'counter_left' });
    await f.controller.join();
    f.submit('human', { type: 'interact', target: 'counter_left' });
    const result = await f.controller.perform('counter_left', 'take');
    expect(result.reason).toBe('target_changed');
    expect(f.calls.filter(call => call.name === 'game_observe').length).toBeGreaterThan(0);
    expect(actions(f.calls)).toEqual([]);
    expect(cancellations(f.calls)).toEqual([]);
  });

  it('compacts the real observation while retaining human inventory, stations and orders', async () => {
    const f = await setup();
    await f.station('source_pumpkin');
    f.submit('human', { type: 'interact', target: 'source_pumpkin' });
    await f.advance(12000);
    const observation = await f.controller.join();
    const compact = JSON.stringify(compactObservation(observation));
    const original = JSON.stringify(observation);
    expect(compact.length).toBeLessThan(original.length * 0.75);
    expect(compact).toContain('human');
    expect(compact).toContain(observation.snapshot.seats.human.held_item_id!);
    expect(compact).toContain('pumpkin');
    expect(compact).toContain('source_cucumber');
    expect(compact).toContain('burner_a');
    expect(observation.snapshot.orders.length).toBeGreaterThan(0);
    expect(compact).toContain(observation.snapshot.orders[0].id);
    expect(compact).toContain(observation.snapshot.orders[0].recipe_id);
    expect(compact).not.toContain('control_token');
  });
});

