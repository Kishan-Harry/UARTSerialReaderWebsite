// Parser for the energy-monitor UART protocol, version 1.
//
//   EM,1,50.00Hz,14.25V,123.4mA,174.5mA,1.42W,1.75VA,0.81,125.60J
//
// One record per line. The parser never throws: it returns either
//   { ok: true,  data, warnings }
//   { ok: false, reason }
// so a single corrupted line can never break the dashboard.
//
// Optional integrity check: a trailing NMEA-style checksum "*HH" (two hex digits,
// XOR of every character before the '*') is verified when present. Current
// firmware doesn't send one; records without it are accepted.

import { CONFIG } from '../config.js';

/** Measurement fields after the "EM,1," header, in protocol order. */
export const FIELDS = [
  { key: 'frequencyHz',     unit: 'Hz' },
  { key: 'voltageRmsV',     unit: 'V'  },
  { key: 'currentRmsMa',    unit: 'mA' },
  { key: 'currentPeakMa',   unit: 'mA' },
  { key: 'realPowerW',      unit: 'W'  },
  { key: 'apparentPowerVA', unit: 'VA' },
  { key: 'powerFactor',     unit: ''   },
  { key: 'energyJ',         unit: 'J'  },
];

const HEADER_FIELDS = 2;
const EXPECTED_FIELDS = HEADER_FIELDS + FIELDS.length;

// Plain decimal only: rejects "", "nan", "inf", "1e3", "12abc", "1.2.3".
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)$/;

const fail = (reason) => ({ ok: false, reason });

export function xorChecksum(text) {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum ^= text.charCodeAt(i) & 0xff;
  return sum;
}

/**
 * @param {string} line a single complete line, terminator already removed
 */
export function parseRecord(line) {
  if (typeof line !== 'string' || line.trim() === '') return fail('Empty line');

  let body = line.trim();

  const star = body.lastIndexOf('*');
  if (star !== -1) {
    const given = body.slice(star + 1);
    body = body.slice(0, star);
    if (!/^[0-9A-Fa-f]{2}$/.test(given)) return fail('Malformed checksum');
    const expected = xorChecksum(body);
    if (parseInt(given, 16) !== expected) {
      return fail(`Checksum mismatch (got ${given.toUpperCase()}, expected ${expected.toString(16).toUpperCase().padStart(2, '0')})`);
    }
  }

  const parts = body.split(',').map((p) => p.trim());

  if (parts[0] !== CONFIG.protocol.deviceId) {
    return fail(`Unknown device identifier "${parts[0].slice(0, 12)}"`);
  }
  if (parts.length < 2 || parts[1] !== CONFIG.protocol.version) {
    return fail(`Unsupported protocol version "${(parts[1] ?? '').slice(0, 8)}"`);
  }
  if (parts.length !== EXPECTED_FIELDS) {
    return fail(`Expected ${EXPECTED_FIELDS} fields, got ${parts.length}`);
  }

  const data = {};
  for (let i = 0; i < FIELDS.length; i++) {
    const { key, unit } = FIELDS[i];
    const raw = parts[HEADER_FIELDS + i];

    // The unit suffix doubles as a position check: a shifted or missing field
    // ends up with the wrong suffix and is rejected rather than misread.
    if (unit && !raw.endsWith(unit)) {
      return fail(`Field ${HEADER_FIELDS + i + 1} "${raw.slice(0, 16)}" should end in "${unit}"`);
    }
    const numeric = unit ? raw.slice(0, -unit.length).trim() : raw;
    if (!DECIMAL.test(numeric)) {
      return fail(`Field ${HEADER_FIELDS + i + 1} "${raw.slice(0, 16)}" is not a number`);
    }
    data[key] = Number(numeric);
  }

  return { ok: true, data, warnings: plausibilityWarnings(data) };
}

// Soft checks: the record is kept, but the dashboard flags it.
function plausibilityWarnings(d) {
  const w = [];
  if (Math.abs(d.powerFactor) > 1.005) w.push('|PF| > 1');
  if (Math.abs(d.realPowerW) > d.apparentPowerVA * 1.02 + 0.01) w.push('P exceeds S');
  if (d.voltageRmsV < 0 || d.currentRmsMa < 0 || d.apparentPowerVA < 0) w.push('Negative RMS value');
  if (d.frequencyHz !== 0 && (d.frequencyHz < 40 || d.frequencyHz > 70)) w.push('Frequency outside 40–70 Hz');
  if (d.currentRmsMa > 0 && d.currentPeakMa < d.currentRmsMa * 0.99) w.push('Peak current below RMS');
  return w;
}

/** Format a measurement object back into a protocol line (used by the simulator). */
export function formatRecord(d, { checksum = false } = {}) {
  const body = [
    CONFIG.protocol.deviceId,
    CONFIG.protocol.version,
    `${d.frequencyHz.toFixed(2)}Hz`,
    `${d.voltageRmsV.toFixed(2)}V`,
    `${d.currentRmsMa.toFixed(1)}mA`,
    `${d.currentPeakMa.toFixed(1)}mA`,
    `${d.realPowerW.toFixed(2)}W`,
    `${d.apparentPowerVA.toFixed(2)}VA`,
    d.powerFactor.toFixed(2),
    `${d.energyJ.toFixed(2)}J`,
  ].join(',');
  const suffix = checksum ? `*${xorChecksum(body).toString(16).toUpperCase().padStart(2, '0')}` : '';
  return `${body}${suffix}\r\n`;
}
