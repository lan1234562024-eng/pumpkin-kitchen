import type { GameEvent, GameSnapshot, KitchenItem, SeatId, StationId } from '../shared/contracts';
import type { ServerMessage } from '../shared/protocol';
import { WORLD, STATION_IDS, RECIPES, distance } from '../game/world';
import { canReachTarget } from '../game/navigation';

export function itemName(item?: KitchenItem): string {
  if (!item) return '空手';
  if (item.kind === 'ingredient')
    return `${item.preparation === 'raw' ? '' : item.preparation === 'chopped' ? '切好的' : '熟'}${{ pumpkin: '南瓜', cucumber: '黄瓜', cream: '奶油' }[item.ingredient]}`;
  if (item.kind === 'plate')
    return item.recipe_id ? RECIPES[item.recipe_id].label : item.contents.length ? '装配中的碗' : '空碗';
  return item.phase === 'empty' ? '空锅' : item.phase === 'soup_ready' ? '一锅南瓜汤' : item.phase === 'cooked_pumpkin' ? '锅里的熟南瓜' : `南瓜锅 · ${Math.ceil(item.remaining_ms / 1000)}秒`;
}

export function stationLabel(id: StationId): string { return id === 'plates' ? '净碗' : WORLD.stations[id].label; }

export function nearest(snapshot: GameSnapshot | undefined, seat: SeatId): StationId | null {
  if (!snapshot) return null;
  const pos = snapshot.seats[seat].position;
  return STATION_IDS.filter(id => canReachTarget(pos, id)).sort((a, b) =>
    Math.min(...WORLD.stations[a].approach_points.map(p => distance(p, pos))) -
    Math.min(...WORLD.stations[b].approach_points.map(p => distance(p, pos))))[0] ?? null;
}

const eventLabels: Record<string, string> = {
  order_completed: '交付成功', order_accepted: '接到新单', order_expired: '订单到期',
  kitchen_changed: '制作完成', round_started: '开饭啦', round_finished: '打烊啦', item_transferred: '物品已转移',
};
export function eventText(type: GameEvent['type']): string { return eventLabels[type] ?? '动作更新'; }

/** Only values represented in the React UI; Phaser and command handlers keep the full snapshot. */
export function uiSnapshotKey(message: Extract<ServerMessage, { type: 'snapshot' }>, selected: SeatId): string {
  const s = message.snapshot, target = nearest(s, selected);
  const preview = target ? message.interaction_previews[selected][target] : undefined;
  const pending = s.orders.filter(order => order.phase === 'pending'), accepted = s.orders.filter(order => order.phase === 'accepted');
  return JSON.stringify([
    s.phase, s.round_id, s.score, s.revenue,
    s.round_ends_at_ms ? Math.max(0, Math.ceil((s.round_ends_at_ms - s.server_time_ms) / 1000)) : 90,
    [...accepted, ...pending].map(order => [
      order.id, order.recipe_id, order.phase,
      Math.max(0, Math.ceil(((order.phase === 'accepted' ? order.delivery_deadline_ms! : order.pending_deadline_ms) - s.server_time_ms) / 1000)),
    ]),
    (['human', 'ai'] as const).map(id => {
      const seat = s.seats[id];
      return [seat.controller, seat.active_action?.type ?? null, itemName(seat.held_item_id ? s.items[seat.held_item_id] : undefined)];
    }),
    message.controller_status.connected, message.controller_status.waiting, selected, target,
    preview ? [preview.allowed, preview.operation, preview.error ?? null] : null,
    message.events.slice(-4).reverse().map(event => [
      event.seat_id === 'human' ? '玩家' : event.seat_id === 'ai' ? '队友' : '厨房', eventText(event.type),
    ]),
  ]);
}

