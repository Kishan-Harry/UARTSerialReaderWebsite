// Thin wrapper around uPlot: theme-aware colours, responsive sizing, an
// empty-state overlay, and a legend that doubles as the hover readout.
// uPlot is loaded as a classic script (window.uPlot) from vendor/.

import { cssVar } from './metrics.js';

const MOBILE_BREAKPOINT = 560;

const pad2 = (n) => String(n).padStart(2, '0');
// Compact 24-hour tick labels; uPlot's default date+time labels collide on narrow charts.
const clockLabel = (ts) => {
  const d = new Date(ts * 1000);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

export class Chart {
  /**
   * @param {HTMLElement} container
   * @param {object} opts
   * @param {{label: string, color: string, unit: string, decimals: number, scale?: string, fill?: boolean}[]} opts.series
   * @param {boolean} [opts.time=true]   x axis is wall-clock time (seconds since epoch)
   * @param {string}  [opts.xUnit]       unit for a numeric x axis
   * @param {string}  [opts.yUnit]       unit appended to y tick labels' axis
   * @param {Function}[opts.yRange]      uPlot range function
   * @param {string}  [opts.syncKey]     charts with the same key share a cursor
   * @param {Function}[opts.onDraw]      (u, ctx-colours) => void, drawn over the series
   * @param {string}  [opts.emptyText]
   * @param {boolean} [opts.latestInLegend=true] legend shows the newest values when not hovering
   * @param {{scale: string, label: string, side?: 'left'|'right', range?: Function, color?: string, grid?: boolean}[]} [opts.yAxes]
   *        several y scales (oscilloscope-style channels); series pick one via `scale`.
   *        Omit for a single y axis described by yUnit / yRange.
   */
  constructor(container, opts) {
    this.container = container;
    this.opts = { time: true, emptyText: 'Waiting for data…', latestInLegend: true, ...opts };
    this.data = [[], ...opts.series.map(() => [])];
    this.xRange = null;

    this.empty = document.createElement('div');
    this.empty.className = 'chart-empty';
    this.empty.textContent = this.opts.emptyText;

    this._build();

    this._resize = new ResizeObserver(() => this._fit());
    this._resize.observe(container);
  }

  _height() {
    const d = this.container.dataset;
    return Number(window.innerWidth < MOBILE_BREAKPOINT ? d.heightSm || d.height : d.height) || 200;
  }

  _build() {
    const o = this.opts;
    const c = {
      muted: cssVar('--muted'),
      grid: cssVar('--grid'),
      axis: cssVar('--axis'),
      surface: cssVar('--surface'),
      text2: cssVar('--text-2'),
    };
    this.colors = c;

    const axis = {
      stroke: c.muted,
      font: '11px system-ui, -apple-system, "Segoe UI", sans-serif',
      grid: { stroke: c.grid, width: 1 },
      ticks: { stroke: c.axis, width: 1, size: 4 },
      border: { show: true, stroke: c.axis, width: 1 },
    };

    const yAxes = o.yAxes ?? [{ scale: 'y', label: o.yUnit, range: o.yRange }];
    // On phones a multi-axis chart drops the rotated axis titles (units move to the
    // legend) so the plot keeps a usable width.
    this.compact = this._isCompact();

    const xSeries = o.time
      ? { value: (u, ts) => (ts == null ? '—' : new Date(ts * 1000).toLocaleTimeString()) }
      : { label: 't', value: (u, v) => (v == null ? '—' : `${v.toFixed(3)} ${o.xUnit ?? ''}`) };

    const uopts = {
      width: Math.max(200, this.container.clientWidth),
      height: this._height(),
      pxAlign: 0,
      cursor: {
        sync: o.syncKey ? { key: o.syncKey } : undefined,
        drag: { x: o.time, y: false },
        points: { size: 8, width: 2, stroke: c.surface },
      },
      scales: {
        x: { time: o.time },
        ...Object.fromEntries(yAxes.map((a) => [a.scale, a.range ? { range: a.range } : {}])),
      },
      series: [
        xSeries,
        ...o.series.map((s) => ({
          label: s.label,
          scale: s.scale ?? 'y',
          stroke: cssVar(s.color),
          // ~10% wash down to zero, for quantities whose area means something (energy).
          ...(s.fill ? { fill: `${cssVar(s.color)}1a` } : {}),
          width: 2,
          points: { show: false },
          value: (u, v) => (v == null ? '—' : `${v.toFixed(s.decimals)}${s.unit ? ' ' + s.unit : ''}`),
        })),
      ],
      axes: [
        {
          ...axis,
          space: o.time ? 70 : 40,
          values: o.time
            ? (u, vals) => vals.map((v) => clockLabel(v))
            : (u, vals) => vals.map((v) => `${+v.toFixed(3)}`),
          label: o.time ? undefined : o.xUnit,
          labelSize: o.time ? 0 : 18,
          labelFont: axis.font,
        },
        ...yAxes.map((a, i) => ({
          ...axis,
          scale: a.scale,
          side: a.side === 'right' ? 1 : 3,
          size: this.compact ? 36 : 52,
          label: this.compact ? undefined : a.label,
          labelSize: a.label && !this.compact ? 18 : 0,
          labelFont: axis.font,
          // Only the first axis draws gridlines; extra channels would just add clutter.
          grid: (a.grid ?? i === 0) ? axis.grid : { show: false },
          // A coloured axis line ties each scale to its trace; the text stays in ink.
          ...(a.color ? { border: { show: true, stroke: cssVar(a.color), width: 2 } } : {}),
        })),
      ],
      legend: { live: true },
      hooks: {
        ...(o.onDraw ? { draw: [(u) => o.onDraw(u, c)] } : {}),
        // Restore the latest-value readout when the pointer leaves.
        setCursor: [(u) => this._showLatestInLegend(u)],
      },
    };

    this.container.replaceChildren();
    this.u = new uPlot(uopts, this.data, this.container);
    this.container.appendChild(this.empty);
    this._applyRange();
    this._updateEmpty();
  }

  _isCompact() {
    return (this.opts.yAxes?.length ?? 1) > 1 && window.innerWidth < MOBILE_BREAKPOINT;
  }

  _fit() {
    if (this._isCompact() !== this.compact) {
      this.rebuild();
      return;
    }
    const width = Math.max(200, this.container.clientWidth);
    const height = this._height();
    if (width !== this.u.width || height !== this.u.height) this.u.setSize({ width, height });
  }

  /**
   * @param {Array<number[]>} data   [x, ...series], uPlot column format
   * @param {[number, number]} [xRange] force the visible x range
   */
  setData(data, xRange = null) {
    this.data = data;
    this.xRange = xRange;
    this.u.setData(data, !xRange);
    this._applyRange();
    this._updateEmpty();
    this._showLatestInLegend();
  }

  // When the pointer isn't over the chart, the legend reads out the newest values.
  _showLatestInLegend(u = this.u) {
    if (!this.opts.latestInLegend) return;
    const n = u?.data[0]?.length ?? 0;
    if (n > 0 && !(u.cursor.left >= 0)) u.setLegend({ idx: n - 1 });
  }

  _applyRange() {
    if (this.xRange && this.xRange[1] > this.xRange[0]) {
      this.u.setScale('x', { min: this.xRange[0], max: this.xRange[1] });
    }
  }

  _updateEmpty() {
    this.empty.hidden = this.data[0].length > 0;
  }

  /** Re-create with current theme colours, keeping data. */
  rebuild() {
    this.u.destroy();
    this._build();
  }

  redraw() {
    this.u.redraw();
  }
}
