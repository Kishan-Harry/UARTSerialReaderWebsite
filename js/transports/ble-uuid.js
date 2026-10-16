// Normalises the ways a Bluetooth UUID gets written down into the lowercase
// 128-bit form Web Bluetooth expects.
//
//   "FFE0", "ffe0", "0xFFE0"        → 0000ffe0-0000-1000-8000-00805f9b34fb  (16-bit, Bluetooth base UUID)
//   "0000FFE0"                      → 0000ffe0-0000-1000-8000-00805f9b34fb  (32-bit)
//   "6E400001-B5A3-F393-..."        → 6e400001-b5a3-f393-...                (full 128-bit)

const BASE_SUFFIX = '-0000-1000-8000-00805f9b34fb';
const FULL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** @returns {string|null} 128-bit UUID, or null if the input isn't a valid UUID */
export function normalizeUuid(input) {
  const s = String(input ?? '').trim().toLowerCase().replace(/^0x/, '');
  if (/^[0-9a-f]{4}$/.test(s)) return `0000${s}${BASE_SUFFIX}`;
  if (/^[0-9a-f]{8}$/.test(s)) return `${s}${BASE_SUFFIX}`;
  if (FULL.test(s)) return s;
  return null;
}

/** Short display form: "ffe0" for base-UUID values, the full string otherwise. */
export function shortUuid(uuid) {
  const n = normalizeUuid(uuid);
  if (n && n.endsWith(BASE_SUFFIX) && n.startsWith('0000')) return n.slice(4, 8);
  return n ?? String(uuid);
}
