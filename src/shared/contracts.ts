import type {TargetId} from '../game/kitchen-layout';
import type {RULESET_ID} from './ruleset';
export type SeatId='human'|'ai';
export type StationId=TargetId;
export type Controller='human'|'demo'|'external';
export interface Point{x:number;y:number}
export type RecipeId='pumpkin_salad'|'pumpkin_soup';
export interface IngredientItem{id:string;kind:'ingredient';ingredient:'pumpkin'|'cucumber'|'cream';preparation:'raw'|'chopped'|'cooked';chop_remaining_ms:number}
export type PotPhase='empty'|'loaded_pumpkin'|'cooking_pumpkin'|'cooked_pumpkin'|'loaded_soup'|'cooking_soup'|'soup_ready';
export interface PotItem{id:string;kind:'pot';contents:string[];phase:PotPhase;remaining_ms:number}
export interface PlateItem{id:string;kind:'plate';contents:string[];recipe_id:RecipeId|null}
export type KitchenItem=IngredientItem|PotItem|PlateItem;
export type SemanticAction={type:'move_to';target:Point}|{type:'interact';target:StationId}|{type:'cancel'};
export interface GameCommand{action_id:string;state_version:number;issued_at_ms:number;ttl_ms:number;seat_generation:number;seat_id:SeatId;action:SemanticAction}
export type ActiveAction={type:'move_to';action_id:string;target:Point;path:Point[]}|{type:'chop';action_id:string;target:StationId;item_id:string};
export interface SeatState{id:SeatId;position:Point;held_item_id:string|null;active_action:ActiveAction|null;generation:number;controller:Controller}
export type ErrorCode='INVALID_COMMAND'|'INVALID_TIME'|'OUT_OF_BOUNDS'|'TARGET_BLOCKED'|'NO_PATH'|'FUTURE_COMMAND'|'EXPIRED'|'STALE_STATE'|'STALE_GENERATION'|'NOT_PLAYING'|'SEAT_BUSY'|'OUT_OF_RANGE'|'INVALID_INTERACTION'|'ACTION_ID_CONFLICT'|'RECEIPT_CAPACITY';
export interface CommandReceipt{action_id:string;status:'accepted'|'rejected';state_version:number;error?:ErrorCode}
export type GameEventType='round_started'|'round_finished'|'action_accepted'|'action_completed'|'action_cancelled'|'action_rejected'|'controller_changed'|'item_transferred'|'kitchen_changed'|'order_created'|'order_accepted'|'order_expired'|'order_completed';
export interface GameEvent{id:number;type:GameEventType;at_ms:number;seat_id?:SeatId;action_id?:string;reason?:string;item_id?:string;target?:StationId;order_id?:string}
export interface Order{id:string;recipe_id:RecipeId;phase:'pending'|'accepted';appeared_at_ms:number;pending_deadline_ms:number;delivery_deadline_ms:number|null}
export type InteractionOperation='take'|'place'|'source'|'chop'|'resume_chop'|'add_ingredient'|'pour'|'take_plate'|'return_plate'|'accept_order'|'deliver'|'cleanup'|'unavailable';
export interface InteractionPreview{target:StationId;allowed:boolean;operation:InteractionOperation;error?:ErrorCode}
export type InteractionOutcome={ok:true;started_chop:boolean}|{ok:false;error:ErrorCode};
export interface GameSnapshot{
 ruleset_id:typeof RULESET_ID;phase:'lobby'|'playing'|'finished';round_id:number;state_version:number;server_time_ms:number;
 round_started_at_ms:number|null;round_ends_at_ms:number|null;score:number;revenue:number;
 items:Record<string,KitchenItem>;slots:Record<StationId,string|null>;seats:Record<SeatId,SeatState>;orders:Order[];
}
export interface StoredReceipt{fingerprint:string;receipt:CommandReceipt}
export interface GameState extends GameSnapshot{receipts:Record<string,StoredReceipt>;events:GameEvent[];events_cursor:number;item_sequence:number;order_sequence:number;next_spawn_at_ms:number;next_recipe:RecipeId}
export interface CommandResult{state:GameState;receipt:CommandReceipt}
export interface Observation{seat_id:SeatId;snapshot:GameSnapshot;legal_actions:SemanticAction[];interaction_previews:Record<StationId,InteractionPreview>;events:GameEvent[];events_cursor:number;server_time_ms:number}

