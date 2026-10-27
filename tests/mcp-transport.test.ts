import {RULESET_ID} from '../src/shared/ruleset';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../src/server/index';
import { request,createServer } from 'node:http';
import {createRoom} from '../src/server/room';
import {createGameMcpHttp} from '../src/mcp/http';

const servers: Awaited<ReturnType<typeof startServer>>[]=[];
const clients: {client:Client;transport:StreamableHTTPClientTransport|StdioClientTransport}[]=[];
afterEach(async()=>{for(const {client} of clients.splice(0))await client.close();await Promise.all(servers.splice(0).map(server=>server.close()));});
async function setup(){const server=await startServer({port:0});servers.push(server);return server;}
async function connect(address:string){const client=new Client({name:'test',version:'1'});const transport=new StreamableHTTPClientTransport(new URL(address+'/mcp'));clients.push({client,transport});await client.connect(transport);return {client,transport};}
const data=(result:Awaited<ReturnType<Client['callTool']>>) => result.structuredContent as Record<string,any>;
describe('standard MCP transports',()=>{
  it('correlates each HTTP request without creating an MCP session capability',async()=>{
    const s=await setup();const a=await connect(s.address),b=await connect(s.address);
    const joined=data(await a.client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}}));
    const observed=data(await a.client.callTool({name:'game_observe',arguments:{control_token:joined.control_token}}));
    const other=data(await b.client.callTool({name:'game_observe',arguments:{}}));
    expect(joined.transport_tag).toEqual(expect.any(String));
    expect(observed.transport_tag).not.toBe(joined.transport_tag);
    expect(other.transport_tag).not.toBe(joined.transport_tag);
    expect(a.transport.sessionId).toBeUndefined();
    expect(observed.controller_status.connected).toBe(true);
  });
  it('rejects an invalid ruleset without advancing or expiring room ownership',async()=>{
    let time=0;const room=createRoom(()=>time),http=createGameMcpHttp(room,{now:()=>time});
    const server=createServer((req,res)=>{void http.handle(req,res);});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error();
    const a=await connect('http://127.0.0.1:'+address.port);
    try{
      const joined=data(await a.client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}}));
      const before=room.getSnapshot();time=300000;
      const result=await a.client.callTool({name:'game_join',arguments:{ruleset_id:'old',control_token:joined.control_token}});
      expect(data(result)).toMatchObject({code:'RULESET_MISMATCH'});
      expect(room.getSnapshot()).toEqual(before);
      const observed=data(await a.client.callTool({name:'game_observe',arguments:{}}));
      expect(observed.controller_status).toEqual({connected:false,waiting:false});
    }finally{await http.close();room.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it('discovers tools and enforces token ownership with safe AI observations',async()=>{
    const s=await setup();const a=await connect(s.address),b=await connect(s.address);
    expect(a.client.getServerVersion()?.name).toBe('pumpkin-kitchen');
    expect((await a.client.listTools()).tools.map(tool=>tool.name).sort()).toEqual(['game_act','game_brief','game_cancel','game_events','game_join','game_leave','game_observe','game_task','game_wait']);
    const join=await a.client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}});const joined=data(join);
    expect(joined).toHaveProperty('generation');
    expect(join.content).toEqual([{type:'text',text:JSON.stringify(join.structuredContent)}]);
    expect(await b.client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}})).toMatchObject({isError:true});
    const observation=data(await a.client.callTool({name:'game_observe',arguments:{control_token:joined.control_token}})).observation;
    expect(observation).toHaveProperty('seat_id','ai');expect(observation.snapshot).not.toHaveProperty('receipts');
    const command={ruleset_id:RULESET_ID,action_id:'lobby-action',seat_id:'ai',seat_generation:observation.snapshot.seats.ai.generation,state_version:observation.snapshot.state_version,issued_at_ms:observation.server_time_ms,ttl_ms:1000,action:{type:'cancel'}};
    expect(data(await a.client.callTool({name:'game_act',arguments:command})).code).toBe('FORBIDDEN');
    const rejected=await b.client.callTool({name:'game_act',arguments:{...command,control_token:joined.control_token}});
    expect(rejected).toMatchObject({isError:true});expect(data(rejected).receipt.error).toBe('NOT_PLAYING');
    await a.transport.terminateSession();
    expect(await b.client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}})).toMatchObject({isError:true});
    expect(data(await b.client.callTool({name:'game_leave',arguments:{ruleset_id:RULESET_ID,control_token:joined.control_token}})).released).toBe(true);
    expect(await b.client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}})).not.toMatchObject({isError:true});
  });
  it('rejects untrusted Host/Origin and oversized bodies',async()=>{
    const s=await setup();
    for(const headers of [{Host:'attacker.example'},{Origin:'https://attacker.example'}])expect(await new Promise<number|undefined>((resolve,reject)=>{const req=request(s.address+'/mcp',{headers},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();})).toBe(403);
    expect((await fetch(s.address+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(65537)})).status).toBe(413);
  });
  it('cancels a disconnected wait request without releasing its token owner',async()=>{
    const s=await setup();const a=await connect(s.address);const join=data(await a.client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}}));
    const req=request(s.address+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'}},res=>res.resume());req.on('error',()=>{});
    req.end(JSON.stringify({jsonrpc:'2.0',id:999,method:'tools/call',params:{name:'game_wait',arguments:{control_token:join.control_token,generation:join.generation,round_id:join.round_id,after_cursor:join.cursor,timeout_ms:15000}}}));
    const status=async()=>data(await a.client.callTool({name:'game_observe',arguments:{control_token:join.control_token}})).controller_status;
    for(let n=0;n<50;n++){if((await status()).waiting)break;await new Promise(resolve=>setImmediate(resolve));}
    expect(await status()).toEqual({connected:true,waiting:true});req.destroy();
    for(let n=0;n<50;n++){if(!(await status()).waiting)break;await new Promise(resolve=>setImmediate(resolve));}
    expect(await status()).toEqual({connected:true,waiting:false});
  });
  it('continues serving HTTP after five minutes while the AI lease expires normally',async()=>{
    let time=0;const s=await startServer({port:0,now:()=>time});servers.push(s);const a=await connect(s.address);
    await a.client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}});time=300000;
    expect(data(await a.client.callTool({name:'game_observe',arguments:{}})).controller_status).toEqual({connected:false,waiting:false});
    const b=await connect(s.address);expect(await b.client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}})).not.toMatchObject({isError:true});
  });
  it('rejects JSON-RPC batches before they can register a wait',async()=>{
    const s=await setup();const a=await connect(s.address);const join=data(await a.client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}}));
    const message={jsonrpc:'2.0',id:1000,method:'tools/call',params:{name:'game_wait',arguments:{control_token:join.control_token,generation:join.generation,round_id:join.round_id,after_cursor:join.cursor,timeout_ms:0}}};
    const response=await fetch(s.address+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify([message])});
    expect(response.status).toBe(400);await response.body?.cancel();
    expect(data(await a.client.callTool({name:'game_observe',arguments:{control_token:join.control_token}})).controller_status).toEqual({connected:true,waiting:false});
    expect(data(await a.client.callTool({name:'game_wait',arguments:message.params.arguments})).reason).toBe('timeout');
  });
  it('aborts only its disconnected station move before interacting',async()=>{
    let time=0;const room=createRoom(()=>time);room.startRound();
    const http=createGameMcpHttp(room),server=createServer((req,res)=>{void http.handle(req,res);});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error();
    const base='http://127.0.0.1:'+address.port,a=await connect(base);
    try{
      const join=data(await a.client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}}));
      const o=join.observation,p=o.snapshot;
      const req=request(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'}},res=>res.resume());req.on('error',()=>{});
      req.end(JSON.stringify({jsonrpc:'2.0',id:1001,method:'tools/call',params:{name:'game_task',arguments:{
        ruleset_id:RULESET_ID,control_token:join.control_token,target:'source_cucumber',operation:'source',expected_key:join.task_keys.source_cucumber,
        round_id:p.round_id,seat_generation:p.seats.ai.generation,state_version:p.state_version,issued_at_ms:o.server_time_ms,ttl_ms:10000}}}));
      const observed=async()=>data(await a.client.callTool({name:'game_observe',arguments:{compact:true,control_token:join.control_token}}));
      let current=await observed();
      for(let n=0;n<50&&!current.observation.snapshot.seats.ai.active_action;n++)current=await observed();
      expect(current.observation.snapshot.seats.ai.active_action?.type).toBe('move_to');
      req.destroy();
      for(let n=0;n<50&&current.observation.snapshot.seats.ai.active_action;n++)current=await observed();
      expect(current.observation.snapshot.seats.ai.active_action).toBeNull();
      expect(current.observation.snapshot.seats.ai.held_item_id).toBeNull();
      expect(current.controller_status).toEqual({connected:true,waiting:false});
      const next=current.observation,s=next.snapshot;
      const ticker=setInterval(()=>{time+=50;room.tick();},1);
      try{
        const result=data(await a.client.callTool({name:'game_task',arguments:{ruleset_id:RULESET_ID,control_token:join.control_token,
          target:'source_cucumber',operation:'source',expected_key:current.task_keys.source_cucumber,
          round_id:s.round_id,seat_generation:s.seats.ai.generation,state_version:s.state_version,issued_at_ms:next.server_time_ms,ttl_ms:10000}}));
        expect(result.reason).toBe('completed');
      }finally{clearInterval(ticker);}
    }finally{await http.close();room.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it('bridges stdio RPC transparently, keeping control on its explicit room token',async()=>{
    const s=await setup();const client=new Client({name:'stdio-test',version:'1'});
    const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','src/mcp/stdio.ts','--url',s.address+'/mcp'],cwd:process.cwd(),stderr:'pipe'});clients.push({client,transport});
    transport.stderr?.on('data',chunk=>process.stderr.write(chunk));await client.connect(transport);
    expect((await client.listTools()).tools).toHaveLength(9);
    expect(data(await client.callTool({name:'game_brief',arguments:{}}))).toHaveProperty('loop');
    const join=data(await client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}}));await client.close();
    const other=await connect(s.address);
    expect(await other.client.callTool({name:'game_join',arguments:{ruleset_id:RULESET_ID}})).toMatchObject({isError:true});
    expect(data(await other.client.callTool({name:'game_observe',arguments:{control_token:join.control_token}})).controller_status.connected).toBe(true);
    expect(data(await other.client.callTool({name:'game_leave',arguments:{ruleset_id:RULESET_ID,control_token:join.control_token}})).released).toBe(true);
  });
});
