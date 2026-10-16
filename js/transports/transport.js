// Common interface for every data source (simulator, USB serial, BLE).
//
// A transport only moves text. It emits:
//   'data'   detail: string      — a raw chunk, NOT necessarily a complete line
//   'status' detail: { state, message }
// where state is one of: 'disconnected' | 'connecting' | 'connected' | 'error'.
//
// The dashboard never talks to a transport-specific API, so adding a new
// transport means writing one class like this and registering it in main.js.

export class Transport extends EventTarget {
  /** Human-readable name shown in the UI. */
  static label = 'Transport';

  /** Whether this browser can use the transport at all. */
  static isSupported() {
    return true;
  }

  /** Why the transport is unavailable (shown when isSupported() is false). */
  static unsupportedReason() {
    return '';
  }

  constructor() {
    super();
    this.state = 'disconnected';
  }

  get isActive() {
    return this.state === 'connecting' || this.state === 'connected';
  }

  /** Must be called directly from a user gesture (click) — browsers require it for device pickers. */
  async connect() {
    throw new Error('connect() not implemented');
  }

  async disconnect() {
    throw new Error('disconnect() not implemented');
  }

  _emitData(text) {
    if (text) this.dispatchEvent(new CustomEvent('data', { detail: text }));
  }

  _setStatus(state, message = '') {
    this.state = state;
    this.dispatchEvent(new CustomEvent('status', { detail: { state, message } }));
  }
}

/** Decodes byte chunks to text, keeping multi-byte UTF-8 sequences intact across chunk boundaries. */
export function createChunkDecoder() {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  return (bytes) => decoder.decode(bytes, { stream: true });
}
