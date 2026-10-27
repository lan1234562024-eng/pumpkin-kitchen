import type { GameSnapshot, GameState, SeatId, StationId, KitchenItem, PotItem, PlateItem, IngredientItem, InteractionPreview, InteractionOperation, InteractionOutcome } from '../shared/contracts';
import { STATION_IDS, WORLD, KITCHEN_RULES } from './world';
import { emitEvent } from './events';
export function createKitchen(roundId: number) {
    const slots = Object.fromEntries(STATION_IDS.map(id => [id, null])) as Record<StationId, string | null>;
    const items: Record<string, KitchenItem> = {};
    for (const [target, suffix] of [['burner_a', 'a'], ['burner_b', 'b']] as const) {
        const id = `r${roundId}-pot-${suffix}`;
        items[id] = { id, kind: 'pot', contents: [], phase: 'empty', remaining_ms: 0 };
        slots[target] = id;
    }
    return { items, slots, item_sequence: 0 };
}
function heated(s: GameSnapshot, pot: PotItem) { return s.slots.burner_a === pot.id || s.slots.burner_b === pot.id; }
function syncHeat(s: GameSnapshot, pot: PotItem) {
    if (pot.phase === 'loaded_pumpkin' || pot.phase === 'cooking_pumpkin')
        pot.phase = heated(s, pot) ? 'cooking_pumpkin' : 'loaded_pumpkin';
    if (pot.phase === 'loaded_soup' || pot.phase === 'cooking_soup')
        pot.phase = heated(s, pot) ? 'cooking_soup' : 'loaded_soup';
}
function has(s: GameSnapshot, plate: PlateItem, ingredient: IngredientItem['ingredient']) { return plate.contents.some(id => (s.items[id] as IngredientItem).ingredient === ingredient); }
function canAdd(s: GameSnapshot, item: IngredientItem, container: PotItem | PlateItem) {
    if (container.kind === 'pot')
        return (container.phase === 'empty' && item.ingredient === 'pumpkin' && item.preparation === 'chopped') || (container.phase === 'cooked_pumpkin' && item.ingredient === 'cream');
    return container.recipe_id === null && container.contents.length < 2 && !has(s, container, item.ingredient) && ((item.ingredient === 'pumpkin' && item.preparation === 'cooked') || (item.ingredient === 'cucumber' && item.preparation === 'chopped'));
}
function canPour(s: GameSnapshot, pot: PotItem, plate: PlateItem) { return pot.phase === 'soup_ready' ? plate.contents.length === 0 : pot.phase === 'cooked_pumpkin' && plate.contents.length <= 1 && !has(s, plate, 'pumpkin') && (plate.contents.length === 0 || has(s, plate, 'cucumber')); }
function classify(s: GameSnapshot, plate: PlateItem) { plate.recipe_id = plate.contents.length === 2 && has(s, plate, 'pumpkin') ? (has(s, plate, 'cucumber') ? 'pumpkin_salad' : has(s, plate, 'cream') ? 'pumpkin_soup' : null) : null; }
function isChoppable(i: KitchenItem): i is IngredientItem { return i.kind === 'ingredient' && i.ingredient !== 'cream' && i.preparation !== 'cooked'; }
export function inspectKitchenInteraction(s: GameSnapshot, seatId: SeatId, target: StationId): InteractionPreview | null {
    if (target === 'orders' || target === 'delivery')
        return null;
    const yes = (operation: InteractionOperation): InteractionPreview => ({ target, allowed: true, operation });
    const no = (error: InteractionPreview['error'] = 'INVALID_INTERACTION'): InteractionPreview => ({ target, allowed: false, operation: 'unavailable', error });
    const seat = s.seats[seatId], held = seat.held_item_id ? s.items[seat.held_item_id] : undefined, placed = s.slots[target] ? s.items[s.slots[target]!] : undefined;
    if (seat.active_action)
        return no('SEAT_BUSY');
    if (target === 'chop' && Object.values(s.seats).some(p => p.active_action?.type === 'chop'))
        return no('SEAT_BUSY');
    if (target === 'cleanup')
        return held && (held.kind === 'ingredient' || held.contents.length > 0) ? yes('cleanup') : no();
    if (target === 'plates')
        return !held ? yes('take_plate') : held.kind === 'plate' && held.contents.length === 0 ? yes('return_plate') : no();
    if (!held) {
        if (placed)
            return target === 'chop' && isChoppable(placed) && placed.preparation === 'raw' ? yes('resume_chop') : yes('take');
        return WORLD.stations[target].kind === 'source' ? yes('source') : no();
    }
    if (placed) {
        if (held.kind === 'ingredient' && placed.kind !== 'ingredient' && canAdd(s, held, placed))
            return yes('add_ingredient');
        if (held.kind !== 'ingredient' && placed.kind === 'ingredient' && canAdd(s, placed, held))
            return yes('add_ingredient');
        if (held.kind === 'pot' && placed.kind === 'plate' && canPour(s, held, placed))
            return yes('pour');
        if (held.kind === 'plate' && placed.kind === 'pot' && canPour(s, placed, held))
            return yes('pour');
        return no();
    }
    const kind = WORLD.stations[target].kind;
    if (kind === 'burner')
        return held.kind === 'pot' ? yes('place') : no();
    if (kind === 'chop')
        return isChoppable(held) ? yes(held.preparation === 'raw' ? 'chop' : 'place') : no();
    return kind === 'counter' || kind === 'source' ? yes('place') : no();
}
export function applyKitchenInteraction(s: GameState, seatId: SeatId, target: StationId, actionId: string): InteractionOutcome {
    const preview = inspectKitchenInteraction(s, seatId, target);
    if (!preview?.allowed)
        return { ok: false, error: preview?.error ?? 'INVALID_INTERACTION' };
    const seat = s.seats[seatId], held = seat.held_item_id ? s.items[seat.held_item_id] : undefined, placed = s.slots[target] ? s.items[s.slots[target]!] : undefined;
    const nextId = () => `r${s.round_id}-item-${++s.item_sequence}`;
    let started_chop = false;
    const startChop = (item: IngredientItem) => { seat.active_action = { type: 'chop', action_id: actionId, target, item_id: item.id }; started_chop = true; };
    switch (preview.operation) {
        case 'source': {
            const id = nextId();
            const ingredient = target.slice(7) as IngredientItem['ingredient'];
            s.items[id] = { id, kind: 'ingredient', ingredient, preparation: 'raw', chop_remaining_ms: ingredient === 'pumpkin' ? KITCHEN_RULES.chop_pumpkin_ms : ingredient === 'cucumber' ? KITCHEN_RULES.chop_cucumber_ms : 0 };
            seat.held_item_id = id;
            break;
        }
        case 'take':
            seat.held_item_id = placed!.id;
            s.slots[target] = null;
            if (placed!.kind === 'pot')
                syncHeat(s, placed as PotItem);
            break;
        case 'chop':
        case 'place':
            s.slots[target] = held!.id;
            seat.held_item_id = null;
            if (held!.kind === 'pot')
                syncHeat(s, held as PotItem);
            if (preview.operation === 'chop')
                startChop(held as IngredientItem);
            break;
        case 'resume_chop':
            startChop(placed as IngredientItem);
            break;
        case 'take_plate': {
            const id = nextId();
            s.items[id] = { id, kind: 'plate', contents: [], recipe_id: null };
            seat.held_item_id = id;
            break;
        }
        case 'return_plate':
            delete s.items[held!.id];
            seat.held_item_id = null;
            break;
        case 'cleanup':
            if (held!.kind === 'ingredient') {
                delete s.items[held!.id];
                seat.held_item_id = null;
            }
            else {
                for (const id of held!.contents)
                    delete s.items[id];
                held!.contents = [];
                if (held!.kind === 'pot') {
                    held!.phase = 'empty';
                    held!.remaining_ms = 0;
                }
                else
                    held!.recipe_id = null;
            }
            break;
        case 'add_ingredient': {
            const ingredient = (held!.kind === 'ingredient' ? held : placed) as IngredientItem;
            const container = (held!.kind === 'ingredient' ? placed : held) as PotItem | PlateItem;
            container.contents.push(ingredient.id);
            if (held!.kind === 'ingredient')
                seat.held_item_id = null;
            else
                s.slots[target] = null;
            if (container.kind === 'pot') {
                container.phase = container.phase === 'empty' ? 'loaded_pumpkin' : 'loaded_soup';
                container.remaining_ms = container.phase === 'loaded_pumpkin' ? KITCHEN_RULES.cook_pumpkin_ms : KITCHEN_RULES.simmer_soup_ms;
                syncHeat(s, container);
            }
            else
                classify(s, container);
            break;
        }
        case 'pour': {
            const pot = (held!.kind === 'pot' ? held : placed) as PotItem, plate = (held!.kind === 'plate' ? held : placed) as PlateItem;
            plate.contents.push(...pot.contents);
            pot.contents = [];
            pot.phase = 'empty';
            pot.remaining_ms = 0;
            classify(s, plate);
            break;
        }
    }
    s.state_version++;
    emitEvent(s, { type: 'item_transferred', seat_id: seatId, target, action_id: actionId, reason: preview.operation });
    return { ok: true, started_chop };
}
export function pauseChop(s: GameState, seatId: SeatId) { if (s.seats[seatId].active_action?.type === 'chop')
    s.seats[seatId].active_action = null; }
export function nextKitchenBoundary(s: GameState, fromMs: number) {
    const remaining: number[] = [];
    for (const seat of Object.values(s.seats))
        if (seat.active_action?.type === 'chop') {
            const item = s.items[seat.active_action.item_id] as IngredientItem;
            remaining.push(item.chop_remaining_ms);
        }
    for (const item of Object.values(s.items))
        if (item.kind === 'pot' && heated(s, item) && (item.phase === 'cooking_pumpkin' || item.phase === 'cooking_soup'))
            remaining.push(item.remaining_ms);
    return remaining.length ? fromMs + Math.min(...remaining) : null;
}
export function advanceKitchen(s: GameState, fromMs: number, toMs: number) {
    const delta = Math.max(0, toMs - fromMs);
    for (const seat of Object.values(s.seats)) {
        const action = seat.active_action;
        if (action?.type !== 'chop')
            continue;
        const item = s.items[action.item_id] as IngredientItem;
        const before = item.chop_remaining_ms;
        item.chop_remaining_ms = Math.max(0, before - delta);
        if (item.chop_remaining_ms <= 1e-7) {
            item.chop_remaining_ms = 0;
            item.preparation = 'chopped';
            seat.active_action = null;
            s.state_version++;
            emitEvent(s, { type: 'action_completed', seat_id: seat.id, action_id: action.action_id }, fromMs + before);
            emitEvent(s, { type: 'kitchen_changed', item_id: item.id, reason: 'chopped' }, fromMs + before);
        }
    }
    for (const item of Object.values(s.items)) {
        if (item.kind !== 'pot' || !heated(s, item) || (item.phase !== 'cooking_pumpkin' && item.phase !== 'cooking_soup'))
            continue;
        const before = item.remaining_ms;
        item.remaining_ms = Math.max(0, before - delta);
        if (item.remaining_ms <= 1e-7) {
            item.remaining_ms = 0;
            item.phase = item.phase === 'cooking_pumpkin' ? 'cooked_pumpkin' : 'soup_ready';
            for (const id of item.contents) {
                const food = s.items[id] as IngredientItem;
                if (food.ingredient === 'pumpkin')
                    food.preparation = 'cooked';
            }
            s.state_version++;
            emitEvent(s, { type: 'kitchen_changed', item_id: item.id, reason: item.phase }, fromMs + before);
        }
    }
}

