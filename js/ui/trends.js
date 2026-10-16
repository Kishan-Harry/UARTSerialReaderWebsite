// Time-series trend charts for every measurement.

import { Chart } from './charts.js';
import { METRICS } from './metrics.js';

const TRENDS = [
  { title: 'Voltage RMS',            keys: ['voltageRmsV'],                    yUnit: 'V' },
  { title: 'Current',                keys: ['currentRmsMa', 'currentPeakMa'],  yUnit: 'mA' },
  { title: 'Power',                  keys: ['realPowerW', 'apparentPowerVA'],  yUnit: 'W / VA' },
  { title: 'Power factor',           keys: ['powerFactor'],                    yUnit: '',
    yRange: (u, min, max) => [Math.min(0, Math.floor(min * 10) / 10), Math.max(1, max)] },
  { title: 'Frequency',              keys: ['frequencyHz'],                    yUnit: 'Hz',
    // Keep at least ±0.1 Hz visible so normal grid wander doesn't look dramatic.
    yRange: (u, min, max) => {
      const mid = (min + max) / 2, half = Math.max(0.1, (max - min) / 2 * 1.2);
      return [mid - half, mid + half];
    } },
];

export class Trends {
  constructor(grid, store) {
    this.store = store;
    this.charts = TRENDS.map((t, i) => {
      const fig = document.createElement('figure');
      fig.className = 'chart-card';
      const cap = document.createElement('figcaption');
      cap.textContent = t.title;
      const el = document.createElement('div');
      el.className = 'chart';
      el.dataset.height = i === 0 ? '220' : '200';
      el.dataset.heightSm = '180';
      fig.append(cap, el);
      grid.appendChild(fig);

      const chart = new Chart(el, {
        series: t.keys.map((k) => METRICS[k]),
        yUnit: t.yUnit,
        yRange: t.yRange,
        syncKey: 'trend',
      });
      return { chart, keys: t.keys };
    });
  }

  /** @param {number} windowS seconds to show; 0 = everything */
  render(windowS) {
    const s = this.store;
    if (s.length === 0) {
      for (const { chart, keys } of this.charts) chart.setData([[], ...keys.map(() => [])]);
      return;
    }

    const last = s.time[s.length - 1];
    let start = 0;
    let range = null;
    if (windowS > 0) {
      // Until a full window has been recorded, use the whole width for what exists.
      const xMin = Math.max(s.time[0], last - windowS);
      start = Math.max(0, s.indexAtOrAfter(xMin) - 1);
      range = [xMin, last];
    }

    const x = s.time.slice(start);
    for (const { chart, keys } of this.charts) {
      chart.setData([x, ...keys.map((k) => s.columns[k].slice(start))], range);
    }
  }

  rebuild() {
    for (const { chart } of this.charts) chart.rebuild();
  }
}
