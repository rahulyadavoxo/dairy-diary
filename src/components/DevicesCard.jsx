import { useEffect, useState } from 'react';
import { useLang } from '../i18n.js';
import {
  listDevices,
  canRemove,
  isOwner,
  createPairingCode,
  cancelPairingCode,
  removeDevice,
  renameDevice,
  secondsLeft,
  PairingError,
  cleanDeviceName,
} from '../devices.js';

function fmtDate(ms, lang) {
  if (ms == null) return null;
  try {
    return new Date(ms).toLocaleDateString(lang === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/** Settings → Phones: list, add (pairing code), remove (owner only), rename/leave (self). */
export default function DevicesCard({ fb, farm, farmId, uid, online, now: nowProp }) {
  const { t, lang } = useLang();
  const [pairing, setPairing] = useState(null); // { code, createdAtMs }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [tick, setTick] = useState(Date.now());
  const [renaming, setRenaming] = useState(false);
  const devices = listDevices(farm);
  const owner = isOwner(farm, uid);
  const me = farm && farm.devices ? farm.devices[uid] : null;
  const [newName, setNewName] = useState(me ? me.name : '');

  useEffect(() => {
    if (!pairing) return undefined;
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, [pairing]);

  const now = nowProp ?? tick;
  // A code is "used" once a device whose entry carries it shows up in the farm doc.
  const usedBy = pairing ? devices.find((d) => d.code === pairing.code) : null;
  const left = pairing ? secondsLeft({ createdAt: pairing.createdAtMs }, now) : 0;

  const addPhone = async () => {
    setErr('');
    setBusy(true);
    try {
      if (pairing && !usedBy) cancelPairingCode(fb, pairing.code);
      const code = await createPairingCode(fb, farmId, uid);
      setPairing({ code, createdAtMs: Date.now() });
      setTick(Date.now());
    } catch (e) {
      console.error(e);
      setErr(t(e instanceof PairingError && e.reason === 'network' ? 'errNetwork' : 'codeFailed'));
    } finally {
      setBusy(false);
    }
  };

  const closeCode = () => {
    if (pairing && !usedBy && left > 0) cancelPairingCode(fb, pairing.code);
    setPairing(null);
  };

  const remove = (d) => {
    const self = d.uid === uid;
    if (!window.confirm(t(self ? 'confirmLeave' : 'confirmRemoveDevice') + `\n\n${d.name}`)) return;
    removeDevice(fb, farmId, d.uid).catch((e) => {
      console.error(e);
      setErr(t('errDenied'));
    });
  };

  const saveName = (e) => {
    e.preventDefault();
    // A blank name keeps the form open with the error; a good name clears any old error.
    if (!cleanDeviceName(newName)) return setErr(t('errInvalidName'));
    setErr('');
    renameDevice(fb, farmId, uid, newName).catch(() => setErr(t('errInvalidName')));
    setRenaming(false);
  };

  return (
    <div className="card devices" data-testid="devices">
      <h2>{t('devicesTitle')}</h2>
      <p className="muted small">{t('devicesHint')}</p>
      <ul className="device-list">
        {devices.map((d) => (
          <li key={d.uid} className="device-row" data-testid="device-row">
            <div className="device-info">
              <b>📱 {d.name}</b>
              <div className="small muted">
                {d.isOwner && <span className="badge">{t('ownerBadge')}</span>}
                {d.uid === uid && <span className="badge me">{t('thisPhone')}</span>}
                {t('addedOn')}: {fmtDate(d.addedAtMs, lang) || t('unknownDate')}
              </div>
            </div>
            {owner && canRemove(farm, uid, d.uid) && d.uid !== uid && (
              <button type="button" className="btn small danger" onClick={() => remove(d)} disabled={!online}>
                {t('removeDevice')}
              </button>
            )}
          </li>
        ))}
      </ul>

      {renaming ? (
        <form className="rename" onSubmit={saveName}>
          <label>
            {t('deviceName')}
            <input value={newName} maxLength={40} onChange={(e) => setNewName(e.target.value)} />
          </label>
          <div className="chips">
            <button type="button" className="btn small" onClick={() => { setErr(''); setRenaming(false); }}>
              {t('cancel')}
            </button>
            <button type="submit" className="btn small primary">
              {t('save')}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="btn small ghost" onClick={() => { setNewName(me ? me.name : ''); setRenaming(true); }}>
          ✏️ {t('rename')}
        </button>
      )}

      {pairing ? (
        <div className="pairing" data-testid="pairing">
          {usedBy ? (
            <p className="ok">
              {t('codeUsed')} — {usedBy.name}
            </p>
          ) : left > 0 ? (
            <>
              <p className="small">{t('codeTitle')}</p>
              <div className="code-big" data-testid="pairing-code">
                {pairing.code.slice(0, 3)} {pairing.code.slice(3)}
              </div>
              <p className="small">
                {t('codeExpiresIn')}: <b>{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</b>
              </p>
              <p className="muted small">{t('codeSteps')}</p>
            </>
          ) : (
            <p className="error">{t('codeExpired')}</p>
          )}
          <div className="chips">
            <button type="button" className="btn small" onClick={closeCode}>
              {t('close')}
            </button>
            <button type="button" className="btn small primary" onClick={addPhone} disabled={busy || !online}>
              {t('newCode')}
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn primary big" onClick={addPhone} disabled={busy || !online}>
          {busy ? t('loading') : '➕ ' + t('addPhone')}
        </button>
      )}
      {!online && <p className="muted small">{t('joinNeedsInternet')}</p>}
      {err && <p className="error" role="alert">{err}</p>}

      {!owner && me && (
        <button type="button" className="btn danger big leave" onClick={() => remove({ uid, name: me.name })}>
          {t('leaveFarm')}
        </button>
      )}
    </div>
  );
}
