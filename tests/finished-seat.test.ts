import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRoom } from '../src/server/room';
import { createGameMcpServer } from '../src/mcp/server';
import { RULESET_ID } from '../src/shared/ruleset';
import type { Observation } from '../src/shared/contracts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function setup() {
  let time = 0;
  const room = createRoom(() => time);
  room.setDemoEnabled(false); room.startRound();
  cleanup.push(async () => room.close());
  const at = (value: number) => { time = value; room.tick(); };
  const connect = async (id: string) => {
    const server = createGameMcpServer(room, id);
    const client = new Client({ name: id, version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    cleanup.push(async () => { await client.close(); await server.close(); });
    return async (name: string, args: Record<string, unknown> = {}) => {
      const reply = await client.callTool({ name, arguments: args });
      const data = reply.structuredContent as {
        control_token?: string; observation?: Observation; code?: string;
        receipt?: { error?: string }; controller_status?: { connected: boolean };
      };
      return { error: reply.isError === true, data };
    };
  };
  return { room, at, connect };
}

function claim(room: ReturnType<typeof createRoom>, id: string) {
  const result = room.claimExternal(id);
  if (!('control_token' in result)) throw Error('test_claim_failed');
  return result.control_token;
}

describe('finished-round AI seat connection', () => {
  it.each([false, true])('revokes the previous round owner at finish (expiring human input: %s)', pendingInput => {
    const { room, at } = setup();
    at(89900);
    const token = claim(room, 'old-owner');
    if (pendingInput) {
      const s = room.getSnapshot();
      expect(room.setHumanInput('keyboard', {
        type: 'human_input', ruleset_id: RULESET_ID, seat_id: 'human',
        round_id: s.round_id, seat_generation: s.seats.human.generation,
        sequence: 1, direction: { x: 1, y: 0 },
      }).status).toBe('accepted');
    }
    at(pendingInput ? 90200 : 90000);
    expect(room.getSnapshot().phase).toBe('finished');
    expect(room.getControllerStatus().connected).toBe(false);
    expect(room.touchExternal('new-transport', token)).toBe(false);
  });

  it('keeps a finished-round join through ticks and cross-transport observations without permitting gameplay', async () => {
    const { room, at, connect } = setup();
    at(90000);
    const first = await connect('first-transport');
    const second = await connect('second-transport');
    const joined = await first('game_join', { ruleset_id: RULESET_ID });
    expect(joined.error).toBe(false);
    const token = joined.data.control_token;
    if (typeof token !== 'string') throw Error('test_join_token_missing');
    const before = room.getSnapshot();
    at(90050);
    const observed = await second('game_observe', { control_token: token, compact: true });
    expect(observed.error).toBe(false);
    expect(observed.data.controller_status?.connected).toBe(true);
    expect(observed.data.observation?.snapshot.phase).toBe('finished');
    expect(observed.data.observation?.snapshot.round_id).toBe(before.round_id);
    const rejected = await second('game_act', {
      ruleset_id: RULESET_ID, control_token: token, action_id: 'finished-move',
      seat_id: 'ai', seat_generation: before.seats.ai.generation,
      state_version: room.getSnapshot().state_version, issued_at_ms: 90050,
      ttl_ms: 1000, action: { type: 'move_to', target: { x: 540, y: 320 } },
    });
    expect(rejected.error).toBe(true);
    expect(rejected.data.receipt?.error).toBe('NOT_PLAYING');
    expect(room.getSnapshot()).toMatchObject({
      phase: 'finished', round_id: before.round_id, score: before.score,
      seats: { ai: { active_action: null, held_item_id: before.seats.ai.held_item_id } },
    });
    const again = await first('game_observe', { control_token: token, compact: true });
    expect(again.error).toBe(false);
    expect(again.data.controller_status?.connected).toBe(true);
  });

  it('renews a finished-round lease but still expires it at 30 seconds', () => {
    const { room, at } = setup();
    at(90000);
    const token = claim(room, 'owner');
    at(119999);
    expect(room.touchExternal('other-transport', token)).toBe(true);
    const generation = room.getSnapshot().seats.ai.generation;
    at(149998);
    expect(room.getControllerStatus().connected).toBe(true);
    at(149999);
    expect(room.touchExternal('other-transport', token)).toBe(false);
    expect(room.getControllerStatus().connected).toBe(false);
    expect(room.getSnapshot().seats.ai.generation).toBe(generation + 1);
  });

  it.each(['takeover', 'new_round'] as const)('revokes a finished-round token on %s', action => {
    const { room, at } = setup();
    at(90000);
    const token = claim(room, 'owner');
    expect(room.touchExternal('other-transport', token)).toBe(true);
    if (action === 'takeover') room.takeover('ai'); else room.startRound();
    expect(room.touchExternal('other-transport', token)).toBe(false);
    expect(room.getControllerStatus().connected).toBe(false);
    expect(room.getSnapshot().phase).toBe(action === 'takeover' ? 'finished' : 'playing');
  });
});
