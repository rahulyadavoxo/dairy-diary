import { useLang } from '../i18n.js';
import { addMonths, monthName, todayISO, monthOf } from '../format.js';

/** ◀ month ▶ picker (never past the current month, never before minMonth = first delivery month). */
export default function MonthNav({ month, setMonth, minMonth }) {
  const { t, lang } = useLang();
  const curMonth = monthOf(todayISO());
  const lo = minMonth && minMonth <= curMonth ? minMonth : null;
  const goMonth = (m) => setMonth(m > curMonth ? curMonth : lo && m < lo ? lo : m);
  return (
    <div className="date-nav">
      <button
        className="btn icon"
        disabled={!!lo && month <= lo}
        onClick={() => goMonth(addMonths(month, -1))}
        aria-label={t('prevMonth')}
      >
        ◀
      </button>
      <label className="date-pick">
        <span>{monthName(month, lang)}</span>
        <input type="month" value={month} min={lo || undefined} max={curMonth} onChange={(e) => e.target.value && goMonth(e.target.value)} />
      </label>
      <button
        className="btn icon"
        disabled={month === curMonth}
        onClick={() => {
          const n = addMonths(month, 1);
          if (n <= curMonth) setMonth(n);
        }}
        aria-label={t('nextMonth')}
      >
        ▶
      </button>
    </div>
  );
}
