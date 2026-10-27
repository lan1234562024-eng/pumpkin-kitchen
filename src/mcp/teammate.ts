import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createHash, randomUUID } from 'node:crypto';
import { approachFor } from '../game/navigation';
import { STATION_IDS, KITCHEN_RULES } from '../game/world';
import { RULESET_ID } from '../shared/ruleset';
import type { CommandReceipt, InteractionOperation, KitchenItem, Observation, SemanticAction, StationId } from '../shared/contracts';

interface Reply {
  code?: string;
  control_token?: string;
  observation?: Observation;
  receipt?: CommandReceipt;
  reason?: string;
}
export interface TeammateTaskResult {
  reason: string;
  observation: Observation;
  receipts: CommandReceipt[];
}
class ToolFailure extends Error {
  constructor(readonly code: string) { super(code); }
}

// Timers advance independently; identities, contents and preparation change intent.
function itemState(observation: Observation, id: string | null): unknown {
  const item = id ? observation.snapshot.items[id] : undefined;
  if (!item) return id;
  if (item.kind === 'ingredient') return [item.id, item.ingredient, item.preparation];
  return [item.id, item.kind, item.kind === 'pot' ? item.phase : item.recipe_id,
    item.contents.map(child => itemState(observation, child))];
}
function targetState(observation: Observation, target: StationId, operation: InteractionOperation) {
  const s = observation.snapshot;
  // Mirror the order the authoritative interaction will actually select.
  // Other orders may arrive or expire while this player walks to the station.
  let orderIntent: unknown = null;
  if (operation === 'accept_order') {
    orderIntent = [s.orders.find(order => order.phase === 'pending' &&
      s.server_time_ms < order.pending_deadline_ms) ?? null,
      s.orders.filter(order => order.phase === 'accepted').length < KITCHEN_RULES.order_cap];
  } else if (operation === 'deliver') {
    const held = s.seats.ai.held_item_id ? s.items[s.seats.ai.held_item_id] : undefined;
    orderIntent = held?.kind === 'plate' && held.recipe_id
      ? s.orders.filter(order => order.phase === 'accepted' && order.recipe_id === held.recipe_id &&
          s.server_time_ms < order.delivery_deadline_ms!)
        .sort((a, b) => a.delivery_deadline_ms! - b.delivery_deadline_ms! || a.id.localeCompare(b.id))[0] ?? null
      : null;
  }
  const intent = [itemState(observation, s.seats.ai.held_item_id),
    itemState(observation, s.slots[target]),
    orderIntent];
  // Source tasks bind the same-ingredient set at the existing mutation boundary.
  // Ignore location/preparation timers, but stop if another portion appears or disappears.
  if (target.startsWith('source_') && s.seats.ai.held_item_id === null && s.slots[target] === null) {
    intent.push(Object.values(s.items).filter(item => item.kind === 'ingredient' && item.ingredient === target.slice(7))
      .map(item => item.id).sort());
  }
  // An empty-handed bowl pickup yields when the human takes over plating.
  // Keep this narrow: movement, non-plate inventory and cooking timers are unrelated.
  if (target === 'plates' && s.seats.ai.held_item_id === null) {
    const human = s.items[s.seats.human.held_item_id ?? ''];
    intent.push(human?.kind === 'plate' ? itemState(observation, human.id) : null);
  }
  return JSON.stringify(intent);
}

/** Bind station intent to entities, not unrelated human movement or countdown ticks. */
export function taskIntentKey(observation: Observation, target: StationId): string {
  const operation = target === 'orders' ? 'accept_order' : target === 'delivery' ? 'deliver' : 'take';
  return createHash('sha256').update(JSON.stringify([observation.snapshot.round_id,
    observation.snapshot.seats.ai.generation, target, targetState(observation, target, operation)])).digest('hex');
}

/** One model-selected station task, over the existing SDK and authoritative tools. */
export class TeammateController {
  private token?: string;
  private observation?: Observation;
  private running = false;
  constructor(private readonly client: Pick<Client, 'callTool'>, initial?: {control_token: string; observation: Observation}) {
    if (initial) { this.token = initial.control_token; this.observation = structuredClone(initial.observation); }
  }

  private async call(name: string, args: Record<string, unknown> = {}): Promise<Reply> {
    const result = await this.client.callTool({ name, arguments: args });
    if (!result.structuredContent) throw new Error(`${name}: missing structured MCP result`);
    const reply = result.structuredContent as Reply;
    if (reply.code) throw new ToolFailure(reply.code);
    if (result.isError && !reply.receipt && !reply.observation) throw new Error(`${name}: MCP tool failed`);
    return reply;
  }
  private remember(reply: Reply): Observation {
    if (!reply.observation) throw new Error('MCP result is missing its observation');
    return this.observation = reply.observation;
  }
  async join(): Promise<Observation> {
    if (this.running) throw new Error('A teammate task is already running');
    const reply = await this.call('game_join', { ruleset_id: RULESET_ID,
      ...(this.token ? { control_token: this.token } : {}) });
    if (!reply.control_token) throw new Error('game_join did not grant AI control');
    this.token = reply.control_token;
    return this.remember(reply);
  }
  async observe(): Promise<Observation> {
    try {
      return this.remember(await this.call('game_observe', this.token ? { control_token: this.token } : {}));
    } catch (error) {
      if (!(error instanceof ToolFailure) || error.code !== 'FORBIDDEN') throw error;
      this.token = undefined;
      return this.remember(await this.call('game_observe'));
    }
  }
  async leave(): Promise<void> {
    if (this.running) throw new Error('Wait for the current teammate task before leaving');
    if (!this.token) return;
    try { await this.call('game_leave', { ruleset_id: RULESET_ID, control_token: this.token }); }
    catch (error) { if (!(error instanceof ToolFailure) || error.code !== 'FORBIDDEN') throw error; }
    finally { this.token = undefined; }
  }

  async perform(target: StationId, operation: Exclude<InteractionOperation, 'unavailable'>, signal?: AbortSignal): Promise<TeammateTaskResult> {
    if (!STATION_IDS.includes(target)) throw new Error('Unknown kitchen station');
    const expected = this.observation;
    if (!expected) throw new Error('Observe the room before choosing a teammate task');
    if (this.running) return { reason: 'busy', observation: expected, receipts: [] };
    this.running = true;
    const receipts: CommandReceipt[] = [];
    let observation = expected;
    const finish = (reason: string) => ({ reason, observation, receipts });
    const contextChange = () => {
      const s = observation.snapshot, before = expected.snapshot;
      if (s.phase !== 'playing') return 'round_finished';
      if (s.round_id !== before.round_id) return 'round_changed';
      if (!this.token || s.seats.ai.generation !== before.seats.ai.generation || s.seats.ai.controller !== 'external') return 'control_lost';
    };
    const expectedTarget = targetState(expected, target, operation);
    const changed = () => targetState(observation, target, operation) !== expectedTarget;
    const submit = async (action: SemanticAction) => {
      const s = observation.snapshot;
      const reply = await this.call('game_act', { ruleset_id: RULESET_ID, control_token: this.token,
        action_id: `teammate-task-${randomUUID()}`, seat_id: 'ai', seat_generation: s.seats.ai.generation,
        state_version: s.state_version, issued_at_ms: observation.server_time_ms, ttl_ms: 5000, action });
      observation = this.remember(reply);
      if (!reply.receipt) throw new Error('game_act is missing its receipt');
      receipts.push(reply.receipt);
      return reply.receipt;
    };
    const run = async (action: SemanticAction, guardTarget: boolean): Promise<string | undefined> => {
      if (signal?.aborted) return 'aborted';
      const receipt = await submit(action);
      if (receipt.status !== 'accepted') return receipt.error ?? 'rejected';
      const stopMove = async (reason: string) => {
        if (action.type === 'move_to' && !contextChange() && observation.snapshot.seats.ai.active_action?.action_id === receipt.action_id) {
          let cancelled: CommandReceipt;
          try { cancelled = await submit({ type: 'cancel' }); }
          catch (error) { if (error instanceof ToolFailure && error.code === 'STALE_INTENT') return 'cancel_rejected'; throw error; }
          if (cancelled.status !== 'accepted') return 'cancel_rejected';
        }
        return reason;
      };
      for (;;) {
        const context = contextChange();
        if (context) return context;
        if (signal?.aborted) return stopMove('aborted');
        const active = observation.snapshot.seats.ai.active_action;
        if (guardTarget && changed()) {
          return stopMove('target_changed');
        }
        if (active?.action_id !== receipt.action_id) {
          const terminal = observation.events.find(event => event.action_id === receipt.action_id &&
            ['action_completed', 'action_cancelled', 'action_rejected'].includes(event.type));
          return terminal?.type === 'action_completed' ? undefined : terminal?.type ?? 'state_changed';
        }
        const s = observation.snapshot;
        const reply = await this.call('game_wait', { control_token: this.token, round_id: s.round_id,
          generation: s.seats.ai.generation, after_cursor: observation.events_cursor, timeout_ms: 1000,
          // Movement must also wake on a teammate changing the target.
          ...(!guardTarget ? { action_id: receipt.action_id } : {}) });
        observation = this.remember(reply);
        if (!['timeout', 'changed', 'action_completed', 'action_cancelled', 'action_rejected'].includes(reply.reason ?? '')) return stopMove(reply.reason ?? 'state_changed');
      }
    };
    try {
      if (signal?.aborted) return finish('aborted');
      observation = await this.observe();
      const context = contextChange();
      if (context) return finish(context);
      if (observation.snapshot.seats.ai.active_action) return finish('busy');
      if (changed()) return finish('target_changed');
      if (observation.interaction_previews[target].error === 'OUT_OF_RANGE') {
        const point = approachFor(observation.snapshot.seats.ai.position, target);
        if (!point) return finish('NO_PATH');
        const stopped = await run({ type: 'move_to', target: point }, true);
        if (stopped) return finish(stopped);
      }
      const preview = observation.interaction_previews[target];
      if (!preview.allowed || preview.operation !== operation) return finish('operation_changed');
      const stopped = await run({ type: 'interact', target }, false);
      return finish(stopped ?? 'completed');
    } catch (error) {
      if (error instanceof ToolFailure && error.code === 'STALE_INTENT') return finish('target_changed');
      if (!(error instanceof ToolFailure) || error.code !== 'FORBIDDEN') throw error;
      this.token = undefined;
      observation = await this.observe();
      return finish('control_lost');
    } finally { this.running = false; }
  }
}

/** Keep decision-relevant state, without historical events or unusable previews. */
export function compactObservation(observation: Observation) {
  const s = observation.snapshot;
  const seat = (id: 'human' | 'ai') => {
    const value = s.seats[id];
    return { position: value.position, held_item_id: value.held_item_id,
      action: value.active_action ? { type: value.active_action.type, target: value.active_action.target } : null };
  };
  return { round: s.round_id, phase: s.phase,
    remaining_ms: Math.max(0, (s.round_ends_at_ms ?? s.server_time_ms) - s.server_time_ms),
    ai: seat('ai'), human: seat('human'), items: s.items as Record<string, KitchenItem>, stations: s.slots,
    orders: s.orders.map(order => ({ id: order.id, recipe: order.recipe_id, phase: order.phase,
      remaining_ms: Math.max(0, (order.delivery_deadline_ms ?? order.pending_deadline_ms) - s.server_time_ms) })),
    nearby: Object.values(observation.interaction_previews).filter(preview => preview.allowed)
      .map(({ target, operation }) => ({ target, operation })), score: s.score, revenue: s.revenue };
}



