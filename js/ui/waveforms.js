// Reconstructed, idealised voltage, current and instantaneous-power waveforms.
//
// The firmware reports summary values only (RMS, peak, PF, f) — not samples — so
// these are pure sinusoids synthesised from the latest complete record:
//
//   v(t) = √2 · V_rms · sin(ωt)
//   i(t) = √2 · I_rms · sin(ωt − φ),   φ = arccos(PF)
//   p(t) = v(t) · i(t) = V_rms·I_rms·cos φ − V_rms·I_rms·cos(2ωt − φ)
//
// All loads in this project are inductive (RL), so the current is drawn LAGGING
// the voltage by φ. p(t) oscillates at 2f about its mean, which is the real power
// P; the parts below zero are energy the inductance returns to the source.
//
// Three charts share one time axis and cursor: a combined v/i/p "scope" view
// (primary) plus the separate v(t) and i(t) charts. The measured current peak is
// overlaid on i(t) so a non-sinusoidal current (peak ≠ √2·I_rms) still shows.

import { Chart } from './charts.js';
import { METRICS, cssVar, fmt } from './metrics.js';
import { CONFIG } from '../config.js';

const DEG = 180 / Math.PI;
const HEADROOM = 1.15;
const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/**
 * Pure reconstruction maths (no DOM) — exported for tests.
 * Current is in mA, as reported; power is in W.
 */
export function reconstructWaveforms(r, { cycles = CONFIG.waveform.cycles, samplesPerCycle = CONFIG.waveform.samplesPerCycle } = {}) {
  const f = r.frequencyHz;
  if (!(f > 0)) return null;

  const pf = Math.max(-1, Math.min(1, r.powerFactor));
  const phi = Math.acos(pf);                 // rad; current lags voltage (inductive load)
  const vPeak = Math.SQRT2 * r.voltageRmsV;  // V
  const iPeak = Math.SQRT2 * r.currentRmsMa; // mA
  const periodMs = 1000 / f;
  const w = (2 * Math.PI * f) / 1000;        // rad per ms

  const n = cycles * samplesPerCycle + 1;
  const t = new Array(n), v = new Array(n), i = new Array(n), p = new Array(n);
  for (let k = 0; k < n; k++) {
    const tm = (k / samplesPerCycle) * periodMs;
    t[k] = tm;
    v[k] = vPeak * Math.sin(w * tm);
    i[k] = iPeak * Math.sin(w * tm - phi);
    p[k] = (v[k] * i[k]) / 1000;             // V × mA → W
  }

  const s = (r.voltageRmsV * r.currentRmsMa) / 1000; // apparent power of the reconstruction, VA
  return {
    t, v, i, p,
    periodMs, phi, vPeak, iPeak,
    lagMs: phi / w,
    pMeanW: s * Math.cos(phi),               // = P
    pMaxW: s * (Math.cos(phi) + 1),
    pMinW: s * (Math.cos(phi) - 1),
    qVar: s * Math.sin(phi),
    rangeMs: [0, cycles * periodMs],
  };
}

const symmetric = (getPeak) => () => {
  const peak = getPeak() || 1;
  return [-peak * HEADROOM, peak * HEADROOM];
};

export class Waveforms {
  constructor({ combinedEl, voltageEl, currentEl, factsEl }) {
    this.factsEl = factsEl;
    this.w = null;
    this.measuredPeakMa = null;

    const vPeak = () => this.w?.vPeak;
    const iPeak = () => this.w && Math.max(this.w.iPeak, this.measuredPeakMa || 0);
    // Symmetric about zero like the other two channels, so all three zero lines coincide.
    const pPeak = () => this.w && Math.max(Math.abs(this.w.pMaxW), Math.abs(this.w.pMinW));

    const common = { time: false, xUnit: 'ms', syncKey: 'wave', latestInLegend: false };

    // Primary view: oscilloscope-style, one time axis, one vertical scale per channel.
    this.combined = new Chart(combinedEl, {
      ...common,
      series: [
        { ...METRICS.voltageRmsV, label: 'v(t) voltage [V]', scale: 'v' },
        { ...METRICS.currentRmsMa, label: 'i(t) current [mA]', scale: 'i' },
        { ...METRICS.realPowerW, label: 'p(t) = v·i power [W]', scale: 'p', decimals: 3, fill: true },
      ],
      yAxes: [
        { scale: 'v', label: 'Voltage (V)',  side: 'left',  range: symmetric(vPeak), color: METRICS.voltageRmsV.color },
        { scale: 'i', label: 'Current (mA)', side: 'right', range: symmetric(iPeak), color: METRICS.currentRmsMa.color },
        { scale: 'p', label: 'Power (W)',    side: 'right', range: symmetric(pPeak), color: METRICS.realPowerW.color },
      ],
      onDraw: (u, c) => this._drawMeanPower(u, c),
    });

    this.vChart = new Chart(voltageEl, {
      ...common,
      yUnit: 'Voltage (V)',
      series: [{ ...METRICS.voltageRmsV, label: 'v(t)' }],
      yRange: symmetric(vPeak),
    });

    this.iChart = new Chart(currentEl, {
      ...common,
      yUnit: 'Current (mA)',
      series: [{ ...METRICS.currentRmsMa, label: 'i(t)' }],
      yRange: symmetric(iPeak),
      onDraw: (u, c) => this._drawMeasuredPeak(u, c),
    });

    this._renderFacts(null, null);
  }

  /** Call once per complete protocol record. */
  update(r) {
    const w = reconstructWaveforms(r);
    if (!w) return; // can't draw a waveform without a frequency

    this.w = w;
    this.measuredPeakMa = r.currentPeakMa;

    this.combined.setData([w.t, w.v, w.i, w.p], w.rangeMs);
    this.vChart.setData([w.t, w.v], w.rangeMs);
    this.iChart.setData([w.t, w.i], w.rangeMs);

    this._renderFacts(w, r);
  }

  // Horizontal reference at mean p(t), i.e. the real power P.
  _drawMeanPower(u, c) {
    if (!this.w || u.data[0].length === 0) return;
    const y = Math.round(u.valToPos(this.w.pMeanW, 'p', true));
    this._refLine(u, y, cssVar(METRICS.realPowerW.color), c.text2,
      `mean p(t) = P = ${this.w.pMeanW.toFixed(3)} W`, 'left');
  }

  // Reference lines at ± the measured current peak.
  _drawMeasuredPeak(u, c) {
    const p = this.measuredPeakMa;
    if (!(p > 0) || u.data[0].length === 0) return;
    const color = cssVar(METRICS.currentPeakMa.color);
    this._refLine(u, Math.round(u.valToPos(p, 'y', true)), color, c.text2, `measured peak ±${p.toFixed(1)} mA`, 'right');
    this._refLine(u, Math.round(u.valToPos(-p, 'y', true)), color, null, '', 'right');
  }

  _refLine(u, y, stroke, textColor, label, align) {
    const ctx = u.ctx;
    const { left, width } = u.bbox;
    const dpr = window.devicePixelRatio || 1;

    ctx.save();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5 * dpr;
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + width, y);
    ctx.stroke();

    if (label) {
      ctx.setLineDash([]);
      ctx.font = `${11 * dpr}px ${FONT}`;
      ctx.textAlign = align;
      ctx.textBaseline = 'bottom';
      const x = align === 'right' ? left + width - 6 * dpr : left + 6 * dpr;
      const ty = y - 3 * dpr;
      // Surface-coloured plate so the label stays legible where traces cross it.
      const tw = ctx.measureText(label).width;
      const pad = 3 * dpr;
      ctx.fillStyle = cssVar('--surface');
      ctx.globalAlpha = 0.9;
      ctx.fillRect(align === 'right' ? x - tw - pad : x - pad, ty - 13 * dpr, tw + pad * 2, 14 * dpr);
      ctx.globalAlpha = 1;
      ctx.fillStyle = textColor;
      ctx.fillText(label, x, ty);
    }
    ctx.restore();
  }

  _renderFacts(w, r) {
    const rows = [
      ['Period T',          w && `${fmt(w.periodMs, 2)} ms`],
      ['Phase φ',           w && `${fmt(w.phi * DEG, 1)}° lag`],
      ['Current lag Δt',    w && `${fmt(w.lagMs, 2)} ms`],
      ['V peak',            w && `${fmt(w.vPeak, 2)} V`],
      ['I peak (ideal)',    w && `${fmt(w.iPeak, 1)} mA`],
      ['I peak (measured)', r && `${fmt(r.currentPeakMa, 1)} mA`],
      ['p(t) max',          w && `${fmt(w.pMaxW, 3)} W`],
      ['p(t) min',          w && `${fmt(w.pMinW, 3)} W`],
      ['Mean p(t) = P',     w && `${fmt(w.pMeanW, 3)} W`],
      ['Reactive Q',        w && `${fmt(w.qVar, 3)} var`],
    ];
    this.factsEl.replaceChildren(...rows.map(([k, v]) => {
      const div = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = k;
      dd.textContent = v ?? '—';
      div.append(dt, dd);
      return div;
    }));
  }

  clear() {
    this.w = null;
    this.measuredPeakMa = null;
    this.combined.setData([[], [], [], []]);
    this.vChart.setData([[], []]);
    this.iChart.setData([[], []]);
    this._renderFacts(null, null);
  }

  rebuild() {
    this.combined.rebuild();
    this.vChart.rebuild();
    this.iChart.rebuild();
  }
}
