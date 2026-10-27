import type { SeatId } from '../shared/contracts';
import type { HumanInputMessage, HumanInputResult } from '../shared/protocol';
import {RULESET_ID} from '../shared/ruleset';

export interface KeyboardControlContext {
  connected: boolean;
  enabled: boolean;
  seat_id: SeatId;
  seat_generation: number;
  round_id: number;
}

interface KeyboardControlOptions {
  beforeMove?(resume:()=>void):void;
  getContext(): KeyboardControlContext;
  send(message: HumanInputMessage): boolean;
  onInteract(): void;
  onRejected?(message: HumanInputResult): void;
  windowTarget?: Window;
  documentTarget?: Document;
  timers?: {
    setInterval(callback: () => void, delay: number): unknown;
    clearInterval(timer: unknown): void;
  };
}

export interface KeyboardControls {
  updateContext(): void;
  handleResult(message: HumanInputResult): void;
  releaseThen(callback: () => void): void;
  release(): void;
  dispose(): void;
}

const DIRECTIONS: Record<string, {x:-1 | 0 | 1;y:-1 | 0 | 1}> = {
  KeyW:{x:0,y:-1},ArrowUp:{x:0,y:-1},KeyS:{x:0,y:1},ArrowDown:{x:0,y:1},
  KeyA:{x:-1,y:0},ArrowLeft:{x:-1,y:0},KeyD:{x:1,y:0},ArrowRight:{x:1,y:0},
};

function sameContext(a: KeyboardControlContext, b: KeyboardControlContext) {
  return a.connected === b.connected && a.enabled === b.enabled && a.seat_id === b.seat_id &&
    a.seat_generation === b.seat_generation && a.round_id === b.round_id;
}

function editable(target: EventTarget | null) {
  if (!target || typeof target !== 'object') return false;
  const element = target as {isContentEditable?: boolean;tagName?: string};
  return element.isContentEditable || ['INPUT','TEXTAREA','SELECT'].includes(element.tagName ?? '');
}

/** Sends bounded intent only; the room remains responsible for movement and control ownership. */
export function createKeyboardControls(options: KeyboardControlOptions): KeyboardControls {
  const windowTarget = options.windowTarget ?? window;
  const documentTarget = options.documentTarget ?? document;
  const timers = options.timers ?? {
    setInterval:(callback: () => void,delay: number) => globalThis.setInterval(callback,delay),
    clearInterval:(timer: unknown) => globalThis.clearInterval(timer as ReturnType<typeof setInterval>),
  };
  const held = new Set<string>();
  let context = options.getContext();
  let disposed = false;
  let heartbeat: unknown;
  let sequence = 0;
  let latestInput: HumanInputMessage | undefined;
  let firstSequence: number | undefined;
  let deferred: {sequence: number;callback: () => void} | undefined;
  let motionEpoch=0,awaitingMove=false;

  const direction = (): HumanInputMessage['direction'] => {
    const keys = [...held].map(code => DIRECTIONS[code]);
    return {
      x:((keys.some(key => key.x === 1) ? 1 : 0)-(keys.some(key => key.x === -1) ? 1 : 0)) as -1 | 0 | 1,
      y:((keys.some(key => key.y === 1) ? 1 : 0)-(keys.some(key => key.y === -1) ? 1 : 0)) as -1 | 0 | 1,
    };
  };
  const clearHeartbeat = () => {
    if (heartbeat !== undefined) {timers.clearInterval(heartbeat);heartbeat = undefined;}
  };
  const discard = () => {
    motionEpoch++;awaitingMove=false;
    held.clear();clearHeartbeat();latestInput = undefined;firstSequence = undefined;deferred = undefined;
  };
  const send = (intent: HumanInputMessage['direction'], inputContext = context) => {
    const message: HumanInputMessage = {type:'human_input',ruleset_id:RULESET_ID,seat_id:inputContext.seat_id,
      seat_generation:inputContext.seat_generation,round_id:inputContext.round_id,sequence:++sequence,direction:intent};
    if (!options.send(message)) {discard();return false;}
    latestInput = message;firstSequence ??= sequence;return true;
  };
  const release = () => {
    const hadInput = latestInput !== undefined || held.size > 0;
    discard();
    if (hadInput && options.getContext().connected) send({x:0,y:0});
  };
  const updateContext = () => {
    if (disposed) return;
    const next = options.getContext();
    if (!sameContext(context,next)) {
      // Release the old seat while the socket is usable, then forget all old acknowledgements.
      release();discard();context = next;
    }
  };
  const updateMotion = () => {
    const intent = direction();
    if (!send(intent)) return;
    if (intent.x === 0 && intent.y === 0) {clearHeartbeat();return;}
    if (heartbeat === undefined) heartbeat = timers.setInterval(() => {
      updateContext();
      if (disposed || !context.connected || !context.enabled || held.size === 0) return;
      const current = direction();
      if (current.x !== 0 || current.y !== 0) send(current);
    },100);
  };
  const releaseThen = (callback: () => void) => {
    if (disposed) return;
    updateContext();
    if (!context.connected) {discard();return;}
    if (deferred) {deferred.callback = callback;return;}
    if (!latestInput && held.size === 0) {callback();return;}
    release();
    if (latestInput) deferred = {sequence:latestInput.sequence,callback};
  };
  const keydown = (raw: Event) => {
    const event = raw as KeyboardEvent;
    if (disposed || event.repeat || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || editable(event.target)) return;
    if (!DIRECTIONS[event.code] && event.code !== 'KeyE') return;
    updateContext();
    if (!context.connected || !context.enabled || documentTarget.visibilityState === 'hidden') return;
    event.preventDefault();
    if (event.code === 'KeyE') {releaseThen(options.onInteract);return;}
    if (held.has(event.code)) return;
    const first=held.size===0;
    if (first) {deferred = undefined;firstSequence = undefined;}
    const before = direction();held.add(event.code);const after = direction();
    if(first&&options.beforeMove){const epoch=++motionEpoch;awaitingMove=true;options.beforeMove(()=>{updateContext();if(disposed||epoch!==motionEpoch||!context.connected||!context.enabled||!held.size)return;awaitingMove=false;updateMotion();});}
    else if (!awaitingMove&&(before.x !== after.x || before.y !== after.y)) updateMotion();
  };
  const keyup = (raw: Event) => {
    const event = raw as KeyboardEvent;
    updateContext();
    if (disposed || !held.has(event.code)) return;
    event.preventDefault();
    const before = direction();held.delete(event.code);const after = direction();
    if(awaitingMove){if(!held.size){motionEpoch++;awaitingMove=false;}return;}
    if (before.x !== after.x || before.y !== after.y) updateMotion();
  };
  const blur = () => { if (!disposed) release(); };
  const visibility = () => { if (documentTarget.visibilityState === 'hidden') blur(); };
  windowTarget.addEventListener('keydown',keydown);
  windowTarget.addEventListener('keyup',keyup);
  windowTarget.addEventListener('blur',blur);
  // Capture runs before canvas/button handlers schedule their manual action handoff.
  windowTarget.addEventListener('pointerdown',blur,true);
  documentTarget.addEventListener('visibilitychange',visibility);

  return {
    updateContext,releaseThen,
    release() { if (!disposed) release(); },
    handleResult(message) {
      if (disposed) return;
      updateContext();
      if (!latestInput || firstSequence === undefined || message.seat_id !== latestInput.seat_id ||
        message.sequence < firstSequence || message.sequence > sequence) return;
      if (message.status === 'rejected') {discard();options.onRejected?.(message);return;}
      if (deferred?.sequence === message.sequence) {
        const callback = deferred.callback;discard();callback();
      } else if (latestInput.sequence === message.sequence && latestInput.direction.x === 0 && latestInput.direction.y === 0) {
        latestInput = undefined;firstSequence = undefined;
      }
    },
    dispose() {
      if (disposed) return;
      release();discard();disposed = true;
      windowTarget.removeEventListener('keydown',keydown);
      windowTarget.removeEventListener('keyup',keyup);
      windowTarget.removeEventListener('blur',blur);
      windowTarget.removeEventListener('pointerdown',blur,true);
      documentTarget.removeEventListener('visibilitychange',visibility);
    },
  };
}

