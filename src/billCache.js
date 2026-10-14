// Bill photo cache: pre-generated PNGs stored in IndexedDB (phone).
// Key: `${customerId}:${month}`. Share uses the saved image directly —
// no on-the-fly canvas render at share time.
const DB_NAME = 'dairy-diary-bills';
const STORE = 'photos';

function openDb() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

const key = (customerId, month) => `${customerId}:${month}`;

/**
 * Returns the cached PNG only if it was rendered from exactly the same bill data (`fp`).
 * A bill depends on earlier months (previous due), payments, the customer's opening due and
 * the farm name/phone, so deleting one month's key on edit is not enough: the fingerprint
 * guarantees a stale photo is never shared.
 */
export async function getCachedPhoto(customerId, month, fp) {
  try {
    const db = await openDb();
    const rec = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key(customerId, month));
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    // Old format (bare Blob, no fingerprint) is treated as stale.
    if (!rec || !rec.blob || !fp || rec.fp !== fp) return null;
    return rec.blob;
  } catch {
    return null;
  }
}

export async function putCachedPhoto(customerId, month, blob, fp) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put({ blob, fp: fp || '' }, key(customerId, month));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* ignore */
  }
}

export async function clearCachedPhotos() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* ignore */
  }
}

/** Remove one cached photo (call when its data changes so it regenerates). */
export async function deleteCachedPhoto(customerId, month) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key(customerId, month));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* ignore */
  }
}
