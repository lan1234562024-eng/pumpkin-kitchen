import type { ClientPerformanceReport } from '../shared/performance';

const MAX_SAMPLES = 300;
const MAX_PENDING = 64;
const MAX_DURATION_MS = 120000;
const validTime = (value: number) => Number.isFinite(value) && value >= 0;
const validSequence = (value: number) => Number.isSafeInteger(value) && value >= 0;
const cap = (value: number) => Math.max(0, Math.min(MAX_DURATION_MS, value));

function samples() {
  const values: number[] = [];
  let cursor = 0;
  return {
    add(value: number) {
      if (!validTime(value)) return;
      if (values.length < MAX_SAMPLES) values.push(cap(value));
      else { values[cursor] = cap(value); cursor = (cursor + 1) % MAX_SAMPLES; }
    },
    take() {
      const sorted = [...values].sort((a, b) => a - b);
      values.length = 0; cursor = 0;
      return { count: sorted.length, p95: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0, max: sorted[sorted.length - 1] ?? 0 };
    },
  };
}

/** Clock values are supplied by the caller so aggregation is deterministic and browser-independent. */
export function createPerformanceAccumulator(startNow?: number) {
  const frames = samples(), longTasks = samples(), snapshotGaps = samples(), handlers = samples(), acknowledgements = samples();
  const reactRenders = samples(), gameFrames = samples();
  const pending = new Map<number, number>();
  let lastFrame: number | undefined, lastSnapshot: number | undefined;
  let windowStart = startNow !== undefined && validTime(startNow) ? startNow : undefined;
  let includeCpu = windowStart !== undefined;
  return {
    reactRender(duration: number) { if (validTime(duration)) { includeCpu = true; reactRenders.add(duration); } },
    gameFrame(duration: number) { if (validTime(duration)) { includeCpu = true; gameFrames.add(duration); } },
    frame(now: number, visible: boolean) {
      if (!visible) { lastFrame = undefined; return; }
      if (!validTime(now) || lastFrame !== undefined && now < lastFrame) return;
      if (lastFrame !== undefined) frames.add(now - lastFrame);
      lastFrame = now;
    },
    longTask(duration: number) { longTasks.add(duration); },
    snapshot(now: number, handlerMs: number) {
      if (!validTime(now) || !validTime(handlerMs) || lastSnapshot !== undefined && now < lastSnapshot) return;
      if (lastSnapshot !== undefined) snapshotGaps.add(now - lastSnapshot);
      handlers.add(handlerMs); lastSnapshot = now;
    },
    inputSent(sequence: number, now: number) {
      if (!validSequence(sequence) || !validTime(now) || pending.has(sequence)) return;
      if (pending.size >= MAX_PENDING) {
        const oldest = pending.keys().next().value;
        if (oldest !== undefined) pending.delete(oldest);
      }
      pending.set(sequence, now);
    },
    inputAck(sequence: number, now: number) {
      const sent = pending.get(sequence);
      if (sent === undefined || !validTime(now) || now < sent) return;
      pending.delete(sequence); acknowledgements.add(now - sent);
    },
    report(now: number, visible: boolean): ClientPerformanceReport {
      const frame = frames.take(), tasks = longTasks.take(), gaps = snapshotGaps.take(), snapshot = handlers.take(), ack = acknowledgements.take();
      const react = reactRenders.take(), game = gameFrames.take();
      const report: ClientPerformanceReport = {
        type: 'client_performance', version: 1, visible,
        frame_count: frame.count, frame_p95_ms: frame.p95, frame_max_ms: frame.max,
        long_task_count: tasks.count, long_task_max_ms: tasks.max,
        snapshot_count: snapshot.count, snapshot_gap_p95_ms: gaps.p95, snapshot_handler_p95_ms: snapshot.p95,
        snapshot_age_ms: lastSnapshot === undefined ? -1 : cap((validTime(now) ? now : lastSnapshot) - lastSnapshot),
        input_ack_count: ack.count, input_ack_p95_ms: ack.p95, input_pending: pending.size,
      };
      if (windowStart !== undefined) {
        report.window_ms = cap((validTime(now) ? now : windowStart) - windowStart);
        if (validTime(now) && now >= windowStart) windowStart = now;
      }
      if (includeCpu) {
        report.react_render_count = react.count; report.react_render_p95_ms = react.p95;
        report.game_frame_count = game.count; report.game_frame_p95_ms = game.p95;
      }
      return report;
    },
  };
}

/** Optional own-app diagnostics. No input content or game state is retained. */
export function createClientPerformance(send: (report: ClientPerformanceReport) => void) {
  const metrics = createPerformanceAccumulator(performance.now());
  const visible = () => document.visibilityState !== 'hidden';
  let disposed = false, visibleSince = performance.now();
  let frameRequest: number;
  let observer: PerformanceObserver | undefined;
  let longTaskSupported = false;
  const frame = (now: number) => {
    if (disposed) return;
    metrics.frame(now, visible());
    frameRequest = requestAnimationFrame(frame);
  };
  const visibilityChanged = () => {
    visibleSince = performance.now();
    // A visibility transition is a baseline reset, never a frame measurement.
    metrics.frame(visibleSince, false);
  };
  document.addEventListener('visibilitychange', visibilityChanged);
  frameRequest = requestAnimationFrame(frame);
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    try {
      observer = new PerformanceObserver(list => {
        if (disposed || !visible()) return;
        for (const entry of list.getEntries()) if (entry.startTime >= visibleSince) metrics.longTask(entry.duration);
      });
      observer.observe({ type: 'longtask' });
      longTaskSupported = true;
    } catch { observer?.disconnect(); observer = undefined; }
  }
  const timer = globalThis.setInterval(() => {
    if (disposed) return;
    const report = metrics.report(performance.now(), visible());
    report.focused = document.hasFocus();
    report.long_task_supported = longTaskSupported;
    try { send(report); } catch { /* Diagnostics must never interrupt game controls. */ }
  }, 2000);
  return {
    reactRender(duration: number) { if (!disposed) metrics.reactRender(duration); },
    gameFrame(duration: number) { if (!disposed) metrics.gameFrame(duration); },
    snapshot(handlerMs: number) { if (!disposed) metrics.snapshot(performance.now(), handlerMs); },
    inputSent(sequence: number) { if (!disposed) metrics.inputSent(sequence, performance.now()); },
    inputAck(sequence: number) { if (!disposed) metrics.inputAck(sequence, performance.now()); },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frameRequest);
      globalThis.clearInterval(timer);
      observer?.disconnect();
      document.removeEventListener('visibilitychange', visibilityChanged);
    },
  };
}

