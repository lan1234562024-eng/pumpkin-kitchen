import {RULESET_ID} from '../src/shared/ruleset';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer } from '../src/server/index';
import type { HumanInputMessage, ServerMessage } from '../src/shared/protocol';

const servers: Awaited<ReturnType<typeof startServer>>[]=[];
const sockets:WebSocket[]=[];
afterEach(async()=>{for(const socket of sockets.splice(0)) socket.terminate();await Promise.all(servers.splice(0).map(server=>server.close()));});
async function connect(address:string) {
  const socket=new WebSocket(`${address.replace('http','ws')}/game-ws`);sockets.push(socket);
  const messages:ServerMessage[]=[],history:ServerMessage[]=[];
  const waiters:{predicate:(message:ServerMessage)=>boolean;resolve:(message:ServerMessage)=>void}[]=[];
  socket.on('message',data=>{const message=JSON.parse(data.toString()) as ServerMessage;history.push(message);const waiter=waiters.find(waiter=>waiter.predicate(message));if(waiter){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(message);}else messages.push(message);});
  await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  const next=(predicate:(message:ServerMessage)=>boolean):Promise<ServerMessage>=>{
    const index=messages.findIndex(predicate);if(index>=0) return Promise.resolve(messages.splice(index,1)[0]);
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Expected WebSocket message did not arrive')),1000);waiters.push({predicate,resolve:message=>{clearTimeout(timer);resolve(message);}});});
  };
  return {socket,next,history,send:(message:unknown)=>socket.send(JSON.stringify(message))};
}
const isSnapshot=(message:ServerMessage)=>message.type==='snapshot';
function input(snapshot:Extract<ServerMessage,{type:'snapshot'}>,sequence:number,direction:HumanInputMessage['direction']):HumanInputMessage {
  return {type:'human_input',ruleset_id:RULESET_ID,seat_id:'human',seat_generation:snapshot.snapshot.seats.human.generation,round_id:snapshot.snapshot.round_id,sequence,direction};
}

describe('human keyboard WebSocket transport',()=>{
  it('broadcasts the released snapshot before acknowledging the matching zero sequence',async()=>{
    let time=0;const server=await startServer({port:0,tickMs:100000,now:()=>time});servers.push(server);
    const client=await connect(server.address);await client.next(isSnapshot);client.send({ruleset_id:RULESET_ID,type:'start_round'});
    const started=await client.next(message=>message.type==='snapshot'&&message.snapshot.phase==='playing');if(started.type!=='snapshot') throw Error();
    client.send(input(started,1,{x:1,y:0}));
    expect(await client.next(message=>message.type==='human_input_result'&&message.sequence===1)).toMatchObject({status:'accepted'});
    time=100;client.send(input(started,2,{x:0,y:0}));
    const ack=await client.next(message=>message.type==='human_input_result'&&message.sequence===2);
    expect(ack).toMatchObject({status:'accepted'});
    const preceding=client.history[client.history.indexOf(ack)-1];
    expect(preceding).toMatchObject({type:'snapshot',snapshot:{server_time_ms:100,seats:{human:{active_action:null,position:{x:276,y:320}}}}});
    if(preceding.type!=='snapshot') throw Error();
    client.send({ruleset_id:RULESET_ID,type:'command',command:{action_id:'after-release',seat_id:'human',seat_generation:preceding.snapshot.seats.human.generation,state_version:preceding.snapshot.state_version,issued_at_ms:time,ttl_ms:1000,action:{type:'move_to',target:{x:176,y:100}}}});
    expect(await client.next(message=>message.type==='result')).toMatchObject({receipt:{status:'accepted'}});
  });

  it('gives distinct sockets exclusive ownership and releases it on socket close',async()=>{
    const server=await startServer({port:0,tickMs:100000,now:()=>0});servers.push(server);
    const a=await connect(server.address),b=await connect(server.address);await a.next(isSnapshot);await b.next(isSnapshot);a.send({ruleset_id:RULESET_ID,type:'start_round'});
    const started=await a.next(message=>message.type==='snapshot'&&message.snapshot.phase==='playing');await b.next(message=>message.type==='snapshot'&&message.snapshot.phase==='playing');if(started.type!=='snapshot') throw Error();
    a.send(input(started,1,{x:1,y:0}));await a.next(message=>message.type==='human_input_result');
    b.send(input(started,1,{x:-1,y:0}));expect(await b.next(message=>message.type==='human_input_result')).toMatchObject({status:'rejected',error:'INPUT_OWNED'});
    a.socket.close();await b.next(message=>message.type==='snapshot'&&message.snapshot.seats.human.active_action===null);
    b.send(input(started,2,{x:-1,y:0}));expect(await b.next(message=>message.type==='human_input_result')).toMatchObject({status:'accepted'});
  });
});
