import type { GameState, SeatId, RecipeId } from '../shared/contracts';
import { KITCHEN_RULES as K, RECIPES } from './world';
import { emitEvent } from './events';
export type OrderSeed = Pick<GameState, 'orders' | 'order_sequence' | 'next_spawn_at_ms' | 'next_recipe' | 'score' | 'revenue'>;
export function createOrders(start: number, _end: number): OrderSeed { return { orders: [{ id: 'order-1', recipe_id: 'pumpkin_salad', phase: 'pending', appeared_at_ms: start, pending_deadline_ms: start + K.pending_ms, delivery_deadline_ms: null }], order_sequence: 1, next_spawn_at_ms: start + K.spawn_ms, next_recipe: 'pumpkin_soup', score: 0, revenue: 0 }; }
export function nextOrderBoundary(s: GameState, from: number) { const times = [...s.orders.map(o => o.phase === 'pending' ? o.pending_deadline_ms : o.delivery_deadline_ms!), s.next_spawn_at_ms].filter(t => t >= from); return times.length ? Math.min(...times) : null; }
export function advanceOrders(s: GameState, at: number) {
    s.orders = s.orders.filter(o => { const deadline = o.phase === 'pending' ? o.pending_deadline_ms : o.delivery_deadline_ms!; if (at < deadline)
        return true; if (o.phase === 'accepted')
        s.revenue = Math.max(0, s.revenue - RECIPES[o.recipe_id].penalty); s.state_version++; emitEvent(s, { type: 'order_expired', order_id: o.id, reason: o.phase }, deadline); return false; });
    if (at >= s.next_spawn_at_ms) {
        s.next_spawn_at_ms += K.spawn_ms;
        if (at >= s.round_ends_at_ms! || s.orders.filter(o => o.phase === 'pending').length >= K.order_cap)
            return;
        const other: RecipeId = s.next_recipe === 'pumpkin_salad' ? 'pumpkin_soup' : 'pumpkin_salad';
        const recipe = ([s.next_recipe, other] as RecipeId[]).find(r => s.round_ends_at_ms! - at >= K.pending_ms + RECIPES[r].minimum_ms);
        if (!recipe)
            return;
        const id = `order-${++s.order_sequence}`;
        s.orders.push({ id, recipe_id: recipe, phase: 'pending', appeared_at_ms: at, pending_deadline_ms: at + K.pending_ms, delivery_deadline_ms: null });
        s.next_recipe = recipe === 'pumpkin_salad' ? 'pumpkin_soup' : 'pumpkin_salad';
        s.state_version++;
        emitEvent(s, { type: 'order_created', order_id: id }, at);
    }
}
export function acceptOrder(s: GameState, at: number) {
    if (s.orders.filter(o => o.phase === 'accepted').length >= K.order_cap)
        return false;
    const o = s.orders.find(o => o.phase === 'pending' && at < o.pending_deadline_ms);
    if (!o || at >= s.round_ends_at_ms!)
        return false;
    o.phase = 'accepted';
    o.delivery_deadline_ms = Math.min(at + RECIPES[o.recipe_id].delivery_ms, s.round_ends_at_ms!);
    s.state_version++;
    emitEvent(s, { type: 'order_accepted', order_id: o.id }, at);
    return true;
}
export function deliverOrder(s: GameState, seat: SeatId, at: number) {
    const p = s.seats[seat], plate = p.held_item_id ? s.items[p.held_item_id] : undefined;
    if (plate?.kind !== 'plate' || !plate.recipe_id || at >= s.round_ends_at_ms!)
        return false;
    const o = s.orders.filter(o => o.phase === 'accepted' && o.recipe_id === plate.recipe_id && at < o.delivery_deadline_ms!).sort((a, b) => a.delivery_deadline_ms! - b.delivery_deadline_ms! || a.id.localeCompare(b.id))[0];
    if (!o)
        return false;
    s.orders = s.orders.filter(x => x.id !== o.id);
    for (const id of plate.contents)
        delete s.items[id];
    delete s.items[plate.id];
    p.held_item_id = null;
    s.score++;
    s.revenue += RECIPES[o.recipe_id].reward;
    s.state_version++;
    emitEvent(s, { type: 'order_completed', order_id: o.id, seat_id: seat, reason: o.recipe_id }, at);
    return true;
}

