// Review & import past register data (October 2026) — DATABASE-centric.
// The customer list comes live from the database (auto-synced). For each
// customer, the transcribed register data is auto-matched (exact → alias →
// fuzzy). Tap a name → see all days (Oct 1-13) in one place → edit → save.
// Nothing is uploaded until the user taps "Save".
import { useMemo, useState, useEffect } from 'react';
import { useLang } from '../i18n.js';
import { saveEntries, deleteEntry } from '../db.js';
import { normaliseEntry } from '../entry.js';
import { sortCustomers } from './RegisterView.jsx';
import { OCT_IMPORT, IMPORT_DATES, parseImportValue } from '../octoberImport.js';
import { dmy, todayISO, addDays } from '../format.js';
import { pushBackHandler } from '../backStack.js';

/** All dates from Oct 1 to today (for review + correction). */
function getReviewDates() {
  const out = [];
  let d = '2026-10-01';
  const today = todayISO();
  while (d <= today) {
    out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

/** Known renames: register name -> app customer name. */
const ALIASES = {
  'Madhu Mishra': 'Madhu Muskan',
  // Spelling differs between the paper register transcription and the customer list.
  'Bhabhi G': 'Bhabi G',
};

/** Find the best transcription name for a database customer. */
function findRegName(regNames, customer) {
  const key = String(customer.name || '').trim().toLowerCase();
  // 1. exact
  let hit = regNames.find((n) => n.toLowerCase() === key);
  if (hit) return hit;
  // 2. alias (register -> app) — only if that register name really exists
  hit = Object.keys(ALIASES).find((rn) => ALIASES[rn].toLowerCase() === key && regNames.includes(rn));
  if (hit) return hit;
  // 3. fuzzy: whole-word containment only, and only when exactly ONE register name matches.
  //    (Plain substring matching mapped e.g. "Ravi" -> "Ravi K Maa" or "Mini" -> "Mini Singh Bagal"
  //    and could import another customer's milk.)
  const words = (x) => ` ${x.toLowerCase().replace(/[^a-z0-9\u0900-\u097f]+/g, ' ').trim()} `;
  const k = words(key);
  const cands = regNames.filter((n) => {
    const rn = words(n);
    return k.includes(rn) || rn.includes(k);
  });
  return cands.length === 1 ? cands[0] : null;
}

/** All transcribed names across all dates. */
function allRegNames() {
  const s = new Set();
  IMPORT_DATES.forEach((d) => Object.keys(OCT_IMPORT[d] || {}).forEach((n) => s.add(n)));
  return [...s];
}

function CustomerDays({ fb, customer, regName, days, settings, displayName, onDone, onSaved }) {
  const { t } = useLang();
  const dates = useMemo(() => getReviewDates(), []);
  const [vals, setVals] = useState(() => {
    const init = {};
    dates.forEach((d) => {
      // Pre-fill: transcription first (Oct 1-13), else app's saved value
      const raw = regName ? (OCT_IMPORT[d] || {})[regName] : undefined;
      const parsed = parseImportValue(raw);
      if (parsed) {
        init[d] = String(parsed.milkL);
      } else {
        const en = days[d] && days[d].entries && days[d].entries[customer.id];
        init[d] = en && !en.skip && (en.milkL || 0) > 0 ? String(en.milkL) : '';
      }
    });
    return init;
  });
  const [flash, setFlash] = useState('');

  const setVal = (d, v) => setVals((p) => ({ ...p, [d]: v }));

  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null); // iso being deleted
  const [deletedDays, setDeletedDays] = useState(new Set()); // locally deleted, listener may lag

  const removeDay = async (d) => {
    if (deleting) return;
    if (!window.confirm(t('confirmDeleteDay').replace('{d}', dmy(d)))) return;
    setDeleting(d);
    try {
      deleteEntry(fb, d, customer.id, displayName); // not awaited: would hang forever offline
      setVals((p) => ({ ...p, [d]: '' }));
      setDeletedDays((s) => new Set(s).add(d));
      setFlash(t('deleted'));
      if (onSaved) onSaved();
    } catch (e) {
      setFlash(t('saveFailed'));
      console.error('[import-delete]', e);
    }
    setDeleting(null);
    setTimeout(() => setFlash(''), 2500);
  };
  const save = async () => {
    const datesToSave = dates.filter((d) => {
      const v = vals[d];
      const n = Number(v);
      return v !== '' && v != null && Number.isFinite(n) && n > 0;
    });
    if (!datesToSave.length || saving) return;
    setSaving(true);
    setFlash(t('saving'));
    try {
      // NOT awaited: saveEntries only resolves when the server confirms, so awaiting it hung on
      // "Saving..." forever while offline. Writes are queued locally and sync later.
      for (const d of datesToSave) {
        const n = Math.round(Number(vals[d]) * 1000) / 1000;
        const prev = (days[d] && days[d].entries && days[d].entries[customer.id]) || null;
        // Unchanged day already in the app: don't rewrite it.
        if (prev && !prev.skip && Number(prev.milkL) === n) continue;
        // Keep the register's morning+evening split when it matches the typed total.
        const parsed = regName ? parseImportValue((OCT_IMPORT[d] || {})[regName]) : null;
        const split = parsed && parsed.milkMorningL != null && parsed.milkL === n
          ? { milkMorningL: parsed.milkMorningL, milkEveningL: parsed.milkEveningL }
          : { milkL: n, milkMorningL: null, milkEveningL: null };
        saveEntries(
          fb,
          d,
          {
            [customer.id]: normaliseEntry(
              customer,
              // keep paneer and note already recorded for that day (they were overwritten with 0 / '')
              { ...split, paneerKg: prev ? prev.paneerKg || 0 : 0, skip: false, note: prev ? prev.note || '' : '' },
              settings,
            ),
          },
          displayName,
        );
      }
      setFlash(t('saved'));
      if (onSaved) onSaved();
    } catch (e) {
      setFlash(t('saveFailed'));
      console.error('[import-save]', e);
    }
    setSaving(false);
    setTimeout(() => setFlash(''), 2500);
  };

  const savedDays = dates.filter((d) => {
    if (deletedDays.has(d)) return false;
    const en = days[d] && days[d].entries && days[d].entries[customer.id];
    return en && !en.skip && (en.milkL || 0) > 0;
  });

  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="btn small ghost" onClick={onDone}>
          ← {t('back')}
        </button>
        <h1>{customer.name}</h1>
        {regName && regName.toLowerCase() !== customer.name.toLowerCase() && (
          <p className="muted small">{t('register')}: {regName}</p>
        )}
        {!regName && <p className="card warn small">{t('noRegisterData')}</p>}
        <p className="muted small">
          {savedDays.length}/{dates.length} {t('daysDone')}
        </p>
      </header>
      <ul className="rows">
        {dates.map((d) => {
          const raw = regName ? (OCT_IMPORT[d] || {})[regName] : undefined;
          const isSaved = savedDays.includes(d);
          return (
            <li key={d} className="row">
              <div className="who" style={{ flex: 1 }}>
                <b>{dmy(d)}</b>
                {raw !== undefined && <span className="muted small"> · {t('register')}: {raw === 'X' ? 'X' : String(raw)}</span>}
                {isSaved && <span className="tag"> ✓</span>}
              </div>
              <input
                className="qty"
                type="number"
                inputMode="decimal"
                step="0.25"
                min="0"
                value={vals[d]}
                onChange={(e) => setVal(d, e.target.value)}
              />
              <span className="unit">{t('litre')}</span>
              {isSaved && (
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => removeDay(d)}
                  disabled={deleting === d}
                  aria-label={t('delete')}
                >
                  {deleting === d ? '…' : '✕'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="savebar">
        <span className="small">{flash}</span>
        <button type="button" className="btn primary big" onClick={save} disabled={saving}>
          {saving ? t('saving') : t('saveAllDays')}
        </button>
      </div>
    </div>
  );
}

export default function ImportReview({ fb, customers, days, settings, displayName, onDone }) {
  const { t } = useLang();
  const [openId, setOpenId] = useState(null);
  const [lastEditedId, setLastEditedId] = useState(null);

  // Hardware back button closes the customer detail overlay first
  useEffect(() => {
    if (!openId) return;
    return pushBackHandler(() => setOpenId(null));
  }, [openId]);

  const regNames = useMemo(() => allRegNames(), []);
  const sorted = useMemo(() => sortCustomers(customers.filter((c) => c.active !== false)), [customers]);

  const rows = useMemo(
    () =>
      sorted.map((c, i) => ({
        customer: c,
        num: i + 1,
        regName: findRegName(regNames, c),
      })),
    [sorted, regNames],
  );

  // Register names with no database customer (not added yet, or deleted)
  const orphanNames = useMemo(() => {
    const used = new Set(rows.map((r) => r.regName).filter(Boolean));
    return regNames.filter((n) => !used.has(n));
  }, [rows, regNames]);

  const doneCount = useMemo(() => {
    const dates = getReviewDates();
    return rows.filter(({ customer }) =>
      dates.every((d) => {
        const en = days[d] && days[d].entries && days[d].entries[customer.id];
        return en && !en.skip && (en.milkL || 0) > 0;
      }),
    ).length;
  }, [rows, days]);

  const openCustomer = openId ? rows.find((r) => r.customer.id === openId) : null;

  return (
    <div className="screen">
      <header className="screen-head">
        <button type="button" className="btn small ghost" onClick={onDone}>
          ← {t('back')}
        </button>
        <h1>{t('importReviewTitle')}</h1>
        <p className="muted small">
          {doneCount}/{rows.length} {t('customersDone')}
        </p>
        <p className="muted small">{t('tapCustomerHint')}</p>
      </header>
      <ul className="rows">
        {rows.map(({ customer, num, regName }) => (
          <li key={customer.id}>
            <button
              type="button"
              className={'card cust-card' + (customer.id === lastEditedId ? ' just-edited' : '')}
              onClick={() => setOpenId(customer.id)}
            >
              <div className="row-top">
                <div className="who">
                  <b>
                    {num}. {customer.name}
                  </b>
                  {customer.id === lastEditedId && <span className="tag edited-tag"> ✓ {t('lastEdited')}</span>}
                  {regName ? (
                    <span className="tag"> ✓ {t('register')}</span>
                  ) : (
                    <span className="tag"> {t('noRegisterData')}</span>
                  )}
                </div>
                <span className="muted">›</span>
              </div>
            </button>
          </li>
        ))}
      </ul>
      {orphanNames.length > 0 && (
        <div className="card warn" style={{ marginTop: '1rem' }}>
          <b className="small">{t('registerOnlyNames')}</b>
          <p className="muted small">{orphanNames.join(', ')}</p>
        </div>
      )}
      {/* Customer detail as overlay — list stays mounted, scroll position kept */}
      {openCustomer && (
        <div className="full-overlay">
          <CustomerDays
            fb={fb}
            customer={openCustomer.customer}
            regName={openCustomer.regName}
            days={days}
            settings={settings}
            displayName={displayName}
            onDone={() => setOpenId(null)}
            onSaved={() => setLastEditedId(openCustomer.customer.id)}
          />
        </div>
      )}
    </div>
  );
}
