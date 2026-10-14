// Guided WhatsApp bill sending (free flow).
// On the 1st of a month, bills for the previous month are ready. This screen
// walks through every customer that has a phone number: it opens their WhatsApp
// chat with the bill text prefilled, the user presses Send, then moves to the
// next customer. Progress survives app restarts (localStorage).
import { useEffect, useMemo, useState } from 'react';
import { useLang } from '../i18n.js';
import { computeMonth } from '../billing.js';
import { billText, waLink } from '../bill.js';
import { renderBillImage, shareImage, billFileName } from '../billImage.js';
import { saveSettings } from '../db.js';
import { addMonths, monthOf, todayISO, monthName, rupees } from '../format.js';

const PROG_KEY = 'dd_wa_progress';

export function shouldPromptBills(settings) {
  return todayISO().slice(8, 10) === '01' && settings.billsSentForMonth !== monthOf(todayISO());
}

export default function BillSender({ fb, customers, days, payments, settings, onClose }) {
  const { t, lang } = useLang();
  const billMonth = addMonths(monthOf(todayISO()), -1);
  const res = useMemo(
    () => computeMonth({ customers, days, payments, settings, month: billMonth }),
    [customers, days, payments, settings, billMonth],
  );
  const targets = useMemo(
    () =>
      res.rows.filter(
        (r) => r.customer.phone && r.customer.active !== false && (r.balancePaise !== 0 || r.hasActivity),
      ),
    [res],
  );
  const [idx, setIdx] = useState(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PROG_KEY));
      if (p && p.month === billMonth && Number.isInteger(p.idx)) return Math.min(p.idx, Math.max(0, targets.length - 1));
    } catch {
      /* ignore */
    }
    return 0;
  });
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(PROG_KEY, JSON.stringify({ month: billMonth, idx }));
    } catch {
      /* ignore */
    }
  }, [idx, billMonth]);

  const finish = () => {
    saveSettings(fb, { billsSentForMonth: monthOf(todayISO()) });
    try {
      localStorage.removeItem(PROG_KEY);
    } catch {
      /* ignore */
    }
    onClose();
  };

  if (targets.length === 0) {
    return (
      <div className="screen">
        <header className="screen-head">
          <button type="button" className="btn small ghost" onClick={onClose}>
            ← {t('back')}
          </button>
          <h1>{t('waBillsTitle')}</h1>
        </header>
        <p className="empty">{t('noActivity')}</p>
      </div>
    );
  }

  if (idx >= targets.length) {
    return (
      <div className="screen">
        <div className="center-screen">
          <h2>{t('waAllSent')}</h2>
          <button type="button" className="btn primary big" onClick={finish}>
            {t('waDone')}
          </button>
        </div>
      </div>
    );
  }

  const row = targets[idx];
  const text = billText(row, billMonth, settings);
  const [imgUrl, setImgUrl] = useState(null);
  const [imgBlob, setImgBlob] = useState(null);
  const [imgErr, setImgErr] = useState('');

  // Render the bill image (with calendar) for preview
  useEffect(() => {
    let live = true;
    setImgUrl(null);
    setImgBlob(null);
    setImgErr('');
    renderBillImage(row, billMonth, settings).then(
      (blob) => {
        if (!live) return;
        setImgBlob(blob);
        setImgUrl(URL.createObjectURL(blob));
      },
      (e) => {
        if (!live) return;
        console.error('[bill-render]', e);
        setImgErr(t('shareFailed'));
      },
    );
    return () => {
      live = false;
    };
  }, [idx]);

  const sharePhoto = async () => {
    if (!imgBlob) return;
    try {
      await shareImage(imgBlob, billFileName(row.customer.name, billMonth));
      setOpened(true);
    } catch (e) {
      console.error('[share-bill]', e);
    }
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="btn small ghost" onClick={onClose}>
          ← {t('back')}
        </button>
        <h1>
          {t('waBillsTitle')} <span className="muted small">({idx + 1}/{targets.length})</span>
        </h1>
        <p className="muted small">
          {monthName(billMonth, lang)} · {t('sendBills')}
        </p>
      </header>
      <div className="card">
        <h2>
          {row.customer.name}
          <span className="muted small"> · {row.customer.phone}</span>
        </h2>
        <p>
          <b className={row.balancePaise > 0 ? 'due' : 'clear'}>{rupees(row.balancePaise)}</b>
        </p>
        {imgUrl ? (
          <img src={imgUrl} alt={row.customer.name} className="bill-preview-img" />
        ) : imgErr ? (
          <p className="err small">{imgErr}</p>
        ) : (
          <p className="muted small">{t('loading')}</p>
        )}
        {!opened ? (
          <>
            <button
              type="button"
              className="btn whatsapp big"
              onClick={sharePhoto}
              disabled={!imgBlob}
            >
              📤 {t('waSharePhoto')}
            </button>
            <p className="muted small" style={{ marginTop: '0.5rem' }}>{t('waSharePhotoHint')}</p>
            <button
              type="button"
              className="btn small ghost"
              onClick={() => {
                window.location.href = waLink(row.customer.phone, text);
                setOpened(true);
              }}
              style={{ marginTop: '0.5rem' }}
            >
              {t('waOpenChatText')}
            </button>
          </>
        ) : (
          <button type="button" className="btn primary big" onClick={() => { setOpened(false); setIdx((i) => i + 1); }}>
            ✓ {t('waNext')}
          </button>
        )}
      </div>
    </div>
  );
}
