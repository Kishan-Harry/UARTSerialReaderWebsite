// Application wiring:
//
//   Transport ──chunks──▶ LineFramer ──lines──▶ parseRecord ──▶ MeasurementStore ──▶ UI
//
// The UI only listens to the store and to transport status events, so a new
// transport plugs in by adding one entry to TRANSPORTS.

import { CONFIG } from './config.js';
import { LineFramer } from './protocol/line-framer.js';
import { parseRecord } from './protocol/em-parser.js';
import { MeasurementStore } from './data/store.js';
import { downloadCsv } from './data/csv-export.js';
import { SimulatedTransport } from './transports/simulated.js';
import { WebSerialTransport } from './transports/web-serial.js';
import { WebBluetoothTransport } from './transports/web-bluetooth.js';
import { Cards } from './ui/cards.js';
import { Trends } from './ui/trends.js';
import { Waveforms } from './ui/waveforms.js';
import { RawLog } from './ui/raw-log.js';
import { loadSettings, saveSettings, initSettingsDialog } from './ui/settings.js';

const $ = (id) => document.getElementById(id);

const TRANSPORTS = {
  simulated: { cls: SimulatedTransport,    create: () => new SimulatedTransport() },
  serial:    { cls: WebSerialTransport,    create: (s) => new WebSerialTransport({ baudRate: s.baudRate }) },
  bluetooth: { cls: WebBluetoothTransport, create: (s) => new WebBluetoothTransport({
    serviceUuid: s.bleServiceUuid,
    characteristicUuid: s.bleCharacteristicUuid,
    namePrefix: s.bleNamePrefix,
  }) },
};

let settings = loadSettings();
let transport = null;
let paused = false;
let pendingWhilePaused = 0;

// --- Data pipeline -----------------------------------------------------------

const store = new MeasurementStore();
const rawLog = new RawLog($('raw-log'));

const framer = new LineFramer({
  maxLineLength: CONFIG.protocol.maxLineLength,
  onLine(line) {
    const result = parseRecord(line);
    if (result.ok) {
      store.add(result.data, result.warnings);
    } else {
      store.reject();
      rawLog.add('bad', line, result.reason);
    }
  },
  onOverflow(dropped) {
    store.reject();
    rawLog.add('bad', dropped, `No line terminator within ${CONFIG.protocol.maxLineLength} characters — wrong baud rate?`);
  },
});

// --- UI components -----------------------------------------------------------

const cards = new Cards($('cards'), store);
const trends = new Trends($('trend-grid'), store);
const waveforms = new Waveforms({
  combinedEl: $('wave-combined'),
  voltageEl: $('wave-v'),
  currentEl: $('wave-i'),
  factsEl: $('wave-facts'),
});

store.addEventListener('record', ({ detail: { record, warnings } }) => {
  rawLog.add(warnings.length ? 'warn' : 'ok', describe(record), warnings.join('; '));

  $('stat-warning').hidden = warnings.length === 0;
  $('stat-warning').textContent = warnings.join('; ');

  cards.update(record);
  if (paused) {
    pendingWhilePaused++;
    $('pause-btn').textContent = `Resume (${pendingWhilePaused})`;
  } else {
    waveforms.update(record);
    trends.render(settings.windowS);
  }
  updateStatusPill();
});

store.addEventListener('stats', ({ detail: s }) => {
  $('stat-received').textContent = s.received;
  $('stat-rejected').textContent = s.rejected;
  const iv = store.meanInterval();
  $('stat-interval').textContent = iv ? `${iv.toFixed(2)} s` : '—';
});

function describe(r) {
  return `f=${r.frequencyHz.toFixed(2)}Hz V=${r.voltageRmsV.toFixed(2)}V I=${r.currentRmsMa.toFixed(1)}mA ` +
    `Ipk=${r.currentPeakMa.toFixed(1)}mA P=${r.realPowerW.toFixed(2)}W S=${r.apparentPowerVA.toFixed(2)}VA ` +
    `PF=${r.powerFactor.toFixed(2)} E=${r.energyJ.toFixed(2)}J`;
}

// --- Connection --------------------------------------------------------------

const connectBtn = $('connect-btn');
const sourceInputs = [...document.querySelectorAll('input[name="source"]')];

function selectedSource() {
  return sourceInputs.find((i) => i.checked)?.value ?? 'simulated';
}

// Disable sources this browser can't use, and say why rather than failing silently.
function refreshSupport() {
  const notes = [];
  for (const input of sourceInputs) {
    const { cls } = TRANSPORTS[input.value];
    input.disabled = !cls.isSupported();
    input.toggleAttribute('data-unsupported', input.disabled);
    if (input.disabled) notes.push(`${cls.label} unavailable: ${cls.unsupportedReason()}`);
  }
  if (sourceInputs.find((i) => i.checked)?.disabled) sourceInputs[0].checked = true;
  $('support-note').hidden = notes.length === 0;
  $('support-note').textContent = notes.join(' ');
}

async function connect() {
  const source = selectedSource();
  const entry = TRANSPORTS[source];
  if (!entry.cls.isSupported()) return;

  framer.reset();
  transport = entry.create(settings);
  transport.addEventListener('data', (e) => framer.push(e.detail));
  transport.addEventListener('status', (e) => onStatus(e.detail));
  // Must run synchronously inside the click handler: device pickers need a user gesture.
  await transport.connect();
}

async function disconnect() {
  await transport?.disconnect();
}

function onStatus({ state, message }) {
  const msg = $('connection-message');
  msg.textContent = message || '';
  msg.dataset.tone = state === 'error' ? 'error' : '';

  const active = state === 'connecting' || state === 'connected';
  connectBtn.textContent = state === 'connected' ? 'Disconnect' : state === 'connecting' ? 'Connecting…' : 'Connect';
  connectBtn.dataset.mode = active ? 'disconnect' : 'connect';
  connectBtn.disabled = state === 'connecting' && !(transport instanceof SimulatedTransport);
  for (const i of sourceInputs) i.disabled = active || !TRANSPORTS[i.value].cls.isSupported();

  if (state === 'connected') requestWakeLock();
  if (!active) {
    releaseWakeLock();
    cards.setStale(true);
  }
  updateStatusPill();
}

connectBtn.addEventListener('click', () => {
  if (transport?.isActive) disconnect();
  else connect();
});

for (const input of sourceInputs) {
  input.addEventListener('change', () => {
    settings = { ...settings, source: selectedSource() };
    saveSettings(settings);
    refreshSupport();
  });
}

// --- Status pill & staleness -------------------------------------------------

function updateStatusPill() {
  const pill = $('status');
  const text = pill.querySelector('.status-text');
  const state = transport?.state ?? 'disconnected';
  const lastAt = store.stats.lastAt;
  const age = lastAt ? Date.now() - lastAt : Infinity;

  let shown = state, label;
  switch (state) {
    case 'connected':
      if (age > CONFIG.ui.staleAfterMs) {
        shown = 'stale';
        label = lastAt ? `No data ${Math.round(age / 1000)} s` : 'Waiting for data';
      } else {
        label = transport instanceof SimulatedTransport ? 'Simulating' : 'Live';
      }
      break;
    case 'connecting': label = 'Connecting'; break;
    case 'error':      label = 'Error'; break;
    default:           label = 'Disconnected';
  }
  pill.dataset.state = shown;
  text.textContent = label;

  if (state === 'connected') cards.setStale(age > CONFIG.ui.staleAfterMs);
  $('stat-age').textContent = lastAt ? `${(age / 1000).toFixed(age < 10000 ? 1 : 0)} s ago` : '—';
}

setInterval(updateStatusPill, 1000);

// --- Toolbar -----------------------------------------------------------------

const windowSelect = $('window-select');
for (const w of CONFIG.ui.windows) {
  windowSelect.add(new Option(w === 0 ? 'All data' : w < 60 ? `${w} s` : `${w / 60} min`, String(w)));
}
windowSelect.value = String(settings.windowS);
if (windowSelect.selectedIndex === -1) windowSelect.value = String(CONFIG.ui.defaultWindowS);
windowSelect.addEventListener('change', () => {
  settings = { ...settings, windowS: Number(windowSelect.value) };
  saveSettings(settings);
  trends.render(settings.windowS);
});

$('pause-btn').addEventListener('click', () => {
  paused = !paused;
  const btn = $('pause-btn');
  btn.setAttribute('aria-pressed', String(paused));
  btn.textContent = paused ? 'Resume' : 'Pause';
  $('paused-badge').hidden = !paused;
  if (!paused) {
    pendingWhilePaused = 0;
    if (store.latest) waveforms.update(store.latest);
    trends.render(settings.windowS);
  }
});

$('clear-btn').addEventListener('click', () => {
  if (store.length > 0 && !confirm(`Clear ${store.length} recorded measurements? Export to CSV first if you need them.`)) return;
  store.clear();
  rawLog.clear();
  cards.reset();
  waveforms.clear();
  trends.render(settings.windowS);
  pendingWhilePaused = 0;
  if (paused) $('pause-btn').textContent = 'Resume';
  $('stat-warning').hidden = true;
});

$('export-btn').addEventListener('click', () => {
  if (!downloadCsv(store)) alert('No measurements recorded yet.');
});

// --- Theme -------------------------------------------------------------------

function currentTheme() {
  return document.documentElement.dataset.theme ||
    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

// Charts keep their current data across a rebuild, so a paused view stays frozen.
function rebuildCharts() {
  trends.rebuild();
  waveforms.rebuild();
}

$('theme-toggle').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  settings = { ...settings, theme: next };
  saveSettings(settings);
  rebuildCharts();
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (!settings.theme) rebuildCharts();
});

// --- Settings ----------------------------------------------------------------

initSettingsDialog({
  dialog: $('settings-dialog'),
  openButton: $('settings-open'),
  getSettings: () => settings,
  onSave(partial) {
    settings = { ...settings, ...partial };
    saveSettings(settings);
    if (transport?.isActive) {
      $('connection-message').textContent = 'Settings saved — reconnect to apply them.';
    }
  },
});

// --- Keep the phone screen on while monitoring --------------------------------

let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch { /* denied or unsupported — not essential */ }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && transport?.state === 'connected' && !wakeLock) requestWakeLock();
});

window.addEventListener('pagehide', () => {
  if (transport?.isActive) transport.disconnect();
});

// --- Start -------------------------------------------------------------------

const initial = sourceInputs.find((i) => i.value === settings.source);
if (initial) initial.checked = true;
refreshSupport();
updateStatusPill();
trends.render(settings.windowS);

// ?demo starts the simulator immediately (no device picker is involved, so no click is needed).
if (new URLSearchParams(location.search).has('demo')) {
  sourceInputs.find((i) => i.value === 'simulated').checked = true;
  connect();
}
