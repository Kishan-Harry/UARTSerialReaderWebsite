// Holds every accepted measurement for the session, in columnar form so charts
// can take slices without copying record objects.
//
// Events:
//   'record'  detail: { record, warnings }   — a new valid measurement
//   'stats'   detail: stats snapshot          — counters changed (incl. rejects)
//   'clear'

import { FIELDS } from '../protocol/em-parser.js';
import { CONFIG } from '../config.js';

export const KEYS = FIELDS.map((f) => f.key);

export class MeasurementStore extends EventTarget {
  constructor({ maxRecords = CONFIG.store.maxRecords } = {}) {
    super();
    this.maxRecords = maxRecords;
    this._init();
  }

  _init() {
    /** Receive time, seconds since epoch (uPlot's time-axis unit). */
    this.time = [];
    /** One array per measurement key, aligned with `time`. */
    this.columns = Object.fromEntries(KEYS.map((k) => [k, []]));
    this.stats = { received: 0, rejected: 0, warnings: 0, energyResets: 0, lastAt: null, startedAt: null };
    this.latest = null;
    this.min = {};
    this.max = {};
  }

  get length() {
    return this.time.length;
  }

  add(data, warnings = []) {
    const now = Date.now();
    const record = { t: now / 1000, ...data };

    // Energy is cumulative in firmware; a drop means the MCU reset.
    if (this.latest && data.energyJ < this.latest.energyJ - 0.01) {
      warnings = [...warnings, 'Energy counter reset (device restarted?)'];
      this.stats.energyResets++;
    }

    this.time.push(record.t);
    for (const k of KEYS) {
      this.columns[k].push(data[k]);
      if (!(data[k] >= this.min[k])) this.min[k] = data[k];
      if (!(data[k] <= this.max[k])) this.max[k] = data[k];
    }

    if (this.time.length > this.maxRecords) {
      const drop = this.time.length - this.maxRecords;
      this.time.splice(0, drop);
      for (const k of KEYS) this.columns[k].splice(0, drop);
    }

    this.latest = record;
    this.stats.received++;
    if (warnings.length) this.stats.warnings++;
    this.stats.lastAt = now;
    this.stats.startedAt ??= now;

    this.dispatchEvent(new CustomEvent('record', { detail: { record, warnings } }));
    this._emitStats();
  }

  reject() {
    this.stats.rejected++;
    this._emitStats();
  }

  /** Index of the first sample with time >= t (binary search; time is ascending). */
  indexAtOrAfter(t) {
    let lo = 0, hi = this.time.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.time[mid] < t) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  /** Last `n` values of one column (for sparklines). */
  tail(key, n) {
    const col = this.columns[key];
    return col.slice(Math.max(0, col.length - n));
  }

  /** Mean interval between the last few records, in seconds. */
  meanInterval(n = 10) {
    const len = this.time.length;
    if (len < 2) return null;
    const first = Math.max(0, len - 1 - n);
    return (this.time[len - 1] - this.time[first]) / (len - 1 - first);
  }

  clear() {
    this._init();
    this.dispatchEvent(new Event('clear'));
    this._emitStats();
  }

  _emitStats() {
    this.dispatchEvent(new CustomEvent('stats', { detail: this.stats }));
  }
}
