import { describe, it, expect } from 'vitest';
import { createPresentationMotion, type PresentationSample } from '../src/client/game/presentation-motion';

function frame(serverTime: number, x: number, y = 0, roundId = 1, generation = 1): PresentationSample {
  return { serverTime, position: { x, y }, roundId, generation };
}

describe('confirmed presentation motion', () => {
  it('keeps the displayed point continuous across irregular 63, 37 and 26 ms snapshots', () => {
    const motion = createPresentationMotion();
    motion.observe(frame(1000, 0, 20), 2000);
    for (const serverTime of [1063, 1100, 1126, 1189]) {
      const receivedAt = serverTime + 1000;
      const before = motion.sample(receivedAt);
      motion.observe(frame(serverTime, (serverTime - 1000) * 0.16, 20 + (serverTime - 1000) * 0.08), receivedAt);
      expect(motion.sample(receivedAt)).toEqual(before);
    }
  });

  it('does not restart irregular motion when the same server timestamp is repeated', () => {
    const setup = () => {
      const motion = createPresentationMotion();
      motion.observe(frame(1000, 0), 2000);
      motion.observe(frame(1063, 10.08), 2063);
      motion.observe(frame(1100, 16), 2100);
      return motion;
    };
    const motion = setup(), uninterrupted = setup(), before = motion.sample(2120);
    motion.observe(frame(1100, 16), 2120);
    expect(motion.sample(2120)).toEqual(before);
    expect(motion.sample(2140)).toEqual(uninterrupted.sample(2140));
  });

  it('keeps the 63 ms duration after shorter 37 and 26 ms input intervals', () => {
    const motion = createPresentationMotion();
    motion.observe(frame(1000, 0), 2000);
    motion.observe(frame(1063, 10.08), 2063);
    const startOf37 = motion.sample(2100)!.x;
    motion.observe(frame(1100, 16), 2100);
    expect(motion.sample(2118.5)!.x).toBeCloseTo(startOf37 + (16 - startOf37) * 18.5 / 63, 10);
    const startOf26 = motion.sample(2126)!.x;
    motion.observe(frame(1126, 20.16), 2126);
    expect(motion.sample(2157.5)!.x).toBeCloseTo((startOf26 + 20.16) / 2, 10);
    expect(motion.sample(2189)).toEqual({ x: 20.16, y: 0 });
  });

  it('preserves the original completion deadline when newer packets confirm the same target', () => {
    const motion = createPresentationMotion();
    motion.observe(frame(1000, 0), 2000);
    motion.observe(frame(1050, 10), 2050);
    expect(motion.sample(2075)).toEqual({ x: 5, y: 0 });
    motion.observe(frame(1075, 10), 2075);
    expect(motion.sample(2075)).toEqual({ x: 5, y: 0 });
    motion.observe(frame(1090, 10), 2090);
    expect(motion.sample(2090)).toEqual({ x: 8, y: 0 });
    expect(motion.sample(2100)).toEqual({ x: 10, y: 0 });
    expect(motion.sample(10000)).toEqual({ x: 10, y: 0 });
  });

  it('recovers continuously from a delayed packet batch without extrapolating', () => {
    const motion = createPresentationMotion();
    motion.observe(frame(1000, 0), 2000);
    motion.observe(frame(1050, 8), 2050);
    expect(motion.sample(2300)).toEqual({ x: 8, y: 0 });
    motion.observe(frame(1100, 16), 2300);
    expect(motion.sample(2300)).toEqual({ x: 8, y: 0 });
    const beforeNextPacket = motion.sample(2310);
    motion.observe(frame(1150, 24), 2310);
    expect(motion.sample(2310)).toEqual(beforeNextPacket);
    for (const now of [2310, 2320, 2335, 2360, 10000]) {
      const point = motion.sample(now)!;
      expect(point.x).toBeGreaterThanOrEqual(8);
      expect(point.x).toBeLessThanOrEqual(24);
      expect(point.y).toBe(0);
    }
    expect(motion.sample(10000)).toEqual({ x: 24, y: 0 });
  });

  it('shows the first confirmed position immediately', () => {
    const motion = createPresentationMotion();
    expect(motion.sample(2000)).toBeUndefined();
    motion.observe(frame(1000, 20, 30), 2000);
    expect(motion.sample(2000)).toEqual({ x: 20, y: 30 });
  });

  it('interpolates both axes halfway between confirmed positions', () => {
    const motion = createPresentationMotion();
    motion.observe(frame(1000, 0, 20), 2000);
    motion.observe(frame(1050, 10, 0), 2050);
    expect(motion.sample(2075)).toEqual({ x: 5, y: 10 });
  });

  it('uses the confirmed server interval when ticks are slower than 50 ms', () => {
    const motion = createPresentationMotion();
    motion.observe(frame(1000, 0), 2000);
    motion.observe(frame(1062, 10), 2062);
    expect(motion.sample(2093)).toEqual({ x: 5, y: 0 });
  });

  it('clamps an early render time to the previous confirmed position', () => {
    const motion = createPresentationMotion();
    motion.observe(frame(1000, 0), 2000);
    motion.observe(frame(1050, 10), 2050);
    expect(motion.sample(2040)).toEqual({ x: 0, y: 0 });
  });

  it('reaches the confirmed endpoint and never extrapolates during a stall', () => {
    const motion = createPresentationMotion();
    motion.observe(frame(1000, 0), 2000);
    motion.observe(frame(1050, 10), 2050);
    expect(motion.sample(2100)).toEqual({ x: 10, y: 0 });
    expect(motion.sample(10000)).toEqual({ x: 10, y: 0 });
  });

  it('does not restart the presentation clock for a duplicate server timestamp', () => {
    const motion = createPresentationMotion();
    motion.observe(frame(1000, 0), 2000);
    motion.observe(frame(1050, 10), 2050);
    motion.observe(frame(1050, 10), 2080);
    expect(motion.sample(2080)).toEqual({ x: 6, y: 0 });
  });

  it('ignores an older confirmed sample within the same seat context', () => {
    const motion = createPresentationMotion();
    motion.observe(frame(1000, 0), 2000);
    motion.observe(frame(1050, 10), 2050);
    motion.observe(frame(1025, 3), 2070);
    expect(motion.sample(2075)).toEqual({ x: 5, y: 0 });
  });

  it('snaps immediately when the round changes', () => {
    const motion = createPresentationMotion();
    motion.observe(frame(1000, 0), 2000);
    motion.observe(frame(1050, 10), 2050);
    motion.observe(frame(1050, 200, 100, 2), 2060);
    expect(motion.sample(2060)).toEqual({ x: 200, y: 100 });
  });

  it('snaps immediately when the seat generation changes', () => {
    const motion = createPresentationMotion();
    motion.observe(frame(1000, 0), 2000);
    motion.observe(frame(1050, 10), 2050);
    motion.observe(frame(1050, 200, 100, 1, 2), 2060);
    expect(motion.sample(2060)).toEqual({ x: 200, y: 100 });
  });

  it('snaps across a large discontinuity instead of sliding across the room', () => {
    const motion = createPresentationMotion();
    motion.observe(frame(1000, 0), 2000);
    motion.observe(frame(1050, 500), 2050);
    expect(motion.sample(2050)).toEqual({ x: 500, y: 0 });
  });

  it('snaps the first sample after an explicit disconnect or stale reset', () => {
    const motion = createPresentationMotion();
    motion.observe(frame(1000, 0), 2000);
    motion.observe(frame(1050, 10), 2050);
    motion.reset();
    expect(motion.sample(2075)).toBeUndefined();
    motion.observe(frame(1100, 20), 2100);
    expect(motion.sample(2100)).toEqual({ x: 20, y: 0 });
  });
});
