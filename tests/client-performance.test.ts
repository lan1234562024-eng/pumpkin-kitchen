import { describe, it, expect } from 'vitest';
import { createPerformanceAccumulator } from '../src/client/performance';
import { isClientPerformanceReport, type ClientPerformanceReport } from '../src/shared/performance';

function emptyReport(): ClientPerformanceReport {
  return {
    type: 'client_performance', version: 1, visible: true,
    frame_count: 0, frame_p95_ms: 0, frame_max_ms: 0,
    long_task_count: 0, long_task_max_ms: 0,
    snapshot_count: 0, snapshot_gap_p95_ms: 0, snapshot_handler_p95_ms: 0, snapshot_age_ms: -1,
    input_ack_count: 0, input_ack_p95_ms: 0, input_pending: 0,
  };
}

describe('bounded client performance reports', () => {
  it('reports actual monotonic window length instead of assuming the timer fired on time', () => {
    const metrics = createPerformanceAccumulator(100);
    expect(metrics.report(2600, true).window_ms).toBe(2500);
    expect(metrics.report(4800, true).window_ms).toBe(2200);
    expect(metrics.report(1000000, true).window_ms).toBe(120000);
  });

  it('bounds CPU measurements to the newest 300 samples and clears each report window', () => {
    const metrics = createPerformanceAccumulator(0);
    for (let index = 0; index < 350; index++) {
      metrics.reactRender(index < 50 ? 1000 : 4);
      metrics.gameFrame(index < 50 ? 1000 : 8);
    }
    metrics.reactRender(-1);
    metrics.gameFrame(NaN);
    const report = metrics.report(2000, true);
    expect(report.react_render_count).toBe(300);
    expect(report.react_render_p95_ms).toBe(4);
    expect(report.game_frame_count).toBe(300);
    expect(report.game_frame_p95_ms).toBe(8);
    const next = metrics.report(4000, true);
    expect(next.react_render_count).toBe(0);
    expect(next.react_render_p95_ms).toBe(0);
    expect(next.game_frame_count).toBe(0);
    expect(next.game_frame_p95_ms).toBe(0);
  });

  it('accepts bounded optional measurement fields while preserving the old exact schema', () => {
    const valid: ClientPerformanceReport = {
      ...emptyReport(), window_ms: 2200, focused: false, long_task_supported: true,
      react_render_count: 20, react_render_p95_ms: 2.5, game_frame_count: 40, game_frame_p95_ms: 4.5,
    };
    expect(isClientPerformanceReport(emptyReport())).toBe(true);
    expect(isClientPerformanceReport(valid)).toBe(true);
    expect(isClientPerformanceReport({ ...emptyReport(), focused: true })).toBe(true);
    for (const invalid of [
      { ...valid, window_ms: -1 }, { ...valid, window_ms: 120001 },
      { ...valid, focused: 1 }, { ...valid, long_task_supported: 'yes' },
      { ...valid, react_render_count: 301 }, { ...valid, game_frame_count: 0.5 },
      { ...valid, react_render_p95_ms: Infinity }, { ...valid, game_frame_p95_ms: -1 },
      { ...valid, focused: undefined }, { ...valid, browser_details: 'extra' },
    ]) expect(isClientPerformanceReport(invalid)).toBe(false);
  });

  it('reports visible frame gaps with nearest-rank p95 and maximum', () => {
    const metrics = createPerformanceAccumulator();
    for (const now of [100, 116, 133, 183]) metrics.frame(now, true);
    const report = metrics.report(200, true);
    expect(report.frame_count).toBe(3);
    expect(report.frame_p95_ms).toBe(50);
    expect(report.frame_max_ms).toBe(50);
  });

  it('excludes the entire hidden interval from frame gaps', () => {
    const metrics = createPerformanceAccumulator();
    metrics.frame(100, true);
    metrics.frame(200, false);
    metrics.frame(10000, true);
    metrics.frame(10016, true);
    const report = metrics.report(10020, true);
    expect(report.frame_count).toBe(1);
    expect(report.frame_max_ms).toBe(16);
  });

  it('separates snapshot arrival gaps, handler time and latest snapshot age', () => {
    const metrics = createPerformanceAccumulator();
    metrics.snapshot(100, 2);
    metrics.snapshot(150, 4);
    metrics.snapshot(200, 6);
    const report = metrics.report(230, true);
    expect(report.snapshot_count).toBe(3);
    expect(report.snapshot_gap_p95_ms).toBe(50);
    expect(report.snapshot_handler_p95_ms).toBe(6);
    expect(report.snapshot_age_ms).toBe(30);
  });

  it('matches acknowledgements by sequence and ignores unknown or repeated acknowledgements', () => {
    const metrics = createPerformanceAccumulator();
    metrics.inputSent(1, 100);
    metrics.inputSent(2, 110);
    metrics.inputAck(99, 120);
    metrics.inputAck(1, 140);
    metrics.inputAck(1, 180);
    const report = metrics.report(200, true);
    expect(report.input_ack_count).toBe(1);
    expect(report.input_ack_p95_ms).toBe(40);
    expect(report.input_pending).toBe(1);
  });

  it('evicts the oldest pending acknowledgement when the 64-sequence limit is reached', () => {
    const metrics = createPerformanceAccumulator();
    for (let sequence = 0; sequence < 65; sequence++) metrics.inputSent(sequence, 100 + sequence);
    expect(metrics.report(200, true).input_pending).toBe(64);
    metrics.inputAck(0, 300);
    metrics.inputAck(64, 310);
    const report = metrics.report(320, true);
    expect(report.input_ack_count).toBe(1);
    expect(report.input_ack_p95_ms).toBe(146);
    expect(report.input_pending).toBe(63);
  });

  it('bounds each measurement ring to the newest 300 samples', () => {
    const metrics = createPerformanceAccumulator();
    metrics.frame(0, true);
    for (let index = 1; index <= 1000; index++) {
      metrics.frame(index * 10, true);
      metrics.longTask(index <= 700 ? 500 : 50);
      metrics.snapshot(index * 10, index <= 700 ? 200 : 2);
      metrics.inputSent(index, index * 10);
      metrics.inputAck(index, index * 10 + (index <= 700 ? 300 : 3));
    }
    const report = metrics.report(10010, true);
    expect(report.frame_count).toBe(300);
    expect(report.frame_max_ms).toBe(10);
    expect(report.long_task_count).toBe(300);
    expect(report.long_task_max_ms).toBe(50);
    expect(report.snapshot_count).toBe(300);
    expect(report.snapshot_handler_p95_ms).toBe(2);
    expect(report.input_ack_count).toBe(300);
    expect(report.input_ack_p95_ms).toBe(3);
  });

  it('starts a new aggregation window while retaining pending inputs and snapshot age', () => {
    const metrics = createPerformanceAccumulator();
    metrics.frame(100, true);
    metrics.frame(116, true);
    metrics.snapshot(120, 4);
    metrics.inputSent(1, 130);
    expect(metrics.report(140, true).frame_count).toBe(1);
    const next = metrics.report(200, false);
    expect(next.visible).toBe(false);
    expect(next.frame_count).toBe(0);
    expect(next.snapshot_count).toBe(0);
    expect(next.snapshot_age_ms).toBe(80);
    expect(next.input_pending).toBe(1);
    metrics.inputAck(1, 210);
    expect(metrics.report(220, true).input_ack_p95_ms).toBe(80);
  });

  it('uses -1 before a snapshot and caps unusually old or slow measurements', () => {
    const metrics = createPerformanceAccumulator();
    expect(metrics.report(0, true).snapshot_age_ms).toBe(-1);
    metrics.snapshot(0, 1000000);
    metrics.longTask(1000000);
    metrics.inputSent(1, 0);
    metrics.inputAck(1, 1000000);
    const report = metrics.report(1000000, true);
    expect(report.snapshot_age_ms).toBe(120000);
    expect(report.snapshot_handler_p95_ms).toBe(120000);
    expect(report.long_task_max_ms).toBe(120000);
    expect(report.input_ack_p95_ms).toBe(120000);
    expect(isClientPerformanceReport(report)).toBe(true);
  });

  it('accepts only the exact diagnostic schema with finite bounded scalar values', () => {
    const valid = emptyReport();
    expect(isClientPerformanceReport(valid)).toBe(true);
    for (const invalid of [
      { ...valid, raw_keys: ['KeyW'] },
      { ...valid, version: 2 },
      { ...valid, visible: 1 },
      { ...valid, frame_count: 301 },
      { ...valid, frame_count: 0.5 },
      { ...valid, input_pending: 65 },
      { ...valid, frame_p95_ms: NaN },
      { ...valid, frame_max_ms: Infinity },
      { ...valid, input_ack_p95_ms: -1 },
      { ...valid, snapshot_age_ms: -2 },
      { ...valid, snapshot_age_ms: 120001 },
      [], null,
    ]) expect(isClientPerformanceReport(invalid)).toBe(false);
    const missing: Partial<ClientPerformanceReport> = { ...valid };
    delete missing.input_pending;
    expect(isClientPerformanceReport(missing)).toBe(false);
  });

  it('ignores invalid durations, timestamps and input sequences', () => {
    const metrics = createPerformanceAccumulator();
    metrics.frame(NaN, true);
    metrics.longTask(-1);
    metrics.longTask(Infinity);
    metrics.snapshot(NaN, 1);
    metrics.snapshot(100, -1);
    metrics.inputSent(-1, 100);
    metrics.inputSent(1.5, 100);
    metrics.inputSent(1, NaN);
    const report = metrics.report(200, true);
    expect(report).toEqual(emptyReport());
  });
});
