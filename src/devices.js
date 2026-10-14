// Device authorization: one farm, only paired phones.
//
//   farms/{farmId}            { ownerUid, name, createdAt, devices: { [uid]: { name, addedAt, addedBy, code? } } }
//                             farmId == ownerUid (owner's email/password account).
//   pairingCodes/{code}       { farmId, createdBy, createdAt, used, usedBy?, usedAt? }
//                             6 digits, valid 10 minutes after createdAt (server time), single use.
//
// The pure helpers below are unit-tested (tests/devices.test.js); the Firestore rules in
// firestore.rules enforce the same constraints server-side (tests/rules/*.test.js).

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_RE = /^[0-9]{6}$/;
export const NAME_MAX = 40;
const FARM_KEY = 'dd_farm';

// ------------------------------------------------------------------ pure helpers

/** Random 6-digit code (leading zeros allowed). `rand` returns a float in [0,1). */
export function generateCode(rand = secureRandom) {
  const n = Math.floor(rand() * 1_000_000) % 1_000_000;
  return String(n).padStart(6, '0');
}

function secureRandom() {
  try {
    const a = new Uint32Array(1);
    globalThis.crypto.getRandomValues(a);
    return a[0] / 2 ** 32;
  } catch {
    return Math.random();
  }
}

/** Accepts "123 456", "123-456" etc. Returns the 6-digit string or null. */
export function normalizeCode(input) {
  const s = String(input ?? '').replace(/[\s-]/g, '');
  return CODE_RE.test(s) ? s : null;
}

/** Trimmed device name or null when invalid (empty / too long). */
export function cleanDeviceName(input) {
  const s = String(input ?? '').trim().replace(/\s+/g, ' ');
  return s.length >= 1 && s.length <= NAME_MAX ? s : null;
}

/** Millis from a Firestore Timestamp, a Date, a number, or null. */
export function toMillis(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000 + Math.floor((v.nanoseconds || 0) / 1e6);
  return null;
}

export function codeExpiresAt(codeDoc) {
  const c = toMillis(codeDoc && codeDoc.createdAt);
  return c == null ? null : c + CODE_TTL_MS;
}

/** 'ok' | 'notFound' | 'used' | 'expired' — client-side mirror of the rules check. */
export function codeStatus(codeDoc, nowMs = Date.now()) {
  if (!codeDoc) return 'notFound';
  if (codeDoc.used) return 'used';
  const exp = codeExpiresAt(codeDoc);
  if (exp == null || nowMs >= exp) return 'expired';
  return 'ok';
}

/** Seconds left on a code (0 when expired). */
export function secondsLeft(codeDoc, nowMs = Date.now()) {
  const exp = codeExpiresAt(codeDoc);
  return exp == null ? 0 : Math.max(0, Math.ceil((exp - nowMs) / 1000));
}

/**
 * Where this phone stands, from the farm doc snapshot.
 *  'loading'    – no answer yet
 *  'noFarm'     – farm doc does not exist (owner: create it)
 *  'authorized' – uid is in devices
 *  'removed'    – farm exists but uid is not in devices, or the server denied access
 *  'error'      – the listener failed for another reason (offline, unavailable…)
 */
export function deviceStatus({ farm, exists, denied, loaded, error }, uid) {
  if (denied) return 'removed';
  if (error) return 'error'; // network / unknown listener error: not proof the farm is missing
  if (!loaded) return 'loading';
  if (!exists) return 'noFarm';
  return farm && farm.devices && Object.prototype.hasOwnProperty.call(farm.devices, uid) ? 'authorized' : 'removed';
}

export function isOwner(farm, uid) {
  return !!farm && !!uid && farm.ownerUid === uid;
}

/** Only the owner removes, never the owner device itself; a non-owner may remove itself. */
export function canRemove(farm, actorUid, targetUid) {
  if (!farm || !farm.devices || !farm.devices[targetUid] || !farm.devices[actorUid]) return false;
  if (targetUid === farm.ownerUid) return false;
  return actorUid === farm.ownerUid || actorUid === targetUid;
}

/** Devices as a sorted list: owner first, then by date added. */
export function listDevices(farm) {
  if (!farm || !farm.devices) return [];
  return Object.entries(farm.devices)
    .map(([uid, d]) => ({ uid, ...d, isOwner: uid === farm.ownerUid, addedAtMs: toMillis(d.addedAt) }))
    .sort((a, b) => (b.isOwner - a.isOwner) || ((a.addedAtMs ?? Infinity) - (b.addedAtMs ?? Infinity)));
}

// ------------------------------------------------------------------ local farm id (anonymous phones)

export function loadFarmId(uid) {
  try {
    const v = JSON.parse(localStorage.getItem(FARM_KEY) || 'null');
    return v && v.uid === uid && typeof v.farmId === 'string' ? v.farmId : null;
  } catch {
    return null;
  }
}

export function saveFarmId(uid, farmId) {
  try {
    localStorage.setItem(FARM_KEY, JSON.stringify({ uid, farmId }));
  } catch {
    /* ignore */
  }
}

export function clearFarmId() {
  try {
    localStorage.removeItem(FARM_KEY);
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------------------ Firestore operations

export class PairingError extends Error {
  constructor(reason, cause) {
    super(reason);
    this.reason = reason; // 'invalidCode' | 'invalidName' | 'notFound' | 'used' | 'expired' | 'denied' | 'network'
    this.cause = cause;
  }
}

function classify(e) {
  const code = (e && e.code) || '';
  if (/permission-denied/.test(code)) return 'denied';
  if (/unavailable|network|deadline/.test(code)) return 'network';
  return 'denied';
}

export function farmRef(fb, farmId) {
  return fb.fsMod.doc(fb.db, 'farms', farmId);
}

/** Owner bootstrap: create farms/{uid} with the owner as the only device. Awaited (needs internet). */
export async function createFarm(fb, uid, deviceName, farmName = '') {
  const name = cleanDeviceName(deviceName);
  if (!name) throw new PairingError('invalidName');
  const { setDoc, serverTimestamp } = fb.fsMod;
  const data = {
    ownerUid: uid,
    createdAt: serverTimestamp(),
    devices: { [uid]: { name, addedAt: serverTimestamp(), addedBy: uid } },
  };
  if (farmName && farmName.trim()) data.name = farmName.trim().slice(0, 60);
  await setDoc(farmRef(fb, uid), data);
  return uid;
}

/** Authorized phone: create a fresh pairing code (retries on the rare collision). */
export async function createPairingCode(fb, farmId, uid, rand) {
  const { doc, getDoc, setDoc, serverTimestamp } = fb.fsMod;
  let lastErr;
  for (let i = 0; i < 5; i++) {
    const code = generateCode(rand);
    const ref = doc(fb.db, 'pairingCodes', code);
    try {
      const existing = await getDoc(ref);
      if (existing.exists()) continue;
      await setDoc(ref, { farmId, createdBy: uid, createdAt: serverTimestamp(), used: false });
      return code;
    } catch (e) {
      lastErr = e;
      if (classify(e) === 'network') throw new PairingError('network', e);
    }
  }
  throw new PairingError('denied', lastErr);
}

export function cancelPairingCode(fb, code) {
  return fb.fsMod.deleteDoc(fb.fsMod.doc(fb.db, 'pairingCodes', code)).catch((e) => console.error('[pairing]', e));
}

/** New phone: look up the code, then atomically add itself to the farm and consume the code. */
export async function joinFarm(fb, uid, codeInput, deviceName, nowMs = Date.now()) {
  const code = normalizeCode(codeInput);
  if (!code) throw new PairingError('invalidCode');
  const name = cleanDeviceName(deviceName);
  if (!name) throw new PairingError('invalidName');
  const { doc, getDoc, writeBatch, serverTimestamp } = fb.fsMod;
  const codeRef = doc(fb.db, 'pairingCodes', code);
  let snap;
  try {
    snap = await getDoc(codeRef);
  } catch (e) {
    throw new PairingError(classify(e) === 'network' ? 'network' : 'notFound', e);
  }
  const data = snap.exists() ? snap.data() : null;
  const st = codeStatus(data, nowMs);
  if (st !== 'ok') throw new PairingError(st);
  const batch = writeBatch(fb.db);
  batch.update(codeRef, { used: true, usedBy: uid, usedAt: serverTimestamp() });
  batch.update(farmRef(fb, data.farmId), {
    [`devices.${uid}`]: { name, addedAt: serverTimestamp(), addedBy: data.createdBy, code },
  });
  try {
    await batch.commit();
  } catch (e) {
    throw new PairingError(classify(e), e);
  }
  saveFarmId(uid, data.farmId);
  return data.farmId;
}

/** Owner removes a device (or a phone removes itself). */
export function removeDevice(fb, farmId, targetUid) {
  return fb.fsMod.updateDoc(farmRef(fb, farmId), { [`devices.${targetUid}`]: fb.fsMod.deleteField() });
}

export function renameDevice(fb, farmId, uid, newName) {
  const name = cleanDeviceName(newName);
  if (!name) return Promise.reject(new PairingError('invalidName'));
  return fb.fsMod
    .updateDoc(farmRef(fb, farmId), { [`devices.${uid}.name`]: name })
    .catch((e) => console.error('[devices]', e));
}

/** Listen to the farm doc. cb({ farm, exists, loaded, denied, fromCache }). */
export function listenFarm(fb, farmId, cb) {
  const { onSnapshot } = fb.fsMod;
  return onSnapshot(
    farmRef(fb, farmId),
    { includeMetadataChanges: true },
    (s) => {
      const fromCache = s.metadata.fromCache;
      const exists = s.exists();
      // A missing doc read only from cache is not proof the farm doesn't exist — wait for the server.
      const loaded = exists || !fromCache;
      cb({ farm: exists ? s.data({ serverTimestamps: 'estimate' }) : null, exists, loaded, denied: false, fromCache });
    },
    (e) => {
      console.error('[farm]', e);
      const denied = e && /permission-denied/.test(e.code || '');
      cb({ farm: null, exists: false, loaded: true, denied, error: e });
    },
  );
}

/**
 * Lock-out: wipe everything this phone has cached for the farm, sign out, reload.
 * Firestore must be terminated before its IndexedDB cache can be cleared.
 */
export async function wipeLocalData(fb) {
  clearFarmId();
  try {
    await fb.fsMod.terminate(fb.db);
    await fb.fsMod.clearIndexedDbPersistence(fb.db);
  } catch (e) {
    console.error('[wipe]', e);
  }
  try {
    await fb.authMod.signOut(fb.auth);
  } catch {
    /* ignore */
  }
}

/**
 * Owner "Sign out": besides signing out, remove the farm data this phone keeps — the Firestore
 * offline cache, the saved bill photos, the PIN and the other per-phone keys (language stays).
 */
export async function signOutAndWipe(fb, clearPhotos, waitMs = 8000) {
  // Give queued entries a chance to reach the server first (the cache is about to be deleted).
  if (fb.fsMod.waitForPendingWrites) {
    let timer;
    await Promise.race([
      fb.fsMod.waitForPendingWrites(fb.db).catch(() => {}),
      new Promise((r) => {
        timer = setTimeout(r, waitMs);
      }),
    ]);
    clearTimeout(timer);
  }
  try {
    if (clearPhotos) await clearPhotos();
  } catch {
    /* ignore */
  }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('dd_') && k !== 'dd_lang') localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
  await wipeLocalData(fb);
}
