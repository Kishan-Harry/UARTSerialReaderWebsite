// Bluetooth Low Energy (AT-09 / HM-10-style UART bridge) via the Web Bluetooth API.
//
// The module forwards whatever the ATmega writes to its UART as notifications on a
// single characteristic. Notifications are small (typically 20 bytes), so one
// protocol line arrives in several pieces — they are emitted as raw chunks and
// reassembled by the LineFramer, exactly like serial data.

import { Transport, createChunkDecoder } from './transport.js';
import { normalizeUuid, shortUuid } from './ble-uuid.js';

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

  constructor({ serviceUuid = 'ffe0', characteristicUuid = 'ffe1', namePrefix = '' } = {}) {
    super();
    this.serviceUuid = serviceUuid;
    this.characteristicUuid = characteristicUuid;
    this.namePrefix = namePrefix.trim();
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

    this._setStatus('connecting', 'Choose your Bluetooth module…');
    this.userDisconnect = false;

    // Clone modules don't reliably advertise FFE0, so by default show every
    // device and only *request access* to the service. optionalServices is
    // mandatory: Web Bluetooth hides any service not listed there.
    const options = this.namePrefix
      ? { filters: [{ namePrefix: this.namePrefix }], optionalServices: [service] }
      : { acceptAllDevices: true, optionalServices: [service] };

    try {
      this.device = await navigator.bluetooth.requestDevice(options);
    } catch (err) {
      this._setStatus('disconnected', err.name === 'NotFoundError' ? 'No device selected' : err.message);
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
