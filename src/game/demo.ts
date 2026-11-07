import type { GameCommand, GameState, StationId, PotItem, PlateItem } from '../shared/contracts';
import { approachFor, canReachTarget } from './navigation';
import { inspectInteraction } from './engine';
import { inspectKitchenInteraction } from './kitchen';

/** A deterministic, visible demonstration; it obeys ordinary commands and timers. */
export function chooseDemoCommand(s: GameState, now: number): GameCommand | null {
    const p = s.seats.ai;
    if (s.phase !== 'playing' || p.controller !== 'demo' || p.active_action)
        return null;

    const held = p.held_item_id ? s.items[p.held_item_id] : undefined;
    const accepted = s.orders.find(o => o.phase === 'accepted');
    const recipe = accepted?.recipe_id ?? s.orders.find(o => o.phase === 'pending')?.recipe_id;
    const pots = (['burner_a', 'burner_b'] as const).map(target => ({
        target, item: s.slots[target] ? s.items[s.slots[target]!] as PotItem : null,
    }));
    const cooked = pots.find(x => x.item?.phase === 'cooked_pumpkin' || x.item?.phase === 'soup_ready');
    const cookedPumpkin = pots.find(x => x.item?.phase === 'cooked_pumpkin');
    const empty = pots.find(x => x.item?.phase === 'empty');
    const counters = ['counter_left', 'counter_right', 'handoff_a', 'handoff_b'] as const;
    const plateTargets = counters.filter(t => s.slots[t] && s.items[s.slots[t]!]?.kind === 'plate');
    const plateTarget = plateTargets[0];
    const plate = plateTarget ? s.items[s.slots[plateTarget]!] as PlateItem : undefined;
    const emptyCounter = counters.find(t => !s.slots[t]);
    const canUse = (t: StationId) => inspectKitchenInteraction(s, 'ai', t)?.allowed === true;
    const has = (bowl: PlateItem, ingredient: 'pumpkin' | 'cucumber') =>
        bowl.contents.some(id => {
            const item = s.items[id];
            return item?.kind === 'ingredient' && item.ingredient === ingredient;
        });
    const looseCucumber = ([...counters, 'chop'] as const).find(t => {
        const item = s.items[s.slots[t] ?? ''];
        return item?.kind === 'ingredient' && item.ingredient === 'cucumber' && item.preparation === 'chopped';
    });
    const readyPlate = plateTargets.find(t => {
        const item = s.items[s.slots[t]!] as PlateItem;
        return item.recipe_id && s.orders.some(o => o.phase === 'accepted' &&
            o.recipe_id === item.recipe_id && now < (o.delivery_deadline_ms ?? 0));
    });

    let target: StationId | undefined;
    if (held?.kind === 'plate') {
        if (held.recipe_id)
            target = s.orders.some(o => o.phase === 'accepted' && o.recipe_id === held.recipe_id &&
                now < (o.delivery_deadline_ms ?? 0)) ? 'delivery'
                : !accepted && s.orders.some(o => o.phase === 'pending') ? 'orders' : emptyCounter;
        else if (recipe === 'pumpkin_salad' && looseCucumber && !has(held, 'cucumber') && canUse(looseCucumber))
            target = looseCucumber;
        else {
            const pot = pots.find(x => x.item && canUse(x.target) &&
                (x.item.phase === 'soup_ready' || (recipe === 'pumpkin_salad' && x.item.phase === 'cooked_pumpkin')));
            target = pot?.target ?? emptyCounter ?? (held.contents.length === 0 ? 'plates' : undefined);
        }
    }
    else if (held?.kind === 'ingredient') {
        if (held.preparation === 'raw' && held.ingredient !== 'cream')
            target = 'chop';
        else if (held.ingredient === 'cream')
            target = cookedPumpkin?.target ?? emptyCounter;
        else if (held.ingredient === 'pumpkin')
            target = empty?.target ?? emptyCounter;
        else
            target = plateTargets.find(t => canUse(t)) ?? emptyCounter;
    }
    else if (held?.kind === 'pot')
        target = plateTargets.find(t => canUse(t)) ?? pots.find(x => !x.item)?.target ?? emptyCounter;
    else if (!accepted && s.orders.some(o => o.phase === 'pending'))
        target = 'orders';
    else if (readyPlate)
        target = readyPlate;
    else if (recipe === 'pumpkin_salad' && looseCucumber && !plateTarget)
        target = 'plates';
    else if (recipe === 'pumpkin_salad' && cookedPumpkin) {
        const cucumberPlate = plateTargets.find(t => has(s.items[s.slots[t]!] as PlateItem, 'cucumber'));
        if (cucumberPlate)
            target = cucumberPlate;
    }
    if (!target && !held) {
        if (plate?.contents.length === 1 && has(plate, 'pumpkin'))
            target = looseCucumber ? plateTarget : 'source_cucumber';
        else if (s.slots.chop && canUse('chop'))
            target = 'chop';
        else if (recipe === 'pumpkin_salad' && looseCucumber)
            target = plateTarget ?? 'plates';
        else if (cooked)
            target = recipe === 'pumpkin_soup' && cooked.item?.phase === 'cooked_pumpkin'
                ? 'source_cream' : plateTarget ?? 'plates';
        else if (empty && recipe && !pots.some(x => x.item && x.item.phase !== 'empty'))
            target = 'source_pumpkin';
    }

    // Don't walk across the kitchen toward a target that is already impossible to use.
    if (!target || (target !== 'orders' && target !== 'delivery' && !canUse(target)))
        return null;
    const near = canReachTarget(p.position, target), approach = approachFor(p.position, target);
    if (near && !inspectInteraction(s, 'ai', target).allowed)
        return null;
    if (!near && !approach)
        return null;
    return { action_id: 'demo-' + p.generation + '-' + s.state_version,
        seat_id: 'ai', seat_generation: p.generation, state_version: s.state_version,
        issued_at_ms: now, ttl_ms: 1000,
        action: near ? { type: 'interact', target } : { type: 'move_to', target: approach! } };
}
