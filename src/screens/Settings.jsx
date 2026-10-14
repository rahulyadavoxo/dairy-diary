import { useEffect, useState } from 'react';
import { useLang } from '../i18n.js';
import { saveSettings } from '../db.js';
import { paiseToInput, toPaise } from '../format.js';
import { getPinHash, hashPin } from '../pinLock.js';
import DevicesCard from '../components/DevicesCard.jsx';

export default function Settings({ fb, user, settings, displayName, setDisplayName, online, farm, farmId }) {
  const { t, lang, setLang } = useLang();
  const [f, setF] = useState({ milkRate: '', paneerRate: '', farmName: '', phone: '' });
  const [name, setName] = useState(displayName || '');
  const [msg, setMsg] = useState('');
  const [pin, setPin] = useState('');
  const [pinMsg, setPinMsg] = useState('');
  const hasPin = !!getPinHash(settings);

  const savePin = async (e) => {
    e.preventDefault();
    const p = pin.trim();
    if (p.length < 4) {
      setPinMsg(t('pinTooShort'));
      return;
    }
    const h = await hashPin(p);
    saveSettings(fb, { totalsPinHash: h });
    setPin('');
    setPinMsg(t('pinSaved'));
    setTimeout(() => setPinMsg(''), 2500);
  };

  const removePin = (e) => {
    e.preventDefault();
    if (!window.confirm(t('pinRemoveConfirm'))) return;
    saveSettings(fb, { totalsPinHash: '' });
    setPinMsg(t('pinRemoved'));
    setTimeout(() => setPinMsg(''), 2500);
  };

  useEffect(() => {
    setF({
      milkRate: paiseToInput(settings.milkRatePaise),
      paneerRate: paiseToInput(settings.paneerRatePaise),
      farmName: settings.farmName || '',
      phone: settings.phone || '',
    });
  }, [settings.milkRatePaise, settings.paneerRatePaise, settings.farmName, settings.phone]);

  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  const save = (e) => {
    e.preventDefault();
    saveSettings(fb, {
      milkRatePaise: toPaise(f.milkRate) || 0,
      paneerRatePaise: toPaise(f.paneerRate) || 0,
      farmName: f.farmName.trim(),
      phone: f.phone.trim(),
    });
    const n = name.trim();
    if (n && n !== displayName) {
      setDisplayName(n);
      fb.authMod.updateProfile(fb.auth.currentUser, { displayName: n }).catch((er) => console.error(er));
    }
    setMsg(online ? t('saved') : t('savedOffline'));
    setTimeout(() => setMsg(''), 2500);
  };

  return (
    <form className="screen form" onSubmit={save}>
      <header className="screen-head">
        <h1>{t('settingsTitle')}</h1>
      </header>
      <label>
        {t('milkRate')}
        <input type="number" inputMode="decimal" min="0" step="0.5" value={f.milkRate} onChange={set('milkRate')} />
      </label>
      <label>
        {t('paneerRate')}
        <input type="number" inputMode="decimal" min="0" step="1" value={f.paneerRate} onChange={set('paneerRate')} />
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
        {t('myName')}
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {msg && <p className="ok">{msg}</p>}
      <button className="btn primary big" type="submit">
        {t('save')}
      </button>

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

      <div className="card">
        <p>
          <b>🔒 {t('totalsLock')}</b>
        </p>
        <p className="muted small">{t('totalsLockHint')}</p>
        {hasPin ? (
          <div className="chips">
            <button type="button" className="btn small danger" onClick={removePin}>
              {t('pinRemove')}
            </button>
          </div>
        ) : null}
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
        {pinMsg && <p className="ok small">{pinMsg}</p>}
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
          <button type="button" className="btn danger big" onClick={() => fb.authMod.signOut(fb.auth)}>
            {t('signOut')}
          </button>
        )}
        <p className="muted tiny">
          {t('version')} 1.9.3
        </p>
      </div>
    </form>
  );
}
