// USB serial via the Web Serial API (Chrome / Edge / Opera on desktop).

import { Transport, createChunkDecoder } from './transport.js';

// Common USB-UART bridge vendor IDs, for a friendlier "connected to …" message.
const USB_VENDORS = {
  0x1a86: 'CH340',
  0x0403: 'FTDI',
  0x10c4: 'CP210x',
  0x2341: 'Arduino',
  0x2a03: 'Arduino',
  0x067b: 'PL2303',
};

export class WebSerialTransport extends Transport {
  static label = 'USB Serial';

  static isSupported() {
    return 'serial' in navigator && window.isSecureContext;
  }

  static unsupportedReason() {
    if (!window.isSecureContext) return 'Web Serial needs HTTPS or localhost.';
    return 'Web Serial is supported in desktop Chrome, Edge and Opera only.';
  }

  constructor({ baudRate = 9600 } = {}) {
    super();
    this.baudRate = baudRate;
    this.port = null;
    this.reader = null;
    this.closing = false;
    this._onUnplug = (e) => {
      if (e.target === this.port) this._teardown('Device unplugged');
    };
  }

  async connect() {
    this._setStatus('connecting', 'Choose a serial port…');
    this.closing = false;

    try {
      this.port = await navigator.serial.requestPort();
    } catch (err) {
      // NotFoundError = the user closed the picker without choosing.
      this._setStatus('disconnected', err.name === 'NotFoundError' ? 'No port selected' : err.message);
      return;
    }

    try {
      this._setStatus('connecting', `Opening port at ${this.baudRate} baud…`);
      await this.port.open({ baudRate: this.baudRate });
    } catch (err) {
      this.port = null;
      const hint = err.name === 'InvalidStateError' ? 'Port is already open in this page.'
        : err.name === 'NetworkError' ? 'Port is in use — close the Arduino Serial Monitor or other apps.'
        : err.message;
      this._setStatus('error', `Could not open port: ${hint}`);
      return;
    }

    navigator.serial.addEventListener('disconnect', this._onUnplug);

    const { usbVendorId } = this.port.getInfo();
    const bridge = USB_VENDORS[usbVendorId] ? ` (${USB_VENDORS[usbVendorId]})` : '';
    this._setStatus('connected', `Serial port open at ${this.baudRate} baud${bridge}`);

    this.readLoop = this._readLoop();
  }

  async _readLoop() {
    const decode = createChunkDecoder();

    // port.readable is replaced after non-fatal errors (framing, parity, break,
    // buffer overrun) and becomes null after fatal ones, so keep re-acquiring it.
    while (this.port?.readable && !this.closing) {
      this.reader = this.port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) this._emitData(decode(value));
        }
      } catch (err) {
        if (!this.closing) console.warn('Serial read error (recovering):', err.name, err.message);
      } finally {
        this.reader.releaseLock();
        this.reader = null;
      }
    }

    if (!this.closing) this._teardown('Serial connection lost');
  }

  async disconnect() {
    await this._teardown('Disconnected');
  }

  async _teardown(message) {
    if (this.closing && !this.port) return;
    this.closing = true;
    navigator.serial.removeEventListener('disconnect', this._onUnplug);

    try { await this.reader?.cancel(); } catch { /* already released */ }
    try { await this.readLoop; } catch { /* loop errors already reported */ }
    try { await this.port?.close(); } catch { /* port may already be gone */ }

    this.port = null;
    this._setStatus('disconnected', message);
  }
}
