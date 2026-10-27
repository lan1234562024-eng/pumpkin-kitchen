import {RULESET_ID} from '../src/shared/ruleset';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer } from '../src/server/index';
import type { ServerMessage } from '../src/shared/protocol';

const servers: Awaited<ReturnType<typeof startServer>>[]=[];
const clients: WebSocket[]=[];
afterEach(async()=>{for(const client of clients.splice(0)) client.terminate();await Promise.all(servers.splice(0).map(s=>s.close()));});
async function server(options: Parameters<typeof startServer>[0]={}) {const s=await startServer({port:0,tickMs:100000,...options});servers.push(s);return s;}
async function connect(address: string, origin?: string) {
  const socket=new WebSocket(`${address.replace('http','ws')}/game-ws`,origin?{origin}:{});clients.push(socket);
  const messages: ServerMessage[]=[];const waiters: {predicate:(m:ServerMessage)=>boolean;resolve:(m:ServerMessage)=>void}[]=[];
  socket.on('message',data=>{const m=JSON.parse(data.toString()) as ServerMessage;const w=waiters.find(w=>w.predicate(m));if(w){waiters.splice(waiters.indexOf(w),1);w.resolve(m);}else messages.push(m);});
  await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  const next=(predicate:(m:ServerMessage)=>boolean)=>{const index=messages.findIndex(predicate);if(index>=0) return Promise.resolve(messages.splice(index,1)[0]);return new Promise<ServerMessage>(resolve=>waiters.push({predicate,resolve}));};
  return {socket,next};
}
const snapshot=(m:ServerMessage)=>m.type==='snapshot';
describe('local websocket service',()=>{
  it('refuses old and missing rulesets before advancing any room state',async()=>{let time=0;const s=await server({now:()=>time});const c=await connect(s.address);const before=await c.next(snapshot);time=1000;for(const type of ['start_round','takeover','human_input','command','set_demo'])for(const version of [{},{ruleset_id:'old'}]){c.socket.send(JSON.stringify({type,...version}));expect(await c.next(m=>m.type==='error')).toMatchObject({code:'RULESET_MISMATCH'});}const next=await connect(s.address);expect(await next.next(snapshot)).toEqual(before);});
  it('sends consistent snapshots to two clients and reconnects at current state',async()=>{
    const s=await server({now:()=>100});const a=await connect(s.address),b=await connect(s.address);
    expect(await a.next(snapshot)).toEqual(await b.next(snapshot));
    a.socket.send(JSON.stringify({ruleset_id:RULESET_ID,type:'start_round'}));
    const playing=await a.next(m=>m.type==='snapshot'&&m.snapshot.phase==='playing');
    expect(await b.next(m=>m.type==='snapshot'&&m.snapshot.phase==='playing')).toEqual(playing);
    const c=await connect(s.address);expect(await c.next(snapshot)).toEqual(playing);
    expect(playing).not.toHaveProperty('snapshot.receipts');
  });
  it('rejects malformed messages and forged AI commands while continuing service',async()=>{
    const s=await server({now:()=>100});const c=await connect(s.address);const initial=await c.next(snapshot);
    if(initial.type!=='snapshot') throw new Error('snapshot missing');
    for(const payload of ['{',JSON.stringify({type:'unknown'}),JSON.stringify({ruleset_id:RULESET_ID,type:'set_demo',enabled:'yes'}),JSON.stringify({ruleset_id:RULESET_ID,type:'start_round',actor:'external'})]) {
      c.socket.send(payload);expect((await c.next(m=>m.type==='error')).type).toBe('error');
    }
    c.socket.send(JSON.stringify({ruleset_id:RULESET_ID,type:'command',command:{action_id:'forge',seat_id:'ai',seat_generation:0,state_version:0,issued_at_ms:100,ttl_ms:1000,action:{type:'cancel'}}}));
    expect(await c.next(m=>m.type==='error')).toMatchObject({type:'error',code:'FORBIDDEN'});
    c.socket.send(JSON.stringify({ruleset_id:RULESET_ID,type:'start_round'}));expect(await c.next(m=>m.type==='snapshot'&&m.snapshot.phase==='playing')).toMatchObject({type:'snapshot'});
    const oversized=await connect(s.address);await oversized.next(snapshot);
    const closed=new Promise<number>(resolve=>oversized.socket.once('close',resolve));
    oversized.socket.send('x'.repeat(16385));expect(await closed).toBe(1009);
  });
  it('returns command receipts and broadcasts takeover with controller authority',async()=>{
    const s=await server({now:()=>100});const c=await connect(s.address);await c.next(snapshot);
    c.socket.send(JSON.stringify({ruleset_id:RULESET_ID,type:'start_round'}));const started=await c.next(m=>m.type==='snapshot'&&m.snapshot.phase==='playing');if(started.type!=='snapshot') throw Error();
    c.socket.send(JSON.stringify({ruleset_id:RULESET_ID,type:'command',command:{action_id:'human-cancel',seat_id:'human',seat_generation:started.snapshot.seats.human.generation,state_version:started.snapshot.state_version,issued_at_ms:100,ttl_ms:1000,action:{type:'cancel'}}}));
    expect(await c.next(m=>m.type==='result')).toMatchObject({type:'result',receipt:{status:'accepted'}});
    c.socket.send(JSON.stringify({ruleset_id:RULESET_ID,type:'takeover',seat_id:'ai'}));expect(await c.next(m=>m.type==='snapshot'&&m.snapshot.seats.ai.controller==='human')).toMatchObject({type:'snapshot'});
  });
  it('rejects forbidden origins, wrong paths and public bind addresses',async()=>{
    const s=await server();
    for(const [path,origin] of [['/game-ws','https://untrusted.example'],['/wrong','http://127.0.0.1:5173']]) {
      const socket=new WebSocket(`${s.address.replace('http','ws')}${path}`,{origin});clients.push(socket);
      await new Promise<void>(resolve=>socket.once('error',()=>resolve()));expect(socket.readyState).not.toBe(WebSocket.OPEN);
    }
    await expect(startServer({host:'0.0.0.0',port:0})).rejects.toThrow(/loopback/i);
    const c=await connect(s.address,'http://127.0.0.1:5173');expect(await c.next(snapshot)).toMatchObject({type:'snapshot'});
  });
  it('broadcasts ticks and closes active and connecting sockets without hanging',async()=>{
    let time=0;const s=await server({now:()=>time,tickMs:5});const c=await connect(s.address);await c.next(snapshot);time=500;
    expect(await c.next(m=>m.type==='snapshot'&&m.snapshot.server_time_ms===500)).toMatchObject({type:'snapshot'});
    const connecting=new WebSocket(`${s.address.replace('http','ws')}/game-ws`);connecting.on('error',()=>{});clients.push(connecting);
    const closed=new Promise<void>(resolve=>c.socket.once('close',()=>resolve()));
    await s.close();await s.close();await closed;expect(c.socket.readyState).toBe(WebSocket.CLOSED);
  });
});
