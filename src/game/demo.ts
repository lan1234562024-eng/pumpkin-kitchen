import type { GameCommand, GameState, StationId, PotItem, PlateItem } from '../shared/contracts';
import { approachFor, canReachTarget } from './navigation';
import { inspectInteraction } from './engine';
/** A deterministic, visible demonstration; it obeys ordinary commands and timers. */
export function chooseDemoCommand(s: GameState, now: number): GameCommand | null {
    const p = s.seats.ai;
    if (s.phase !== 'playing' || p.controller !== 'demo' || p.active_action)
        return null;
    const held = p.held_item_id ? s.items[p.held_item_id] : undefined;
    const accepted = s.orders.find(o => o.phase === 'accepted'), recipe = accepted?.recipe_id ?? s.orders.find(o => o.phase === 'pending')?.recipe_id;
    const pots = (['burner_a', 'burner_b'] as const).map(target => ({ target, item: s.slots[target] ? s.items[s.slots[target]!] as PotItem : null }));
    const cooked = pots.find(x => x.item?.phase === 'cooked_pumpkin' || x.item?.phase === 'soup_ready');
    const empty = pots.find(x => x.item?.phase === 'empty');
    const plateTarget = (['counter_left', 'counter_right', 'handoff_a', 'handoff_b'] as const).find(t => s.slots[t] && s.items[s.slots[t]!].kind === 'plate');
    const plate = plateTarget ? s.items[s.slots[plateTarget]!] as PlateItem : undefined;
    let target: StationId | undefined;
    if (held?.kind === 'plate') {
        if (held.recipe_id)
            target = accepted ? 'delivery' : 'orders';
        else if (held.contents.length === 0 && cooked && (cooked.item?.phase === 'soup_ready' || recipe === 'pumpkin_salad'))
            target = cooked.target;
        else
            target = plateTarget ? undefined : 'counter_left';
    }
    else if (held?.kind === 'ingredient')
        target = held.preparation === 'raw' && held.ingredient !== 'cream' ? 'chop' : held.ingredient === 'cream' ? cooked?.target : held.ingredient === 'pumpkin' ? empty?.target : plateTarget;
    else if (!accepted && s.orders.some(o => o.phase === 'pending'))
        target = 'orders';
    else if (plate?.recipe_id)
        target = plateTarget;
    else if (s.slots.chop)
        target = 'chop';
    else if (plate && plate.contents.length === 1)
        target = 'source_cucumber';
    else if (cooked) {
        if (recipe === 'pumpkin_soup' && cooked.item?.phase === 'cooked_pumpkin')
            target = 'source_cream';
        else
            target = plateTarget ?? 'plates';
    }
    else if (empty && recipe && !pots.some(x => x.item && x.item.phase !== 'empty'))
        target = 'source_pumpkin';
    if (!target)
        return null;
    const near = canReachTarget(p.position, target), approach = approachFor(p.position, target);
    if (near && !inspectInteraction(s, 'ai', target).allowed)
        return null;
    if (!near && !approach)
        return null;
    return { action_id: `demo-${p.generation}-${s.state_version}`, seat_id: 'ai', seat_generation: p.generation, state_version: s.state_version, issued_at_ms: now, ttl_ms: 1000, action: near ? { type: 'interact', target } : { type: 'move_to', target: approach! } };
}

