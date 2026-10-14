// PIN check before a sensitive change (Settings rates / UPI, adding or removing a phone).
// Uses the same Hisaab PIN as "Lock hisaab amounts" and customer Deactivate. With no PIN set on
// this phone it falls back to a plain confirm, like Deactivate does.
//
//   const gate = usePinGate();
//   gate.ask(t('pinForRates'), () => doIt());   ...   {gate.element}
import { useEffect, useState } from 'react';
import { useLang } from '../i18n.js';
import { getPinHash, verifyPin, pinWaitSeconds } from '../pinLock.js';
import { pushBackHandler } from '../backStack.js';
import { saveFeedback } from '../feedback.js';

export function usePinGate() {
  const { t } = useLang();
  const [req, setReq] = useState(null); // { title, onOk }
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => (req ? pushBackHandler(() => setReq(null)) : undefined), [req]);

  const ask = (title, onOk) => {
    if (!getPinHash()) {
      if (window.confirm(title + '\n\n' + t('pinGateNoPin'))) onOk();
      return;
    }
    setPin('');
    setErr('');
    setReq({ title, onOk });
  };

  const submit = async () => {
    const w0 = pinWaitSeconds();
    if (w0 > 0) return setErr(t('pinWait').replace('{s}', w0));
    const ok = await verifyPin(pin.trim());
    if (!ok) {
      saveFeedback(false);
      const w = pinWaitSeconds();
      setErr(w > 0 ? t('pinWait').replace('{s}', w) : t('pinWrong'));
      return;
    }
    const r = req;
    setReq(null);
    r.onOk();
  };

  const element = req ? (
    <div className="modal-backdrop" onClick={() => setReq(null)}>
      <div className="modal pin-card" data-testid="pin-gate" onClick={(e) => e.stopPropagation()}>
        <p>
          <b>🔒 {req.title}</b>
        </p>
        <div className="form-inline">
          <input
            type="password"
            inputMode="numeric"
            placeholder={t('pinEnter')}
            aria-label={t('pinEnter')}
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            maxLength={12}
            autoFocus
          />
          <button type="button" className="btn small primary" onClick={submit}>
            {t('pinGateOk')}
          </button>
          <button type="button" className="btn small ghost" onClick={() => setReq(null)} aria-label={t('cancel')}>
            ✕
          </button>
        </div>
        {err && <p className="error small">{err}</p>}
      </div>
    </div>
  ) : null;

  return { ask, element };
}
