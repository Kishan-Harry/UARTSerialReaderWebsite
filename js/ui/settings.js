// User settings persisted to localStorage, plus the Settings dialog.

import { CONFIG } from '../config.js';
import { normalizeUuid } from '../transports/ble-uuid.js';

const STORAGE_KEY = 'em-dashboard-settings';
const SETTINGS_VERSION = 2;

export const DEFAULTS = Object.freeze({
  settingsVersion: SETTINGS_VERSION,
  source: 'simulated',
  baudRate: CONFIG.serial.baudRate,
  bleServiceUuid: CONFIG.ble.serviceUuid,
  bleCharacteristicUuid: CONFIG.ble.characteristicUuid,
  bleNamePrefix: CONFIG.ble.namePrefix,
  bleMatchService: CONFIG.ble.matchService,
  windowS: CONFIG.ui.defaultWindowS,
  theme: null, // null = follow the OS
});

export function loadSettings() {
  try {
    return migrateSettings({ ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') });
  } catch {
    return { ...DEFAULTS };
  }
}

export function migrateSettings(saved) {
  // v1 saved the then-default empty name filter; adopt the new "BT05" default
  // unless the user had actually typed a filter.
  if ((saved.settingsVersion ?? 1) < 2 && saved.bleNamePrefix === '') delete saved.bleNamePrefix;
  return { ...DEFAULTS, ...saved, settingsVersion: SETTINGS_VERSION };
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* storage unavailable (private mode) — settings last for this session only */ }
}

/** Wires up the Settings dialog. `onSave(partial)` receives only the dialog's fields. */
export function initSettingsDialog({ dialog, openButton, getSettings, onSave }) {
  const form = dialog.querySelector('form');
  const error = dialog.querySelector('#settings-error');
  const baud = form.elements.baudRate;

  for (const rate of CONFIG.serial.baudRates) baud.add(new Option(String(rate), String(rate)));

  const fill = (s) => {
    baud.value = String(s.baudRate);
    form.elements.bleServiceUuid.value = s.bleServiceUuid;
    form.elements.bleCharacteristicUuid.value = s.bleCharacteristicUuid;
    form.elements.bleNamePrefix.value = s.bleNamePrefix;
    form.elements.bleMatchService.checked = Boolean(s.bleMatchService);
    error.textContent = '';
    for (const el of form.elements) el.removeAttribute?.('aria-invalid');
  };

  openButton.addEventListener('click', () => {
    fill(getSettings());
    dialog.showModal();
  });

  dialog.querySelector('#settings-reset').addEventListener('click', () => fill(DEFAULTS));

  form.addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return;

    let ok = true;
    for (const name of ['bleServiceUuid', 'bleCharacteristicUuid']) {
      const el = form.elements[name];
      const valid = normalizeUuid(el.value) !== null;
      el.setAttribute('aria-invalid', String(!valid));
      ok &&= valid;
    }
    if (!ok) {
      e.preventDefault();
      error.textContent = 'Enter a 16-bit (e.g. ffe0) or full 128-bit UUID.';
      return;
    }

    onSave({
      baudRate: Number(baud.value),
      bleServiceUuid: form.elements.bleServiceUuid.value.trim(),
      bleCharacteristicUuid: form.elements.bleCharacteristicUuid.value.trim(),
      bleNamePrefix: form.elements.bleNamePrefix.value.trim(),
      bleMatchService: form.elements.bleMatchService.checked,
    });
  });
}
