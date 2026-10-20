// BLE discovery tool: lists services/characteristics on a module and streams raw
// notifications, so the dashboard's UUIDs can be verified against real hardware.

import { normalizeUuid, shortUuid } from '../js/transports/ble-uuid.js';
import { parseNamePrefixes, buildRequestOptions } from '../js/transports/web-bluetooth.js';
import { loadSettings, saveSettings } from '../js/ui/settings.js';

const $ = (id) => document.getElementById(id);
const PROP_NAMES = ['broadcast', 'read', 'writeWithoutResponse', 'write', 'notify', 'indicate',
  'authenticatedSignedWrites', 'reliableWrite', 'writableAuxiliaries'];

let device = null;

// Start from the dashboard's name filter so both pages agree.
$('prefix').value = loadSettings().bleNamePrefix;

function msg(text, error = false) {
  $('msg').textContent = text;
  $('msg').dataset.tone = error ? 'error' : '';
}

function candidates() {
  const out = [], bad = [];
  for (const raw of $('candidates').value.split('\n')) {
    const s = raw.replace(/#.*/, '').trim();
    if (!s) continue;
    const u = normalizeUuid(s);
    if (u) out.push(u); else bad.push(s);
  }
  return { uuids: [...new Set(out)], bad };
}

function log(kind, text) {
  const li = document.createElement('li');
  li.className = kind;
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = new Date().toLocaleTimeString();
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = kind === 'ok' ? 'RX' : kind === 'bad' ? 'ERR' : 'INFO';
  const line = document.createElement('span');
  line.className = 'line';
  line.textContent = text;
  li.append(ts, tag, line);
  $('log').prepend(li);
  while ($('log').childElementCount > 300) $('log').lastElementChild.remove();
}

const visible = (bytes) => [...bytes].map((b) =>
  b === 13 ? '\\r' : b === 10 ? '\\n' : b >= 32 && b < 127 ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, '0')}`).join('');
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ');

$('scan').addEventListener('click', async () => {
  if (!('bluetooth' in navigator)) {
    msg('Web Bluetooth is not available in this browser. Use Chrome or Edge (desktop) or Chrome on Android.', true);
    return;
  }
  const { uuids, bad } = candidates();
  if (bad.length) { msg(`Invalid UUID(s): ${bad.join(', ')}`, true); return; }

  const prefixes = parseNamePrefixes($('prefix').value);
  saveSettings({ ...loadSettings(), bleNamePrefix: prefixes.join(', ') });
  const options = buildRequestOptions({ prefixes, optionalServices: uuids });

  try {
    msg('Choose a device…');
    device = await navigator.bluetooth.requestDevice(options);
  } catch (e) {
    msg(e.name === 'NotFoundError' ? 'No device selected.' : e.message, e.name !== 'NotFoundError');
    return;
  }

  device.addEventListener('gattserverdisconnected', () => {
    log('info', 'Disconnected');
    msg('Disconnected.');
    $('disc').disabled = true;
    $('scan').disabled = false;
  });

  try {
    msg(`Connecting to ${device.name || device.id}…`);
    const server = await device.gatt.connect();
    $('disc').disabled = false;
    $('scan').disabled = true;
    log('info', `Connected to "${device.name || '(unnamed)'}" id=${device.id}`);

    let services = [];
    try {
      services = await server.getPrimaryServices();
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
    await render(services);
    msg(services.length
      ? `Found ${services.length} service(s) from your candidate list.`
      : 'None of the candidate services exist on this device. Add more UUIDs (find them with nRF Connect) and retry.', !services.length);
  } catch (e) {
    msg(`Error: ${e.message}`, true);
    log('bad', e.message);
  }
});

$('disc').addEventListener('click', () => device?.gatt?.connected && device.gatt.disconnect());
$('clear').addEventListener('click', () => $('log').replaceChildren());

async function render(services) {
  const list = $('svc-list');
  list.replaceChildren();
  $('services').hidden = false;

  for (const svc of services) {
    const box = document.createElement('div');
    box.className = 'svc';
    const h = document.createElement('h3');
    h.textContent = `Service ${shortUuid(svc.uuid)}  (${svc.uuid})`;
    box.appendChild(h);

    let chars = [];
    try { chars = await svc.getCharacteristics(); } catch (e) { log('bad', `${shortUuid(svc.uuid)}: ${e.message}`); }

    for (const ch of chars) {
      const props = PROP_NAMES.filter((p) => ch.properties[p]);
      const canNotify = ch.properties.notify || ch.properties.indicate;

      const row = document.createElement('div');
      row.className = 'chr' + (canNotify ? ' hit' : '');
      const info = document.createElement('div');
      const code = document.createElement('code');
      code.textContent = `Characteristic ${shortUuid(ch.uuid)}  (${ch.uuid})`;
      const p = document.createElement('div');
      p.className = 'props';
      p.textContent = props.join(' · ') || 'no properties';
      info.append(code, p);

      const actions = document.createElement('div');
      actions.className = 'row';
      if (canNotify) {
        const sub = button('Subscribe', async () => {
          if (sub.dataset.on) {
            await ch.stopNotifications().catch(() => {});
            ch.removeEventListener('characteristicvaluechanged', onValue);
            sub.textContent = 'Subscribe';
            delete sub.dataset.on;
            return;
          }
          ch.addEventListener('characteristicvaluechanged', onValue);
          await ch.startNotifications();
          sub.textContent = 'Unsubscribe';
          sub.dataset.on = '1';
          log('info', `Subscribed to ${shortUuid(ch.uuid)}`);
        });
        const use = button('Use in dashboard', () => {
          saveSettings({ ...loadSettings(), bleServiceUuid: shortUuid(svc.uuid), bleCharacteristicUuid: shortUuid(ch.uuid) });
          msg(`Saved: dashboard will use service ${shortUuid(svc.uuid)} / characteristic ${shortUuid(ch.uuid)}.`);
        });
        actions.append(sub, use);
      }
      if (ch.properties.read) {
        actions.append(button('Read', async () => {
          try {
            const v = await ch.readValue();
            const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
            log('ok', `${shortUuid(ch.uuid)} read ${b.length} B: "${visible(b)}"  [${hex(b)}]`);
          } catch (e) { log('bad', e.message); }
        }));
      }

      row.append(info, actions);
      box.appendChild(row);
    }
    list.appendChild(box);
  }
}

function onValue(e) {
  const v = e.target.value;
  const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  log('ok', `${shortUuid(e.target.uuid)} ${b.length} B: "${visible(b)}"  [${hex(b)}]`);
}

function button(label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn';
  b.textContent = label;
  b.addEventListener('click', () => Promise.resolve(onClick()).catch((e) => log('bad', e.message)));
  return b;
}
