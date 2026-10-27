import { describe, it, expect } from 'vitest';
import { createGame, observe, startRound } from '../src/game/engine';
import { WORLD } from '../src/game/world';
import type { ServerMessage } from '../src/shared/protocol';
import type { SeatId } from '../src/shared/contracts';
import { eventText, itemName, nearest, uiSnapshotKey } from '../src/client/ui-snapshot';

type SnapshotMessage = Extract<ServerMessage, { type: 'snapshot' }>;
function fixture(): SnapshotMessage {
  const state = startRound(createGame(1000), 1000), human = observe(state, 'human'), ai = observe(state, 'ai');
  const message: SnapshotMessage = {
    type: 'snapshot', snapshot: human.snapshot, events: [], events_cursor: 5,
    controller_status: { connected: false, waiting: false },
    interaction_previews: { human: human.interaction_previews, ai: ai.interaction_previews },
  };
  message.snapshot.seats.human.position = { ...WORLD.stations.orders.approach_points[0] };
  message.snapshot.seats.human.controller = 'human';
  message.snapshot.seats.ai.controller = 'demo';
  message.snapshot.seats.human.active_action = null;
  message.snapshot.seats.ai.active_action = null;
  message.snapshot.seats.ai.held_item_id = null;
  message.snapshot.items.food = { id: 'food', kind: 'ingredient', ingredient: 'pumpkin', preparation: 'raw', chop_remaining_ms: 0 };
  message.snapshot.seats.human.held_item_id = 'food';
  message.snapshot.orders = [
    { id: 'pending', recipe_id: 'pumpkin_salad', phase: 'pending', appeared_at_ms: 1000, pending_deadline_ms: 19000, delivery_deadline_ms: null },
    { id: 'accepted', recipe_id: 'pumpkin_soup', phase: 'accepted', appeared_at_ms: 1000, pending_deadline_ms: 19000, delivery_deadline_ms: 31000 },
  ];
  message.interaction_previews.human.orders = { target: 'orders', allowed: true, operation: 'accept_order' };
  message.events = [
    { id: 1, type: 'round_started', at_ms: 1000 },
    { id: 2, type: 'action_accepted', seat_id: 'human', at_ms: 1000 },
    { id: 3, type: 'kitchen_changed', seat_id: 'ai', at_ms: 1000 },
    { id: 4, type: 'item_transferred', at_ms: 1000 },
    { id: 5, type: 'order_accepted', seat_id: 'human', at_ms: 1000 },
  ];
  return message;
}
function changesKey(change: (message: SnapshotMessage) => void, selected: SeatId = 'human') {
  const original = fixture(), changed = structuredClone(original);
  change(changed);
  expect(uiSnapshotKey(changed, selected)).not.toBe(uiSnapshotKey(original, 'human'));
}

describe('visible kitchen UI projection', () => {
  it('ignores subsecond clock, pose, internal identifiers and identical rendered activity', () => {
    const original = fixture(), changed = structuredClone(original);
    changed.snapshot.server_time_ms += 100;
    changed.snapshot.state_version += 10;
    changed.snapshot.seats.human.position.x += 1;
    changed.snapshot.seats.ai.position.x += 1;
    changed.snapshot.seats.human.generation += 1;
    changed.snapshot.items.replacement = { ...changed.snapshot.items.food, id: 'replacement' };
    changed.snapshot.seats.human.held_item_id = 'replacement';
    delete changed.snapshot.items.food;
    changed.events_cursor += 100;
    changed.events = changed.events.map(event => ({ ...event, id: event.id + 100, at_ms: event.at_ms + 100, action_id: 'different' }));
    changed.events[0].type = 'round_finished';
    changed.events[1].type = 'action_completed';
    expect(uiSnapshotKey(changed, 'human')).toBe(uiSnapshotKey(original, 'human'));
  });

  it('updates for phase, round, displayed seconds, score and revenue', () => {
    for (const change of [
      (m: SnapshotMessage) => { m.snapshot.phase = 'finished'; },
      (m: SnapshotMessage) => { m.snapshot.round_id++; },
      (m: SnapshotMessage) => { m.snapshot.server_time_ms += 1000; },
      (m: SnapshotMessage) => { m.snapshot.round_ends_at_ms! += 1000; },
      (m: SnapshotMessage) => { m.snapshot.score++; },
      (m: SnapshotMessage) => { m.snapshot.revenue++; },
    ]) changesKey(change);
    const noDeadline = fixture(), fallback = structuredClone(noDeadline);
    noDeadline.snapshot.round_ends_at_ms = null;
    fallback.snapshot.round_ends_at_ms = fallback.snapshot.server_time_ms + 90000;
    expect(uiSnapshotKey(noDeadline, 'human')).toBe(uiSnapshotKey(fallback, 'human'));
  });

  it('tracks rendered order identity, recipe, phase and rounded active deadline', () => {
    for (const change of [
      (m: SnapshotMessage) => { m.snapshot.orders[0].id = 'new-order'; },
      (m: SnapshotMessage) => { m.snapshot.orders[0].recipe_id = 'pumpkin_soup'; },
      (m: SnapshotMessage) => { m.snapshot.orders[0].phase = 'accepted'; m.snapshot.orders[0].delivery_deadline_ms = 31000; },
      (m: SnapshotMessage) => { m.snapshot.orders[0].pending_deadline_ms += 1000; },
      (m: SnapshotMessage) => { m.snapshot.orders[1].delivery_deadline_ms! += 1000; },
    ]) changesKey(change);
    const original = fixture(), changed = structuredClone(original);
    changed.snapshot.orders[1].pending_deadline_ms += 9000;
    changed.snapshot.orders[0].delivery_deadline_ms = 90000;
    expect(uiSnapshotKey(changed, 'human')).toBe(uiSnapshotKey(original, 'human'));
  });

  it('tracks seat control, action type, held summary, controller status and selection', () => {
    for (const change of [
      (m: SnapshotMessage) => { m.snapshot.seats.human.controller = 'external'; },
      (m: SnapshotMessage) => { m.snapshot.seats.ai.controller = 'human'; },
      (m: SnapshotMessage) => { m.snapshot.seats.human.active_action = { type: 'move_to', action_id: 'walk', target: { x: 200, y: 100 }, path: [{ x: 200, y: 100 }] }; },
      (m: SnapshotMessage) => { m.snapshot.seats.ai.active_action = { type: 'chop', action_id: 'chop', target: 'chop', item_id: 'food' }; },
      (m: SnapshotMessage) => { m.snapshot.items.food = { id: 'food', kind: 'ingredient', ingredient: 'pumpkin', preparation: 'chopped', chop_remaining_ms: 0 }; },
      (m: SnapshotMessage) => { m.snapshot.items.food = { id: 'food', kind: 'pot', contents: [], phase: 'cooking_pumpkin', remaining_ms: 1100 }; },
      (m: SnapshotMessage) => { m.controller_status.connected = true; },
      (m: SnapshotMessage) => { m.controller_status.waiting = true; },
    ]) changesKey(change);
    changesKey(() => {}, 'ai');
  });

  it('updates when the selected reachable station or interaction preview changes', () => {
    for (const change of [
      (m: SnapshotMessage) => { m.snapshot.seats.human.position = { ...WORLD.stations.source_pumpkin.approach_points[0] }; },
      (m: SnapshotMessage) => { m.snapshot.seats.human.position = { x: 250, y: 150 }; },
      (m: SnapshotMessage) => { m.interaction_previews.human.orders.allowed = false; },
      (m: SnapshotMessage) => { m.interaction_previews.human.orders.operation = 'take'; },
      (m: SnapshotMessage) => { m.interaction_previews.human.orders.error = 'OUT_OF_RANGE'; },
    ]) changesKey(change);
  });

  it('preserves helper wording and tracks rendered recent activity roles and text', () => {
    const message = fixture();
    expect(nearest(message.snapshot, 'human')).toBe('orders');
    expect(nearest(undefined, 'human')).toBeNull();
    expect(itemName()).toBe('空手');
    expect(itemName(message.snapshot.items.food)).toBe('南瓜');
    expect(eventText('order_completed')).toBe('交付成功');
    expect(eventText('action_rejected')).toBe('动作更新');
    changesKey(m => { m.events[4].type = 'order_completed'; });
    changesKey(m => { m.events[4].seat_id = 'ai'; });
    changesKey(m => { m.events[3].seat_id = 'human'; });
  });
});
