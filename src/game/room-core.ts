import { applyCommand, createGame, observe, setController, startRound, stepGame } from './engine';
import { chooseDemoCommand } from './demo';
import {stopAlongRay} from './navigation';

import type { CommandResult, GameCommand, GameEvent, GameSnapshot, GameState, Observation, SeatId, SemanticAction } from '../shared/contracts';
import type { HumanInputMessage, HumanInputResult } from '../shared/protocol';

export interface ForbiddenResult { code: 'FORBIDDEN'; message: string }
export interface ControllerStatus { connected: boolean; waiting: boolean }
export interface EventBatch { events: GameEvent[]; cursor: number; oldest_cursor: number; truncated: boolean }
export interface ExternalClaim { generation: number; round_id: number; cursor: number; observation: Observation; control_token: string }
export interface WaitOptions { generation: number; round_id: number; after_cursor: number; action_id?: string; timeout_ms: number }
export type WaitReason = 'action_completed' | 'action_cancelled' | 'action_rejected' | 'changed' | 'gap' | 'control_lost' | 'round_changed' | 'round_finished' | 'timeout' | 'aborted' | 'closed' | 'wait_limit' | 'invalid_request';
export interface WaitResult extends EventBatch { reason: WaitReason; observation: Observation }
export interface Room {
  getSnapshot(): GameSnapshot;
  observe(seatId: SeatId): Observation;
  submit(command: GameCommand, actor?: 'human' | 'demo' | 'external'): CommandResult | ForbiddenResult;
  setHumanInput(connectionId: string, input: HumanInputMessage): HumanInputResult;
  releaseHumanInput(connectionId: string): void;
  claimExternal(sessionId: string, controlToken?: string): ExternalClaim | ForbiddenResult;
  submitExternal(sessionId: string, command: GameCommand, controlToken?: string): CommandResult | ForbiddenResult;
  submitExternalTaskAction(sessionId: string, intent: Pick<GameCommand,'action_id'|'action'|'seat_generation'> & {round_id:number}, guard: (observation:Observation)=>boolean, controlToken:string): CommandResult | ForbiddenResult | {code:'STALE_INTENT';message:string};
  releaseExternal(sessionId: string, controlToken?: string): boolean;
  disconnectExternal(sessionId: string): void;
  touchExternal(sessionId: string, controlToken?: string): boolean;
  eventsSince(afterCursor: number): EventBatch;
  waitForChange(sessionId: string, options: WaitOptions, signal?: AbortSignal, controlToken?: string): Promise<WaitResult>;
  getControllerStatus(): ControllerStatus;
  tick(): void;
  startRound(): void;
  takeover(seatId: SeatId): void;
  setDemoEnabled(enabled: boolean): void;
  close(): void;
}

/** One authoritative room. AI control requires its bound transport or a current lease capability. */
export interface RoomSecurity {
  randomUUID(): string;
  createToken(): string;
  tokenEquals(supplied: string, expected: string): boolean;
}

export function createRoom(now: () => number, security: RoomSecurity): Room {
  let state = createGame(now());
  let owner: {id: string; generation: number; round: number; cursor: number; lastSeen: number; token: string; portable: boolean} | undefined;
  type InputLease = {connectionId:string;generation:number;round:number;direction:HumanInputMessage['direction'];expiresAt:number;actionId:string};
  const inputLeases = new Map<SeatId,InputLease>();
  const inputSequences = new Map<string,Map<SeatId,number>>();
  const inputPrefix = `human-input-${security.randomUUID()}`;
  let inputAction = 0;
  let closed=false;
  const waiters=new Map<string,()=>void>();
  const forbidden=(): ForbiddenResult => ({code:'FORBIDDEN',message:'This session does not control the AI seat.'});
  const copyResult=(result:CommandResult):CommandResult=>{
    const {receipts,events,...data}=result.state;
    // Receipts contain only primitive fields. Copy them explicitly rather than
    // serializing the entire growing history on every browser/MCP submission.
    return {receipt:{...result.receipt},state:{...structuredClone(data),events:events.map(event=>({...event})),receipts:Object.fromEntries(Object.entries(receipts).map(([id,stored])=>[id,{fingerprint:stored.fingerprint,receipt:{...stored.receipt}}]))}};
  };
  const owns=(id:string,controlToken?:string) => {
    if(closed || !owner || owner.generation!==state.seats.ai.generation || owner.round!==state.round_id || state.seats.ai.controller!=='external') return false;
    if(controlToken===undefined) return owner.id===id;
    return security.tokenEquals(controlToken,owner.token);
  };
  const refreshOwner=(time:number,controlToken?:string) => {owner!.lastSeen=time;if(controlToken!==undefined) owner!.portable=true;};
  const commit=(next:GameState) => {
    state=next;
    for(const [seatId,lease] of inputLeases) {
      const seat=state.seats[seatId];
      if(state.phase!=='playing'||lease.round!==state.round_id||lease.generation!==seat.generation||seat.controller!=='human') inputLeases.delete(seatId);
    }
    for(const check of [...waiters.values()]) check();
  };
  const revoke=() => {owner=undefined;};
  const inputCommand=(seatId:SeatId,action:SemanticAction,time:number):GameCommand => ({action_id:`${inputPrefix}-${++inputAction}`,seat_id:seatId,seat_generation:state.seats[seatId].generation,state_version:state.state_version,issued_at_ms:time,ttl_ms:1000,action});
  const stopInput=(seatId:SeatId,lease:InputLease,time:number) => {
    const seat=state.seats[seatId];
    inputLeases.delete(seatId);
    if(seat.controller!=='human'||seat.generation!==lease.generation||state.round_id!==lease.round||seat.active_action?.type!=='move_to'||seat.active_action.action_id!==lease.actionId) return;
    const result=applyCommand(state,inputCommand(seatId,{type:'cancel'},time),time);
    // A full receipt store must still stop this exact keyboard-owned move.
    // The generation reset invalidates subsequent packets from this gesture.
    commit(result.receipt.error==='RECEIPT_CAPACITY'?setController(result.state,seatId,'human',time):result.state);
  };
  const advance=(time:number) => {
    if(closed) return;
    const phaseBeforeAdvance=state.phase;
    for(;;) {
      const expiring=[...inputLeases].filter(([,lease])=>lease.expiresAt<=time).sort((a,b)=>a[1].expiresAt-b[1].expiresAt)[0];
      if(!expiring) break;
      const [seatId,lease]=expiring;
      commit(stepGame(state,lease.expiresAt));
      if(inputLeases.get(seatId)===lease) stopInput(seatId,lease,lease.expiresAt);
    }
    const next=stepGame(state,time);
    if(phaseBeforeAdvance!=='finished'&&next.phase==='finished') {revoke();commit(next);return;}
    if(owner && time-owner.lastSeen>=30000) {revoke();commit(setController(next,'ai','external',time));}
    else commit(next);
  };
  const retireSupersededInput=(seatId:SeatId,result:CommandResult) => {
    const lease=inputLeases.get(seatId);
    if(lease && result.receipt.status==='accepted' && result.state.seats[seatId].active_action?.action_id!==lease.actionId) inputLeases.delete(seatId);
  };
  const room: Room = {
    getSnapshot() { return observe(state,'human').snapshot; },
    observe(seatId) { return observe(state,seatId); },
    submit(command, actor = 'human') {
      const time=now();advance(time);
      const seat = state.seats[command?.seat_id];
      if (closed || actor==='external' || !seat || seat.controller !== actor || (actor === 'demo' && command.seat_id !== 'ai')) return forbidden();
      const result = applyCommand(state,command,time);retireSupersededInput(command.seat_id,result);commit(result.state);return copyResult(result);
    },
    setHumanInput(connectionId,input) {
      const time=now();advance(time);
      const response=(error?:HumanInputResult['error']):HumanInputResult => ({type:'human_input_result',seat_id:input.seat_id,sequence:input.sequence,status:error?'rejected':'accepted',...(error?{error}:{})});
      if(closed||!connectionId) return response('FORBIDDEN');
      const sequences=inputSequences.get(connectionId)??new Map<SeatId,number>();
      if(input.sequence<=(sequences.get(input.seat_id)??-1)) return response('STALE_INPUT');
      sequences.set(input.seat_id,input.sequence);inputSequences.set(connectionId,sequences);
      if(input.round_id!==state.round_id) return response('ROUND_CHANGED');
      const seat=state.seats[input.seat_id];
      if(input.seat_generation!==seat.generation) return response('STALE_GENERATION');
      if(seat.controller!=='human') return response('FORBIDDEN');
      if(state.phase!=='playing') return response('NOT_PLAYING');
      const lease=inputLeases.get(input.seat_id);
      if(lease && lease.connectionId!==connectionId) return response('INPUT_OWNED');
      const {x,y}=input.direction;
      if(x===0&&y===0) {if(lease) stopInput(input.seat_id,lease,time);return response();}
      if(lease && lease.direction.x===x && lease.direction.y===y) {lease.expiresAt=time+300;return response();}
      if(seat.active_action?.type==='chop') return response('SEAT_BUSY');
      if(lease) stopInput(input.seat_id,lease,time);
      else if(seat.active_action?.type==='move_to') {
        const cancelled=applyCommand(state,inputCommand(input.seat_id,{type:'cancel'},time),time);commit(cancelled.state);
        if(cancelled.receipt.status==='rejected') return response(cancelled.receipt.error);
      }
      const position=state.seats[input.seat_id].position;
      const command=inputCommand(input.seat_id,{type:'move_to',target:stopAlongRay(position,{x,y})},time);
      const result=applyCommand(state,command,time);commit(result.state);
      if(result.receipt.status==='rejected') return response(result.receipt.error);
      inputLeases.set(input.seat_id,{connectionId,generation:state.seats[input.seat_id].generation,round:state.round_id,direction:{x,y},expiresAt:time+300,actionId:command.action_id});
      return response();
    },
    releaseHumanInput(connectionId) {
      const time=now();advance(time);
      for(const [seatId,lease] of [...inputLeases]) if(lease.connectionId===connectionId) stopInput(seatId,lease,time);
      inputSequences.delete(connectionId);
    },
    claimExternal(sessionId,controlToken) {
      const time=now();advance(time);
      if(closed || !sessionId || state.seats.ai.controller==='human' || (owner ? !owns(sessionId,controlToken) : controlToken!==undefined)) return forbidden();
      if(!owner) {const next=setController(state,'ai','external',time);owner={id:sessionId,generation:next.seats.ai.generation,round:next.round_id,cursor:next.events_cursor,lastSeen:time,token:security.createToken(),portable:false};commit(next);}
      else refreshOwner(time,controlToken);
      return {generation:state.seats.ai.generation,round_id:state.round_id,cursor:state.events_cursor,observation:room.observe('ai'),control_token:owner!.token};
    },
    touchExternal(sessionId,controlToken) {const time=now();advance(time);if(!owns(sessionId,controlToken)) return false;refreshOwner(time,controlToken);return true;},
    submitExternal(sessionId,command,controlToken) {
      const time=now();advance(time);
      if(!owns(sessionId,controlToken) || command?.seat_id!=='ai' || command.seat_generation!==owner!.generation) return forbidden();
      if(controlToken!==undefined) owner!.portable=true;
      const result=applyCommand(state,command,time);
      if(result.receipt.status==='accepted') refreshOwner(time,controlToken);
      retireSupersededInput(command.seat_id,result);
      commit(result.state);return copyResult(result);
    },
    submitExternalTaskAction(sessionId,intent,guard,controlToken) {
      const time=now();advance(time);
      if(!owns(sessionId,controlToken)||intent.round_id!==state.round_id||intent.seat_generation!==owner!.generation)return forbidden();
      // Intent checking and command construction share the actual mutation boundary.
      // No async observation window, and no rebasing of public game_act commands.
      if(!guard(room.observe('ai')))return {code:'STALE_INTENT',message:'The selected task intent changed.'};
      const command:GameCommand={action_id:intent.action_id,action:intent.action,seat_id:'ai',seat_generation:intent.seat_generation,
        state_version:state.state_version,issued_at_ms:time,ttl_ms:5000};
      const result=applyCommand(state,command,time);
      if(result.receipt.status==='accepted')refreshOwner(time,controlToken);
      commit(result.state);return copyResult(result);
    },
    releaseExternal(sessionId,controlToken) {
      const time=now();advance(time);
      if(!owns(sessionId,controlToken)) return false;
      revoke();commit(setController(state,'ai','external',time));return true;
    },
    disconnectExternal(sessionId) {
      // Token-authenticated controllers are governed by their room lease,
      // not by any one short-lived HTTP connection. Legacy clients keep cleanup.
      if(owner?.id===sessionId && !owner.portable) room.releaseExternal(sessionId);
    },
    eventsSince(afterCursor) {
      const oldest_cursor=state.events[0]?.id ?? state.events_cursor+1;
      return {events:structuredClone(state.events.filter(event=>event.id>afterCursor)),cursor:state.events_cursor,oldest_cursor,truncated:afterCursor<oldest_cursor-1 || afterCursor>state.events_cursor};
    },
    waitForChange(sessionId,options,signal,controlToken) {
      const time=now();advance(time);
      if(controlToken!==undefined && owns(sessionId,controlToken)) owner!.portable=true;
      const result=(reason:WaitReason): WaitResult => ({reason,...room.eventsSince(options.after_cursor),observation:room.observe('ai')});
      if(!Number.isSafeInteger(options.after_cursor)||options.after_cursor<0||!Number.isSafeInteger(options.generation)||!Number.isSafeInteger(options.round_id)||!Number.isFinite(options.timeout_ms)||options.timeout_ms<0||options.timeout_ms>15000||options.action_id!==undefined&&(typeof options.action_id!=='string'||!options.action_id||options.action_id.length>128)) return Promise.resolve(result('invalid_request'));
      const waiterId=owns(sessionId,controlToken)?owner!.id:sessionId;
      if(waiters.has(waiterId)||waiters.size>=8) return Promise.resolve(result('wait_limit'));
      const reason=(): WaitReason|undefined => {
        if(closed) return 'closed';
        if(signal?.aborted) return 'aborted';
        if(options.round_id!==state.round_id) return 'round_changed';
        if(state.phase==='finished') return 'round_finished';
        if(!owns(sessionId,controlToken)||options.generation!==state.seats.ai.generation) return 'control_lost';
        const batch=room.eventsSince(options.after_cursor);if(batch.truncated) return 'gap';
        // The claim cursor bounds this generation's history, including terminal
        // events retained before the caller's cursor advanced.
        const candidates=options.action_id?state.events.filter(event=>event.id>owner!.cursor && event.seat_id==='ai' && event.action_id===options.action_id):batch.events;
        const terminal=options.action_id
          ? candidates.find(event=>event.type==='action_completed'||event.type==='action_cancelled')
            ?? candidates.find(event=>event.type==='action_rejected' && (event.reason!=='ACTION_ID_CONFLICT'||state.seats.ai.active_action?.action_id!==options.action_id))
          : candidates.find(event=>['action_completed','action_cancelled','action_rejected'].includes(event.type));
        if(terminal) return terminal.type as WaitReason;
        if(!options.action_id && batch.events.some(event=>['controller_changed','round_started','round_finished','item_transferred','kitchen_changed','order_created','order_accepted','order_expired','order_completed'].includes(event.type))) return 'changed';
      };
      const immediate=reason();if(immediate) {
        if(owns(sessionId,controlToken)&&['action_completed','action_cancelled','action_rejected','changed'].includes(immediate)) refreshOwner(time,controlToken);
        return Promise.resolve(result(immediate));
      }
      refreshOwner(time,controlToken);
      if(options.timeout_ms===0) return Promise.resolve(result('timeout'));
      return new Promise(resolve=>{
        let timer:ReturnType<typeof setTimeout>;
        const finish=(value:WaitReason) => {clearTimeout(timer);waiters.delete(waiterId);signal?.removeEventListener('abort',abort);resolve(result(value));};
        const abort=() => finish('aborted');
        waiters.set(waiterId,()=>{const value=reason();if(value) finish(value);});
        signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>finish('timeout'),options.timeout_ms);
      });
    },
    getControllerStatus() {return {connected:owner!==undefined,waiting:owner!==undefined&&waiters.has(owner.id)};},
    tick() {
      if(closed) return;
      const time=now();
      advance(time);
      const command=chooseDemoCommand(state,time);if(command) room.submit(command,'demo');
    },
    startRound() {if(closed||state.phase==='playing') return;const time=now();advance(time);const next=startRound(state,time);if(next===state) return;revoke();commit(next);},
    takeover(seatId) {const time=now();advance(time);if(!closed&&seatId==='ai'&&state.seats.ai.controller!=='human') {revoke();commit(setController(state,'ai','human',time));}},
    setDemoEnabled(enabled) {
      const time=now();advance(time);
      if(closed) return;const controller=enabled?'demo':'external';
      if(state.seats.ai.controller!==controller) {revoke();commit(setController(state,'ai',controller,time));}
    },
    close() {const time=now();advance(time);if(closed) return;for(const [seatId,lease] of [...inputLeases]) stopInput(seatId,lease,time);closed=true;inputSequences.clear();revoke();commit(setController(state,'ai','external',time));},
  };
  return room;
}
