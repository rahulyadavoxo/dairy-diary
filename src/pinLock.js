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

// Wrong-PIN throttle: a 4-digit PIN has only 10,000 combinations and verifyPin could be tried
// endlessly (Hisaab unlock and the new "current PIN" step in Settings). After 5 wrong tries,
// wait 30 s, doubling each further wrong try (max 15 min). Kept in localStorage so restarting
// the app does not reset it.
const FAIL_KEY = 'dd_pin_fails';
const MAX_FREE_TRIES = 5;
function readFails() {
  try {
    const v = JSON.parse(localStorage.getItem(FAIL_KEY) || '{}');
    return { n: v.n || 0, until: v.until || 0 };
  } catch {
    return { n: 0, until: 0 };
  }
}
function writeFails(v) {
  try {
    if (v) localStorage.setItem(FAIL_KEY, JSON.stringify(v));
    else localStorage.removeItem(FAIL_KEY);
  } catch {
    /* ignore */
  }
}
/** Seconds the user must still wait before the next PIN try (0 = may try now). */
export function pinWaitSeconds(now = Date.now()) {
  const { until } = readFails();
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

export async function verifyPin(pin) {
  const h = getPinHash();
  if (!h) return true; // no lock set
  if (pinWaitSeconds() > 0) return false;
  const input = await sha256Hex('dd-pin:' + pin);
  if (input === h) {
    writeFails(null);
    return true;
  }
  const f = readFails();
  const n = f.n + 1;
  const extra = n - MAX_FREE_TRIES;
  const until = extra > 0 ? Date.now() + Math.min(30000 * 2 ** (extra - 1), 15 * 60000) : 0;
  writeFails({ n, until });
  return false;
}

export async function hashPin(pin) {
  return sha256Hex('dd-pin:' + pin);
}

export function savePinHash(hash) {
  try {
    localStorage.setItem(MIGRATED_KEY, '1'); // a PIN set/removed here wins over the old synced one
    if (hash) localStorage.setItem(KEY, hash);
    else localStorage.removeItem(KEY);
    localStorage.removeItem(FAIL_KEY);
  } catch {
    /* ignore */
  }
}

// v1.9.3 and earlier kept the hash in Firestore settings.totalsPinHash. Copy it to this phone
// once, so updating the app does not silently remove a PIN the user had already set.
const MIGRATED_KEY = 'dd_totals_pin_migrated';
export function migrateLegacyPin(settings) {
  try {
    if (localStorage.getItem(MIGRATED_KEY) === '1') return false;
    const legacy = settings && settings.totalsPinHash;
    if (!legacy) return false; // settings not loaded yet, or no old PIN: try again next time
    if (!getPinHash()) localStorage.setItem(KEY, legacy);
    localStorage.setItem(MIGRATED_KEY, '1');
    return true;
  } catch {
    return false;
  }
}
