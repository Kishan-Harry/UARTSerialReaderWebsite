// Minimal in-browser test runner for the protocol layer. Open tests/index.html
// through a local server (python -m http.server) — no build tools needed.

import { LineFramer } from '../js/protocol/line-framer.js';
import { parseRecord, formatRecord, xorChecksum } from '../js/protocol/em-parser.js';
import { normalizeUuid, shortUuid } from '../js/transports/ble-uuid.js';
import { MeasurementStore } from '../js/data/store.js';
import { buildCsv } from '../js/data/csv-export.js';
import { reconstructWaveforms } from '../js/ui/waveforms.js';
import { parseNamePrefixes, buildRequestOptions } from '../js/transports/web-bluetooth.js';
import { migrateSettings } from '../js/ui/settings.js';

const results = [];
const test = (name, fn) => {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, error: e.message }); }
};
const eq = (a, b, msg = '') => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
};
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

const SAMPLE = 'EM,1,500.00Hz,14.25V,123.4mA,174.5mA,1.42W,1.75VA,0.81,125.60J';
const collect = (opts = {}) => {
  const lines = [], overflows = [];
  const f = new LineFramer({ onLine: (l) => lines.push(l), onOverflow: (d) => overflows.push(d), ...opts });
  return { f, lines, overflows };
};

// --- Line framer -------------------------------------------------------------

test('framer: whole line in one chunk', () => {
  const { f, lines } = collect();
  f.push(SAMPLE + '\r\n');
  eq(lines, [SAMPLE]);
});

test('framer: line split into 20-byte BLE notifications', () => {
  const { f, lines } = collect();
  const data = SAMPLE + '\r\n';
  for (let i = 0; i < data.length; i += 20) {
    f.push(data.slice(i, i + 20));
    if (i + 20 < data.length) eq(lines.length, 0, 'no line before terminator:');
  }
  eq(lines, [SAMPLE]);
});

test('framer: \\r and \\n in separate chunks', () => {
  const { f, lines } = collect();
  f.push(SAMPLE + '\r');
  eq(lines.length, 0, 'no line until \\n:');
  f.push('\nEM');
  eq(lines, [SAMPLE]);
});

test('framer: several lines in one chunk, plus a trailing partial', () => {
  const { f, lines } = collect();
  f.push(`${SAMPLE}\r\n${SAMPLE}\r\nEM,1,50`);
  eq(lines.length, 2);
  f.push('0.00Hz\r\n');
  eq(lines[2], 'EM,1,500.00Hz');
});

test('framer: byte-at-a-time delivery', () => {
  const { f, lines } = collect();
  for (const ch of SAMPLE + '\r\n' + SAMPLE + '\r\n') f.push(ch);
  eq(lines, [SAMPLE, SAMPLE]);
});

test('framer: blank lines are ignored', () => {
  const { f, lines } = collect();
  f.push('\r\n\r\n' + SAMPLE + '\r\n\n');
  eq(lines, [SAMPLE]);
});

test('framer: overflow without terminator is dropped, then recovers', () => {
  const { f, lines, overflows } = collect({ maxLineLength: 64 });
  f.push('x'.repeat(100));
  eq(overflows.length, 1);
  f.push('\r\n' + SAMPLE + '\r\n');
  eq(lines, [SAMPLE]);
});

test('framer: reset discards partial line', () => {
  const { f, lines } = collect();
  f.push('EM,1,50.0');
  f.reset();
  f.push(SAMPLE + '\r\n');
  eq(lines, [SAMPLE]);
});

// --- Parser ------------------------------------------------------------------

test('parser: example record', () => {
  const r = parseRecord(SAMPLE);
  assert(r.ok, r.reason);
  eq(r.data, {
    frequencyHz: 500, voltageRmsV: 14.25, currentRmsMa: 123.4, currentPeakMa: 174.5,
    realPowerW: 1.42, apparentPowerVA: 1.75, powerFactor: 0.81, energyJ: 125.6,
  });
  eq(r.warnings, []);
});

test('parser: tolerates spaces around fields', () => {
  assert(parseRecord('EM, 1, 500.00Hz, 14.25V,123.4mA,174.5mA, 1.42W,1.75VA,0.81,125.60J').ok);
});

test('parser: frequency outside 450–550 Hz is flagged, not rejected', () => {
  for (const f of ['50.00', '449.99', '550.01']) {
    const r = parseRecord(SAMPLE.replace('500.00Hz', `${f}Hz`));
    assert(r.ok, r.reason);
    assert(r.warnings.some((w) => w.startsWith('Frequency outside')), `${f} Hz should warn`);
  }
  for (const f of ['450.00', '550.00', '512.34']) {
    eq(parseRecord(SAMPLE.replace('500.00Hz', `${f}Hz`)).warnings, [], `${f} Hz:`);
  }
});

test('parser: negative and zero values', () => {
  const r = parseRecord('EM,1,0.00Hz,0.00V,0.0mA,0.0mA,-0.50W,0.00VA,-0.20,0.00J');
  assert(r.ok, r.reason);
  eq(r.data.realPowerW, -0.5);
});

const rejects = {
  'empty line': '',
  'wrong device id': SAMPLE.replace('EM,', 'XX,'),
  'unsupported version': SAMPLE.replace('EM,1,', 'EM,2,'),
  'missing field': SAMPLE.replace(',0.81', ''),
  'extra field': SAMPLE + ',1.00',
  'truncated record': SAMPLE.slice(0, 30),
  'wrong unit (shifted fields)': 'EM,1,14.25V,500.00Hz,123.4mA,174.5mA,1.42W,1.75VA,0.81,125.60J',
  'A instead of mA': SAMPLE.replace('123.4mA', '0.1234A'),
  'non-numeric value': SAMPLE.replace('14.25V', '14.2#V'),
  'nan from dtostrf': SAMPLE.replace('1.42W', 'nanW'),
  'unit only': SAMPLE.replace('14.25V', 'V'),
  'two decimal points': SAMPLE.replace('14.25V', '14.2.5V'),
  'exponent notation': SAMPLE.replace('1.42W', '1e2W'),
  'garbage prefix': '\x00\xffEM' + SAMPLE.slice(5),
  'empty field': SAMPLE.replace('V,', 'V,,').replace(',0.81', ''),
};
for (const [name, line] of Object.entries(rejects)) {
  test(`parser rejects: ${name}`, () => {
    const r = parseRecord(line);
    assert(!r.ok, 'should have been rejected');
    assert(typeof r.reason === 'string' && r.reason.length > 0, 'needs a reason');
  });
}

test('parser: non-string input does not throw', () => {
  assert(!parseRecord(undefined).ok);
  assert(!parseRecord(null).ok);
});

test('parser: valid checksum accepted', () => {
  const line = `${SAMPLE}*${xorChecksum(SAMPLE).toString(16).padStart(2, '0')}`;
  assert(parseRecord(line).ok, parseRecord(line).reason);
});

test('parser: bad checksum rejected', () => {
  const bad = ((xorChecksum(SAMPLE) ^ 0x01)).toString(16).padStart(2, '0');
  const r = parseRecord(`${SAMPLE}*${bad}`);
  assert(!r.ok && /Checksum/.test(r.reason), r.reason);
});

test('parser: plausibility warnings do not reject', () => {
  const r = parseRecord('EM,1,500.00Hz,14.25V,123.4mA,174.5mA,2.50W,1.75VA,1.20,125.60J');
  assert(r.ok);
  assert(r.warnings.includes('P exceeds S') && r.warnings.includes('|PF| > 1'), JSON.stringify(r.warnings));
});

test('formatRecord round-trips through the framer and parser', () => {
  const d = { frequencyHz: 499.98, voltageRmsV: 14.2, currentRmsMa: 99.95, currentPeakMa: 141.3,
              realPowerW: 1.3, apparentPowerVA: 1.42, powerFactor: 0.92, energyJ: 3600 };
  for (const checksum of [false, true]) {
    const { f, lines } = collect();
    f.push(formatRecord(d, { checksum }));
    const r = parseRecord(lines[0]);
    assert(r.ok, r.reason);
    eq(r.data.currentRmsMa, 100.0);
    eq(r.data.energyJ, 3600);
  }
});

// --- BLE UUIDs ---------------------------------------------------------------

test('uuid: 16-bit forms', () => {
  const full = '0000ffe0-0000-1000-8000-00805f9b34fb';
  for (const s of ['ffe0', 'FFE0', '0xFFE0', ' ffe0 ', '0000ffe0', full.toUpperCase()]) eq(normalizeUuid(s), full, s);
});

test('uuid: custom 128-bit preserved', () => {
  eq(normalizeUuid('6E400001-B5A3-F393-E0A9-E50E24DCCA9E'), '6e400001-b5a3-f393-e0a9-e50e24dcca9e');
});

test('uuid: invalid rejected', () => {
  for (const s of ['', 'ffe', 'fffe0', 'zzzz', '1234-5678', null]) eq(normalizeUuid(s), null, String(s));
});

test('uuid: short display form', () => {
  eq(shortUuid('0000ffe1-0000-1000-8000-00805f9b34fb'), 'ffe1');
  eq(shortUuid('6e400001-b5a3-f393-e0a9-e50e24dcca9e'), '6e400001-b5a3-f393-e0a9-e50e24dcca9e');
});

// --- BLE device filter -------------------------------------------------------

const FFE0 = '0000ffe0-0000-1000-8000-00805f9b34fb';

test('ble filter: parse comma-separated prefixes', () => {
  eq(parseNamePrefixes('BT05'), ['BT05']);
  eq(parseNamePrefixes(' BT05, MLT-BT05 ;HMSoft,, BT05 '), ['BT05', 'MLT-BT05', 'HMSoft']);
  eq(parseNamePrefixes(''), []);
  eq(parseNamePrefixes(undefined), []);
});

test('ble filter: name prefix only lists matching devices', () => {
  eq(buildRequestOptions({ prefixes: ['BT05'], optionalServices: [FFE0] }),
    { filters: [{ namePrefix: 'BT05' }], optionalServices: [FFE0] });
});

test('ble filter: several prefixes plus service match are OR-ed', () => {
  eq(buildRequestOptions({ prefixes: ['BT05', 'HMSoft'], matchService: true, optionalServices: [FFE0] }),
    { filters: [{ namePrefix: 'BT05' }, { namePrefix: 'HMSoft' }, { services: [FFE0] }], optionalServices: [FFE0] });
});

test('ble filter: no filter falls back to all devices', () => {
  eq(buildRequestOptions({ optionalServices: [FFE0] }), { acceptAllDevices: true, optionalServices: [FFE0] });
});

test('settings: v1 blank name filter migrates to BT05; explicit choices kept', () => {
  eq(migrateSettings({}).bleNamePrefix, 'BT05');
  eq(migrateSettings({ bleNamePrefix: '' }).bleNamePrefix, 'BT05');
  eq(migrateSettings({ bleNamePrefix: 'MyModule' }).bleNamePrefix, 'MyModule');
  eq(migrateSettings({ settingsVersion: 2, bleNamePrefix: '' }).bleNamePrefix, '', 'v2 blank means "all devices":');
  eq(migrateSettings({}).settingsVersion, 2);
});

// --- Store & CSV -------------------------------------------------------------

test('store: records, min/max, energy reset detection', () => {
  const s = new MeasurementStore();
  const warns = [];
  s.addEventListener('record', (e) => warns.push(e.detail.warnings));
  s.add(parseRecord(SAMPLE).data);
  s.add(parseRecord(SAMPLE.replace('14.25V', '15.00V').replace('125.60J', '130.00J')).data);
  s.add(parseRecord(SAMPLE.replace('125.60J', '1.00J')).data);
  eq(s.length, 3);
  eq(s.max.voltageRmsV, 15);
  eq(s.min.voltageRmsV, 14.25);
  eq(warns[2].length, 1, 'energy reset warning:');
  eq(s.stats.energyResets, 1);
});

test('store: maxRecords cap drops oldest', () => {
  const s = new MeasurementStore({ maxRecords: 5 });
  for (let i = 0; i < 8; i++) s.add(parseRecord(SAMPLE.replace('125.60J', `${i}.00J`)).data);
  eq(s.length, 5);
  eq(s.columns.energyJ[0], 3);
});

test('csv: header and row formatting', () => {
  const s = new MeasurementStore();
  s.add(parseRecord(SAMPLE).data);
  const [header, row] = buildCsv(s).split('\r\n');
  eq(header, 'timestamp_iso,elapsed_s,frequency_hz,voltage_rms_v,current_rms_ma,current_peak_ma,real_power_w,apparent_power_va,power_factor,energy_j');
  eq(row.split(',').slice(1).join(','), '0.000,500.00,14.25,123.4,174.5,1.42,1.75,0.81,125.60');
});

// --- Waveform reconstruction -------------------------------------------------

const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg}: expected ${b}, got ${a}`);
const SAMPLE_DATA = parseRecord(SAMPLE).data; // 500 Hz, 14.25 V, 123.4 mA, PF 0.81

test('waveform: peaks, period and lagging phase from PF', () => {
  const w = reconstructWaveforms(SAMPLE_DATA, { cycles: 3, samplesPerCycle: 360 });
  near(w.periodMs, 2, 1e-9, 'period');
  near(w.vPeak, 14.25 * Math.SQRT2, 1e-9, 'V peak');
  near(Math.max(...w.v), w.vPeak, 1e-3, 'sampled V peak');
  near(Math.max(...w.i), 123.4 * Math.SQRT2, 0.01, 'sampled I peak');
  near(w.phi, Math.acos(0.81), 1e-12, 'phi');
  near(w.lagMs, Math.acos(0.81) / (2 * Math.PI) * 2, 1e-9, 'lag');
  eq(w.rangeMs, [0, 6]);
});

test('waveform: current lags — i(t) crosses zero rising Δt after v(t)', () => {
  const w = reconstructWaveforms(SAMPLE_DATA, { cycles: 1, samplesPerCycle: 3600 });
  const k = w.i.findIndex((x, n) => n > 0 && w.i[n - 1] < 0 && x >= 0);
  near(w.t[k], w.lagMs, 2 / 3600 + 1e-9, 'rising zero crossing');
});

test('waveform: p(t) = v·i, mean equals V·I·PF, extremes S(cosφ ± 1)', () => {
  const w = reconstructWaveforms(SAMPLE_DATA, { cycles: 4, samplesPerCycle: 400 });
  for (const k of [0, 37, 211, 999]) near(w.p[k], w.v[k] * w.i[k] / 1000, 1e-12, `p[${k}]`);
  const mean = w.p.slice(0, -1).reduce((a, b) => a + b, 0) / (w.p.length - 1); // whole cycles
  const s = 14.25 * 0.1234;
  near(mean, s * 0.81, 1e-6, 'mean p');
  near(w.pMeanW, s * 0.81, 1e-12, 'pMeanW');
  near(Math.max(...w.p), s * 1.81, 1e-3, 'p max');
  near(Math.min(...w.p), s * -0.19, 1e-3, 'p min (energy returned by inductance)');
  near(w.qVar, s * Math.sin(Math.acos(0.81)), 1e-12, 'Q');
});

test('waveform: unity PF gives in-phase current and non-negative p(t)', () => {
  const w = reconstructWaveforms({ ...SAMPLE_DATA, powerFactor: 1 });
  eq(w.lagMs, 0);
  assert(Math.min(...w.p) > -1e-12, 'p(t) should never go negative at PF = 1');
});

test('waveform: no frequency → no reconstruction', () => {
  eq(reconstructWaveforms({ ...SAMPLE_DATA, frequencyHz: 0 }), null);
});

// --- Report ------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
const summary = document.getElementById('summary');
summary.textContent = `${results.length - failed.length} passed, ${failed.length} failed`;
summary.dataset.result = failed.length ? 'fail' : 'pass';

const list = document.getElementById('results');
for (const r of results) {
  const li = document.createElement('li');
  li.className = r.ok ? 'pass' : 'fail';
  li.textContent = `${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : ` — ${r.error}`}`;
  list.appendChild(li);
}
