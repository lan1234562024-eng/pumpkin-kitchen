import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createGameMcpServer } from './server';
import type { Room } from '../server/room';

export const MAX_MCP_BODY_BYTES=64*1024;
export const MAX_MCP_REQUESTS=8;
export const DEFAULT_ORIGINS=['http://127.0.0.1:5173','http://localhost:5173','http://terminal.local:4173'];
function trustFailure(request:IncomingMessage,allowedOrigins:string[]=DEFAULT_ORIGINS) {
  const host=request.headers.host;
  if(!host || !/^(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/.test(host)) return 'untrusted_host';
  const origin=request.headers.origin;
  if(origin!==undefined && !allowedOrigins.includes(origin)) return 'untrusted_origin';
}
export function isTrustedRequest(request:IncomingMessage,allowedOrigins:string[]=DEFAULT_ORIGINS) {
  return trustFailure(request,allowedOrigins)===undefined;
}
export interface McpHttpDiagnostic {
  request:number; phase:'request'|'response'|'aborted'; method:'POST'|'GET'|'DELETE'|'other';
  session:'none'|'known'|'unknown'; rpc?:'initialize'|'notifications/initialized'|'tools/list'|'tools/call'|'other';
  protocol?:string; accept_json:boolean; accept_sse:boolean; status?:number; reason?:string; duration_ms?:number;
}
interface ActiveRequest {
  request:IncomingMessage; response:ServerResponse; abort:AbortController;
  server?:McpServer; dispose(abort:boolean):Promise<void>;
}
export function createGameMcpHttp(room:Room,options:{now?:()=>number;allowedOrigins?:string[];onDiagnostic?:(event:McpHttpDiagnostic)=>void}={}) {
  const active=new Set<ActiveRequest>();let closing=false,sequence=0;
  // Opt-in, allowlisted metadata only: never headers, IDs, bodies, tokens or raw errors.
  const diagnostic=options.onDiagnostic??(process.env.PUMPKIN_MCP_DIAGNOSTICS==='1'?(event:McpHttpDiagnostic)=>console.error(`[mcp-http] ${JSON.stringify(event)}`):undefined);
  const emit=(event:McpHttpDiagnostic)=>{try{diagnostic?.(event);}catch{/* Diagnostics must not affect gameplay. */}};
  const reply=(response:ServerResponse,status:number,error:string) => {
    if(response.headersSent||response.destroyed) return;
    response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify({error}));
  };
  let closePromise:Promise<void>|undefined;
  return {
    // Kept for the existing room tick caller; stateless HTTP retains no idle sessions.
    prune() {},
    async handle(request:IncomingMessage,response:ServerResponse):Promise<void> {
      const started=performance.now(),header=request.headers['mcp-session-id'];
      const protocol=request.headers['mcp-protocol-version'];
      const event:McpHttpDiagnostic={request:++sequence,phase:'request',
        method:request.method==='POST'||request.method==='GET'||request.method==='DELETE'?request.method:'other',
        session:header===undefined?'none':'unknown',
        accept_json:typeof request.headers.accept==='string'&&request.headers.accept.includes('application/json'),
        accept_sse:typeof request.headers.accept==='string'&&request.headers.accept.includes('text/event-stream'),
        ...(protocol===undefined?{}:{protocol:typeof protocol==='string'&&['2024-11-05','2025-03-26','2025-06-18','2025-11-25','2026-07-28'].includes(protocol)?protocol:'other'})};
      emit({...event});
      let failure:string|undefined,finished=false;
      response.once('finish',()=>{
        finished=true;
        emit({...event,phase:'response',status:response.statusCode,
          ...(failure?{reason:failure}:response.statusCode>=400?{reason:'sdk_rejected'}:{}),duration_ms:Math.round(performance.now()-started)});
      });
      response.once('close',()=>{
        if(!finished)emit({...event,phase:'aborted',reason:'response_closed',duration_ms:Math.round(performance.now()-started)});
      });
      const reject=(status:number,error:string,reason:string)=>{failure=reason;reply(response,status,error);};
      const untrusted=trustFailure(request,options.allowedOrigins);
      if(untrusted) {reject(403,'Forbidden Host or Origin',untrusted);return;}
      if(closing) {reject(503,'Service closing','closing');return;}
      if(request.method!=='POST') {response.setHeader('Allow','POST');reject(405,'Method not allowed','method_not_allowed');return;}
      if(header!==undefined&&typeof header!=='string') {reject(400,'Invalid MCP session header','invalid_session');return;}
      // Bound current work, including uploads, rather than historical initialize calls.
      if(active.size>=MAX_MCP_REQUESTS) {reject(503,'MCP request capacity reached','request_capacity');return;}
      const abort=new AbortController();
      let disposed=false,disposePromise=Promise.resolve();
      const scope:ActiveRequest={request,response,abort,
        dispose(cancel) {
          if(cancel) abort.abort();
          if(disposed)return disposePromise;
          disposed=true;active.delete(scope);
          disposePromise=scope.server?.close().catch(()=>{})??Promise.resolve();
          return disposePromise;
        }};
      active.add(scope);
      response.once('finish',()=>{void scope.dispose(false);});
      response.once('close',()=>{void scope.dispose(!response.writableEnded);});
      try {
        let body:unknown,size=0;const chunks:Buffer[]=[];
        try {
          for await(const chunk of request) {
            const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;
            if(size>MAX_MCP_BODY_BYTES) {reject(413,'MCP body exceeds 64 KiB','body_too_large');return;}
            chunks.push(bytes);
          }
          body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          if(!abort.signal.aborted)reject(400,'Invalid JSON body','invalid_json');
          return;
        }
        if(abort.signal.aborted||disposed||response.destroyed)return;
        if(Array.isArray(body)) {reject(400,'Send one JSON-RPC message per HTTP request','batch_unsupported');return;}
        if(body&&typeof body==='object'&&'method' in body) {
          const method=body.method;event.rpc=method==='initialize'||method==='notifications/initialized'||method==='tools/list'||method==='tools/call'?method:'other';
        }
        // Official SDK stateless pattern: one server and transport per POST.
        // Only the Room-issued control_token bridges requests; HTTP IDs grant no seat.
        const server=createGameMcpServer(room,randomUUID(),()=>abort.signal);
        scope.server=server;
        const transport=new StreamableHTTPServerTransport({sessionIdGenerator:undefined,enableJsonResponse:true});
        await server.connect(transport);
        if(abort.signal.aborted||disposed) {await server.close();return;}
        await transport.handleRequest(request,response,body);
      } catch {
        failure='transport_error';
        if(!response.headersSent)reply(response,500,'MCP request failed');else if(!response.destroyed)response.end();
      } finally {
        if(response.writableEnded||response.destroyed)await scope.dispose(!response.writableEnded);
      }
    },
    close() {
      return closePromise??=(async()=>{
        closing=true;
        await Promise.all([...active].map(scope=>{
          scope.abort.abort();scope.request.destroy();scope.response.destroy();
          return scope.dispose(true);
        }));
      })();
    },
  };
}

