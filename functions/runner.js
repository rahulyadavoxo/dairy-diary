// Auto-bill sender shared by the GitHub Actions cron (cron.mjs, free) and the Blaze Cloud
// Functions (index.js). Uses the Admin SDK, so firestore.rules don't apply here.
//
// farms/{farmId}/waPrivate/main   { phoneNumberId, accessToken, template:{name,lang}, display }
//                                 (only the owner's own account can read/write it — firestore.rules)
// farms/{farmId}/waRuns/{month}   { status, sent:{cid:msgId}, failed:{cid:msg} }  (server only)
// farms/{farmId}/settings/main.autoBill.{lastRun, doneMonth}  status the app shows
import { computeMonth } from './shared/billing.js';
import { autoBillTarget, dueBillMonth, templateParams, templateMessage, GRAPH_VERSION } from './shared/autoBill.js';

export async function graph(path, token, body) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
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

async function loadAll(db, farmId) {
  const base = `farms/${farmId}`;
  const [cs, ds, ps, ss] = await Promise.all([
    db.collection(`${base}/customers`).get(),
    db.collection(`${base}/days`).get(),
    db.collection(`${base}/payments`).get(),
    db.doc(`${base}/settings/main`).get(),
  ]);
  const days = {};
  ds.docs.forEach((d) => (days[d.id] = d.data()));
  return {
    customers: cs.docs.map((d) => ({ id: d.id, ...d.data() })),
    days,
    payments: ps.docs.map((d) => ({ id: d.id, ...d.data() })),
    settings: ss.data() || {},
  };
}

// Token / template / account errors: stop this farm's run instead of failing every customer.
const FATAL = /^(190|100|10|200|131031|131042|132000|132001|132015|133010):/;

export async function runFarm(db, farmId, priv, { now = new Date(), deadline = Date.now() + 300000, log = console.log } = {}) {
  const settingsRef = db.doc(`farms/${farmId}/settings/main`);
  const settings = (await settingsRef.get()).data() || {};
  const ab = settings.autoBill || {};
  const month = dueBillMonth(ab, now, ab.doneMonth || null);
  if (!month || !priv || !priv.phoneNumberId || !priv.accessToken) return null;
  const runRef = db.doc(`farms/${farmId}/waRuns/${month}`);
  const run = { sent: {}, failed: {}, ...((await runRef.get()).data() || {}) };
  if (run.status === 'done') return null;
  const data = await loadAll(db, farmId);
  const targets = computeMonth({ ...data, month }).rows.filter(autoBillTarget);
  let fatal = '';
  for (const r of targets) {
    if (run.sent[r.customerId]) continue;
    if (Date.now() > deadline) break; // resumes on the next run
    try {
      const res = await graph(`${priv.phoneNumberId}/messages`, priv.accessToken, templateMessage(r.customer.phone, templateParams(r, month, data.settings), priv.template));
      run.sent[r.customerId] = (res.messages && res.messages[0] && res.messages[0].id) || 'ok';
      delete run.failed[r.customerId];
    } catch (e) {
      run.failed[r.customerId] = e.message;
      if (FATAL.test(e.message)) {
        fatal = e.message;
        break;
      }
    }
    await runRef.set({ sent: run.sent, failed: run.failed }, { merge: true });
  }
  const left = targets.filter((r) => !run.sent[r.customerId] && !run.failed[r.customerId]).length;
  const done = !fatal && left === 0;
  await runRef.set({ status: done ? 'done' : 'running', sent: run.sent, failed: run.failed, at: Date.now() }, { merge: true });
  const lastRun = { month, sent: Object.keys(run.sent).length, failed: Object.keys(run.failed).length, done, error: fatal, at: Date.now() };
  await settingsRef.set({ autoBill: done ? { lastRun, doneMonth: month } : { lastRun } }, { merge: true });
  log(`auto-bill ${farmId} ${JSON.stringify({ ...lastRun, error: fatal ? fatal.slice(0, 80) : '' })}`);
  return lastRun;
}

/** Every connected dairy (collection group "waPrivate" under each farm). */
export async function runAll(db, opts = {}) {
  const deadline = opts.deadline || Date.now() + 300000;
  const privs = await db.collectionGroup('waPrivate').get();
  let checked = 0, sentRuns = 0;
  for (const p of privs.docs) {
    if (p.id !== 'main') continue;
    const farmId = p.ref.parent.parent.id;
    if (Date.now() > deadline) break;
    try {
      checked++;
      if (await runFarm(db, farmId, p.data(), { ...opts, deadline })) sentRuns++;
    } catch (e) {
      (opts.log || console.log)(`auto-bill ${farmId} failed: ${String(e && e.message).slice(0, 200)}`);
    }
  }
  return { checked, sentRuns };
}
