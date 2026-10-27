import {describe,it,expect} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';
import {startServer} from '../src/server/index';
import {RULESET_ID} from '../src/shared/ruleset';
import {approachFor} from '../src/game/navigation';
import type {GameSnapshot,SeatId,StationId,SemanticAction,Observation,GameCommand} from '../src/shared/contracts';
import type {ServerMessage} from '../src/shared/protocol';

describe('real browser-protocol human and HTTP MCP teammate',()=>{
 it.each(['pumpkin_salad','pumpkin_soup'] as const)('cooks and delivers %s through both transports',async recipe=>{
  let now=0,sequence=0;const service=await startServer({port:0,now:()=>now,tickMs:100000});
  const browser=new WebSocket(service.address.replace('http','ws')+'/game-ws');
  const messages:ServerMessage[]=[],listeners:Array<{predicate:(m:ServerMessage)=>boolean;resolve:(m:ServerMessage)=>void}>=[];
  browser.on('message',raw=>{const m=JSON.parse(raw.toString()) as ServerMessage;const listener=listeners.find(l=>l.predicate(m));if(listener){listeners.splice(listeners.indexOf(listener),1);listener.resolve(m);}else messages.push(m);});
  const next=(predicate:(m:ServerMessage)=>boolean):Promise<ServerMessage>=>{const index=messages.findIndex(predicate);if(index>=0)return Promise.resolve(messages.splice(index,1)[0]);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Missing transport reply')),2000);listeners.push({predicate,resolve:m=>{clearTimeout(timer);resolve(m);}});});};
  const client=new Client({name:'pumpkin-integration',version:'0.3.0'}),transport=new StreamableHTTPClientTransport(new URL(service.address+'/mcp'));
  try{
   await new Promise<void>((resolve,reject)=>{browser.once('open',resolve);browser.once('error',reject);});await next(m=>m.type==='snapshot');
   browser.send(JSON.stringify({type:'start_round',ruleset_id:RULESET_ID}));await next(m=>m.type==='snapshot'&&m.snapshot.phase==='playing');
   browser.send(JSON.stringify({type:'set_demo',ruleset_id:RULESET_ID,enabled:false}));await next(m=>m.type==='snapshot'&&m.snapshot.seats.ai.controller==='external');
   await client.connect(transport);expect((await client.listTools()).tools).toHaveLength(9);
   const joined=await client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}});expect(joined.isError).not.toBe(true);
   const control_token=(joined.structuredContent as {control_token:string}).control_token;
   const observation=async()=>((await client.callTool({name:'game_observe',arguments:{control_token}})).structuredContent as {observation:Observation}).observation;
   const act=async(seat:SeatId,action:SemanticAction)=>{const o=await observation(),s=o.snapshot;const command:GameCommand={action_id:`integration-${++sequence}`,seat_id:seat,seat_generation:s.seats[seat].generation,state_version:s.state_version,issued_at_ms:s.server_time_ms,ttl_ms:10000,action};
    if(seat==='ai'){const r=await client.callTool({name:'game_act',arguments:{ruleset_id:RULESET_ID,control_token,...command}});expect(r.structuredContent).toMatchObject({receipt:{status:'accepted'}});}else {browser.send(JSON.stringify({type:'command',ruleset_id:RULESET_ID,command}));expect(await next(m=>m.type==='result'&&m.receipt.action_id===command.action_id)).toMatchObject({receipt:{status:'accepted'}});}return command;
   };
   const wait=async(ms:number)=>{now+=ms;return observation();};
   const station=async(seat:SeatId,target:StationId)=>{const o=await observation();await act(seat,{type:'move_to',target:approachFor(o.snapshot.seats[seat].position,target)!});let s:GameSnapshot;let attempts=0;do {s=(await wait(50)).snapshot;if(++attempts>200)throw Error('Movement never completed');}while(s.seats[seat].active_action);};
   const use=async(seat:SeatId,target:StationId)=>{await station(seat,target);return act(seat,{type:'interact',target});};
   const cut=async(ingredient:'pumpkin'|'cucumber')=>{await use('human',`source_${ingredient}`);await use('human','chop');await wait(ingredient==='pumpkin'?2000:1500);await act('human',{type:'interact',target:'chop'});};
   await use('human','orders');
   if(recipe==='pumpkin_soup'){now=12000;await observation();await act('human',{type:'interact',target:'orders'});}
   await cut('pumpkin');await use('human','handoff_a');await use('ai','handoff_a');await use('ai','burner_a');
   if(recipe==='pumpkin_salad'){await cut('cucumber');await use('human','handoff_b');await wait(6000);await use('ai','plates');await use('ai','burner_a');await use('ai','counter_right');await use('ai','handoff_b');await use('ai','counter_right');await act('ai',{type:'interact',target:'counter_right'});}
   else {await wait(6000);await use('ai','source_cream');await use('ai','burner_a');await wait(3000);await use('ai','plates');await use('ai','burner_a');}
   await station('ai','delivery');const delivery=await act('ai',{type:'interact',target:'delivery'});const delivered=(await observation()).snapshot;
   expect(delivered.score).toBe(1);expect(delivered.revenue).toBe(recipe==='pumpkin_salad'?30:40);expect(delivered.seats.ai.held_item_id).toBeNull();expect(Object.values(delivered.items).filter(i=>i.kind==='pot')).toHaveLength(2);
   const refs=[...Object.values(delivered.slots),...Object.values(delivered.seats).map(s=>s.held_item_id),...Object.values(delivered.items).flatMap(i=>i.kind==='ingredient'?[]:i.contents)].filter(Boolean);expect(new Set(refs).size).toBe(refs.length);expect(refs.length).toBe(Object.keys(delivered.items).length);
   expect((await client.callTool({name:'game_act',arguments:{ruleset_id:RULESET_ID,control_token,...delivery}})).structuredContent).toMatchObject({receipt:{status:'accepted'}});expect((await observation()).snapshot.score).toBe(1);
  }finally{await transport.terminateSession().catch(()=>{});await client.close();browser.terminate();await service.close();}
 },20000);
});

