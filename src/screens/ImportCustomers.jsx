// Bulk import customers: textarea (pre-filled with the September list),
// one tap adds them all in route order. Skips names already in the app.
import { useMemo, useState } from 'react';
import { useLang } from '../i18n.js';
import { saveCustomer } from '../db.js';
import { DEFAULT_IMPORT_LIST, parseImportList } from '../importList.js';

export default function ImportCustomers({ fb, customers, onDone }) {
  const { t } = useLang();
  const [text, setText] = useState(DEFAULT_IMPORT_LIST);
  const [done, setDone] = useState(null);

  const existing = useMemo(() => new Set(customers.map((c) => String(c.name || '').trim().toLowerCase())), [customers]);
  const parsed = useMemo(() => parseImportList(text), [text]);
  const fresh = useMemo(() => parsed.filter((p) => !existing.has(p.name.toLowerCase())), [parsed, existing]);

  const doImport = () => {
    const base = customers.length;
    fresh.forEach((p, i) => {
      saveCustomer(fb, null, {
        name: p.name,
        phone: '',
        area: '',
        usualMorningL: p.morningL,
        usualEveningL: p.eveningL,
        usualL: Math.round((p.morningL + p.eveningL) * 1000) / 1000,
        rateOverridePaise: null,
        openingDuePaise: 0,
        pauseFrom: '',
        pauseTo: '',
        active: true,
        order: (base + i + 1) * 10,
      });
    });
    setDone({ added: fresh.length, skipped: parsed.length - fresh.length });
  };

  if (done) {
    return (
      <div className="screen">
        <div className="center-screen">
          <h2>✓ {done.added} {t('importAdded')}</h2>
          {done.skipped > 0 && <p className="muted small">{done.skipped} {t('importSkipped')}</p>}
          <button type="button" className="btn primary big" onClick={onDone}>
            {t('waDone')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen form">
      <header className="screen-head">
        <button type="button" className="btn small ghost" onClick={onDone}>
          ← {t('back')}
        </button>
        <h1>{t('importTitle')}</h1>
        <p className="muted small">{t('importHint')}</p>
      </header>
      <textarea
        className="import-box"
        rows={14}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('importPlaceholder')}
      />
      <p className="small">
        {parsed.length} {t('importNames')} · {fresh.length} {t('importNew')}
      </p>
      <button type="button" className="btn primary big" disabled={fresh.length === 0} onClick={doImport}>
        + {t('importAdd')} ({fresh.length})
      </button>
    </div>
  );
}
