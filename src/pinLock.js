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

// v2 PIN hash: PBKDF2-SHA256 with a random per-phone salt, "v2$<salt hex>$<hash hex>".
// (v1 was an unsalted SHA-256, which a 4-digit PIN gives up instantly.)
const PBKDF2_ITER = 150000;
const hex = (u8) => [...u8].map((b) => b.toString(16).padStart(2, '0')).join('');
const unhex = (h) => new Uint8Array((h.match(/../g) || []).map((x) => parseInt(x, 16)));
async function pbkdf2Hex(pin, salt, iter = PBKDF2_ITER) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('dd-pin:' + pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
  return hex(new Uint8Array(bits));
}
async function matches(pin, stored) {
  if (stored.startsWith('v2$')) {
    const [, saltHex, h] = stored.split('$');
    return (await pbkdf2Hex(pin, unhex(saltHex))) === h;
  }
  return (await sha256Hex('dd-pin:' + pin)) === stored; // v1 (older phones / old synced PIN)
}

export async function verifyPin(pin) {
  const h = getPinHash();
  if (!h) return true; // no lock set
  if (pinWaitSeconds() > 0) return false;
  if (await matches(pin, h)) {
    writeFails(null);
    if (!h.startsWith('v2$')) {
      // upgrade an old v1 hash the first time the right PIN is typed
      try {
        localStorage.setItem(KEY, await hashPin(pin));
      } catch {
        /* ignore */
      }
    }
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
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `v2$${hex(salt)}$${await pbkdf2Hex(pin, salt)}`;
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

/** True once this phone has its own copy (or its own choice) of the PIN, so the old synced
 *  settings.totalsPinHash is no longer needed and can be deleted from Firestore. */
export function legacyPinCleared() {
  try {
    return localStorage.getItem(MIGRATED_KEY) === '1';
  } catch {
    return false;
  }
}
