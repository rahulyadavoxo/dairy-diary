import { useEffect, useState } from 'react';
import { saveFeedback } from '../feedback.js';
import { useLang } from '../i18n.js';
import { saveSettings } from '../db.js';
import { paiseToInput, toPaise } from '../format.js';
import { validUpiId } from '../upi.js';
import { getPinHash, hashPin, savePinHash, verifyPin, pinWaitSeconds } from '../pinLock.js';
import DevicesCard from '../components/DevicesCard.jsx';
import { signOutAndWipe } from '../devices.js';
import { clearCachedPhotos } from '../billCache.js';
import { ringTimes, validRingTimes } from '../reminders.js';
import { usePinGate } from '../components/PinGate.jsx';

// Single source of truth for the version (package.json, injected by vite.config.js).
// eslint-disable-next-line no-undef
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';

export default function Settings({ fb, user, settings, displayName, setDisplayName, online, farm, farmId }) {
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
  useEffect(() => setRing({ night: nightStr, morning: morningStr }), [nightStr, morningStr]);
  const ringDirty = ring.night !== nightStr || ring.morning !== morningStr;
  const saveRing = (e) => {
    e.preventDefault();
    if (!ringDirty) return;
    if (!validRingTimes(ring.night, ring.morning)) {
      setRingMsg({ text: t('ringTimesInvalid'), err: true });
      saveFeedback(false);
    } else {
      saveSettings(fb, { ringNight: ring.night, ringMorning: ring.morning });
      setRingMsg({ text: t('ringTimesSaved'), err: false });
      saveFeedback(true);
    }
    setTimeout(() => setRingMsg({ text: '', err: false }), 2500);
  };

  const verifyCurrentPin = async (e) => {
    e.preventDefault();
    const ok = await verifyPin(pin.trim());
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

  useEffect(() => {
    setF({
      milkRate: paiseToInput(settings.milkRatePaise),
      paneerRate: paiseToInput(settings.paneerRatePaise),
      farmName: settings.farmName || '',
      phone: settings.phone || '',
      upiId: settings.upiId || '',
    });
  }, [settings.milkRatePaise, settings.paneerRatePaise, settings.farmName, settings.phone, settings.upiId]);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const gate = usePinGate();
  // Nothing changed -> a white "✓ Saved" button; any change -> the green "Save" (user, 15 Oct 2026).
  const dirty =
    f.milkRate !== paiseToInput(settings.milkRatePaise) ||
    f.paneerRate !== paiseToInput(settings.paneerRatePaise) ||
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
    if (sensitive && !(f.upiId.trim() && !validUpiId(f.upiId.trim()))) return gate.ask(t('pinForSettings'), doSave);
    doSave();
  };

  const doSave = () => {
    // A blank (or invalid) rate box keeps the old rate instead of silently saving ₹0.
    const upiRaw = f.upiId.trim();
    if (upiRaw && !validUpiId(upiRaw)) {
      setMsg(t('upiInvalid'));
      setTimeout(() => setMsg(''), 2500);
      saveFeedback(false);
      return;
    }
    const data = { farmName: f.farmName.trim(), phone: f.phone.trim(), upiId: upiRaw };
    const mr = toPaise(f.milkRate);
    const pr = toPaise(f.paneerRate);
    if (mr !== null && mr > 0) data.milkRatePaise = mr;
    if (pr !== null && pr > 0) data.paneerRatePaise = pr;
    saveSettings(fb, data);
    setF((cur) => ({
      ...cur,
      milkRate: data.milkRatePaise ? cur.milkRate : paiseToInput(settings.milkRatePaise),
      paneerRate: data.paneerRatePaise ? cur.paneerRate : paiseToInput(settings.paneerRatePaise),
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

      <form className="card ring-card" onSubmit={saveRing} noValidate>
        <p>
          <b>⏰ {t('ringSettings')}</b>
        </p>
        <p className="muted small">{t('ringSettingsHint')}</p>
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
              signOutAndWipe(fb, clearCachedPhotos).finally(() => window.location.reload());
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
