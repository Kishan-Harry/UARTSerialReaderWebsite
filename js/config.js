// Central configuration. User-editable values (baud rate, BLE UUIDs, theme) are
// defaults only — the Settings dialog overrides them and persists to localStorage.

export const CONFIG = {
  protocol: {
    deviceId: 'EM',
    version: '1',
    // A line longer than this without a terminator is treated as garbage and dropped.
    maxLineLength: 256,
  },

  serial: {
    baudRate: 9600,
    baudRates: [2400, 4800, 9600, 19200, 38400, 57600, 115200],
  },

  // AT-09 / HM-10-compatible modules usually expose service 0xFFE0 with a single
  // characteristic 0xFFE1 (read / write-without-response / notify). Clones vary,
  // so verify with tools/ble-probe.html or nRF Connect before relying on these.
  ble: {
    serviceUuid: 'ffe0',
    characteristicUuid: 'ffe1',
    // Optional advertised-name prefix filter for the device chooser (e.g. "BT05").
    // Empty = show all nearby devices.
    namePrefix: '',
  },

  simulation: {
    intervalMs: 1200,
    // Simulated BLE-style fragmentation: each record is split into chunks of this size.
    chunkSize: 20,
    // Probability that a simulated line is deliberately corrupted (exercises the parser).
    faultRate: 0.03,
  },

  ui: {
    // Readings older than this (while connected) are greyed out as stale.
    staleAfterMs: 3500,
    // Chart time windows in seconds; 0 = all recorded data.
    windows: [60, 300, 900, 0],
    defaultWindowS: 300,
    sparklinePoints: 40,
    rawLogLines: 60,
  },

  waveform: {
    cycles: 3,
    samplesPerCycle: 120,
  },

  store: {
    // ~33 hours at 1.2 s per record. Oldest records are dropped beyond this.
    maxRecords: 100000,
  },
};
