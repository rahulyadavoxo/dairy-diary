// Auto-bill sender shared by the GitHub Actions cron (cron.mjs, free) and the Blaze Cloud
// Functions (index.js). Uses the Admin SDK, so firestore.rules don't apply here.
//
// farms/{farmId}/waPrivate/main   { phoneNumberId, accessToken, template:{name,lang}, display }
//                                 (only the owner's own account can read/write it — firestore.rules)
// farms/{farmId}/waRuns/{month}   { status, sent:{cid:msgId}, failed:{cid:msg}, tries, tempTries,
//                                   manual:{cid:ms} }
//   status/sent/failed/tries/tempTries: written by this server only.
//   manual: written by the app (BillSender) for each customer sent BY HAND for that bill month
//           (firestore.rules lets a farm device write only that field); the server skips them.
// farms/{farmId}/settings/main.autoBill.{lastRun, doneMonth}  status the app shows
import { computeMonth, withLaterPayments } from './shared/billing.js';
import { addMonths } from './shared/format.js';
import { autoBillTarget, dueBillMonth, istParts, lastDayWait, templateParams, templateMessage, GRAPH_VERSION } from './shared/autoBill.js';

/** One Meta request may take at most this long (fix-bills #7): a hung request used to hold the
 *  job until GitHub killed it, before `sent` was saved -> the next run sent the bill again. */
export const GRAPH_TIMEOUT_MS = 20000;

export async function graph(path, token, body) {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
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
// NOT 100 (fix-bills #1): Meta also returns 100 "Invalid parameter" for ONE bad message (bad `to`
// number, bad text) - that is a per-customer failure, the run goes on with the next customer.
export const FATAL = /^(190|10|200|131031|131042|132000|132001|132015|133010):/;
// Meta down / rate limit / network / timeout: stop this run WITHOUT counting a try; the next cron
// run resumes (fix-bills #6: a 45-min outage used to burn all 3 tries of every customer).
export const TEMPORARY = /^(5\d\d|1|2|4|429|80007|130429|131000|131016|131048|131056|133004):|fetch failed|timeout|aborted|network|ECONN|ETIMEDOUT|ENOTFOUND/i;
// A customer whose send keeps failing "temporarily" this many runs gets one real try counted
// (so one odd number can never hold the farm forever).
const TEMP_LIMIT = 8;
const MAX_TRIES = 3;

export async function runFarm(db, farmId, priv, { now = new Date(), deadline = Date.now() + 300000, log = console.log, fieldDelete = null } = {}) {
  const settingsRef = db.doc(`farms/${farmId}/settings/main`);
  const settings = (await settingsRef.get()).data() || {};
  const ab = settings.autoBill || {};
  // Bills sent by hand from the phone also count as done (billsSentForMonth = the month AFTER the bill month).
  const manualDone = settings.billsSentForMonth ? addMonths(settings.billsSentForMonth, -1) : null;
  const doneMonth = [ab.doneMonth, manualDone].filter(Boolean).sort().pop() || null;
  const month = dueBillMonth(ab, now, doneMonth);
  if (!month || !priv || !priv.phoneNumberId || !priv.accessToken) return null;
  const runRef = db.doc(`farms/${farmId}/waRuns/${month}`);
  const run = { sent: {}, failed: {}, tries: {}, tempTries: {}, manual: {}, ...((await runRef.get()).data() || {}) };
  for (const k of ['sent', 'failed', 'tries', 'tempTries', 'manual']) run[k] = run[k] || {};
  if (run.status === 'done' || run.status === 'failed') return null;
  const data = await loadAll(db, farmId);
  // fix-bills #4: the last day of the bill month must be filled (as the manual sender warns),
  // otherwise every bill misses that day. Waits until it is filled, at most until the 3rd of the
  // month (IST); from the 3rd the bills go out anyway.
  if (lastDayWait(data.days, data.customers, month, now)) {
    const lastRun = { month, sent: Object.keys(run.sent).length, failed: 0, done: false, error: '', waiting: 'lastDayEmpty', at: Date.now() };
    await settingsRef.set({ autoBill: { lastRun } }, { merge: true });
    log(`auto-bill ${farmId} waiting: last day empty`);
    return null;
  }
  // payments made after the bill month (up to today, IST) count: a customer who already paid is not asked again
  const today = istParts(now).date;
  const targets = computeMonth({ ...data, month }).rows.map((r) => withLaterPayments(r, data.payments, month, today)).filter(autoBillTarget);
  // fix-bills #3: customers the owner already sent by hand (BillSender writes run.manual) are skipped.
  const handled = (id) => !!(run.sent[id] || run.manual[id]);
  const saveRun = (extra = {}) => runRef.set({ sent: run.sent, failed: run.failed, tries: run.tries, tempTries: run.tempTries, ...extra }, { merge: true });
  let fatal = '';
  let temporary = '';
  for (const r of targets) {
    const id = r.customerId;
    if (handled(id)) continue;
    if ((run.tries[id] || 0) >= MAX_TRIES) continue;
    if (Date.now() > deadline) break; // resumes on the next run
    try {
      const res = await graph(`${priv.phoneNumberId}/messages`, priv.accessToken, templateMessage(r.customer.phone, templateParams(r, month, data.settings), priv.template));
      run.sent[id] = (res.messages && res.messages[0] && res.messages[0].id) || 'ok';
      const hadFail = id in run.failed;
      delete run.failed[id];
      delete run.tempTries[id];
      // fix-bills #5: a Firestore merge never removes a missing map key -> delete it explicitly.
      await saveRun(hadFail && fieldDelete ? { failed: { ...run.failed, [id]: fieldDelete() } } : {});
      continue;
    } catch (e) {
      const msg = String((e && e.message) || e || 'error').slice(0, 300);
      run.failed[id] = msg;
      if (FATAL.test(msg)) {
        fatal = msg; // a fatal error does not use up the customer's tries
        break;
      }
      if (TEMPORARY.test(msg)) {
        run.tempTries[id] = (run.tempTries[id] || 0) + 1;
        if (run.tempTries[id] < TEMP_LIMIT) {
          temporary = msg;
          await saveRun();
          break; // Meta / network trouble: try everyone again on the next run, no try counted
        }
        run.tempTries[id] = 0;
      }
      run.tries[id] = (run.tries[id] || 0) + 1;
    }
    await saveRun();
  }
  // A failed customer is retried on the next run (up to 3 tries per customer), not dropped.
  const left = targets.filter((r) => !handled(r.customerId) && (run.tries[r.customerId] || 0) < MAX_TRIES).length;
  const finished = !fatal && !temporary && left === 0;
  const sentCount = targets.filter((r) => handled(r.customerId)).length;
  // fix-bills #6: everyone failed (Meta outage, wrong template...) -> NOT done; the month stays open
  // for the owner (hand banner) and is never counted as sent.
  const allFailed = finished && targets.length > 0 && sentCount === 0;
  const done = finished && !allFailed;
  // fix-bills #5: only customers that still have no bill count as failed
  const failedNow = Object.keys(run.failed).filter((id) => !handled(id));
  await saveRun({ status: done ? 'done' : allFailed ? 'failed' : 'running', at: Date.now() });
  const lastRun = {
    month,
    sent: Object.keys(run.sent).length,
    failed: failedNow.length,
    done,
    error: fatal || (allFailed ? run.failed[failedNow[0]] || 'all failed' : '') || temporary,
    waiting: '',
    at: Date.now(),
  };
  if (Object.keys(run.manual).length) lastRun.manual = targets.filter((r) => run.manual[r.customerId] && !run.sent[r.customerId]).length;
  const update = { autoBill: { lastRun } };
  if (done) {
    update.autoBill.doneMonth = month;
    // the hand "send bills" is switched off only when EVERY customer got the bill
    if (failedNow.length === 0) update.billsSentForMonth = addMonths(month, 1);
  }
  await settingsRef.set(update, { merge: true });
  log(`auto-bill ${farmId} ${JSON.stringify({ ...lastRun, error: lastRun.error ? lastRun.error.slice(0, 80) : '' })}`);
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
