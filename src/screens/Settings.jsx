import { useEffect, useRef, useState } from 'react';
import { saveFeedback } from '../feedback.js';
import { useLang } from '../i18n.js';
import { saveSettings, lockCurrentRates } from '../db.js';
import { WA_API } from '../waCloud.js';
import { TEMPLATE_DEFAULT, dueBillMonth, istParts } from '../autoBill.js';
import { paiseToInput, toPaise } from '../format.js';
import { validUpiId } from '../upi.js';
import { getPinHash, hashPin, savePinHash, verifyPin, pinWaitSeconds } from '../pinLock.js';
import DevicesCard from '../components/DevicesCard.jsx';
import { signOutAndWipe } from '../devices.js';
import { clearCachedPhotos } from '../billCache.js';
import { ringTimes, validRingTimes, ringPermission, askRingPermission, batteryExempt, askBatteryExempt } from '../reminders.js';
import { usePinGate } from '../components/PinGate.jsx';
import { ToggleBar, DELIVERY_FORMATS, deliveryFormat, morningUntil } from './Delivery.jsx';

// Single source of truth for the version (package.json, injected by vite.config.js).
// eslint-disable-next-line no-undef
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

export default function Settings({ fb, user, settings, displayName, setDisplayName, online, farm, farmId, customers = [], days = {}, histOk = true }) {
  const { t, lang, setLang } = useLang();
  const [f, setF] = useState({ milkRate: '', paneerRate: '', farmName: '', phone: '', upiId: '' });
  const [name, setName] = useState(displayName || '');
  const [msg, setMsg] = useState('');
  const [pin, setPin] = useState('');
  const [pinMsg, setPinMsg] = useState('');
  const [pinMsgErr, setPinMsgErr] = useState(false); // errors were shown in green ('ok' style)
  const [hasPin, setHasPin] = useState(() => !!getPinHash());
  const [pinVerified, setPinVerified] = useState(false);
  // Register ring times (farm-wide, synced to every phone)
  const pad = (n) => String(n).padStart(2, '0');
  const curTimes = ringTimes(settings);
  const nightStr = `${pad(curTimes.night[0])}:${pad(curTimes.night[1])}`;
  const morningStr = `${pad(curTimes.morning[0])}:${pad(curTimes.morning[1])}`;
  const [ring, setRing] = useState({ night: nightStr, morning: morningStr });
  const [ringMsg, setRingMsg] = useState({ text: '', err: false });
  // Notifications off -> the register ring can never show; warn and offer to turn them on.
  const [ringPerm, setRingPerm] = useState('granted');
  const [battOk, setBattOk] = useState(null); // false = Android battery optimisation on (ring may be late)
  useEffect(() => {
    let live = true;
    const check = () => {
      ringPermission().then((p) => live && setRingPerm(p));
      batteryExempt().then((b) => live && setBattOk(b));
    };
    check();
    const onVis = () => document.visibilityState === 'visible' && check(); // back from Android settings
    document.addEventListener('visibilitychange', onVis);
    // The battery-exemption request is a small dialog over the app: the WebView stays visible, so
    // visibilitychange never fires. Capacitor's 'resume' (Android onResume) does, also after a dialog.
    let sub = null;
    import('@capacitor/app')
      .then(({ App }) => App.addListener('resume', () => live && check()))
      .then((s) => {
        if (live) sub = s;
        else if (s && s.remove) s.remove();
      })
      .catch(() => {});
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVis);
      if (sub && sub.remove) sub.remove();
    };
  }, []);
  useEffect(() => setRing({ night: nightStr, morning: morningStr }), [nightStr, morningStr]);
  const ringDirty = ring.night !== nightStr || ring.morning !== morningStr;
  const saveRing = (e) => {
    e.preventDefault();
    if (!ringDirty) return;
    if (!validRingTimes(ring.night, ring.morning)) {
      setRingMsg({ text: t('ringTimesInvalid'), err: true });
      saveFeedback(false);
    } else {
      // v1.10.73: both times are one setting: always write the pair that was checked together
      // (writing one only could pair it with another phone's other time, morning >= night, and
      // every phone silently fell back to 22:00/08:00).
      saveSettings(fb, { ringNight: ring.night, ringMorning: ring.morning });
      setRingMsg({ text: t('ringTimesSaved'), err: false });
      saveFeedback(true);
    }
    setTimeout(() => setRingMsg({ text: '', err: false }), 2500);
  };

  const pinBusy = useRef(false); // double tap while PBKDF2 runs: verify once
  const verifyCurrentPin = async (e) => {
    e.preventDefault();
    if (pinBusy.current) return;
    pinBusy.current = true;
    let ok;
    try {
      ok = await verifyPin(pin.trim());
    } finally {
      pinBusy.current = false;
    }
    if (ok) {
      setPinVerified(true);
      setPin('');
      setPinMsg('');
    } else {
      const w = pinWaitSeconds();
      setPinMsgErr(true);
      setPinMsg(w > 0 ? t('pinWait').replace('{s}', w) : t('pinWrong'));
      setTimeout(() => setPinMsg(''), 2500);
    }
  };

  const savePin = async (e) => {
    e.preventDefault();
    const p = pin.trim();
    if (p.length < 4) {
      setPinMsgErr(true);
      setPinMsg(t('pinTooShort'));
      saveFeedback(false);
      return;
    }
    try {
      const h = await hashPin(p);
      savePinHash(h);
      setHasPin(true);
      setPinVerified(false);
      setPin('');
      setPinMsgErr(false);
      setPinMsg(t('pinSaved'));
      saveFeedback(true);
    } catch (err) {
      console.error('[pin]', err);
      setPinMsgErr(true);
      setPinMsg(t('pinFailed'));
    }
    setTimeout(() => setPinMsg(''), 2500);
  };

  const removePin = (e) => {
    e.preventDefault();
    if (!window.confirm(t('pinRemoveConfirm'))) return;
    savePinHash('');
    setHasPin(false);
    setPinVerified(false);
    setPin('');
    setPinMsgErr(false);
    setPinMsg(t('pinRemoved'));
    setTimeout(() => setPinMsg(''), 2500);
  };

  // Values last taken from the server. When another phone changes one of them, only the boxes this
  // user has not touched follow it; typing in the other boxes is kept.
  const synced = useRef(null);
  // Rate boxes are compared by VALUE: "60.50" typed and "60.5" from the server are the same rate
  // (a string compare kept such a box "touched" forever, so it never followed another phone).
  const sameField = (k, a, b) => {
    if (k !== 'milkRate' && k !== 'paneerRate') return a === b;
    const pa = toPaise(a);
    const pb = toPaise(b);
    return pa === null || pb === null ? a === b : pa === pb;
  };
  useEffect(() => {
    const next = {
      milkRate: paiseToInput(settings.milkRatePaise),
      paneerRate: paiseToInput(settings.paneerRatePaise),
      farmName: settings.farmName || '',
      phone: settings.phone || '',
      upiId: settings.upiId || '',
    };
    const prev = synced.current;
    synced.current = next;
    setF((cur) => (prev ? Object.fromEntries(Object.keys(next).map((k) => [k, sameField(k, cur[k], prev[k]) ? next[k] : cur[k]])) : next));
  }, [settings.milkRatePaise, settings.paneerRatePaise, settings.farmName, settings.phone, settings.upiId]);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const gate = usePinGate();
  // Nothing changed -> a white "✓ Saved" button; any change -> the green "Save" (user, 15 Oct 2026).
  const norm = (v) => paiseToInput(toPaise(v)); // "60.50" -> "60.5"
  const dirty =
    norm(f.milkRate) !== paiseToInput(settings.milkRatePaise) ||
    norm(f.paneerRate) !== paiseToInput(settings.paneerRatePaise) ||
    f.farmName !== (settings.farmName || '') ||
    f.phone !== (settings.phone || '') ||
    f.upiId !== (settings.upiId || '') ||
    (name.trim() !== '' && name.trim() !== displayName);

  const save = (e) => {
    e.preventDefault();
    if (!dirty) return;
    // Rates and the UPI ID decide where money goes and how much: they need the PIN.
    const mr0 = toPaise(f.milkRate);
    const pr0 = toPaise(f.paneerRate);
    const sensitive =
      (mr0 !== null && mr0 > 0 && mr0 !== settings.milkRatePaise) ||
      (pr0 !== null && pr0 > 0 && pr0 !== settings.paneerRatePaise) ||
      f.upiId.trim() !== (settings.upiId || '');
    // A rate change waits for old history (asked before the PIN, so the PIN is not typed for nothing).
    if (rateBlocked(mr0, pr0)) return;
    if (sensitive && !(f.upiId.trim() && !validUpiId(f.upiId.trim()))) return gate.ask(t('pinForSettings'), doSave);
    doSave();
  };

  // v1.10.70 lock only freezes days on this phone: while old history is still loading (histOk false)
  // older days without a rate snapshot would re-price at the new rate, so the rate save waits.
  const rateBlocked = (mr, pr) => {
    const changes = (mr !== null && mr > 0 && mr !== settings.milkRatePaise) || (pr !== null && pr > 0 && pr !== settings.paneerRatePaise);
    if (!changes || histOk !== false) return false;
    setMsg(t('rateWaitHistory'));
    setTimeout(() => setMsg(''), 4000);
    saveFeedback(false);
    return true;
  };

  const doSave = () => {
    if (rateBlocked(toPaise(f.milkRate), toPaise(f.paneerRate))) return;
    // A blank (or invalid) rate box keeps the old rate instead of silently saving ₹0.
    const upiRaw = f.upiId.trim();
    if (upiRaw && !validUpiId(upiRaw)) {
      setMsg(t('upiInvalid'));
      setTimeout(() => setMsg(''), 2500);
      saveFeedback(false);
      return;
    }
    // Write ONLY the fields that changed: a phone that was offline with old settings must not send
    // back the old rate / UPI ID when its user changed just the name (merge write, last one wins).
    const data = {};
    const put = (k, v, old) => {
      if (v !== old) data[k] = v;
    };
    put('farmName', f.farmName.trim(), settings.farmName || '');
    put('phone', f.phone.trim(), settings.phone || '');
    put('upiId', upiRaw, settings.upiId || '');
    const mr = toPaise(f.milkRate);
    const pr = toPaise(f.paneerRate);
    const mrOk = mr !== null && mr > 0;
    const prOk = pr !== null && pr > 0;
    if (mrOk && mr !== settings.milkRatePaise) data.milkRatePaise = mr;
    if (prOk && pr !== settings.paneerRatePaise) data.paneerRatePaise = pr;
    // v1.10.70: the new rate starts now; saved days without a snapshot keep the old rate
    if ('milkRatePaise' in data || 'paneerRatePaise' in data) lockCurrentRates(fb, customers, days, settings);
    if (Object.keys(data).length) saveSettings(fb, data);
    setF((cur) => ({
      ...cur,
      // show the canonical text of what was saved ("60.50" -> "60.5"), so the box is not
      // "touched" afterwards and keeps following other phones
      milkRate: mrOk ? paiseToInput(mr) : paiseToInput(settings.milkRatePaise),
      paneerRate: prOk ? paiseToInput(pr) : paiseToInput(settings.paneerRatePaise),
      farmName: cur.farmName.trim(),
      phone: cur.phone.trim(),
      upiId: upiRaw,
    }));
    const n = name.trim();
    if (n && n !== displayName) {
      setDisplayName(n);
      fb.authMod.updateProfile(fb.auth.currentUser, { displayName: n }).catch((er) => console.error(er));
    }
    setMsg(online ? t('saved') : t('savedOffline'));
    setTimeout(() => setMsg(''), 2500);
    saveFeedback(true);
  };

  return (
    // NOTE: the outer element is a <div>, not a <form>. The PIN form and the DevicesCard rename
    // form used to be nested inside the settings <form>: nested forms are invalid HTML and their
    // submit events bubbled into save(), so setting a PIN / renaming a phone also re-saved rates.
    <div className="screen form">
      {gate.element}
      <header className="screen-head">
        <h1>{t('settingsTitle')}</h1>
      </header>
      <form onSubmit={save} style={{ display: 'contents' }} noValidate>
      <label>
        {t('milkRate')}
        <input type="number" inputMode="decimal" min="0" step="any" value={f.milkRate} onChange={set('milkRate')} />
      </label>
      <label>
        {t('paneerRate')}
        <input type="number" inputMode="decimal" min="0" step="any" value={f.paneerRate} onChange={set('paneerRate')} />
      </label>
      <p className="muted small">{t('rateNote')}</p>
      <label>
        {t('farmName')}
        <input value={f.farmName} onChange={set('farmName')} />
      </label>
      <label>
        {t('farmPhone')}
        <input type="tel" inputMode="tel" value={f.phone} onChange={set('phone')} />
      </label>
      <label>
        {t('upiId')}
        <input value={f.upiId} onChange={set('upiId')} placeholder="name@okaxis" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      </label>
      <p className="muted small">{t('upiIdHint')}</p>
      <label>
        {t('myName')}
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {msg && <p className="ok">{msg}</p>}
      <button className={'btn big ' + (dirty ? 'primary' : 'saved-btn')} type="submit" data-testid="settings-save">
        {dirty ? t('save') : '✓ ' + t('savedState')}
      </button>
      </form>

      <div className="card">
        <p>{t('language')}</p>
        <div className="chips">
          <button type="button" className={'btn chip' + (lang === 'hi' ? ' on' : '')} onClick={() => setLang('hi')}>
            हिंदी
          </button>
          <button type="button" className={'btn chip' + (lang === 'en' ? ' on' : '')} onClick={() => setLang('en')}>
            English
          </button>
        </div>
      </div>

      <div className="card" data-testid="delivery-format-card">
        <p>
          <b>🚚 {t('deliveryFormat')}</b>
        </p>
        <p className="muted small">{t('deliveryFormatHint')}</p>
        {DELIVERY_FORMATS.map((k) => (
          <ToggleBar
            key={k}
            label={t('deliFmt_' + k)}
            on={deliveryFormat(settings) === k}
            onChange={(v) => v && deliveryFormat(settings) !== k && saveSettings(fb, { deliveryFormat: k })}
            testId={'deli-fmt-' + k}
          />
        ))}
        {deliveryFormat(settings) === 'split' && (
          <label className="ring-times" data-testid="morning-until">
            🌅 {t('morningUntilLabel')}
            <input
              type="time"
              value={morningUntil(settings)}
              onChange={(e) => /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(e.target.value) && saveSettings(fb, { morningUntil: e.target.value })}
            />
            <span className="muted small">{t('morningUntilHint')}</span>
          </label>
        )}
      </div>

      <form className="card ring-card" onSubmit={saveRing} noValidate>
        <p>
          <b>⏰ {t('ringSettings')}</b>
        </p>
        <p className="muted small">{t('ringSettingsHint')}</p>
        {/* Xiaomi/Vivo/Oppo block the boot alarm reset unless Autostart is on (native review #14) */}
        <p className="muted small" data-testid="ring-autostart-hint">
          ℹ️ {t('ringAutostartHint')}
        </p>
        {battOk === false && (
          <div className="card warn" data-testid="ring-battery-off">
            <p className="small">🔋 {t('ringBatteryOff')}</p>
            <button type="button" className="btn primary" onClick={() => askBatteryExempt()}>
              {t('ringBatteryAllow')}
            </button>
          </div>
        )}
        {ringPerm !== 'granted' && (
          <div className="card warn" data-testid="ring-perm-off">
            <p className="error">⚠️ {t('ringPermOff')}</p>
            <button type="button" className="btn primary" onClick={() => askRingPermission().then(setRingPerm)}>
              🔔 {t('ringPermOn')}
            </button>
          </div>
        )}
        <div className="ring-times">
          <label>
            🌙 {t('ringNightLabel')}
            <input type="time" value={ring.night} onChange={(e) => setRing({ ...ring, night: e.target.value })} />
          </label>
          <label>
            🌅 {t('ringMorningLabel')}
            <input type="time" value={ring.morning} onChange={(e) => setRing({ ...ring, morning: e.target.value })} />
          </label>
        </div>
        {ringMsg.text && <p className={(ringMsg.err ? 'error' : 'ok') + ' small'}>{ringMsg.text}</p>}
        <button type="submit" className={'btn small ' + (ringDirty ? 'primary' : 'saved-btn')} data-testid="ring-save">
          {ringDirty ? t('ringSave') : '✓ ' + t('savedState')}
        </button>
      </form>

      <AutoBillCard fb={fb} settings={settings} isOwner={!!user && user.uid === farmId} />
      <ShareAppCard />

      <div className="card">
        <p>
          <b>🔒 {t('totalsLock')}</b>
        </p>
        <p className="muted small">{t('totalsLockHint')}</p>
        {hasPin && !pinVerified ? (
          <form onSubmit={verifyCurrentPin} className="form-inline">
            <input
              type="password"
              inputMode="numeric"
              placeholder={t('pinCurrent')}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              maxLength={12}
            />
            <button type="submit" className="btn small primary">
              {t('pinUnlock')}
            </button>
          </form>
        ) : (
          <>
            {hasPin && (
              <div className="chips" style={{ marginBottom: '0.5rem' }}>
                <button type="button" className="btn small danger" onClick={removePin}>
                  {t('pinRemove')}
                </button>
              </div>
            )}
            <form onSubmit={savePin} className="form-inline">
              <input
                type="password"
                inputMode="numeric"
                placeholder={hasPin ? t('pinNew') : t('pinSet')}
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                maxLength={12}
              />
              <button type="submit" className="btn small">
                {hasPin ? t('pinChange') : t('pinSetBtn')}
              </button>
            </form>
          </>
        )}
        {pinMsg && <p className={(pinMsgErr ? 'error' : 'ok') + ' small'}>{pinMsg}</p>}
      </div>

      {farm && <DevicesCard fb={fb} farm={farm} farmId={farmId} uid={user.uid} online={online} />}

      <div className="card">
        <p className="small">
          {t('signedInAs')}: <b>{user.email || (farm && farm.devices && farm.devices[user.uid] ? farm.devices[user.uid].name : '')}</b>
        </p>
        <p className="small">{online ? t('online') : t('offline')}</p>
        {/* Anonymous phones have no password: signing out would lose this phone's identity, so
            they leave via "Remove this phone" in the Phones card instead. */}
        {!user.isAnonymous && (
          <button
            type="button"
            className="btn danger big"
            disabled={!online}
            onClick={() => {
              if (!window.confirm(t('confirmSignOut'))) return;
              signOutAndWipe(fb, clearCachedPhotos, 8000, () => window.confirm(t('signOutUnsynced')))
                .then((done) => {
                  if (done !== false) window.location.reload();
                })
                .catch(() => window.location.reload());
            }}
          >
            {t('signOut')}
          </button>
        )}
        {!user.isAnonymous && !online && <p className="muted small">{t('signOutNeedsInternet')}</p>}
        <p className="muted tiny">
          {t('version')} {APP_VERSION}
        </p>
      </div>
    </div>
  );
}


/** WhatsApp auto-bill (Nov 2026): day/time setting + "WhatsApp जोड़ो" (owner) + test send.
 *  Bills are sent by the GitHub Actions cron (functions/cron.mjs); it writes lastRun here.
 *  The owner's phone checks the ids with Meta, stores them in farms/{id}/waPrivate/main, sends tests. */
export function AutoBillCard({ fb, settings, isOwner = true, waApi = WA_API }) {
  const { t } = useLang();
  const cur = settings.autoBill || {};
  const base = { enabled: !!cur.enabled, day: Number(cur.day) || 1, time: cur.time || '09:00' };
  const [f, setF] = useState(base);
  // v1.10.73: follow the server (settings snapshot late, another phone changed auto-bill) while the
  // form still shows the previous server values; what the user has changed is kept.
  const prevBase = useRef(base);
  useEffect(() => {
    const p = prevBase.current;
    prevBase.current = base;
    setF((x) => (x.enabled === p.enabled && x.day === p.day && x.time === p.time ? base : x));
  }, [base.enabled, base.day, base.time]); // eslint-disable-line react-hooks/exhaustive-deps
  const [msg, setMsg] = useState({ text: '', err: false });
  const [conn, setConn] = useState(null); // connect form open
  const [busy, setBusy] = useState(false);
  const [testPhone, setTestPhone] = useState('');
  const dirty = f.enabled !== base.enabled || f.day !== base.day || f.time !== base.time;
  const say = (text, err = false) => setMsg({ text, err });
  const fnErr = (e) => String((e && e.message) || e || '').replace(/^.*?WhatsApp:/, 'WhatsApp:').slice(0, 200);

  const save = (e) => {
    e.preventDefault();
    if (!dirty) return;
    const day = Math.min(28, Math.max(1, Math.round(Number(f.day) || 1)));
    const time = /^\d{2}:\d{2}$/.test(f.time) ? f.time : '09:00';
    // Only these three: connected/display/lastRun belong to the server (merge keeps them).
    // Turned on after this month's send day has passed: last month is NOT sent late all at once.
    const ab = { enabled: f.enabled, day, time };
    // fix-bills #8: also when auto-bill is ALREADY on and the day/time moves earlier than today:
    // skip last month only if the OLD setting would not have sent it yet (else the run is due anyway).
    if (f.enabled && (!cur.enabled || day !== base.day || time !== base.time)) {
      const now = new Date();
      const doneM = cur.doneMonth || null;
      const due = dueBillMonth(ab, now, doneM);
      const oldDue = cur.enabled ? dueBillMonth({ enabled: true, day: base.day, time: base.time }, now, doneM) : null;
      if (due && !oldDue && istParts(now).day > day) ab.doneMonth = due;
    }
    saveSettings(fb, { autoBill: ab });
    setF({ enabled: f.enabled, day, time });
    say(t('saved'));
    setTimeout(() => setMsg({ text: '', err: false }), 2500);
  };
  const connect = async (e) => {
    e.preventDefault();
    setBusy(true);
    say('');
    try {
      const r = await waApi.connect(fb, conn);
      setConn(null);
      say(t('waConnected') + (r && r.display ? ': ' + r.display : ''));
    } catch (e2) {
      say(t('waConnectFailed') + ' ' + fnErr(e2), true);
    } finally {
      setBusy(false);
    }
  };
  const disconnect = async () => {
    if (!window.confirm(t('waDisconnectAsk'))) return;
    setBusy(true);
    try {
      await waApi.disconnect(fb);
      say(t('waDisconnected'));
    } catch (e2) {
      say(fnErr(e2), true);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    if (String(testPhone).replace(/\D/g, '').length < 10) return say(t('waTestPhone'), true);
    setBusy(true);
    try {
      await waApi.test(fb, testPhone, settings);
      say(t('waTestSent'));
    } catch (e2) {
      say(fnErr(e2), true);
    } finally {
      setBusy(false);
    }
  };
  const lr = cur.lastRun;

  return (
    <div className="card" data-testid="autobill-card">
      <form onSubmit={save}>
        <p>
          <b>🤖 {t('autoBillTitle')}</b>
        </p>
        <p className="muted small">{t('autoBillHint')}</p>
        <div className="lbl" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
          <input type="checkbox" id="dd-autobill-on" data-testid="autobill-on" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
          <span onClick={() => setF({ ...f, enabled: !f.enabled })}>{t('autoBillOn')}</span>
        </div>
        <div className="form-inline">
          <div className="lbl small">
            {t('autoBillDay')}
            <select data-testid="autobill-day" value={f.day} onChange={(e) => setF({ ...f, day: Number(e.target.value) })}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div className="lbl small">
            {t('autoBillTime')}
            <input type="time" data-testid="autobill-time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
          </div>
        </div>
        {f.enabled && !cur.connected && <p className="muted small">{t('autoBillPending')}</p>}
        <button type="submit" className={'btn small ' + (dirty ? 'primary' : 'saved-btn')} data-testid="autobill-save">
          {dirty ? t('autoBillSave') : '✓ ' + t('savedState')}
        </button>
      </form>

      <hr className="sep" />
      {cur.connected ? (
        <>
          <p className="small" data-testid="wa-connected">
            ✅ {t('waConnected')}
            {cur.display ? ': ' + cur.display : ''}
          </p>
          {lr && lr.month && (
            <p className="muted small" data-testid="autobill-lastrun">
              {t('autoBillLast')}: {lr.month} — ✓ {lr.sent || 0}
              {lr.failed ? ` · ✗ ${lr.failed}` : ''}
              {lr.error ? ` · ${lr.error}` : ''}
              {lr.waiting ? ` · ⏳ ${t('autoBillWaiting')}` : ''}
            </p>
          )}
          {isOwner && <div className="form-inline">
            <input type="tel" inputMode="tel" placeholder={t('waTestPhone')} value={testPhone} onChange={(e) => setTestPhone(e.target.value)} data-testid="wa-test-phone" />
            <button type="button" className="btn small" onClick={test} disabled={busy} data-testid="wa-test">
              {t('waTestBtn')}
            </button>
          </div>}
          {isOwner && (
            <button type="button" className="btn small ghost" onClick={disconnect} disabled={busy}>
              {t('waDisconnect')}
            </button>
          )}
        </>
      ) : isOwner ? (
        conn ? (
          <form onSubmit={connect} data-testid="wa-connect-form">
            <p className="muted small">{t('waConnectHint')}</p>
            <div className="lbl small">
              Phone number ID
              <input inputMode="numeric" value={conn.phoneNumberId} onChange={(e) => setConn({ ...conn, phoneNumberId: e.target.value })} required data-testid="wa-pnid" />
            </div>
            <div className="lbl small">
              Access token
              <input type="password" autoComplete="off" value={conn.accessToken} onChange={(e) => setConn({ ...conn, accessToken: e.target.value })} required data-testid="wa-token" />
            </div>
            <div className="form-inline">
              <div className="lbl small">
                {t('waTemplate')}
                <input value={conn.templateName} onChange={(e) => setConn({ ...conn, templateName: e.target.value })} />
              </div>
              <div className="lbl small">
                {t('waTemplateLang')}
                <input value={conn.templateLang} maxLength={10} onChange={(e) => setConn({ ...conn, templateLang: e.target.value })} />
              </div>
            </div>
            <div className="chips">
              <button type="submit" className="btn small primary" disabled={busy} data-testid="wa-connect-submit">
                {busy ? t('loading') : t('waConnectBtn')}
              </button>
              <button type="button" className="btn small ghost" onClick={() => setConn(null)} disabled={busy}>
                {t('back')}
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="btn small primary"
            data-testid="wa-connect"
            onClick={() => setConn({ phoneNumberId: '', accessToken: '', templateName: TEMPLATE_DEFAULT.name, templateLang: TEMPLATE_DEFAULT.lang })}
          >
            🔗 {t('waConnectBtn')}
          </button>
        )
      ) : (
        <p className="muted small">{t('waOwnerOnly')}</p>
      )}
      {msg.text && <p className={(msg.err ? 'error' : 'ok') + ' small'}>{msg.text}</p>}
    </div>
  );
}

const APP_PAGE = 'https://rahulyadavoxo.github.io/dairy-diary/download.html';

/** Share the app with another dairy: WhatsApp message with the download Page link. */
export function ShareAppCard() {
  const { t } = useLang();
  const share = () => {
    const text = `${t('shareAppText')}\n${APP_PAGE}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  };
  return (
    <div className="card" data-testid="share-app-card">
      <p>
        <b>📲 {t('shareAppTitle')}</b>
      </p>
      <p className="muted small">{t('shareAppHint')}</p>
      <button type="button" className="btn small" onClick={share} data-testid="share-app">
        {t('shareAppBtn')}
      </button>
    </div>
  );
}
