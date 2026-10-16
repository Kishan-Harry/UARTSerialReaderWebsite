// Exports every recorded measurement as CSV.

import { KEYS } from './store.js';

const COLUMNS = [
  ['frequencyHz',     'frequency_hz',      2],
  ['voltageRmsV',     'voltage_rms_v',     2],
  ['currentRmsMa',    'current_rms_ma',    1],
  ['currentPeakMa',   'current_peak_ma',   1],
  ['realPowerW',      'real_power_w',      2],
  ['apparentPowerVA', 'apparent_power_va', 2],
  ['powerFactor',     'power_factor',      2],
  ['energyJ',         'energy_j',          2],
];

if (COLUMNS.length !== KEYS.length) throw new Error('CSV columns out of sync with protocol fields');

export function buildCsv(store) {
  const header = ['timestamp_iso', 'elapsed_s', ...COLUMNS.map(([, name]) => name)].join(',');
  const t0 = store.time[0] ?? 0;
  const rows = store.time.map((t, i) => [
    new Date(t * 1000).toISOString(),
    (t - t0).toFixed(3),
    ...COLUMNS.map(([key, , dp]) => store.columns[key][i].toFixed(dp)),
  ].join(','));
  return [header, ...rows].join('\r\n') + '\r\n';
}

export function downloadCsv(store) {
  if (store.length === 0) return false;

  const blob = new Blob([buildCsv(store)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `energy-monitor-${fileStamp(new Date(store.time[0] * 1000))}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

function fileStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
