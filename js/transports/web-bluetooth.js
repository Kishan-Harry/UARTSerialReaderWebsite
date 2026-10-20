// Bluetooth Low Energy (AT-09 / HM-10-style UART bridge) via the Web Bluetooth API.
//
// The module forwards whatever the ATmega writes to its UART as notifications on a
// single characteristic. Notifications are small (typically 20 bytes), so one
// protocol line arrives in several pieces — they are emitted as raw chunks and
// reassembled by the LineFramer, exactly like serial data.

import { Transport, createChunkDecoder } from './transport.js';
import { normalizeUuid, shortUuid } from './ble-uuid.js';

/** "BT05, MLT-BT05" → ['BT05', 'MLT-BT05']. Matching is a case-sensitive name prefix. */
export function parseNamePrefixes(text) {
  return [...new Set(String(text ?? '').split(/[,;]/).map((s) => s.trim()).filter(Boolean))];
}

/**
 * Options for navigator.bluetooth.requestDevice().
 *
 * Filters are OR'd: a device appears if its name starts with any prefix, or
 * (when matchService is set) it advertises the first optional service. With no
 * filters at all, every nearby device is listed.
 *
 * optionalServices is always required: Web Bluetooth hides any service that
 * wasn't requested up front. Service matching is opt-in because AT-09 clones
 * don't reliably advertise FFE0, and in a lab it also pulls in other people's
 * HM-10-style modules.
 */
export function buildRequestOptions({ prefixes = [], matchService = false, optionalServices = [] }) {
  const filters = prefixes.map((namePrefix) => ({ namePrefix }));
  if (matchService && optionalServices.length) filters.push({ services: [optionalServices[0]] });
  return filters.length
    ? { filters, optionalServices }
    : { acceptAllDevices: true, optionalServices };
}

/** Human-readable filter, e.g. 'devices named BT05… or HMSoft…'. */
export function describeFilter(prefixes, matchService = false) {
  const parts = prefixes.map((p) => `named ${p}…`);
  if (matchService) parts.push('advertising the UART service');
  return parts.length ? `devices ${parts.join(' or ')}` : 'all nearby devices';
}

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export class WebBluetoothTransport extends Transport {
  static label = 'Bluetooth';

  static isSupported() {
    return 'bluetooth' in navigator && window.isSecureContext;
  }

  static unsupportedReason() {
    if (!window.isSecureContext) return 'Web Bluetooth needs HTTPS or localhost.';
    if (isIOS()) return 'iOS browsers do not support Web Bluetooth. Try the Bluefy browser app.';
    return 'Web Bluetooth is supported in Chrome / Edge on desktop and Chrome on Android.';
  }

  constructor({ serviceUuid = 'ffe0', characteristicUuid = 'ffe1', namePrefix = '', matchService = false } = {}) {
    super();
    this.serviceUuid = serviceUuid;
    this.characteristicUuid = characteristicUuid;
    this.namePrefix = namePrefix;
    this.matchService = matchService;
    this.device = null;
    this.characteristic = null;
    this.userDisconnect = false;

    this._onNotify = (e) => {
      const v = e.target.value;
      this._emitData(this.decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)));
    };
    this._onGattDisconnected = () => {
      this._cleanup();
      this._setStatus('disconnected', this.userDisconnect ? 'Disconnected' : 'Bluetooth link lost — reconnect when the device is in range');
    };
  }

  async connect() {
    const service = normalizeUuid(this.serviceUuid);
    const characteristic = normalizeUuid(this.characteristicUuid);
    if (!service || !characteristic) {
      this._setStatus('error', 'Invalid service or characteristic UUID — check Settings');
      return;
    }

    const prefixes = parseNamePrefixes(this.namePrefix);
    const filterText = describeFilter(prefixes, this.matchService);
    this._setStatus('connecting', `Choose your Bluetooth module (listing ${filterText})`);
    this.userDisconnect = false;

    const options = buildRequestOptions({ prefixes, matchService: this.matchService, optionalServices: [service] });

    try {
      this.device = await navigator.bluetooth.requestDevice(options);
    } catch (err) {
      const hint = prefixes.length
        ? ` Not listed? Check the module is powered and not connected to another phone/PC (LED blinking), and that its name starts with ${prefixes.join(' or ')} — or change the filter in Settings.`
        : '';
      this._setStatus('disconnected', err.name === 'NotFoundError' ? `No device selected.${hint}` : err.message);
      return;
    }

    this.device.addEventListener('gattserverdisconnected', this._onGattDisconnected);
    const name = this.device.name || 'device';

    try {
      this._setStatus('connecting', `Connecting to ${name}…`);
      const server = await this.device.gatt.connect();

      let svc;
      try {
        svc = await server.getPrimaryService(service);
      } catch {
        throw new Error(`Service ${shortUuid(service)} not found on ${name}. Check the UUID with the BLE probe tool.`);
      }

      try {
        this.characteristic = await svc.getCharacteristic(characteristic);
      } catch {
        throw new Error(`Characteristic ${shortUuid(characteristic)} not found in service ${shortUuid(service)}.`);
      }

      const { notify, indicate } = this.characteristic.properties;
      if (!notify && !indicate) {
        throw new Error(`Characteristic ${shortUuid(characteristic)} does not support notifications.`);
      }

      this.decode = createChunkDecoder();
      this.characteristic.addEventListener('characteristicvaluechanged', this._onNotify);
      await this.characteristic.startNotifications();

      this._setStatus('connected', `Connected to ${name} (${shortUuid(service)}/${shortUuid(characteristic)})`);
    } catch (err) {
      this.userDisconnect = true; // suppress the "link lost" message from our own disconnect
      this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
      try { this.device.gatt.disconnect(); } catch { /* not connected */ }
      this._cleanup();
      this._setStatus('error', err.message || String(err));
    }
  }

  async disconnect() {
    this.userDisconnect = true;
    if (this.device?.gatt?.connected) {
      try { await this.characteristic?.stopNotifications(); } catch { /* link may already be down */ }
      this.device.gatt.disconnect(); // fires gattserverdisconnected → status update
    } else {
      this._cleanup();
      this._setStatus('disconnected', 'Disconnected');
    }
  }

  _cleanup() {
    this.characteristic?.removeEventListener('characteristicvaluechanged', this._onNotify);
    this.characteristic = null;
  }
}
