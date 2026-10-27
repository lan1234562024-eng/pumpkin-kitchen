export interface PresentationPoint {
  x: number;
  y: number;
}

export interface PresentationSample {
  serverTime: number;
  position: PresentationPoint;
  roundId: number;
  generation: number;
}

/** Presentation-only sampling; authoritative game state is never mutated. */
export function createPresentationMotion() {
  let from: PresentationPoint | undefined;
  let latest: PresentationSample | undefined;
  let receivedAt = 0;
  let duration = 0;
  let highWaterDuration = 0;
  const pointAt = (now: number): PresentationPoint | undefined => {
    if (!latest) return;
    if (!from || duration === 0) return { ...latest.position };
    const progress = Math.max(0, Math.min(1, (now - receivedAt) / duration));
    if (progress === 0) return { ...from };
    if (progress === 1) return { ...latest.position };
    return {
      x: from.x + (latest.position.x - from.x) * progress,
      y: from.y + (latest.position.y - from.y) * progress,
    };
  };
  return {
    observe(sample: PresentationSample, now: number) {
      const sameContext = !!latest && latest.roundId === sample.roundId && latest.generation === sample.generation;
      // Input receipts can repeat a tick's snapshot. They must not restart its clock.
      if (sameContext && latest && sample.serverTime <= latest.serverTime) return;
      const gap = latest ? sample.serverTime - latest.serverTime : 0;
      const distance = latest ? Math.hypot(sample.position.x - latest.position.x, sample.position.y - latest.position.y) : 0;
      if (!sameContext || !latest || gap > 250 || distance > 96) {
        from = undefined; duration = 0; highWaterDuration = 0;
        latest = { ...sample, position: { ...sample.position } }; receivedAt = now;
        return;
      }
      const displayed = pointAt(now);
      const sameTarget = latest.position.x === sample.position.x && latest.position.y === sample.position.y;
      highWaterDuration = Math.max(highWaterDuration, Math.max(16, Math.min(100, gap)));
      latest = { ...sample, position: { ...sample.position } };
      // Reconfirming an endpoint must not postpone an unfinished segment's deadline.
      if (sameTarget) return;
      from = displayed;
      receivedAt = now;
      duration = highWaterDuration;
    },
    sample: pointAt,
    reset() { from = undefined; latest = undefined; duration = 0; highWaterDuration = 0; },
  };
}


