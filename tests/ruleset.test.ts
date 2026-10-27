import {describe,it,expect} from 'vitest';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createGameMcpServer} from '../src/mcp/server';
import {createRoom} from '../src/server/room';
import {isClientMessage} from '../src/shared/protocol';
import {RULESET_ID} from '../src/shared/ruleset';
describe('versioned side effects',()=>{
 it('requires a matching ruleset on every browser mutation envelope',()=>{for(const message of [{type:'start_round'},{type:'set_demo',enabled:false},{type:'takeover',seat_id:'ai'},{type:'human_input',seat_id:'human',seat_generation:1,round_id:1,sequence:1,direction:{x:0,y:0}},{type:'command',command:{action_id:'x',seat_id:'human',seat_generation:1,state_version:1,issued_at_ms:0,ttl_ms:1000,action:{type:'cancel'}}}]){expect(isClientMessage(message)).toBe(false);expect(isClientMessage({...message,ruleset_id:RULESET_ID})).toBe(true);expect(isClientMessage({...message,ruleset_id:'old'})).toBe(false);}});
 it('rejects missing/wrong MCP mutation versions before touching room time or lease',async()=>{let time=0;const room=createRoom(()=>time);room.startRound();const server=createGameMcpServer(room,'test'),client=new Client({name:'versions',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await server.connect(a);await client.connect(b);try{
  const joined=await client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}});expect(joined.isError).not.toBe(true);const before=room.getSnapshot();time=29999;
  const metadata={action_id:'x',state_version:before.state_version,issued_at_ms:0,ttl_ms:1000,seat_generation:before.seats.ai.generation,seat_id:'ai'};
  const task={control_token:(joined.structuredContent as {control_token:string}).control_token,round_id:before.round_id,seat_generation:before.seats.ai.generation,state_version:before.state_version,issued_at_ms:0,ttl_ms:1000,target:'source_cucumber',operation:'source',expected_key:'0'.repeat(64)};
  for(const [name,args] of [['game_join',{}],['game_leave',{}],['game_cancel',metadata],['game_act',{...metadata,action:{type:'cancel'}}],['game_task',task]] as const)for(const version of [{},{ruleset_id:'old'}]){const r=await client.callTool({name,arguments:{...args,...version}});expect(r.structuredContent).toMatchObject({code:'RULESET_MISMATCH'});expect(room.getSnapshot()).toEqual(before);}
  time=30000;room.tick();expect(room.getControllerStatus().connected).toBe(false);
 }finally{await client.close();await server.close();room.close();}});
});

