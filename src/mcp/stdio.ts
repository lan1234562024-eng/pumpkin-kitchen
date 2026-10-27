import { pathToFileURL } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Transparent SDK transport bridge: no game state, tools, or second MCP server. */
export async function startStdioBridge(target='http://127.0.0.1:5230/mcp') {
  const url=new URL(target);
  if(url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.pathname!=='/mcp' || url.username || url.password || url.search || url.hash) throw new Error('Bridge target must be a loopback HTTP /mcp endpoint.');
  const local=new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:64*1024});
  const upstream=new StreamableHTTPClientTransport(url,{requestInit:{redirect:'error'}});
  let closing:Promise<void>|undefined;
  const close=() => closing??=(async()=>{await upstream.terminateSession().catch(()=>{});await upstream.close();await local.close();})();
  const fail=(error:unknown) => {console.error('MCP bridge:',error instanceof Error?error.message:String(error));process.exitCode=1;void close();};
  local.onmessage=message=>{void upstream.send(message).catch(fail);};
  upstream.onmessage=message=>{
    if('result' in message && message.result && typeof message.result==='object' && 'protocolVersion' in message.result && typeof message.result.protocolVersion==='string') upstream.setProtocolVersion(message.result.protocolVersion);
    void local.send(message).catch(fail);
  };
  local.onerror=fail;upstream.onerror=error=>console.error('MCP upstream:',error.message);
  process.stdin.once('end',()=>{void close();});
  for(const signal of ['SIGINT','SIGTERM'] as const) process.once(signal,()=>{void close();});
  await upstream.start();await local.start();return {close};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const index=process.argv.indexOf('--url');
  startStdioBridge(index>=0?process.argv[index+1]:undefined).catch(error=>{console.error(error);process.exitCode=1;});
}

