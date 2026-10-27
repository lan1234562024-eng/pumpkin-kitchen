import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer } from '../src/server/index';

const servers: Awaited<ReturnType<typeof startServer>>[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map(server => server.close()));
});
const report = { type:'client_performance', version:1, visible:true, frame_count:120,
  frame_p95_ms:17, frame_max_ms:20, long_task_count:0, long_task_max_ms:0,
  snapshot_count:40, snapshot_gap_p95_ms:63, snapshot_handler_p95_ms:2,
  snapshot_age_ms:12, input_ack_count:3, input_ack_p95_ms:8, input_pending:0 };
async function setup() {
  const server = await startServer({port:0, tickMs:100000, now:()=>0});
  servers.push(server);
  const socket = new WebSocket(server.address.replace('http','ws')+'/game-ws');
  sockets.push(socket);
  const first = new Promise<any>((resolve,reject) => { socket.once('message',data=>resolve(JSON.parse(data.toString()))); socket.once('error',reject); });
  const initial = await first;
  const read = async () => (await fetch(server.address+'/debug/performance')).json();
  return {server,socket,initial,read};
}
describe('bounded client performance diagnostics', () => {
  it('stores reports without advancing the room or broadcasting game state', async () => {
    const {socket,initial,read} = await setup();
    let messages = 0;
    socket.on('message',()=>messages++);
    socket.send(JSON.stringify(report));
    await expect.poll(async () => (await read()).clients?.length).toBe(1);
    const metrics = await read();
    expect(metrics.clients[0]).toMatchObject({report});
    expect(metrics).toMatchObject({version:1,server:{connected_clients:1}});
    expect(messages).toBe(0);
    expect(initial.snapshot).toMatchObject({phase:'lobby',round_id:0});
  });
  it('rejects smuggled fields and nonfinite values without retaining them', async () => {
    const {socket,read} = await setup();
    const receive = () => new Promise<any>(resolve => socket.once('message',data=>resolve(JSON.parse(data.toString()))));
    for (const invalid of [{...report,action:{type:'move_to'}},{...report,frame_max_ms:null}]) {
      const result = receive(); socket.send(JSON.stringify(invalid));
      expect(await result).toMatchObject({type:'error',code:'INVALID_MESSAGE'});
      expect((await read()).clients).toEqual([]);
    }
  });
  it('retains the last foreground window after the page returns to the background', async () => {
    const {socket,read} = await setup();
    socket.send(JSON.stringify(report));
    await expect.poll(async () => (await read()).clients?.length).toBe(1);
    const barrier = new Promise<any>(resolve => socket.once('message',data=>resolve(JSON.parse(data.toString()))));
    socket.send(JSON.stringify({...report,visible:false,frame_count:0}));
    socket.send(JSON.stringify({type:'diagnostic_test_barrier'}));
    expect(await barrier).toMatchObject({type:'error',code:'INVALID_MESSAGE'});
    const client = (await read()).clients[0];
    expect(client.report.visible).toBe(false);
    expect(client.foreground.report).toEqual(report);
    expect(client.foreground.report_age_ms).toBeGreaterThanOrEqual(0);
  });
  it('drops client diagnostic data when its socket closes', async () => {
    const {socket,read} = await setup(); socket.send(JSON.stringify(report));
    await expect.poll(async () => (await read()).clients?.length).toBe(1);
    socket.close();
    await expect.poll(async () => (await read()).clients?.length).toBe(0);
  });
  it('restricts the diagnostic read to trusted requests and GET', async () => {
    const {server} = await setup(); const url = server.address+'/debug/performance';
    expect((await fetch(url,{headers:{Origin:'https://attacker.example'}})).status).toBe(403);
    expect((await fetch(url,{method:'POST'})).status).toBe(405);
  });
});
