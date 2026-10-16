// Generates realistic protocol TEXT (not pre-parsed objects) so the framer and
// parser are exercised exactly as they will be with real hardware — including
// BLE-style fragmentation and the occasional corrupted line.

import { Transport } from './transport.js';
import { formatRecord } from '../protocol/em-parser.js';
import { CONFIG } from '../config.js';

// Load profiles the simulator steps between, roughly a small transformer-fed bench load.
const LOADS = [
  { name: 'resistive',  currentMa: 95,  pf: 0.98, crest: 1.42 },
  { name: 'motor',      currentMa: 125, pf: 0.81, crest: 1.45 },
  { name: 'rectifier',  currentMa: 70,  pf: 0.64, crest: 2.10 },
  { name: 'light load', currentMa: 30,  pf: 0.90, crest: 1.50 },
];

const jitter = (scale) => (Math.random() * 2 - 1) * scale;

export class SimulatedTransport extends Transport {
  static label = 'Simulated';

  constructor({ intervalMs = CONFIG.simulation.intervalMs,
                chunkSize = CONFIG.simulation.chunkSize,
                faultRate = CONFIG.simulation.faultRate } = {}) {
    super();
    this.intervalMs = intervalMs;
    this.chunkSize = chunkSize;
    this.faultRate = faultRate;
    this.timers = new Set();
    this._resetModel();
  }

  _resetModel() {
    this.frequency = 50;
    this.voltage = 14.25;
    this.energyJ = 0;
    this.load = LOADS[1];
    this.current = this.load.currentMa;
    this.pf = this.load.pf;
    this.ticksUntilLoadChange = 25;
  }

  async connect() {
    this._setStatus('connecting', 'Starting simulator…');
    this._resetModel();
    this._schedule(() => {
      this._setStatus('connected', `Simulating at ${(this.intervalMs / 1000).toFixed(1)} s intervals`);
      this._tick();
      this.interval = setInterval(() => this._tick(), this.intervalMs);
    }, 300);
  }

  async disconnect() {
    clearInterval(this.interval);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this._setStatus('disconnected', 'Simulator stopped');
  }

  _schedule(fn, ms) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  _tick() {
    if (--this.ticksUntilLoadChange <= 0) {
      this.load = LOADS[Math.floor(Math.random() * LOADS.length)];
      this.ticksUntilLoadChange = 15 + Math.floor(Math.random() * 30);
    }

    // Slow random walks toward the active load profile, plus measurement noise.
    this.frequency += (50 - this.frequency) * 0.05 + jitter(0.015);
    this.voltage += (14.25 - this.voltage) * 0.1 + jitter(0.05) - (this.current - 90) * 0.0004;
    this.current += (this.load.currentMa - this.current) * 0.35 + jitter(1.2);
    this.pf += (this.load.pf - this.pf) * 0.35 + jitter(0.005);

    const currentMa = Math.max(0, this.current);
    const pf = Math.min(1, Math.max(0, this.pf));
    const apparent = this.voltage * currentMa / 1000;
    const real = apparent * pf;
    this.energyJ += real * this.intervalMs / 1000;

    let line = formatRecord({
      frequencyHz: this.frequency,
      voltageRmsV: this.voltage,
      currentRmsMa: currentMa,
      currentPeakMa: currentMa * (this.load.crest + jitter(0.02)),
      realPowerW: real,
      apparentPowerVA: apparent,
      powerFactor: pf,
      energyJ: this.energyJ,
    });

    if (Math.random() < this.faultRate) line = corrupt(line);
    this._sendFragmented(line);
  }

  // Emit a line the way an AT-09 delivers it: in ~20-byte notifications a few ms apart.
  _sendFragmented(line) {
    for (let i = 0, n = 0; i < line.length; i += this.chunkSize, n++) {
      const chunk = line.slice(i, i + this.chunkSize);
      this._schedule(() => this._emitData(chunk), n * 15);
    }
  }
}

function corrupt(line) {
  const body = line.replace(/\r\n$/, '');
  switch (Math.floor(Math.random() * 4)) {
    case 0:  return body.slice(0, Math.floor(body.length * 0.6)) + '\r\n';     // truncated record
    case 1:  return body.replace(/V,/, 'V,,') + '\r\n';                        // extra field
    case 2: {                                                                   // bit error
      const i = 8 + Math.floor(Math.random() * (body.length - 8));
      return body.slice(0, i) + '#' + body.slice(i + 1) + '\r\n';
    }
    default: return '\x00\xffEM' + body.slice(5) + '\r\n';                      // garbage prefix / lost header
  }
}
