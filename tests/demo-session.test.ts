import { describe, expect, it } from 'vitest';
import { createDemoSession } from '../src/client/demo-session';
import { RULESET_ID } from '../src/shared/ruleset';
import type { ServerMessage } from '../src/shared/protocol';

function setup() {
  let now = 1000;
  const messages: ServerMessage[] = [];
  const session = createDemoSession({ now: () => now, emit: message => messages.push(structuredClone(message)) });
  const snapshot = () => messages.filter((m): m is Extract<ServerMessage, {type:'snapshot'}> => m.type === 'snapshot').at(-1)!;
  return { session, messages, snapshot, setTime: (time: number) => { now = time; } };
}

describe('isolated browser demo session', () => {
  it('starts in the lobby with a labeled demo seat and waits for the human to start', () => {
    const x = setup();
    expect(x.snapshot().snapshot.phase).toBe('lobby');
    expect(x.snapshot().snapshot.seats.ai.controller).toBe('demo');
    expect(x.snapshot().controller_status).toEqual({ connected: false, waiting: false });
    expect(x.snapshot().interaction_previews.human).toBeDefined();
    expect(x.snapshot().interaction_previews.ai).toBeDefined();
    x.session.receive({ type:'start_round', ruleset_id:RULESET_ID });
    expect(x.snapshot().snapshot.phase).toBe('playing');
    x.session.close();
  });

  it('rejects mismatched rulesets, malformed input, and external control messages without opening a round', () => {
    const x = setup();
    x.session.receive({ type:'start_round', ruleset_id:'wrong' });
    expect(x.messages.at(-1)).toMatchObject({ type:'error', code:'RULESET_MISMATCH' });
    x.session.receive({ type:'claimExternal', sessionId:'untrusted' });
    expect(x.messages.at(-1)).toMatchObject({ type:'error', code:'INVALID_MESSAGE' });
    x.session.receive({ type:'start_round', ruleset_id:RULESET_ID, extra:true });
    expect(x.snapshot().snapshot.phase).toBe('lobby');
    x.session.close();
  });

  it('uses the existing semantic path for demo decisions, while takeover revokes the demo controller', () => {
    const x = setup();
    x.session.receive({ type:'start_round', ruleset_id:RULESET_ID });
    x.setTime(1200); x.session.tick();
    expect(x.snapshot().snapshot.seats.ai.active_action).not.toBeNull();
    x.session.receive({ type:'takeover', ruleset_id:RULESET_ID, seat_id:'ai' });
    expect(x.snapshot().snapshot.seats.ai.controller).toBe('human');
    expect(x.snapshot().snapshot.seats.ai.active_action).toBeNull();
    x.session.close();
  });

  it('acknowledges keyboard input after a snapshot and stops an unrenewed lease after 300ms', () => {
    const x = setup();
    x.session.receive({ type:'start_round', ruleset_id:RULESET_ID });
    const s = x.snapshot().snapshot;
    const input = { type:'human_input', ruleset_id:RULESET_ID, seat_id:'human', seat_generation:s.seats.human.generation, round_id:s.round_id, sequence:1, direction:{x:1,y:0} };
    x.session.receive(input);
    expect(x.messages.at(-2)?.type).toBe('snapshot');
    expect(x.messages.at(-1)).toMatchObject({ type:'human_input_result', status:'accepted', sequence:1 });
    x.setTime(1400); x.session.tick();
    expect(x.snapshot().snapshot.seats.human.active_action).toBeNull();
    const stopped = x.snapshot().snapshot.seats.human.position;
    x.setTime(2000); x.session.tick();
    expect(x.snapshot().snapshot.seats.human.position).toEqual(stopped);
    x.session.receive({ ...input, sequence:2, seat_generation:s.seats.human.generation - 1 });
    expect(x.messages.at(-1)).toMatchObject({ status:'rejected', error:'STALE_GENERATION' });
    x.session.close();
  });

  it('releases held input on blur and finishes once after a throttled timer without auto restarting', () => {
    const x = setup();
    x.session.receive({ type:'start_round', ruleset_id:RULESET_ID });
    const s = x.snapshot().snapshot;
    x.session.receive({ type:'human_input', ruleset_id:RULESET_ID, seat_id:'human', seat_generation:s.seats.human.generation, round_id:s.round_id, sequence:1, direction:{x:1,y:0} });
    x.session.releaseInput();
    expect(x.snapshot().snapshot.seats.human.active_action).toBeNull();
    x.setTime(s.round_ends_at_ms! + 5000); x.session.tick();
    expect(x.snapshot().snapshot.phase).toBe('finished');
    x.setTime(s.round_ends_at_ms! + 10000); x.session.tick();
    expect(x.snapshot().snapshot.round_id).toBe(s.round_id);
    expect(x.snapshot().events.filter(event => event.type === 'round_finished')).toHaveLength(1);
    x.session.close();
    const count = x.messages.length;
    x.session.tick(); x.session.receive({ type:'start_round', ruleset_id:RULESET_ID });
    expect(x.messages).toHaveLength(count);
  });

  it('keeps two independent visitors in separate rooms', () => {
    const one = setup(), two = setup();
    one.session.receive({ type:'start_round', ruleset_id:RULESET_ID });
    expect(one.snapshot().snapshot.phase).toBe('playing');
    expect(two.snapshot().snapshot.phase).toBe('lobby');
    one.session.close(); two.session.close();
  });
});
