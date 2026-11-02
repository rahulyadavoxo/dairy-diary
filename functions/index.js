// Dairy Diary — WhatsApp auto-bill (Cloud Functions v2, needs the Firebase Blaze plan).
//
// waPrivate/{farmId}                 { phoneNumberId, accessToken, template:{name,lang},
//                                      display, connectedBy, connectedAt }   (no client access:
//                                      firestore.rules deny everything outside farms/ + codes)
// waPrivate/{farmId}/runs/{month}    { status, sent:{cid:msgId}, failed:{cid:msg}, startedAt, doneAt }
// farms/{farmId}/settings/main.autoBill.{connected, display, lastRun}   status the app shows
//
// Sending is idempotent per customer: a run that stops half way (timeout, Meta error) resumes on
// the next tick and never sends the same customer the same month twice.

import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { setGlobalOptions, logger } from 'firebase-functions/v2';
import { computeMonth } from './shared/billing.js';
import { addMonths } from './shared/format.js';
import { autoBillTarget, dueBillMonth, templateParams, templateMessage, GRAPH_VERSION, TEMPLATE_DEFAULT } from './shared/autoBill.js';

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: 'asia-south1', maxInstances: 2 });

const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const farmRef = (id) => db.doc(`farms/${id}`);
const settingsRef = (id) => db.doc(`farms/${id}/settings/main`);
const privRef = (id) => db.doc(`waPrivate/${id}`);

async function graph(path, token, body) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = (json && json.error) || {};
    throw new Error(`${e.code || res.status}: ${e.message || 'WhatsApp error'}`.slice(0, 300));
  }
  return json;
}

/** The caller's farm: the owner (farmId == uid) or a joined phone passing farmId. */
async function callerFarm(req, ownerOnly) {
  const uid = req.auth && req.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in first');
  const farmId = String((req.data && req.data.farmId) || uid);
  const snap = await farmRef(farmId).get();
  const farm = snap.exists ? snap.data() : null;
  if (!farm || !farm.devices || !farm.devices[uid]) throw new HttpsError('permission-denied', 'Not a phone of this dairy');
  if (ownerOnly && farm.ownerUid !== uid) throw new HttpsError('permission-denied', 'Only the owner can do this');
  return farmId;
}

const clean = (s, n) => String(s || '').trim().slice(0, n);

/** Owner connects the dairy's WhatsApp Business number (Cloud API ids from Meta). */
export const waConnect = onCall(async (req) => {
  const farmId = await callerFarm(req, true);
  const phoneNumberId = clean(req.data.phoneNumberId, 40);
  const accessToken = clean(req.data.accessToken, 1000);
  const template = { name: clean(req.data.templateName, 100) || TEMPLATE_DEFAULT.name, lang: clean(req.data.templateLang, 10) || TEMPLATE_DEFAULT.lang };
  if (!/^\d{6,30}$/.test(phoneNumberId)) throw new HttpsError('invalid-argument', 'Phone number ID should be digits');
  if (accessToken.length < 20) throw new HttpsError('invalid-argument', 'Access token missing');
  let info;
  try {
    info = await graph(`${phoneNumberId}?fields=display_phone_number,verified_name`, accessToken);
  } catch (e) {
    throw new HttpsError('failed-precondition', `WhatsApp: ${e.message}`);
  }
  const display = clean(`${info.verified_name || ''} ${info.display_phone_number || ''}`, 80);
  await privRef(farmId).set({ phoneNumberId, accessToken, template, display, connectedBy: req.auth.uid, connectedAt: FieldValue.serverTimestamp() });
  await settingsRef(farmId).set({ autoBill: { connected: true, display } }, { merge: true });
  return { display };
});

export const waDisconnect = onCall(async (req) => {
  const farmId = await callerFarm(req, true);
  await privRef(farmId).delete();
  await settingsRef(farmId).set({ autoBill: { connected: false, display: '' } }, { merge: true });
  return { ok: true };
});

/** Any phone of the dairy sends one test bill (last month's numbers) to a number it types. */
export const waTest = onCall(async (req) => {
  const farmId = await callerFarm(req, false);
  const priv = (await privRef(farmId).get()).data();
  if (!priv) throw new HttpsError('failed-precondition', 'WhatsApp not connected');
  const phone = clean(req.data.phone, 20);
  if (String(phone).replace(/\D/g, '').length < 10) throw new HttpsError('invalid-argument', 'Phone number');
  const settings = (await settingsRef(farmId).get()).data() || {};
  const month = addMonths(new Date().toISOString().slice(0, 7), -1);
  const row = { customer: { name: 'Test' }, billedPaise: 123400, balancePaise: 123400 };
  try {
    const r = await graph(`${priv.phoneNumberId}/messages`, priv.accessToken, templateMessage(phone, templateParams(row, month, settings), priv.template));
    return { id: (r.messages && r.messages[0] && r.messages[0].id) || '' };
  } catch (e) {
    throw new HttpsError('failed-precondition', `WhatsApp: ${e.message}`);
  }
});

async function loadAll(farmId) {
  const [cs, ds, ps, ss] = await Promise.all([
    db.collection(`farms/${farmId}/customers`).get(),
    db.collection(`farms/${farmId}/days`).get(),
    db.collection(`farms/${farmId}/payments`).get(),
    settingsRef(farmId).get(),
  ]);
  const customers = cs.docs.map((d) => ({ id: d.id, ...d.data() }));
  const days = {};
  ds.docs.forEach((d) => (days[d.id] = d.data()));
  const payments = ps.docs.map((d) => ({ id: d.id, ...d.data() }));
  return { customers, days, payments, settings: ss.data() || {} };
}

async function runFarm(farmId, priv, deadline) {
  const settings = (await settingsRef(farmId).get()).data() || {};
  const ab = settings.autoBill || {};
  const month = dueBillMonth(ab, new Date(), ab.doneMonth || null);
  if (!month) return;
  const runRef = privRef(farmId).collection('runs').doc(month);
  const run = (await runRef.get()).data() || { status: 'running', sent: {}, failed: {}, startedAt: FieldValue.serverTimestamp() };
  if (run.status === 'done') return;
  const data = await loadAll(farmId);
  const { rows } = computeMonth({ ...data, month });
  const targets = rows.filter(autoBillTarget).filter((r) => !run.sent[r.customerId]);
  for (const r of targets) {
    if (Date.now() > deadline) break; // resume on the next tick
    try {
      const res = await graph(`${priv.phoneNumberId}/messages`, priv.accessToken, templateMessage(r.customer.phone, templateParams(r, month, data.settings), priv.template));
      run.sent[r.customerId] = (res.messages && res.messages[0] && res.messages[0].id) || 'ok';
      delete run.failed[r.customerId];
    } catch (e) {
      run.failed[r.customerId] = e.message;
      // A broken token / template stops the whole run instead of failing every customer.
      if (/^(190|132000|132001|132015|131031|100):/.test(e.message)) break;
    }
    await runRef.set(run, { merge: true });
  }
  const left = rows.filter(autoBillTarget).filter((r) => !run.sent[r.customerId] && !run.failed[r.customerId]).length;
  const finished = left === 0;
  if (finished) run.status = 'done';
  run.doneAt = FieldValue.serverTimestamp();
  await runRef.set(run, { merge: true });
  const lastRun = { month, sent: Object.keys(run.sent).length, failed: Object.keys(run.failed).length, done: finished, at: Date.now() };
  await settingsRef(farmId).set({ autoBill: finished ? { lastRun, doneMonth: month } : { lastRun } }, { merge: true });
  logger.info('auto-bill', { farmId, ...lastRun });
}

/** Every 15 minutes: send last month's bills for each connected dairy whose day+time has come. */
export const autoBillTick = onSchedule({ schedule: 'every 15 minutes', timeZone: 'Asia/Kolkata', timeoutSeconds: 540, memory: '512MiB' }, async () => {
  const deadline = Date.now() + 480 * 1000;
  const privs = await db.collection('waPrivate').get();
  for (const p of privs.docs) {
    if (Date.now() > deadline) break;
    try {
      await runFarm(p.id, p.data(), deadline);
    } catch (e) {
      logger.error('auto-bill farm failed', { farmId: p.id, error: String(e && e.message) });
    }
  }
});
