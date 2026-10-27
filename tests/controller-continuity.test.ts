import {afterEach,describe,expect,it} from 'vitest';
import {createServer} from 'node:http';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createRoom} from '../src/server/room';
import {createGameMcpHttp} from '../src/mcp/http';
import {RULESET_ID} from '../src/shared/ruleset';

type Room=ReturnType<typeof createRoom>;
const rooms:Room[]=[];
const cleanups:Array<()=>Promise<void>>=[];
afterEach(async()=>{
  for(const cleanup of cleanups.splice(0)) await cleanup();
  for(const room of rooms.splice(0)) room.close();
});
function fixture(){
  let time=0;const room=createRoom(()=>time);rooms.push(room);
  return {room,setTime:(value:number)=>{time=value;}};
}
function tokenFor(room:Room,session='original'){
  const result=room.claimExternal(session);
  expect(result).not.toHaveProperty('code');
  expect(result).toHaveProperty('control_token',expect.any(String));
  if('code' in result) throw Error(result.code);
  expect(result.control_token.length).toBeGreaterThanOrEqual(32);
  return result.control_token;
}
function command(room:Room,id='continuity-action'){
  const observation=room.observe('ai');
  return {action_id:id,seat_id:'ai' as const,
    seat_generation:observation.snapshot.seats.ai.generation,
    state_version:observation.snapshot.state_version,
    issued_at_ms:observation.server_time_ms,ttl_ms:1000,
    action:{type:'cancel' as const}};
}
function expectOwned(room:Room,session:string,token?:string,id?:string){
  expect(room.submitExternal(session,command(room,id),token))
    .toMatchObject({receipt:{status:'rejected',error:'NOT_PLAYING'}});
}
const data=(result:Awaited<ReturnType<Client['callTool']>>)=>result.structuredContent as Record<string,any>;
async function httpFixture(){
  const {room}=fixture();const http=createGameMcpHttp(room);
  const server=createServer((req,res)=>{void http.handle(req,res);});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string') throw Error('Missing address');
  const clients:Array<{client:Client;transport:StreamableHTTPClientTransport}>=[];
  cleanups.push(async()=>{
    for(const {client,transport} of clients){await transport.terminateSession().catch(()=>{});await client.close().catch(()=>{});}
    await http.close();
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  });
  const connect=async()=>{
    const client=new Client({name:'continuity-test',version:'1'});
    const transport=new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
    clients.push({client,transport});await client.connect(transport);return {client,transport};
  };
  return {room,connect};
}

describe('logical AI controller continuity',()=>{
  it('issues a private token and authorizes a distinct transport without exposing it in observations or events',()=>{
    const {room}=fixture();const token=tokenFor(room);
    room.touchExternal('replacement',token);
    expectOwned(room,'replacement',token);
    expect(JSON.stringify(room.observe('ai'))).not.toContain(token);
    expect(JSON.stringify(room.eventsSince(0))).not.toContain(token);
    expect(room.submitExternal('unrelated',command(room,'unrelated'))).toMatchObject({code:'FORBIDDEN'});
  });

  it('rejects an invalid supplied token even on the original owning transport',()=>{
    const {room}=fixture();const token=tokenFor(room);
    expect(room.touchExternal('original','invalid-control-token')).toBe(false);
    expect(room.claimExternal('original','invalid-control-token')).toMatchObject({code:'FORBIDDEN'});
    expect(room.releaseExternal('original','invalid-control-token')).toBe(false);
    expect(room.submitExternal('original',command(room),'invalid-control-token')).toMatchObject({code:'FORBIDDEN'});
    expectOwned(room,'original',token,'valid-after-invalid');
  });

  it('keeps token-based ownership on disconnect while preserving legacy tokenless release',()=>{
    const legacy=fixture().room;tokenFor(legacy);
    legacy.disconnectExternal('original');
    expect(legacy.getControllerStatus().connected).toBe(false);
    expect(legacy.claimExternal('next')).not.toHaveProperty('code');
    const room=fixture().room;const token=tokenFor(room);
    room.touchExternal('replacement',token);room.disconnectExternal('original');
    expect(room.getControllerStatus().connected).toBe(true);
    expectOwned(room,'replacement',token);
  });

  it('makes a valid-token rejected act portable without renewing the lease',()=>{
    const {room,setTime}=fixture();const token=tokenFor(room);setTime(10000);room.tick();
    expectOwned(room,'replacement',token);
    room.disconnectExternal('original');
    expect(room.getControllerStatus().connected).toBe(true);
    expectOwned(room,'replacement',token,'still-owned');
    setTime(30000);room.tick();
    expect(room.submitExternal('replacement',command(room,'expired'),token)).toMatchObject({code:'FORBIDDEN'});
  });

  it('makes a valid-token stale-generation wait portable without renewing the lease',async()=>{
    const {room,setTime}=fixture();const token=tokenFor(room);setTime(10000);room.tick();
    const observation=room.observe('ai');
    const result=await room.waitForChange('replacement',{
      generation:observation.snapshot.seats.ai.generation-1,round_id:observation.snapshot.round_id,
      after_cursor:room.eventsSince(0).cursor,timeout_ms:0},undefined,token);
    expect(result.reason).toBe('control_lost');
    room.disconnectExternal('original');
    expect(room.getControllerStatus().connected).toBe(true);
    expectOwned(room,'replacement',token);
    setTime(30000);room.tick();
    expect(room.submitExternal('replacement',command(room,'expired'),token)).toMatchObject({code:'FORBIDDEN'});
  });

  it.each(['takeover','round-start','round-end','lease-expiry','leave'] as const)('revokes the token after %s',reason=>{
    const {room,setTime}=fixture();
    if(reason==='round-end') room.startRound();
    const token=tokenFor(room);
    room.touchExternal('replacement',token);
    if(reason==='takeover') room.takeover('ai');
    if(reason==='round-start') room.startRound();
    if(reason==='round-end'){setTime(90000);room.tick();}
    if(reason==='lease-expiry'){setTime(30000);room.tick();}
    if(reason==='leave') expect(room.releaseExternal('replacement',token)).toBe(true);
    expect(room.submitExternal('replacement',command(room),token)).toMatchObject({code:'FORBIDDEN'});
    // The old transport must not retain a fallback capability after revocation.
    expect(room.submitExternal('original',command(room,'old-transport'))).toMatchObject({code:'FORBIDDEN'});
    expect(room.claimExternal('replacement',token)).toMatchObject({code:'FORBIDDEN'});
  });

  it('allows only one wait per logical owner across transports',async()=>{
    const {room}=fixture();const token=tokenFor(room);const observation=room.observe('ai');
    const options={generation:observation.snapshot.seats.ai.generation,round_id:observation.snapshot.round_id,
      after_cursor:room.eventsSince(0).cursor,timeout_ms:15000};
    const abort=new AbortController();
    const first=room.waitForChange('first',options,abort.signal,token);
    try{
      expect(room.getControllerStatus().waiting).toBe(true);
      expect(await room.waitForChange('second',options,undefined,token)).toMatchObject({reason:'wait_limit'});
    }finally{abort.abort();await first;}
    expect(room.getControllerStatus().waiting).toBe(false);
  });

  it('continues observe and act over independent HTTP sessions after the original closes',async()=>{
    const {room,connect}=await httpFixture();room.startRound();
    const a=await connect(),b=await connect();
    const joined=data(await a.client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}}));
    expect(joined.control_token).toEqual(expect.any(String));
    const observed=data(await b.client.callTool({name:'game_observe',arguments:{control_token:joined.control_token}}));
    expect(observed.controller_status.connected).toBe(true);
    expect(JSON.stringify(observed)).not.toContain(joined.control_token);
    await a.transport.terminateSession();
    const acted=await b.client.callTool({name:'game_act',arguments:{ruleset_id:RULESET_ID,...command(room),control_token:joined.control_token}});
    expect(data(acted)).toMatchObject({receipt:{status:'accepted'}});
    expect(acted.isError).not.toBe(true);
    const events=await b.client.callTool({name:'game_events',arguments:{after_cursor:0,control_token:joined.control_token}});
    expect(JSON.stringify(events)).not.toContain(joined.control_token);
  });

  it('rejects an invalid token at the HTTP read boundary without falling back to session ownership',async()=>{
    const {connect}=await httpFixture();const {client}=await connect();
    const joined=data(await client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}}));
    const invalid=await client.callTool({name:'game_observe',arguments:{control_token:'invalid-control-token'}});
    expect(invalid).toMatchObject({isError:true});expect(data(invalid)).toMatchObject({code:'FORBIDDEN'});
    const invalidLeave=await client.callTool({name:'game_leave',arguments:{ruleset_id:RULESET_ID,control_token:'invalid-control-token'}});
    expect(invalidLeave).toMatchObject({isError:true});expect(data(invalidLeave)).toMatchObject({code:'FORBIDDEN'});
    const valid=await client.callTool({name:'game_observe',arguments:{control_token:joined.control_token}});
    expect(valid.isError).not.toBe(true);
  });
});
