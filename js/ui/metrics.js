// Display metadata for each measurement. `color` names a CSS custom property so
// every quantity keeps the same colour on cards, trend charts and waveforms.

export const METRICS = {
  voltageRmsV:     { label: 'Voltage RMS',    unit: 'V',  decimals: 2, color: '--s-voltage' },
  currentRmsMa:    { label: 'Current RMS',    unit: 'mA', decimals: 1, color: '--s-current' },
  currentPeakMa:   { label: 'Current peak',   unit: 'mA', decimals: 1, color: '--s-current-peak' },
  realPowerW:      { label: 'Real power',     unit: 'W',  decimals: 2, color: '--s-power' },
  apparentPowerVA: { label: 'Apparent power', unit: 'VA', decimals: 2, color: '--s-apparent' },
  powerFactor:     { label: 'Power factor',   unit: '',   decimals: 2, color: '--s-pf' },
  frequencyHz:     { label: 'Frequency',      unit: 'Hz', decimals: 2, color: '--s-frequency' },
  energyJ:         { label: 'Energy',         unit: 'J',  decimals: 2, color: '--s-energy' },
};

export const CARD_ORDER = [
  'voltageRmsV', 'currentRmsMa', 'realPowerW', 'powerFactor',
  'frequencyHz', 'apparentPowerVA', 'currentPeakMa', 'energyJ',
];

export function cssVar(name, el = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

export function fmt(value, decimals) {
  return Number.isFinite(value) ? value.toFixed(decimals) : '—';
}
