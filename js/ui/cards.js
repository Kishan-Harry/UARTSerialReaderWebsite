// Live measurement cards: value, unit, a context line and a sparkline.

import { METRICS, CARD_ORDER, fmt } from './metrics.js';
import { CONFIG } from '../config.js';

export class Cards {
  constructor(container, store) {
    this.store = store;
    this.cards = {};

    for (const key of CARD_ORDER) {
      const m = METRICS[key];
      const el = document.createElement('article');
      el.className = 'card stale';
      el.innerHTML = `
        <div class="card-label"><span class="card-key"></span><span class="name"></span></div>
        <div class="card-value"><span class="num">—</span><span class="card-unit"></span></div>
        <div class="card-sub">&nbsp;</div>
        <svg class="card-spark" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">
          <polyline points=""></polyline>
        </svg>`;
      el.querySelector('.card-key').style.background = `var(${m.color})`;
      el.querySelector('.name').textContent = m.label;
      el.querySelector('.card-unit').textContent = m.unit;
      el.setAttribute('aria-label', m.label);
      container.appendChild(el);

      this.cards[key] = {
        el,
        num: el.querySelector('.num'),
        sub: el.querySelector('.card-sub'),
        line: el.querySelector('polyline'),
      };
    }
  }

  update(record) {
    for (const key of CARD_ORDER) {
      const m = METRICS[key];
      const c = this.cards[key];
      c.num.textContent = fmt(record[key], m.decimals);
      c.sub.textContent = this._subtitle(key, record);
      this._spark(c.line, this.store.tail(key, CONFIG.ui.sparklinePoints), m);
    }
    this.setStale(false);
  }

  _subtitle(key, r) {
    const m = METRICS[key];
    switch (key) {
      case 'energyJ':
        return `${fmt(r.energyJ / 3600, 4)} Wh`;
      case 'powerFactor': {
        const deg = Math.acos(Math.max(-1, Math.min(1, r.powerFactor))) * 180 / Math.PI;
        return `φ = ${fmt(deg, 1)}°`;
      }
      case 'currentPeakMa':
        return r.currentRmsMa > 0 ? `crest factor ${fmt(r.currentPeakMa / r.currentRmsMa, 2)}` : 'crest factor —';
      case 'currentRmsMa':
        return `${fmt(r.currentRmsMa / 1000, 4)} A`;
      default: {
        const { min, max } = this.store;
        return `min ${fmt(min[key], m.decimals)} · max ${fmt(max[key], m.decimals)}`;
      }
    }
  }

  _spark(polyline, values, { decimals, sparkMinSpan }) {
    if (values.length < 2) {
      polyline.setAttribute('points', '');
      return;
    }
    let lo = Math.min(...values), hi = Math.max(...values);
    // Minimum span so last-digit rounding noise doesn't fill the whole sparkline.
    const minSpan = sparkMinSpan ?? Math.max(10 * 10 ** -decimals, Math.abs((lo + hi) / 2) * 0.02);
    if (hi - lo < minSpan) {
      const mid = (lo + hi) / 2;
      lo = mid - minSpan / 2;
      hi = mid + minSpan / 2;
    }
    const pad = 2, h = 26 - pad * 2;
    const step = 100 / (CONFIG.ui.sparklinePoints - 1);
    const x0 = 100 - step * (values.length - 1);
    const pts = values.map((v, i) => `${(x0 + i * step).toFixed(2)},${(pad + h - ((v - lo) / (hi - lo)) * h).toFixed(2)}`);
    polyline.setAttribute('points', pts.join(' '));
  }

  setStale(stale) {
    for (const c of Object.values(this.cards)) c.el.classList.toggle('stale', stale);
  }

  reset() {
    for (const c of Object.values(this.cards)) {
      c.num.textContent = '—';
      c.sub.innerHTML = '&nbsp;';
      c.line.setAttribute('points', '');
    }
    this.setStale(true);
  }
}
