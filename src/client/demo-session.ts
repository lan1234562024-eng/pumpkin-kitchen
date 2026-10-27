import { createRoom } from '../game/room-core';
import { hasMatchingRuleset, isClientMessage, type ServerMessage } from '../shared/protocol';
import { isClientPerformanceReport } from '../shared/performance';

/** One visitor, one isolated demo room. Only ordinary browser messages can mutate it. */
export function createDemoSession(options: { now: () => number; emit: (message: ServerMessage) => void }) {
  const room = createRoom(options.now, {
    randomUUID: () => crypto.randomUUID(),
    createToken: () => { throw new Error('External AI control is unavailable in the browser demo.'); },
    tokenEquals: () => false,
  });
  const connectionId = 'browser-demo';
  let closed = false;
  const emit = (message: ServerMessage) => { if (!closed) options.emit(message); };
  const snapshot = () => {
    const observation = room.observe('human');
    emit({ type:'snapshot', snapshot:observation.snapshot, events:observation.events,
      events_cursor:observation.events_cursor, controller_status:room.getControllerStatus(),
      interaction_previews:{ human:observation.interaction_previews, ai:room.observe('ai').interaction_previews } });
  };
  snapshot();
  return {
    receive(value: unknown) {
      if (closed || isClientPerformanceReport(value)) return;
      if (value && typeof value === 'object' && 'type' in value &&
        ['start_round','human_input','command','takeover','set_demo'].includes(String(value.type)) && !hasMatchingRuleset(value)) {
        emit({ type:'error', code:'RULESET_MISMATCH', message:'厨房版本不匹配，请刷新网页。' }); return;
      }
      if (!isClientMessage(value)) {
        emit({ type:'error', code:'INVALID_MESSAGE', message:'无法识别这条游戏操作。' }); return;
      }
      // Room methods advance wall-clock time before accepting a message, including after tab suspension.
      switch (value.type) {
        case 'human_input': {
          const result = room.setHumanInput(connectionId, value);
          snapshot(); emit(result); return;
        }
        case 'start_round': room.startRound(); break;
        case 'takeover': room.takeover(value.seat_id); break;
        case 'set_demo': room.setDemoEnabled(value.enabled); break;
        case 'command': {
          const result = room.submit(value.command, 'human');
          emit('code' in result ? { type:'error', ...result } : { type:'result', receipt:result.receipt });
          break;
        }
      }
      snapshot();
    },
    tick() { if (!closed) { room.tick(); snapshot(); } },
    releaseInput() { if (!closed) { room.releaseHumanInput(connectionId); snapshot(); } },
    close() { if (!closed) { closed = true; room.releaseHumanInput(connectionId); room.close(); } },
  };
}
