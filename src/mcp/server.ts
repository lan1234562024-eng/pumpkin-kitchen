import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Room } from '../server/room';
import { WORLD,STATION_IDS,ROUND_DURATION_MS,KITCHEN_RULES,RECIPES,INTERACT_RADIUS,MOVEMENT_SPEED } from '../game/world';
import {RULESET_ID,APP_VERSION} from '../shared/ruleset';
import type { RequestId } from '@modelcontextprotocol/sdk/types.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { GameCommand, Observation } from '../shared/contracts';
import type { WaitOptions } from '../server/room';
import { TeammateController, taskIntentKey } from './teammate';

const runningTasks = new WeakSet<Room>();
const operations = ['take','place','source','chop','resume_chop','add_ingredient','pour','take_plate','return_plate','accept_order','deliver','cleanup'] as const;

const integer=z.number().int().nonnegative();
const fields={action_id:z.string().min(1).max(128),state_version:integer,issued_at_ms:z.number().finite(),ttl_ms:z.number().min(1).max(10000),seat_generation:integer,seat_id:z.enum(['ai','human'])};
const action=z.discriminatedUnion('type',[
  z.strictObject({type:z.literal('move_to'),target:z.strictObject({x:z.number().finite(),y:z.number().finite()})}),
  z.strictObject({type:z.literal('interact'),target:z.enum(STATION_IDS)}),
  z.strictObject({type:z.literal('cancel')}),
]);
const empty=z.strictObject({});
const version={ruleset_id:z.unknown().optional()};
const control={control_token:z.string().min(1).max(128).optional()};
const mismatch=(v:unknown)=>v!==RULESET_ID?output({code:'RULESET_MISMATCH',ruleset_id:RULESET_ID},true):null;
function output(value:object,isError=false) {
  const structuredContent=value as Record<string,unknown>;
  return {structuredContent,content:[{type:'text' as const,text:JSON.stringify(value)}],...(isError?{isError:true}:{})};
}

/** Transport identity is internal; a room-issued capability can bridge reconnects. */
export function createGameMcpServer(room:Room,sessionId:string,requestSignal?:(id:RequestId)=>AbortSignal|undefined):McpServer {
  const server=new McpServer({name:'pumpkin-kitchen',version:APP_VERSION});
  // Correlation only: this value is independent of the MCP session capability.
  const transport_tag=randomUUID();
  const denied=() => output({code:'FORBIDDEN',message:'Control token is invalid or no longer owns the AI seat.'},true);
  const read=(controlToken?:string) => {room.tick();const owned=room.touchExternal(sessionId,controlToken);return controlToken!==undefined&&!owned?denied():null;};
  const view=(observation:Observation,compact=false) => ({
    observation:compact?{...observation,events:[]}:observation,
    task_keys:Object.fromEntries(STATION_IDS.map(target=>[target,taskIntentKey(observation,target)])),
    ...(compact?{event_history:'omitted; use game_events for history'}:{}),
  });
  const observeTool=(controlToken?:string,compact=false) => {
    const bad=read(controlToken);if(bad)return bad;
    return output({...view(room.observe('ai'),compact),controller_status:room.getControllerStatus(),transport_tag});
  };
  const actTool=({ruleset_id,control_token,...command}:GameCommand&{ruleset_id?:unknown;control_token?:string}) => {
    const bad=mismatch(ruleset_id);if(bad)return bad;
    const result=room.submitExternal(sessionId,command,control_token);if('code' in result)return output(result,true);
    return output({receipt:result.receipt,...view(room.observe('ai'))},result.receipt.status==='rejected');
  };
  const waitTool=async(options:WaitOptions,controlToken?:string,signal?:AbortSignal) => {
    room.tick();const result=await room.waitForChange(sessionId,options,signal,controlToken);
    return output({...result,...view(result.observation)},['control_lost','gap','round_changed','closed','wait_limit','invalid_request'].includes(result.reason));
  };
  server.registerTool('game_brief',{description:'Read the AI teammate role, rules and observe/act/wait loop. Browser controls round start and human takeover.',inputSchema:empty},()=>{
    read();return output({ruleset_id:RULESET_ID,controller_protocol:'lease-token-v1',role:'AI teammate only; human seat and browser controls are never available to MCP.',world:WORLD,rules:{round_ms:ROUND_DURATION_MS,...KITCHEN_RULES,recipes:RECIPES,interact_radius:INTERACT_RADIUS,movement_speed:MOVEMENT_SPEED},recipe:['salad: chop pumpkin, cook in pot 6s, plate with chopped cucumber in either order','soup: cooked pumpkin in pot + cream, simmer 3s, pour into empty plate','Empty hand takes; held object places or combines. Only pots heat on burners. Carrying pauses heat. No fire or washing.','orders: accept pending order instantly; deliver matching plated recipe before its deadline. Expired accepted orders incur a fine.','Move to approach_points, never furniture centers. Use interaction_previews and stable item IDs. Cancel chopping before moving; progress remains on the board.'],loop:['game_join with ruleset_id; retain its private control_token','game_observe with control_token','game_act with control_token and ruleset_id plus observed state_version, generation and server_time_ms with unique action_id','game_wait with control_token, round_id, generation and cursor; optional action_id','observe and repeat until round_finished/control_lost; game_leave with control_token and ruleset_id when done'],limits:{wait_ms:15000,owner_idle_ms:30000},notes:'Pass the control_token returned by game_join on subsequent tools even if the host reconnects. It is revoked by takeover, round changes, leave or lease expiry. Wait returns to this active host session; it does not wake a finished chat. Reobserve on gap, stale state or stale generation; never silently replace command fields.'});
  });
  server.registerTool('game_join',{description:'Claim the AI seat and retain the returned private control_token for subsequent tools across connections. Requires ruleset_id. Refuses human control or another owner; a current control_token can resume its owner.',inputSchema:z.strictObject({...version,...control})},({ruleset_id,control_token})=>{const bad=mismatch(ruleset_id);if(bad)return bad;const result=room.claimExternal(sessionId,control_token);return 'code' in result?output({...result,transport_tag},true):output({...result,...view(result.observation),transport_tag});});
  server.registerTool('game_observe',{description:'Read the current AI state and task_keys. Use compact:true to omit historical events. Pass control_token to renew the 30 second owner lease.',inputSchema:z.strictObject({...control,compact:z.boolean().optional()})},({control_token,compact})=>observeTool(control_token,compact));
  server.registerTool('game_act',{description:'Submit control_token from game_join, ruleset_id and the exact full GameCommand for the AI seat. Preserves TTL, generation, version and action_id checks.',inputSchema:z.strictObject({...version,...control,...fields,action})},({ruleset_id,control_token,...command})=>{
    return actTool({ruleset_id,control_token,...command});
  });
  server.registerTool('game_cancel',{description:'Cancel owned AI work. Supply control_token from game_join, ruleset_id and full command metadata. Cannot control human.',inputSchema:z.strictObject({...version,...control,...fields})},({ruleset_id,control_token,...command})=>{
    const bad=mismatch(ruleset_id);if(bad)return bad;
    const result=room.submitExternal(sessionId,{...command,action:{type:'cancel'}},control_token);if('code' in result) return output(result,true);
    return output({receipt:result.receipt,...view(room.observe('ai'))},result.receipt.status==='rejected');
  });
  server.registerTool('game_events',{description:'Read incremental events. Pass control_token from game_join to renew ownership. On truncated, resynchronize from the returned observation.',inputSchema:z.strictObject({...control,after_cursor:integer})},({after_cursor,control_token})=>{const bad=read(control_token);if(bad)return bad;return output({...room.eventsSince(after_cursor),observation:room.observe('ai')});});
  server.registerTool('game_wait',{description:'Pass control_token from game_join; wait at most 15 seconds for action termination or meaningful changes. One wait per logical controller, including across connections.',inputSchema:z.strictObject({...control,generation:integer,round_id:integer,after_cursor:integer,action_id:z.string().min(1).max(128).optional(),timeout_ms:z.number().min(0).max(15000).default(15000)})},async({control_token,...options},extra)=>{
    room.tick();const disconnected=requestSignal?.(extra.requestId);
    const signal=disconnected?AbortSignal.any([extra.signal,disconnected]):extra.signal;
    return waitTool(options,control_token,signal);
  });
  server.registerTool('game_leave',{description:'Release AI control using control_token from game_join and ruleset_id. Never affects another owner. Invalid supplied tokens are rejected.',inputSchema:z.strictObject({...version,...control})},({ruleset_id,control_token})=>{const bad=mismatch(ruleset_id);if(bad)return bad;const released=room.releaseExternal(sessionId,control_token);return control_token!==undefined&&!released?denied():output({released,controller_status:room.getControllerStatus()});});
  server.registerTool('game_task',{
    description:'Do ONE selected station task: locally walk to target and perform exactly one operation, then return compact state and task_keys. Copy expected_key from task_keys[target] and round/generation/version/time from your last observation. TTL bounds task start, not cooking duration. Unrelated human movement may advance global version; changed target entities, takeover, expiry or round end stop this task. Never auto-joins or chooses the next task.',
    inputSchema:z.strictObject({...version,control_token:z.string().min(1).max(128),target:z.enum(STATION_IDS),operation:z.enum(operations),expected_key:z.string().regex(/^[a-f0-9]{64}$/),round_id:integer,seat_generation:integer,state_version:integer,issued_at_ms:z.number().finite(),ttl_ms:z.number().min(1).max(10000)})
  },async({ruleset_id,control_token,target,operation,expected_key,round_id,seat_generation,state_version,issued_at_ms,ttl_ms},extra)=>{
    const bad=mismatch(ruleset_id);if(bad)return bad;
    const forbidden=read(control_token);if(forbidden)return forbidden;
    const observation=room.observe('ai'),s=observation.snapshot;
    const stop=(reason:string)=>output({reason,receipts:[],...view(room.observe('ai'),true)},true);
    if(round_id!==s.round_id)return stop('round_changed');
    if(seat_generation!==s.seats.ai.generation)return stop('STALE_GENERATION');
    if(issued_at_ms>s.server_time_ms)return stop('FUTURE_COMMAND');
    if(issued_at_ms+ttl_ms<=s.server_time_ms)return stop('EXPIRED');
    if(state_version>s.state_version)return stop('STALE_STATE');
    if(s.phase!=='playing')return stop('round_finished');
    if(runningTasks.has(room))return stop('busy');
    if(expected_key!==taskIntentKey(observation,target))return stop('target_changed');
    runningTasks.add(room);
    try {
      const disconnected=requestSignal?.(extra.requestId);
      const signal=disconnected?AbortSignal.any([extra.signal,disconnected]):extra.signal;
      let moveActionId:string|undefined;
      // Existing semantic task, on this same authoritative room; no network per micro-step.
      const client:Pick<Client,'callTool'>={callTool:async request=>{
        const args=request.arguments??{};
        if(request.name==='game_observe')return observeTool(control_token);
        if(request.name==='game_act'){
          const command=args as unknown as GameCommand;
          const result=room.submitExternalTaskAction(sessionId,{action_id:command.action_id,action:command.action,
            seat_generation,round_id},current=>command.action.type==='cancel'
              ?moveActionId!==undefined&&current.snapshot.seats.ai.active_action?.action_id===moveActionId
              :!signal.aborted&&taskIntentKey(current,target)===expected_key,control_token);
          if('code' in result)return output(result,true);
          if(command.action.type==='move_to'&&result.receipt.status==='accepted')moveActionId=command.action_id;
          return output({receipt:result.receipt,...view(room.observe('ai'))},result.receipt.status==='rejected');
        }
        if(request.name==='game_wait'){
          const {control_token:token,...options}=args;
          return waitTool(options as unknown as WaitOptions,token as string,signal);
        }
        return output({code:'FORBIDDEN'},true);
      }};
      const controller=new TeammateController(client,{control_token,observation});
      const result=await controller.perform(target,operation,signal);
      return output({...result,...view(result.observation,true)},result.reason!=='completed');
    }finally{runningTasks.delete(room);}
  });
  return server;
}



