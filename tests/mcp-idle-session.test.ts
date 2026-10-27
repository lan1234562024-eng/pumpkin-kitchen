import { describe, expect, it } from 'vitest';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRoom } from '../src/server/room';
import { createGameMcpHttp } from '../src/mcp/http';
import { RULESET_ID } from '../src/shared/ruleset';
import type { Observation } from '../src/shared/contracts';

const headers = {
  'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
  'MCP-Protocol-Version': '2025-11-25',
};

async function fixture() {
  let time = 0, sequence = 0;
  const room = createRoom(() => time);
  const http = createGameMcpHttp(room, { now: () => time });
  const server = createServer((req, res) => { void http.handle(req, res); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const post = async (body: object, extraHeaders: Record<string, string> = {}) => {
    const response = await fetch(url, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify(body) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const initialize = () => post({ jsonrpc: '2.0', id: ++sequence, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'stateless-regression', version: '1' },
  } });
  const call = (name: string, args: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}) =>
    post({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } }, extraHeaders);
  const uploads: Array<{ outgoing: ReturnType<typeof request>; incoming: import('node:http').IncomingMessage; closed: Promise<void> }> = [];
  const openUpload = async () => {
    const received = new Promise<import('node:http').IncomingMessage>(resolve => server.once('request', resolve));
    const outgoing = request(url, { method: 'POST', headers: { ...headers, 'Content-Length': '128' }, agent: false }, response => response.resume());
    outgoing.on('error', () => {});
    outgoing.write('{');
    const incoming = await received;
    const upload = { outgoing, incoming, closed: new Promise<void>(resolve => incoming.once('close', resolve)) };
    uploads.push(upload);
    return upload;
  };
  return { room, http, url, initialize, call, openUpload,
    advance: (value: number) => { time = value; http.prune(); },
    close: async () => {
      for (const upload of uploads) upload.outgoing.destroy();
      await http.close(); room.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

describe('stateless MCP HTTP request lifecycle', () => {
  it('supports more than eight SDK connections closed without DELETE', async () => {
    const f = await fixture();
    try {
      for (let n = 0; n < 12; n++) {
        const client = new Client({ name: 'close-without-delete', version: '1' });
        const transport = new StreamableHTTPClientTransport(new URL(f.url));
        try {
          await client.connect(transport);
          const result = await client.callTool({ name: 'game_observe', arguments: {} });
          expect(result.isError).not.toBe(true);
          expect(result.structuredContent).toHaveProperty('observation');
        } finally {
          // Deliberately do not call terminateSession: this reproduced the old ninth-initialize failure.
          await client.close();
        }
      }
    } finally { await f.close(); }
  });

  it('does not issue session IDs and accepts independent anonymous tool POSTs', async () => {
    const f = await fixture();
    try {
      const initialized = await f.initialize();
      expect(initialized.status).toBe(200);
      expect(initialized.headers.get('mcp-session-id')).toBeNull();
      f.advance(600000);
      const observed = await f.call('game_observe');
      expect(observed.status).toBe(200);
      expect(observed.body.result.structuredContent.observation.seat_id).toBe('ai');
      expect(observed.headers.get('mcp-session-id')).toBeNull();
    } finally { await f.close(); }
  });

  it('returns 405 for GET and DELETE without releasing the room owner', async () => {
    const f = await fixture();
    try {
      const claimed = f.room.claimExternal('fixture-owner');
      expect(claimed).toHaveProperty('control_token');
      const before = f.room.getSnapshot();
      for (const method of ['GET', 'DELETE']) {
        const response = await fetch(f.url, { method, headers: { ...headers, 'Mcp-Session-Id': 'legacy-header' } });
        expect(response.status).toBe(405);
        await response.text();
        expect(f.room.getSnapshot()).toEqual(before);
        expect(f.room.getControllerStatus()).toEqual({ connected: true, waiting: false });
      }
    } finally { await f.close(); }
  });

  it('requires the explicit control token across POSTs and ignores legacy session authority', async () => {
    const f = await fixture();
    try {
      f.room.startRound();
      const joined = await f.call('game_join', { ruleset_id: RULESET_ID });
      expect(joined.status).toBe(200);
      const token = joined.body.result.structuredContent.control_token as string;
      expect(token).toEqual(expect.any(String));
      const observed = await f.call('game_observe', { control_token: token }, { 'Mcp-Session-Id': 'legacy-header' });
      expect(observed.status).toBe(200);
      const observation = observed.body.result.structuredContent.observation as Observation;
      const command = { ruleset_id: RULESET_ID, action_id: 'explicit-token-only', seat_id: 'ai',
        seat_generation: observation.snapshot.seats.ai.generation, state_version: observation.snapshot.state_version,
        issued_at_ms: observation.server_time_ms, ttl_ms: 1000, action: { type: 'cancel' } };
      for (const args of [command, { ...command, control_token: 'wrong-token' }]) {
        const denied = await f.call('game_act', args, { 'Mcp-Session-Id': 'legacy-header' });
        expect(denied.status).toBe(200);
        expect(denied.body.result).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
      }
      const badRead = await f.call('game_observe', { control_token: 'wrong-token' });
      expect(badRead.body.result).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
      const anonymous = await f.call('game_observe');
      expect(anonymous.body.result.structuredContent.controller_status).toEqual({ connected: true, waiting: false });
      const accepted = await f.call('game_act', { ...command, control_token: token });
      expect(accepted.body.result.structuredContent.receipt.status).toBe('accepted');
      expect(f.room.getControllerStatus()).toEqual({ connected: true, waiting: false });
    } finally { await f.close(); }
  });

  it('renews the unchanged thirty-second owner lease only with a valid token', async () => {
    const f = await fixture();
    try {
      const joined = await f.call('game_join', { ruleset_id: RULESET_ID });
      expect(joined.status).toBe(200);
      const token = joined.body.result.structuredContent.control_token as string;
      f.advance(29999);
      const renewed = await f.call('game_observe', { control_token: token });
      expect(renewed.body.result.structuredContent.controller_status.connected).toBe(true);
      f.advance(30000);
      const anonymous = await f.call('game_observe');
      expect(anonymous.body.result.structuredContent.controller_status.connected).toBe(true);
      f.advance(59999);
      const expired = await f.call('game_observe');
      expect(expired.body.result.structuredContent.controller_status).toEqual({ connected: false, waiting: false });
      const oldToken = await f.call('game_observe', { control_token: token });
      expect(oldToken.body.result).toMatchObject({ isError: true, structuredContent: { code: 'FORBIDDEN' } });
    } finally { await f.close(); }
  });

  it('does not renew ownership through GET, DELETE or anonymous observation', async () => {
    const f = await fixture();
    try {
      f.room.claimExternal('fixture-owner');
      f.advance(29999);
      for (const method of ['GET', 'DELETE']) {
        const response = await fetch(f.url, { method, headers });
        expect(response.status).toBe(405);
        await response.text();
      }
      const anonymous = await f.call('game_observe');
      expect(anonymous.body.result.structuredContent.controller_status.connected).toBe(true);
      f.advance(30000);
      const expired = await f.call('game_observe');
      expect(expired.body.result.structuredContent.controller_status.connected).toBe(false);
    } finally { await f.close(); }
  });

  it('counts unfinished uploads as in-flight and releases an aborted upload slot', async () => {
    const f = await fixture();
    try {
      const uploads = [];
      for (let n = 0; n < 8; n++) uploads.push(await f.openUpload());
      const saturated = await f.initialize();
      expect(saturated.status).toBe(503);
      uploads[0].outgoing.destroy();
      await uploads[0].closed;
      const recovered = await f.initialize();
      expect(recovered.status).toBe(200);
      expect(recovered.headers.get('mcp-session-id')).toBeNull();
    } finally { await f.close(); }
  });

  it('cancels an unfinished upload when the HTTP handler closes', async () => {
    const f = await fixture();
    try {
      const upload = await f.openUpload();
      expect(upload.incoming.destroyed).toBe(false);
      await f.http.close();
      expect(upload.incoming.destroyed).toBe(true);
      await upload.closed;
    } finally { await f.close(); }
  });
});
