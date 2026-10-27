import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { createRoom } from './room';
import { isClientMessage,hasMatchingRuleset, MAX_MESSAGE_BYTES, type ServerMessage } from '../shared/protocol';
import { createGameMcpHttp, DEFAULT_ORIGINS, isTrustedRequest, type McpHttpDiagnostic } from '../mcp/http';
import { isClientPerformanceReport, type ClientPerformanceReport } from '../shared/performance';

export interface ServerOptions {
  host?: string;
  port?: number;
  now?: () => number;
  tickMs?: number;
  allowedOrigins?: string[];
}
type McpRequest = {request:number;at_ms:number};
type McpResponse = McpRequest & {status:number;rpc:string|null;reason:string|null};
type McpAborted = McpRequest & {rpc:string|null;reason:string};
export interface RuntimeStatus {
  backend:{listening:boolean;uptime_ms:number};
  mcp:{request_count:number;last_request:McpRequest|null;aborted_count:number;last_aborted:McpAborted|null;
    response_count:number;last_response:McpResponse|null;last_error:McpResponse|null};
}
export interface RunningServer { address: string; getStatus(): RuntimeStatus; close(): Promise<void> }

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const {host = '127.0.0.1',port = 5230,now = Date.now,tickMs = 50,allowedOrigins = DEFAULT_ORIGINS} = options;
  if (!['127.0.0.1','::1'].includes(host)) throw new Error('Server must bind a literal loopback address.');
  if (!Number.isFinite(tickMs) || tickMs <= 0) throw new Error('tickMs must be positive.');
  const room = createRoom(now);
  const startedAt=performance.now();
  const mcpStatus:RuntimeStatus['mcp']={request_count:0,last_request:null,aborted_count:0,last_aborted:null,
    response_count:0,last_response:null,last_error:null};
  const mcp=createGameMcpHttp(room,{now,allowedOrigins,onDiagnostic:(event:McpHttpDiagnostic)=>{
    if(process.env.PUMPKIN_MCP_DIAGNOSTICS==='1') console.error(`[mcp-http] ${JSON.stringify(event)}`);
    const received={request:event.request,at_ms:Date.now()};
    if(event.phase==='request') {mcpStatus.request_count++;mcpStatus.last_request=received;return;}
    if(event.phase==='aborted') {
      mcpStatus.aborted_count++;mcpStatus.last_aborted={...received,rpc:event.rpc??null,reason:'response_closed'};return;
    }
    if(event.phase!=='response'||event.status===undefined) return;
    const response={...received,status:event.status,rpc:event.rpc??null,reason:event.reason??null};
    mcpStatus.response_count++;mcpStatus.last_response=response;
    if(event.status>=400) mcpStatus.last_error=response;
  }});
  // Bounded, in-memory diagnostic data only; no inputs, credentials or game commands.
  type Sample = {receivedAt:number;report:ClientPerformanceReport};
  const clientPerformance = new Map<WebSocket,Sample & {foreground?:Sample}>();
  const tickTimes:number[]=[], broadcastTimes:number[]=[], tickGaps:number[]=[];
  const record = (samples:number[],value:number) => {samples.push(value);if(samples.length>300)samples.shift();};
  const p95 = (samples:number[]) => {const sorted=[...samples].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)]??0;};
  const server = createServer((request,response) => {
    if(request.url==='/mcp') {void mcp.handle(request,response).catch(()=>{if(!response.headersSent) response.writeHead(500);response.end();});return;}
    if(request.url==='/debug/performance') {
      const status=!isTrustedRequest(request,allowedOrigins)?403:request.method!=='GET'?405:200;
      response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});
      response.end(JSON.stringify(status!==200?{error:status===403?'forbidden':'method_not_allowed'}:{
        version:1,server:{connected_clients:ws.clients.size,tick_count:tickTimes.length,
          tick_compute_p95_ms:p95(tickTimes),broadcast_p95_ms:p95(broadcastTimes),tick_gap_p95_ms:p95(tickGaps)},
        clients:[...clientPerformance.values()].map(({receivedAt,report,foreground})=>({report_age_ms:performance.now()-receivedAt,report,
          ...(foreground?{foreground:{report_age_ms:performance.now()-foreground.receivedAt,report:foreground.report}}:{}),})), 
      }));return;
    }
    response.writeHead(request.url === '/health' ? 200 : 404,{'Content-Type':'application/json'});
    response.end(JSON.stringify(request.url === '/health' ? {ok:true} : {error:'not_found'}));
  });
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection',socket => { sockets.add(socket);socket.once('close',() => sockets.delete(socket)); });
  const ws = new WebSocketServer({noServer:true,maxPayload:MAX_MESSAGE_BYTES});
  let closing = false;
  const maxBufferedBytes = MAX_MESSAGE_BYTES * 16;
  const send = (client: WebSocket,message: ServerMessage) => {
    if (client.readyState !== WebSocket.OPEN) return;
    const buffered = client.bufferedAmount;
    // Stale full snapshots are replaceable; the next broadcast has current state.
    if (message.type === 'snapshot' && buffered > 0 && buffered < maxBufferedBytes) return;
    const payload = JSON.stringify(message);
    // Results/errors stay reliable. A saturated connection must fail visibly
    // rather than silently lose a receipt or retain an unbounded send queue.
    if (buffered + Buffer.byteLength(payload) + 14 > maxBufferedBytes) {client.terminate();return;}
    client.send(payload);
  };
  const snapshot = (): ServerMessage => {
    const observation = room.observe('human');
    return {type:'snapshot',snapshot:observation.snapshot,events:observation.events,events_cursor:observation.events_cursor,controller_status:room.getControllerStatus(),interaction_previews:{human:observation.interaction_previews,ai:room.observe('ai').interaction_previews}};
  };
  const broadcast = () => { const startedAt=performance.now();const message = snapshot();for (const client of ws.clients) send(client,message);record(broadcastTimes,performance.now()-startedAt); };
  server.on('upgrade',(request,socket,head) => {
    if (closing || request.url !== '/game-ws' || !isTrustedRequest(request,allowedOrigins)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return;
    }
    ws.handleUpgrade(request,socket,head,client => ws.emit('connection',client,request));
  });
  ws.on('connection',client => {
    const connectionId=randomUUID();
    client.on('error',() => { /* ws closes malformed/oversize frames; never throw into the process. */ });
    client.on('close',() => {clientPerformance.delete(client);room.releaseHumanInput(connectionId);if(!closing) broadcast();});
    send(client,snapshot());
    client.on('message',(data,isBinary) => {
      let value: unknown;
      try {
        if (isBinary) throw new Error('Expected a JSON text message of at most 16 KiB.');
        value = JSON.parse(data.toString());
      } catch {
        send(client,{type:'error',code:'INVALID_MESSAGE',message:'Expected a JSON text message of at most 16 KiB.'});return;
      }
      if(isClientPerformanceReport(value)) {
        const sample={receivedAt:performance.now(),report:value};
        const foreground=value.visible&&value.frame_count>0?sample:clientPerformance.get(client)?.foreground;
        clientPerformance.set(client,{...sample,foreground});return;
      }
      if(value&&typeof value==='object'&&'type' in value&&['start_round','human_input','command','takeover','set_demo'].includes(String(value.type))&&!hasMatchingRuleset(value)){
        send(client,{type:'error',code:'RULESET_MISMATCH',message:'Reload the matching pumpkin kitchen client.'});return;
      }
      if (!isClientMessage(value)) {
        send(client,{type:'error',code:'INVALID_MESSAGE',message:'Unknown message type or invalid message fields.'});return;
      }
      switch (value.type) {
        case 'human_input': {
          const result=room.setHumanInput(connectionId,value);
          broadcast();send(client,result);return;
        }
        case 'start_round': room.startRound();break;
        case 'takeover': room.takeover(value.seat_id);break;
        case 'set_demo': room.setDemoEnabled(value.enabled);break;
        case 'command': {
          const result = room.submit(value.command,'human');
          if ('code' in result) send(client,{type:'error',...result});
          else send(client,{type:'result',receipt:result.receipt});
          break;
        }
      }
      broadcast();
    });
  });
  await new Promise<void>((resolve,reject) => {
    server.once('error',reject);
    server.listen(port,host,() => {server.off('error',reject);resolve();});
  });
  let lastTickAt=performance.now();
  const timer = setInterval(() => {
    const startedAt=performance.now();record(tickGaps,startedAt-lastTickAt);lastTickAt=startedAt;
    room.tick();mcp.prune();record(tickTimes,performance.now()-startedAt);broadcast();
  },tickMs);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address.');
  let closePromise: Promise<void> | undefined;
  return {
    address:`http://${host === '::1' ? '[::1]' : host}:${address.port}`,
    getStatus:()=>({backend:{listening:server.listening,uptime_ms:Math.round(performance.now()-startedAt)},
      mcp:{...mcpStatus,last_request:mcpStatus.last_request?{...mcpStatus.last_request}:null,
        last_aborted:mcpStatus.last_aborted?{...mcpStatus.last_aborted}:null,
        last_response:mcpStatus.last_response?{...mcpStatus.last_response}:null,last_error:mcpStatus.last_error?{...mcpStatus.last_error}:null}}),
    close() {
      if (!closePromise) {
        closing = true;clearInterval(timer);room.close();
        closePromise = mcp.close().then(()=>new Promise<void>((resolve,reject) => {
          for (const client of ws.clients) client.terminate();
          for (const socket of sockets) socket.destroy();
          ws.close(() => server.close(error => error ? reject(error) : resolve()));
        }));
      }
      return closePromise;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().then(server => {
    console.log(`Local game server: ${server.address}`);
    for (const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,() => {void server.close();});
  }).catch(error => {console.error(error);process.exitCode = 1;});
}

