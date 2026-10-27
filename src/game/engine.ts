import type { CommandReceipt, CommandResult, Controller, ErrorCode, GameCommand, GameSnapshot, GameState, Observation, SeatId, SeatState, SemanticAction, StationId, InteractionPreview } from '../shared/contracts';
import { distance, MOVEMENT_SPEED, RECEIPT_LIMIT, ROUND_DURATION_MS, STATION_IDS, WORLD, KITCHEN_RULES } from './world';
import { RULESET_ID } from '../shared/ruleset';
import { createKitchen, inspectKitchenInteraction, applyKitchenInteraction, nextKitchenBoundary, advanceKitchen } from './kitchen';
import { createOrders, nextOrderBoundary, advanceOrders, acceptOrder, deliverOrder } from './orders';
import { emitEvent } from './events';
import { routeTo, isWalkable, canReachTarget } from './navigation';
export type { GameState, GameSnapshot, GameCommand, CommandResult, Observation } from '../shared/contracts';
const SEATS: SeatId[] = ['human', 'ai'];
function validTime(now: number) { return Number.isFinite(now) && now >= 0; }
function clone(s: GameState): GameState { return { ...s, seats: structuredClone(s.seats), items: structuredClone(s.items), slots: { ...s.slots }, orders: structuredClone(s.orders), events: [...s.events], receipts: { ...s.receipts } }; }
function seat(id: SeatId): SeatState { return { id, position: { x: id === 'human' ? 260 : 540, y: 320 }, held_item_id: null, active_action: null, generation: 0, controller: id === 'human' ? 'human' : 'demo' }; }
export function createGame(nowMs: number): GameState { if (!validTime(nowMs))
    throw new RangeError('Invalid server time'); return { ruleset_id: RULESET_ID, phase: 'lobby', round_id: 0, state_version: 0, server_time_ms: nowMs, round_started_at_ms: null, round_ends_at_ms: null, ...createKitchen(0), ...createOrders(nowMs, nowMs + ROUND_DURATION_MS), orders: [], seats: { human: seat('human'), ai: seat('ai') }, receipts: {}, events: [], events_cursor: 0 }; }
export function startRound(state: GameState, nowMs: number): GameState {
    if (state.phase === 'playing' || !validTime(nowMs) || nowMs < state.server_time_ms)
        return state;
    const s = createGame(nowMs);
    s.round_id = state.round_id + 1;
    s.state_version = state.state_version + 1;
    s.phase = 'playing';
    s.round_started_at_ms = nowMs;
    s.round_ends_at_ms = nowMs + ROUND_DURATION_MS;
    Object.assign(s, createKitchen(s.round_id), createOrders(nowMs, s.round_ends_at_ms));
    s.events = [...state.events];
    s.events_cursor = state.events_cursor;
    for (const id of SEATS) {
        s.seats[id].generation = state.seats[id].generation + 1;
        s.seats[id].controller = state.seats[id].controller;
    }
    emitEvent(s, { type: 'round_started' });
    emitEvent(s, { type: 'order_created', order_id: s.orders[0].id });
    return s;
}
function cancel(s: GameState, id: SeatId, reason: string) { const a = s.seats[id].active_action; if (a) {
    s.seats[id].active_action = null;
    emitEvent(s, { type: 'action_cancelled', seat_id: id, action_id: a.action_id, reason });
} }
function moveBoundary(s: GameState, from: number) { const times = SEATS.flatMap(id => { const p = s.seats[id], a = p.active_action; return a?.type === 'move_to' ? [from + distance(p.position, a.path[0]) / MOVEMENT_SPEED * 1000] : []; }); return times.length ? Math.min(...times) : null; }
function advanceMoves(s: GameState, from: number, to: number, complete = true) {
    for (const id of SEATS) {
        const p = s.seats[id], a = p.active_action;
        if (a?.type !== 'move_to')
            continue;
        const target = a.path[0], d = distance(p.position, target), travel = MOVEMENT_SPEED * (to - from) / 1000;
        // Compare in the same rounded clock domain as moveBoundary, including epoch clocks.
        if (from + d / MOVEMENT_SPEED * 1000 <= to) {
            p.position = { ...target };
            if (complete) {
                a.path.shift();
                if (!a.path.length) {
                    p.active_action = null;
                    s.state_version++;
                    emitEvent(s, { type: 'action_completed', seat_id: id, action_id: a.action_id }, to);
                }
            }
        }
        else if (d > 0) {
            p.position.x += (target.x - p.position.x) * travel / d;
            p.position.y += (target.y - p.position.y) * travel / d;
        }
    }
}
export function stepGame(state: GameState, nowMs: number): GameState {
    if (!validTime(nowMs) || nowMs <= state.server_time_ms)
        return state;
    const s = clone(state);
    if (s.phase !== 'playing') {
        s.server_time_ms = nowMs;
        return s;
    }
    const end = s.round_ends_at_ms!, until = Math.min(nowMs, end);
    while (s.server_time_ms < until) {
        const from = s.server_time_ms;
        const to = Math.min(until, ...[moveBoundary(s, from), nextKitchenBoundary(s, from), nextOrderBoundary(s, from)].filter((x): x is number => x !== null));
        s.server_time_ms = to;
        // Expiries win ties. Spawning is handled after work at this same instant.
        const spawn = s.next_spawn_at_ms;
        s.next_spawn_at_ms = Infinity;
        advanceOrders(s, to);
        s.next_spawn_at_ms = spawn;
        if (to < end) {
            advanceKitchen(s, from, to);
            advanceMoves(s, from, to);
            advanceOrders(s, to);
        }
        else { // Time reaches the boundary, but no completed work or delivery at 90s.
            advanceMoves(s, from, to, false);
            for (const target of ['burner_a', 'burner_b'] as const) {
                const pot = s.items[s.slots[target] ?? ''];
                if (pot?.kind === 'pot' && pot.phase.startsWith('cooking'))
                    pot.remaining_ms = Math.max(0, pot.remaining_ms - (to - from));
            }
            for (const p of Object.values(s.seats))
                if (p.active_action?.type === 'chop') {
                    const item = s.items[p.active_action.item_id];
                    if (item.kind === 'ingredient')
                        item.chop_remaining_ms = Math.max(0, item.chop_remaining_ms - (to - from));
                }
            s.phase = 'finished';
            s.state_version++;
            for (const id of SEATS)
                cancel(s, id, 'ROUND_FINISHED');
            emitEvent(s, { type: 'round_finished' }, end);
        }
        if (to === from && to < until && !SEATS.some(id => s.seats[id].active_action?.type === 'move_to'))
            throw Error('Kitchen boundary did not advance');
    }
    s.server_time_ms = nowMs;
    return s;
}
export function setController(state: GameState, seatId: SeatId, controller: Controller, nowMs: number): GameState { if (!SEATS.includes(seatId) || !['human', 'demo', 'external'].includes(controller) || !validTime(nowMs) || nowMs < state.server_time_ms)
    return state; const s = clone(stepGame(state, nowMs)); cancel(s, seatId, 'CONTROLLER_CHANGED'); s.seats[seatId].controller = controller; s.seats[seatId].generation++; s.state_version++; emitEvent(s, { type: 'controller_changed', seat_id: seatId, reason: controller }); return s; }
function keys(value: object, expected: string[]) { const actual = Object.keys(value); return actual.length === expected.length && expected.every(k => Object.hasOwn(value, k)); }
function shape(command: unknown): command is GameCommand {
    if (!command || typeof command !== 'object')
        return false;
    const c = command as GameCommand;
    if (!keys(c, ['action_id', 'seat_id', 'seat_generation', 'state_version', 'issued_at_ms', 'ttl_ms', 'action']) || typeof c.action_id !== 'string' || c.action_id.length < 1 || c.action_id.length > 128 || !SEATS.includes(c.seat_id) || !Number.isSafeInteger(c.state_version) || c.state_version < 0 || !Number.isSafeInteger(c.seat_generation) || c.seat_generation < 0 || !Number.isFinite(c.issued_at_ms) || !Number.isFinite(c.ttl_ms) || c.ttl_ms < 1 || c.ttl_ms > 10000 || !c.action || typeof c.action !== 'object')
        return false;
    if (c.action.type === 'cancel')
        return keys(c.action, ['type']);
    if (!keys(c.action, ['type', 'target']))
        return false;
    if (c.action.type === 'interact')
        return STATION_IDS.includes(c.action.target);
    return c.action.type === 'move_to' && !!c.action.target && keys(c.action.target, ['x', 'y']) && Number.isFinite(c.action.target.x) && Number.isFinite(c.action.target.y);
}
function fingerprint(c: GameCommand) { return JSON.stringify([c.action_id, c.seat_id, c.seat_generation, c.state_version, c.issued_at_ms, c.ttl_ms, c.action.type, c.action.type === 'move_to' ? [c.action.target.x, c.action.target.y] : c.action.type === 'interact' ? c.action.target : null]); }
export function inspectInteraction(s: GameSnapshot, id: SeatId, target: StationId): InteractionPreview {
    const no = (error: ErrorCode): InteractionPreview => ({ target, allowed: false, operation: 'unavailable', error });
    if (s.phase !== 'playing')
        return no('NOT_PLAYING');
    if (s.seats[id].active_action)
        return no('SEAT_BUSY');
    if (!canReachTarget(s.seats[id].position, target))
        return no('OUT_OF_RANGE');
    const kitchen = inspectKitchenInteraction(s, id, target);
    if (kitchen)
        return kitchen;
    if (target === 'orders')
        return s.orders.some(o => o.phase === 'pending' && s.server_time_ms < o.pending_deadline_ms) && s.orders.filter(o => o.phase === 'accepted').length < KITCHEN_RULES.order_cap ? { target, allowed: true, operation: 'accept_order' } : no('INVALID_INTERACTION');
    const held = s.seats[id].held_item_id ? s.items[s.seats[id].held_item_id!] : undefined;
    return held?.kind === 'plate' && held.recipe_id && s.orders.some(o => o.phase === 'accepted' && o.recipe_id === held.recipe_id && s.server_time_ms < o.delivery_deadline_ms!) ? { target, allowed: true, operation: 'deliver' } : no('INVALID_INTERACTION');
}
export function applyCommand(state: GameState, command: GameCommand, nowMs: number): CommandResult {
    const current = stepGame(state, nowMs), valid = shape(command), c = command, id = typeof c?.action_id === 'string' ? c.action_id : '';
    const prior = Object.hasOwn(current.receipts, id) ? current.receipts[id] : undefined;
    if (valid && prior && prior.fingerprint === fingerprint(c))
        return { state: current, receipt: structuredClone(prior.receipt) };
    let error: ErrorCode | undefined, path: ReturnType<typeof routeTo> = null;
    if (prior)
        error = 'ACTION_ID_CONFLICT';
    else if (!valid)
        error = 'INVALID_COMMAND';
    else if (Object.keys(current.receipts).length >= RECEIPT_LIMIT)
        error = 'RECEIPT_CAPACITY';
    else if (!validTime(nowMs) || nowMs < state.server_time_ms)
        error = 'INVALID_TIME';
    else if (c.seat_generation !== current.seats[c.seat_id].generation)
        error = 'STALE_GENERATION';
    else if (c.issued_at_ms > nowMs)
        error = 'FUTURE_COMMAND';
    else if (c.issued_at_ms + c.ttl_ms <= nowMs)
        error = 'EXPIRED';
    else if (current.phase !== 'playing')
        error = 'NOT_PLAYING';
    else if (c.state_version !== current.state_version)
        error = 'STALE_STATE';
    else if (current.seats[c.seat_id].active_action && c.action.type !== 'cancel')
        error = 'SEAT_BUSY';
    else if (c.action.type === 'move_to') {
        const t = c.action.target;
        if (t.x < 0 || t.y < 0 || t.x > WORLD.width || t.y > WORLD.height)
            error = 'OUT_OF_BOUNDS';
        else if (!isWalkable(t))
            error = 'TARGET_BLOCKED';
        else {
            path = routeTo(current.seats[c.seat_id].position, t);
            if (path === null)
                error = 'NO_PATH';
        }
    }
    else if (c.action.type === 'interact')
        error = inspectInteraction(current, c.seat_id, c.action.target).error;
    const s = clone(current);
    const receipt: CommandReceipt = { action_id: id, status: error ? 'rejected' : 'accepted', state_version: current.state_version, ...(error ? { error } : {}) };
    if (error)
        emitEvent(s, { type: 'action_rejected', action_id: id, ...(valid ? { seat_id: c.seat_id } : {}), reason: error });
    else {
        const p = s.seats[c.seat_id], a = c.action;
        s.state_version++;
        emitEvent(s, { type: 'action_accepted', seat_id: c.seat_id, action_id: id });
        if (a.type === 'move_to') {
            if (!path?.length)
                emitEvent(s, { type: 'action_completed', seat_id: c.seat_id, action_id: id });
            else
                p.active_action = { type: 'move_to', action_id: id, target: { ...a.target }, path };
        }
        else if (a.type === 'cancel') {
            cancel(s, c.seat_id, 'CANCELLED');
            emitEvent(s, { type: 'action_completed', seat_id: c.seat_id, action_id: id });
        }
        else {
            let started = false;
            if (a.target === 'orders')
                acceptOrder(s, nowMs);
            else if (a.target === 'delivery')
                deliverOrder(s, c.seat_id, nowMs);
            else {
                const outcome = applyKitchenInteraction(s, c.seat_id, a.target, id);
                started = outcome.ok && outcome.started_chop;
            }
            if (!started)
                emitEvent(s, { type: 'action_completed', seat_id: c.seat_id, action_id: id });
        }
    }
    if (valid && !prior && Object.keys(s.receipts).length < RECEIPT_LIMIT)
        Object.defineProperty(s.receipts, id, { value: { fingerprint: fingerprint(c), receipt: { ...receipt } }, enumerable: true, writable: true, configurable: true });
    return { state: s, receipt };
}
export function observe(state: GameState, seatId: SeatId): Observation {
    const { receipts: _r, events, events_cursor, item_sequence: _i, order_sequence: _o, next_spawn_at_ms: _n, next_recipe: _nr, ...snapshot } = state;
    const previews = Object.fromEntries(STATION_IDS.map(id => [id, inspectInteraction(state, seatId, id)])) as Record<StationId, InteractionPreview>;
    const actions: SemanticAction[] = [];
    if (state.phase === 'playing') {
        if (state.seats[seatId].active_action)
            actions.push({ type: 'cancel' });
        else
            for (const id of STATION_IDS) {
                for (const p of WORLD.stations[id].approach_points)
                    actions.push({ type: 'move_to', target: { ...p } });
                if (previews[id].allowed)
                    actions.push({ type: 'interact', target: id });
            }
    }
    return { seat_id: seatId, snapshot: structuredClone(snapshot), legal_actions: actions, interaction_previews: previews, events: structuredClone(events), events_cursor, server_time_ms: state.server_time_ms };
}

