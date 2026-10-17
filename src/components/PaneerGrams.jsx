// Paneer quantity in grams (user, 15 Oct 2026): − / + move by 100 g, the box stays editable for
// any amount. Data is still stored as paneerKg (rates are per kg), so value/onChange are in kg.
import { useEffect, useState } from 'react';
import { useLang } from '../i18n.js';
import { toMilli } from '../billing.js';

export const PANEER_STEP_G = 100;
export const kgToG = (kg) => Math.max(0, toMilli(kg));
export const gToKg = (g) => Math.max(0, Math.round(Number(g) || 0)) / 1000;

export default function PaneerGrams({ value, onChange, label, testId, className = 'deli-qty' }) {
  const { t } = useLang();
  const g = kgToG(value);
  // keep what is being typed (e.g. an empty box) without snapping back to 0 mid-edit
  const [text, setText] = useState(g ? String(g) : '');
  useEffect(() => {
    if (toMilli(gToKg(text)) !== g) setText(g ? String(g) : '');
  }, [g]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (ng) => {
    const v = Math.max(0, ng);
    setText(v ? String(v) : '');
    onChange(gToKg(v));
  };
  return (
    // <div>, not <label>: a tap beside the stepper must not press its − button
    <div className={className + ' lbl'} data-testid={testId}>
      <span>{label != null ? label : t('paneer')}</span>
      <div className="stepper">
        <button type="button" className="btn step" aria-label="−100" onClick={() => set(Math.floor((g - 1) / PANEER_STEP_G) * PANEER_STEP_G)}>
          −
        </button>
        <input
          className="qty paneer-g"
          type="number"
          inputMode="numeric"
          step={PANEER_STEP_G}
          min="0"
          placeholder="0"
          aria-label={typeof label === 'string' ? label : t('paneer')}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            onChange(gToKg(e.target.value));
          }}
        />
        <span className="unit">{t('gram')}</span>
        <button type="button" className="btn step" aria-label="+100" onClick={() => set(Math.floor(g / PANEER_STEP_G) * PANEER_STEP_G + PANEER_STEP_G)}>
          +
        </button>
      </div>
    </div>
  );
}
