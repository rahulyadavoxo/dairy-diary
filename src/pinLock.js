// PIN lock for Hisaab totals. Hash stored in localStorage (per phone, instant, no sync delay).
const KEY = 'dd_totals_pin_hash';

export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function getPinHash() {
  try {
    return localStorage.getItem(KEY) || '';
  } catch {
    return '';
  }
}

export async function verifyPin(pin) {
  const h = getPinHash();
  if (!h) return true; // no lock set
  const input = await sha256Hex('dd-pin:' + pin);
  return input === h;
}

export async function hashPin(pin) {
  return sha256Hex('dd-pin:' + pin);
}

export function savePinHash(hash) {
  try {
    if (hash) localStorage.setItem(KEY, hash);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
