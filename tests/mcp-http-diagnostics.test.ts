import { describe, expect, it } from 'vitest';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRoom } from '../src/server/room';
import { createGameMcpHttp } from '../src/mcp/http';

const secrets = ['session-secret', 'authorization-secret', 'header-secret', 'body-secret', 'token-secret', 'rpc-id-secret', 'host-secret', 'origin-secret', 'protocol-secret', 'path-secret'];
const allowedFields = ['request', 'phase', 'method', 'session', 'rpc', 'status', 'reason', 'protocol', 'accept_json', 'accept_sse', 'duration_ms'];

async function diagnosticRequest(headers: Record<string, string | undefined>, method = 'POST') {
  const events: Array<Record<string, unknown>> = [];
  const room = createRoom(() => 0);
  const options = { now: () => 0, onDiagnostic: (event: unknown) => events.push({ ...(event as Record<string, unknown>) }) };
  const handler = createGameMcpHttp(room, options);
  const server = createServer((incoming, response) => { void handler.handle(incoming, response); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address() as AddressInfo;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 'rpc-id-secret', method: 'tools/call', params: { name: 'body-secret', arguments: { control_token: 'token-secret' } } });
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const outgoing = request({
        hostname: '127.0.0.1', port, method, path: '/mcp?private=path-secret', agent: false,
        headers: {
          Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer authorization-secret', 'X-Private-Trace': 'header-secret', 'MCP-Protocol-Version': '2025-11-25',
          ...headers,
        },
      }, response => {
        let responseBody = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { responseBody += chunk; });
        response.once('end', () => resolve({ status: response.statusCode!, body: responseBody }));
        response.once('error', reject);
      });
      outgoing.once('error', reject);
      outgoing.end(method === 'POST' ? body : undefined);
    });
    return { ...result, events };
  } finally {
    await handler.close();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    room.close();
  }
}

describe('redacted stateless MCP HTTP diagnostics', () => {
  it('records one redacted aborted event when an unfinished upload disconnects', async () => {
    const events: Array<Record<string, unknown>> = [];
    const room = createRoom(() => 0);
    const handler = createGameMcpHttp(room, {onDiagnostic:event => events.push({...event})});
    const server = createServer((incoming, response) => { void handler.handle(incoming, response); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const {port} = server.address() as AddressInfo;
    const upload = request({hostname:'127.0.0.1',port,path:'/mcp',method:'POST',agent:false,headers:{
      'Content-Type':'application/json','Content-Length':'16384',Accept:'application/json, text/event-stream',
      Authorization:'Bearer authorization-secret','Mcp-Session-Id':'session-secret',
    }});
    upload.on('error', () => {});
    try {
      upload.write('{"jsonrpc":"2.0","id":"rpc-id-secret","params":{"control_token":"token-secret"}');
      await expect.poll(() => events.length).toBe(1);
      upload.destroy();
      await expect.poll(() => events.length).toBe(2);
      expect(events.map(event => event.phase)).toEqual(['request','aborted']);
      expect(events[1]).toMatchObject({request:events[0].request,reason:'response_closed',duration_ms:expect.any(Number)});
      expect(events[1]).not.toHaveProperty('status');
      for (const event of events) expect(Object.keys(event).every(key => allowedFields.includes(key))).toBe(true);
      for (const secret of secrets) expect(JSON.stringify(events)).not.toContain(secret);
    } finally {
      upload.destroy();
      await handler.close();
      await new Promise<void>((resolve,reject) => {
        server.close(error => error ? reject(error) : resolve());server.closeAllConnections();
      });
      room.close();
    }
    expect(events.map(event => event.phase)).toEqual(['request','aborted']);
  });

  it.each([
    { label: 'legacy session header', headers: { 'Mcp-Session-Id': 'session-secret' }, status: 200, reason: undefined, session: 'unknown' },
    { label: 'untrusted Host', headers: { Host: 'host-secret.example:5230' }, status: 403, reason: 'untrusted_host', session: 'none' },
    { label: 'untrusted Origin', headers: { Origin: 'https://origin-secret.example' }, status: 403, reason: 'untrusted_origin', session: 'none' },
    { label: 'unsupported protocol', headers: { 'MCP-Protocol-Version': 'protocol-secret' }, status: 400, reason: 'sdk_rejected', session: 'none' },
    { label: 'unknown tool without initialize', headers: {}, status: 200, reason: undefined, session: 'none' },
  ])('records $label without private request data', async sample => {
    const result = await diagnosticRequest(sample.headers);
    expect(result.status).toBe(sample.status);
    expect(result.events.map(event => event.phase)).toEqual(['request', 'response']);
    const [received, responded] = result.events;
    expect(received).toMatchObject({ request: expect.any(Number), method: 'POST', session: sample.session });
    expect(received).not.toHaveProperty('rpc');
    expect(responded).toMatchObject({ request: received.request, method: 'POST', session: sample.session, status: sample.status });
    expect(responded.reason).toBe(sample.reason);
    if (sample.status !== 403) expect(responded.rpc).toBe('tools/call');
    if (sample.status === 200) {
      const reply = JSON.parse(result.body);
      expect(reply.id).toBe('rpc-id-secret');
      expect(reply.error !== undefined || reply.result?.isError === true).toBe(true);
    }
    for (const event of result.events) expect(Object.keys(event).every(key => allowedFields.includes(key))).toBe(true);
    const serialized = JSON.stringify(result.events);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('initialize_required');
    expect(serialized).not.toContain('unknown_session');
  });

  it.each(['GET', 'DELETE'])('records unsupported %s without leaking its legacy header', async method => {
    const result = await diagnosticRequest({ 'Mcp-Session-Id': 'session-secret', 'MCP-Protocol-Version': 'protocol-secret' }, method);
    expect(result.status).toBe(405);
    expect(result.events.map(event => event.phase)).toEqual(['request', 'response']);
    expect(result.events[1]).toMatchObject({ method, session: 'unknown', status: 405, protocol: 'other' });
    for (const event of result.events) expect(Object.keys(event).every(key => allowedFields.includes(key))).toBe(true);
    const serialized = JSON.stringify(result.events);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
  });
});
