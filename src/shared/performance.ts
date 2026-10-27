export interface ClientPerformanceReport {
  type: 'client_performance';
  version: 1;
  visible: boolean;
  frame_count: number;
  frame_p95_ms: number;
  frame_max_ms: number;
  long_task_count: number;
  long_task_max_ms: number;
  snapshot_count: number;
  snapshot_gap_p95_ms: number;
  snapshot_handler_p95_ms: number;
  /** -1 means no snapshot has arrived; other values are capped at 120000 ms. */
  snapshot_age_ms: number;
  input_ack_count: number;
  input_ack_p95_ms: number;
  input_pending: number;
  window_ms?: number;
  focused?: boolean;
  long_task_supported?: boolean;
  react_render_count?: number;
  react_render_p95_ms?: number;
  game_frame_count?: number;
  game_frame_p95_ms?: number;
}

const keys = [
  'type', 'version', 'visible', 'frame_count', 'frame_p95_ms', 'frame_max_ms',
  'long_task_count', 'long_task_max_ms', 'snapshot_count', 'snapshot_gap_p95_ms',
  'snapshot_handler_p95_ms', 'snapshot_age_ms', 'input_ack_count', 'input_ack_p95_ms', 'input_pending',
] as const;
const optionalKeys = [
  'window_ms', 'focused', 'long_task_supported', 'react_render_count', 'react_render_p95_ms', 'game_frame_count', 'game_frame_p95_ms',
] as const;

function bounded(value: unknown, maximum: number, integer = false): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum &&
    (!integer || Number.isInteger(value));
}

/** Exact scalar-only schema; durations are capped at two minutes, rings at 300 samples. */
export function isClientPerformanceReport(value: unknown): value is ClientPerformanceReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  const actualKeys = Object.keys(report);
  const has = (key: string) => Object.prototype.hasOwnProperty.call(report, key);
  if (!keys.every(has) || !actualKeys.every(key => (keys as readonly string[]).includes(key) || (optionalKeys as readonly string[]).includes(key))) return false;
  return report.type === 'client_performance' && report.version === 1 && typeof report.visible === 'boolean' &&
    ['frame_count', 'long_task_count', 'snapshot_count', 'input_ack_count'].every(key => bounded(report[key], 300, true)) &&
    ['frame_p95_ms', 'frame_max_ms', 'long_task_max_ms', 'snapshot_gap_p95_ms', 'snapshot_handler_p95_ms', 'input_ack_p95_ms'].every(key => bounded(report[key], 120000)) &&
    (report.snapshot_age_ms === -1 || bounded(report.snapshot_age_ms, 120000)) && bounded(report.input_pending, 64, true) &&
    ['window_ms', 'react_render_p95_ms', 'game_frame_p95_ms'].every(key => !has(key) || bounded(report[key], 120000)) &&
    ['react_render_count', 'game_frame_count'].every(key => !has(key) || bounded(report[key], 300, true)) &&
    ['focused', 'long_task_supported'].every(key => !has(key) || typeof report[key] === 'boolean');
}

