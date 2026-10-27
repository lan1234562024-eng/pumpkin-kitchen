import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { startServer } from '../src/server/index';

const servers: Awaited<ReturnType<typeof startServer>>[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map(server => server.close()));
  vi.restoreAllMocks();
});
const nextMessage = (socket: WebSocket) => new Promise<any>((resolve,reject) => {
  socket.once('message',data=>resolve(JSON.parse(data.toString())));
  socket.once('error',reject);
});
async function setup() {
  let serverSocket: WebSocket | undefined;
  let blocked = false, queuedBytes = 0, queuedSnapshots = 0, time = 0;
  const originalSend = WebSocket.prototype.send;
  // Keep real client/server I/O; only the server's stalled outbound snapshots
  // are held here so backpressure is deterministic without a long flood test.
  vi.spyOn(WebSocket.prototype,'send').mockImplementation(function(this: WebSocket,data: any,...args: any[]) {
    serverSocket ??= this;
    if (this===serverSocket && blocked && JSON.parse(data.toString()).type==='snapshot') {
      queuedBytes += Buffer.byteLength(data.toString()); queuedSnapshots++; return;
    }
    Reflect.apply(originalSend,this,[data,...args]);
  });
  const server = await startServer({port:0,tickMs:100000,now:()=>time}); servers.push(server);
  const socket = new WebSocket(server.address.replace('http','ws')+'/game-ws'); sockets.push(socket);
  const initial = await nextMessage(socket);
  vi.spyOn(serverSocket!,'bufferedAmount','get').mockImplementation(()=>queuedBytes);
  const send = (message: object) => socket.send(JSON.stringify(message));
  return {socket,initial,send,
    block:()=>{blocked=true;},
    drain:()=>{blocked=false;queuedBytes=0;},
    saturate:()=>{queuedBytes=16*1024*1024;},
    queued:()=>queuedSnapshots,
    setTime:(value:number)=>{time=value;},
  };
}
describe('bounded WebSocket snapshots', () => {
  it('does not accumulate stale snapshots while blocked and resumes with current state', async () => {
    const client = await setup(); const ruleset_id = client.initial.snapshot.ruleset_id;
    client.block();
    const barrier = nextMessage(client.socket);
    for (let i=0;i<40;i++) client.send({type:'set_demo',ruleset_id,enabled:i%2===0});
    client.send({type:'test_barrier'});
    expect(await barrier).toMatchObject({type:'error',code:'INVALID_MESSAGE'});
    expect(client.queued()).toBe(1);
    client.drain(); client.setTime(1000);
    const resumed = nextMessage(client.socket);
    client.send({type:'set_demo',ruleset_id,enabled:false});
    expect(await resumed).toMatchObject({type:'snapshot',snapshot:{server_time_ms:1000,seats:{ai:{controller:'external'}}}});
  });
  it('delivers command results and errors while a snapshot is pending', async () => {
    const client = await setup(); const initial = client.initial.snapshot;
    client.block();
    client.send({type:'set_demo',ruleset_id:initial.ruleset_id,enabled:false});
    const result = nextMessage(client.socket);
    client.send({type:'command',ruleset_id:initial.ruleset_id,command:{action_id:'pending-snapshot-command',seat_id:'human',seat_generation:initial.seats.human.generation,state_version:initial.state_version,issued_at_ms:0,ttl_ms:1000,action:{type:'cancel'}}});
    expect(await result).toMatchObject({type:'result',receipt:{action_id:'pending-snapshot-command',status:'rejected'}});
    const error = nextMessage(client.socket); client.send({type:'invalid'});
    expect(await error).toMatchObject({type:'error',code:'INVALID_MESSAGE'});
    expect(client.socket.readyState).toBe(WebSocket.OPEN);
  });
  it('disconnects a saturated connection instead of silently dropping a reliable result', async () => {
    const client = await setup(); client.saturate();
    const received: any[] = []; client.socket.on('message',data=>received.push(JSON.parse(data.toString())));
    const closed = new Promise<number>(resolve=>client.socket.once('close',code=>resolve(code)));
    client.send({type:'invalid'});
    await expect.poll(()=>client.socket.readyState).toBe(WebSocket.CLOSED);
    expect(await closed).toBe(1006);
    expect(received).toEqual([]);
  });
});
