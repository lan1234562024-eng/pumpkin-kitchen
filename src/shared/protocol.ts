import type { CommandReceipt, ErrorCode, GameCommand, GameEvent, GameSnapshot, SeatId,StationId,InteractionPreview } from './contracts';
import {RULESET_ID} from './ruleset';
import { STATION_IDS } from '../game/world';

export const MAX_MESSAGE_BYTES = 16 * 1024;
export interface HumanInputMessage {
  ruleset_id: typeof RULESET_ID;
  type: 'human_input';
  seat_id: SeatId;
  seat_generation: number;
  round_id: number;
  sequence: number;
  direction: {x: -1 | 0 | 1; y: -1 | 0 | 1};
}
export interface HumanInputResult {
  type: 'human_input_result';
  seat_id: SeatId;
  sequence: number;
  status: 'accepted' | 'rejected';
  error?: ErrorCode | 'ROUND_CHANGED' | 'STALE_INPUT' | 'INPUT_OWNED' | 'FORBIDDEN';
}
export type ClientMessage =
  | { type: 'start_round';ruleset_id:typeof RULESET_ID }
  | HumanInputMessage
  | { type: 'command'; command: GameCommand;ruleset_id:typeof RULESET_ID }
  | { type: 'takeover'; seat_id: 'ai';ruleset_id:typeof RULESET_ID }
  | { type: 'set_demo'; enabled: boolean;ruleset_id:typeof RULESET_ID };
export type ServerMessage =
  | { type: 'snapshot'; snapshot: GameSnapshot; events: GameEvent[]; events_cursor: number; controller_status: {connected:boolean;waiting:boolean};interaction_previews:Record<SeatId,Record<StationId,InteractionPreview>> }
  | HumanInputResult
  | { type: 'result'; receipt: CommandReceipt }
  | { type: 'error'; code: string; message: string };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]) {
  return Object.keys(value).length === expected.length && expected.every(k => Object.hasOwn(value,k));
}
function integer(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
export function isGameCommand(value: unknown): value is GameCommand {
  if (!record(value) || !keys(value,['action_id','state_version','issued_at_ms','ttl_ms','seat_generation','seat_id','action'])) return false;
  if (typeof value.action_id !== 'string' || value.action_id.length < 1 || value.action_id.length > 128 ||
    !integer(value.state_version) || !integer(value.seat_generation) || !finite(value.issued_at_ms) ||
    !finite(value.ttl_ms) || value.ttl_ms < 1 || value.ttl_ms > 10000 ||
    !['human','ai'].includes(value.seat_id as string) || !record(value.action)) return false;
  const action = value.action;
  if (action.type === 'cancel') return keys(action,['type']);
  if (!keys(action,['type','target'])) return false;
  if (action.type === 'interact') return STATION_IDS.some(id => id === action.target);
  return action.type === 'move_to' && record(action.target) && keys(action.target,['x','y']) && finite(action.target.x) && finite(action.target.y);
}
export function isClientMessage(value: unknown): value is ClientMessage {
  if (!record(value)||!hasMatchingRuleset(value)) return false;
  switch (value.type) {
    case 'start_round': return keys(value,['type','ruleset_id']);
    case 'human_input': return keys(value,['type','ruleset_id','seat_id','seat_generation','round_id','sequence','direction']) &&
      (value.seat_id === 'human' || value.seat_id === 'ai') && integer(value.seat_generation) && integer(value.round_id) &&
      integer(value.sequence) && record(value.direction) && keys(value.direction,['x','y']) &&
      [-1,0,1].includes(value.direction.x as number) && [-1,0,1].includes(value.direction.y as number);
    case 'command': return keys(value,['type','ruleset_id','command']) && isGameCommand(value.command);
    case 'takeover': return keys(value,['type','ruleset_id','seat_id']) && value.seat_id === 'ai';
    case 'set_demo': return keys(value,['type','ruleset_id','enabled']) && typeof value.enabled === 'boolean';
    default: return false;
  }
}
export function hasMatchingRuleset(value:unknown):boolean{return record(value)&&value.ruleset_id===RULESET_ID;}

