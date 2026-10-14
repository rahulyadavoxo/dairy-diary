// PIN lock for Hisaab totals. Hash stored in Firestore settings (synced across phones).
export async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function getPinHash(settings) {
  return (settings && settings.totalsPinHash) || '';
}

export async function verifyPin(settings, pin) {
  const h = getPinHash(settings);
  if (!h) return true; // no lock set
  const input = await sha256Hex('dd-pin:' + pin);
  return input === h;
}

export async function hashPin(pin) {
  return sha256Hex('dd-pin:' + pin);
}
