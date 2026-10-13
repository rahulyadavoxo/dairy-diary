// @vitest-environment node
//
// Firestore security-rules tests against the local emulator, driving the REAL client
// functions from src/devices.js where possible.
// Run:  npm run test:rules   (starts nothing itself — see scripts/rules-test.sh, which starts
// the emulator and sets FIRESTORE_EMULATOR_HOST). Skipped when no emulator is configured.
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import * as fsMod from 'firebase/firestore';
import { createFarm, createPairingCode, joinFarm, removeDevice, renameDevice, PairingError } from '../../src/devices.js';

const HOST = process.env.FIRESTORE_EMULATOR_HOST;
fsMod.setLogLevel('silent'); // expected PERMISSION_DENIED noise
const OWNER_EMAIL = 'owner.dairy@example.com';
const OWNER = 'ownerUid1';
const PHONE2 = 'anonPhone2';
const PHONE3 = 'anonPhone3';
const STRANGER = 'anonStranger';

const rulesPath = fileURLToPath(new URL('../../firestore.rules', import.meta.url));

describe.skipIf(!HOST)('firestore.rules (emulator)', () => {
  let env;

  const ownerCtx = () =>
    env.authenticatedContext(OWNER, { email: OWNER_EMAIL, firebase: { sign_in_provider: 'password' } });
  const anonCtx = (uid) => env.authenticatedContext(uid, { firebase: { sign_in_provider: 'anonymous' } });
  const fbOf = (ctx) => ({ db: ctx.firestore(), fsMod });
  const { doc, getDoc, setDoc, updateDoc, getDocs, collection, deleteField, serverTimestamp, Timestamp } = fsMod;

  async function seedFarm() {
    await createFarm(fbOf(ownerCtx()), OWNER, 'Papa ka phone', 'Yadav Dairy');
  }
  async function seedCode(code, { ageMs = 0, used = false, createdBy = OWNER } = {}) {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'pairingCodes', code), {
        farmId: OWNER,
        createdBy,
        createdAt: Timestamp.fromMillis(Date.now() - ageMs),
        used,
      });
    });
  }
  async function addPhone(uid, code = '111111') {
    await seedCode(code);
    await joinFarm(fbOf(anonCtx(uid)), uid, code, 'Phone ' + uid);
  }

  beforeAll(async () => {
    const [host, port] = HOST.split(':');
    const rules = readFileSync(rulesPath, 'utf8').replace("'OWNER_EMAIL'", `'${OWNER_EMAIL}'`);
    env = await initializeTestEnvironment({ projectId: 'dairy-diary-rules-test', firestore: { host, port: Number(port), rules } });
  });
  afterAll(async () => env && env.cleanup());
  beforeEach(async () => env.clearFirestore());

  // ------------------------------------------------------------- bootstrap
  describe('farm creation', () => {
    it('owner email account creates its own farm', async () => {
      await assertSucceeds(createFarm(fbOf(ownerCtx()), OWNER, 'Papa ka phone'));
      const snap = await getDoc(doc(ownerCtx().firestore(), 'farms', OWNER));
      expect(snap.data().ownerUid).toBe(OWNER);
      expect(Object.keys(snap.data().devices)).toEqual([OWNER]);
    });
    it('owner can read its not-yet-created farm doc (to detect "no farm")', async () => {
      const snap = await assertSucceeds(getDoc(doc(ownerCtx().firestore(), 'farms', OWNER)));
      expect(snap.exists()).toBe(false);
    });
    it('anonymous user cannot create a farm', async () => {
      await assertFails(createFarm(fbOf(anonCtx(STRANGER)), STRANGER, 'Hacker'));
    });
    it('another email/password account cannot create a farm', async () => {
      const ctx = env.authenticatedContext('evil', { email: 'evil@example.com', firebase: { sign_in_provider: 'password' } });
      await assertFails(createFarm(fbOf(ctx), 'evil', 'Evil'));
    });
    it('owner email via a non-password provider token is rejected', async () => {
      const ctx = env.authenticatedContext('x', { email: OWNER_EMAIL, firebase: { sign_in_provider: 'custom' } });
      await assertFails(createFarm(fbOf(ctx), 'x', 'X'));
    });
    it('owner cannot create a farm under another id or with extra devices', async () => {
      const db = ownerCtx().firestore();
      await assertFails(
        setDoc(doc(db, 'farms', 'otherId'), { ownerUid: OWNER, createdAt: serverTimestamp(), devices: { [OWNER]: { name: 'a', addedAt: serverTimestamp(), addedBy: OWNER } } }),
      );
      await assertFails(
        setDoc(doc(db, 'farms', OWNER), {
          ownerUid: OWNER,
          createdAt: serverTimestamp(),
          devices: { [OWNER]: { name: 'a', addedAt: serverTimestamp(), addedBy: OWNER }, [STRANGER]: { name: 'b', addedAt: serverTimestamp(), addedBy: OWNER } },
        }),
      );
    });
    it('farm cannot be re-created / overwritten or deleted', async () => {
      await seedFarm();
      await assertFails(createFarm(fbOf(ownerCtx()), OWNER, 'Again'));
      await assertFails(fsMod.deleteDoc(doc(ownerCtx().firestore(), 'farms', OWNER)));
    });
  });

  // ------------------------------------------------------------- data access
  describe('farm data access', () => {
    beforeEach(seedFarm);
    for (const coll of ['customers', 'days', 'payments', 'settings']) {
      it(`member reads/writes ${coll}; stranger cannot`, async () => {
        const own = ownerCtx().firestore();
        await assertSucceeds(setDoc(doc(own, 'farms', OWNER, coll, 'x'), { a: 1 }));
        await assertSucceeds(getDoc(doc(own, 'farms', OWNER, coll, 'x')));
        await assertSucceeds(getDocs(collection(own, 'farms', OWNER, coll)));
        const st = anonCtx(STRANGER).firestore();
        await assertFails(getDoc(doc(st, 'farms', OWNER, coll, 'x')));
        await assertFails(getDocs(collection(st, 'farms', OWNER, coll)));
        await assertFails(setDoc(doc(st, 'farms', OWNER, coll, 'y'), { a: 1 }));
      });
    }
    it('unknown subcollections and old top-level collections are closed', async () => {
      const own = ownerCtx().firestore();
      await assertFails(setDoc(doc(own, 'farms', OWNER, 'secret', 'x'), { a: 1 }));
      await assertFails(setDoc(doc(own, 'customers', 'x'), { a: 1 }));
      await assertFails(getDoc(doc(own, 'settings', 'main')));
    });
    it('stranger cannot read the farm doc or list farms', async () => {
      const st = anonCtx(STRANGER).firestore();
      await assertFails(getDoc(doc(st, 'farms', OWNER)));
      await assertFails(getDocs(collection(st, 'farms')));
    });
    it('unauthenticated access is denied', async () => {
      const db = env.unauthenticatedContext().firestore();
      await assertFails(getDoc(doc(db, 'farms', OWNER, 'customers', 'x')));
      await assertFails(getDoc(doc(db, 'pairingCodes', '123456')));
    });
  });

  // ------------------------------------------------------------- pairing
  describe('pairing codes', () => {
    beforeEach(seedFarm);
    it('member creates a code; a new phone joins with it and gains access', async () => {
      const code = await createPairingCode(fbOf(ownerCtx()), OWNER, OWNER);
      expect(code).toMatch(/^[0-9]{6}$/);
      const farmId = await joinFarm(fbOf(anonCtx(PHONE2)), PHONE2, code, 'Bhaiya ka phone');
      expect(farmId).toBe(OWNER);
      const farm = (await getDoc(doc(ownerCtx().firestore(), 'farms', OWNER))).data();
      expect(farm.devices[PHONE2]).toMatchObject({ name: 'Bhaiya ka phone', addedBy: OWNER, code });
      const pc = (await getDoc(doc(ownerCtx().firestore(), 'pairingCodes', code))).data();
      expect(pc).toMatchObject({ used: true, usedBy: PHONE2 });
      await assertSucceeds(getDocs(collection(anonCtx(PHONE2).firestore(), 'farms', OWNER, 'customers')));
    });
    it('a joined (non-owner) phone can also create codes', async () => {
      await addPhone(PHONE2);
      const code = await createPairingCode(fbOf(anonCtx(PHONE2)), OWNER, PHONE2);
      await joinFarm(fbOf(anonCtx(PHONE3)), PHONE3, code, 'Third');
      const farm = (await getDoc(doc(ownerCtx().firestore(), 'farms', OWNER))).data();
      expect(farm.devices[PHONE3].addedBy).toBe(PHONE2);
    });
    it('stranger cannot create a code, nor one with a client timestamp or bad id', async () => {
      const st = anonCtx(STRANGER).firestore();
      await assertFails(setDoc(doc(st, 'pairingCodes', '222222'), { farmId: OWNER, createdBy: STRANGER, createdAt: serverTimestamp(), used: false }));
      const own = ownerCtx().firestore();
      await assertFails(setDoc(doc(own, 'pairingCodes', '222222'), { farmId: OWNER, createdBy: OWNER, createdAt: Timestamp.now(), used: false }));
      await assertFails(setDoc(doc(own, 'pairingCodes', 'abc123'), { farmId: OWNER, createdBy: OWNER, createdAt: serverTimestamp(), used: false }));
      await assertFails(setDoc(doc(own, 'pairingCodes', '333333'), { farmId: OWNER, createdBy: OWNER, createdAt: serverTimestamp(), used: true }));
    });
    it('codes cannot be listed (no enumeration), only fetched by exact id', async () => {
      await seedCode('444444');
      const st = anonCtx(STRANGER).firestore();
      await assertFails(getDocs(collection(st, 'pairingCodes')));
      await assertSucceeds(getDoc(doc(st, 'pairingCodes', '444444')));
    });
    it('expired code (older than 10 min) is rejected by the rules even if the client skips its check', async () => {
      await seedCode('555555', { ageMs: 10 * 60 * 1000 + 5000 });
      // client-side check
      await expect(joinFarm(fbOf(anonCtx(PHONE2)), PHONE2, '555555', 'X')).rejects.toMatchObject({ reason: 'expired' });
      // raw write bypassing the client check
      const db = anonCtx(PHONE2).firestore();
      const b = fsMod.writeBatch(db);
      b.update(doc(db, 'pairingCodes', '555555'), { used: true, usedBy: PHONE2, usedAt: serverTimestamp() });
      b.update(doc(db, 'farms', OWNER), { [`devices.${PHONE2}`]: { name: 'X', addedAt: serverTimestamp(), addedBy: OWNER, code: '555555' } });
      await assertFails(b.commit());
    });
    it('a code just under 10 minutes old still works', async () => {
      await seedCode('565656', { ageMs: 9 * 60 * 1000 });
      await assertSucceeds(joinFarm(fbOf(anonCtx(PHONE2)), PHONE2, '565656', 'X'));
    });
    it('a code works only once', async () => {
      await addPhone(PHONE2, '666666');
      await expect(joinFarm(fbOf(anonCtx(PHONE3)), PHONE3, '666666', 'Y')).rejects.toMatchObject({ reason: 'used' });
      const db = anonCtx(PHONE3).firestore();
      const b = fsMod.writeBatch(db);
      b.update(doc(db, 'farms', OWNER), { [`devices.${PHONE3}`]: { name: 'Y', addedAt: serverTimestamp(), addedBy: OWNER, code: '666666' } });
      await assertFails(b.commit());
    });
    it('cannot add yourself without consuming a code in the same write', async () => {
      await seedCode('777777');
      const db = anonCtx(STRANGER).firestore();
      await assertFails(
        updateDoc(doc(db, 'farms', OWNER), { [`devices.${STRANGER}`]: { name: 'S', addedAt: serverTimestamp(), addedBy: OWNER, code: '777777' } }),
      );
      // ...nor consume a code without joining
      await assertFails(updateDoc(doc(db, 'pairingCodes', '777777'), { used: true, usedBy: STRANGER, usedAt: serverTimestamp() }));
    });
    it('a valid code cannot be used to add someone else, or two devices at once', async () => {
      await seedCode('888888');
      const db = anonCtx(STRANGER).firestore();
      const b = fsMod.writeBatch(db);
      b.update(doc(db, 'pairingCodes', '888888'), { used: true, usedBy: STRANGER, usedAt: serverTimestamp() });
      b.update(doc(db, 'farms', OWNER), {
        [`devices.${STRANGER}`]: { name: 'S', addedAt: serverTimestamp(), addedBy: OWNER, code: '888888' },
        [`devices.friend`]: { name: 'F', addedAt: serverTimestamp(), addedBy: OWNER, code: '888888' },
      });
      await assertFails(b.commit());
      const b2 = fsMod.writeBatch(db);
      b2.update(doc(db, 'pairingCodes', '888888'), { used: true, usedBy: 'friend', usedAt: serverTimestamp() });
      b2.update(doc(db, 'farms', OWNER), { [`devices.friend`]: { name: 'F', addedAt: serverTimestamp(), addedBy: OWNER, code: '888888' } });
      await assertFails(b2.commit());
    });
    it('joining cannot change ownerUid or other devices', async () => {
      await seedCode('999999');
      const db = anonCtx(STRANGER).firestore();
      const b = fsMod.writeBatch(db);
      b.update(doc(db, 'pairingCodes', '999999'), { used: true, usedBy: STRANGER, usedAt: serverTimestamp() });
      b.update(doc(db, 'farms', OWNER), {
        ownerUid: STRANGER,
        [`devices.${STRANGER}`]: { name: 'S', addedAt: serverTimestamp(), addedBy: OWNER, code: '999999' },
      });
      await assertFails(b.commit());
      const b2 = fsMod.writeBatch(db);
      b2.update(doc(db, 'pairingCodes', '999999'), { used: true, usedBy: STRANGER, usedAt: serverTimestamp() });
      b2.update(doc(db, 'farms', OWNER), {
        [`devices.${OWNER}`]: deleteField(),
        [`devices.${STRANGER}`]: { name: 'S', addedAt: serverTimestamp(), addedBy: OWNER, code: '999999' },
      });
      await assertFails(b2.commit());
    });
    it('a missing code gives a clean "notFound" error', async () => {
      await expect(joinFarm(fbOf(anonCtx(PHONE2)), PHONE2, '000001', 'X')).rejects.toBeInstanceOf(PairingError);
      await expect(joinFarm(fbOf(anonCtx(PHONE2)), PHONE2, '000001', 'X')).rejects.toMatchObject({ reason: 'notFound' });
    });
    it('members can delete (cancel) their farm codes; strangers cannot', async () => {
      await seedCode('121212');
      await assertFails(fsMod.deleteDoc(doc(anonCtx(STRANGER).firestore(), 'pairingCodes', '121212')));
      await assertSucceeds(fsMod.deleteDoc(doc(ownerCtx().firestore(), 'pairingCodes', '121212')));
    });
  });

  // ------------------------------------------------------------- removal / rename
  describe('device removal and rename', () => {
    beforeEach(async () => {
      await seedFarm();
      await addPhone(PHONE2, '131313');
      await addPhone(PHONE3, '141414');
    });
    it('owner removes a phone and its access is cut immediately', async () => {
      const p2 = anonCtx(PHONE2).firestore();
      await assertSucceeds(getDoc(doc(p2, 'farms', OWNER, 'settings', 'main')));
      await assertSucceeds(removeDevice(fbOf(ownerCtx()), OWNER, PHONE2));
      await assertFails(getDoc(doc(p2, 'farms', OWNER, 'settings', 'main')));
      await assertFails(setDoc(doc(p2, 'farms', OWNER, 'days', '2026-10-13'), { a: 1 }));
      await assertFails(getDoc(doc(p2, 'farms', OWNER)));
      // the removed phone cannot make new codes either
      await assertFails(setDoc(doc(p2, 'pairingCodes', '151515'), { farmId: OWNER, createdBy: PHONE2, createdAt: serverTimestamp(), used: false }));
    });
    it('a removed phone can come back only with a new code', async () => {
      await removeDevice(fbOf(ownerCtx()), OWNER, PHONE2);
      await assertFails(
        updateDoc(doc(anonCtx(PHONE2).firestore(), 'farms', OWNER), { [`devices.${PHONE2}`]: { name: 'again', addedAt: serverTimestamp(), addedBy: OWNER, code: '131313' } }),
      );
      await addPhone(PHONE2, '161616');
      await assertSucceeds(getDoc(doc(anonCtx(PHONE2).firestore(), 'farms', OWNER, 'settings', 'main')));
    });
    it('a non-owner phone cannot remove another phone', async () => {
      await assertFails(removeDevice(fbOf(anonCtx(PHONE2)), OWNER, PHONE3));
    });
    it('nobody can remove the owner device (not even the owner)', async () => {
      await assertFails(removeDevice(fbOf(anonCtx(PHONE2)), OWNER, OWNER));
      await assertFails(removeDevice(fbOf(ownerCtx()), OWNER, OWNER));
    });
    it('a non-owner phone may remove itself', async () => {
      await assertSucceeds(removeDevice(fbOf(anonCtx(PHONE3)), OWNER, PHONE3));
      await assertFails(getDoc(doc(anonCtx(PHONE3).firestore(), 'farms', OWNER, 'customers', 'x')));
    });
    it('a phone renames only itself, and only the name', async () => {
      const p2 = fbOf(anonCtx(PHONE2));
      await renameDevice(p2, OWNER, PHONE2, 'Bhaiya ka naya phone');
      const farm = (await getDoc(doc(ownerCtx().firestore(), 'farms', OWNER))).data();
      expect(farm.devices[PHONE2].name).toBe('Bhaiya ka naya phone');
      await assertFails(updateDoc(doc(p2.db, 'farms', OWNER), { [`devices.${PHONE3}.name`]: 'pwned' }));
      await assertFails(updateDoc(doc(p2.db, 'farms', OWNER), { [`devices.${PHONE2}.addedBy`]: 'pwned' }));
      await assertFails(updateDoc(doc(p2.db, 'farms', OWNER), { ownerUid: PHONE2 }));
    });
    it('a stranger cannot remove or rename anything', async () => {
      await assertFails(removeDevice(fbOf(anonCtx(STRANGER)), OWNER, PHONE2));
      await assertFails(updateDoc(doc(anonCtx(STRANGER).firestore(), 'farms', OWNER), { [`devices.${PHONE2}.name`]: 'x' }));
    });
  });
});
