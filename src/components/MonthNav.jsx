import { useLang } from '../i18n.js';
import { addMonths, monthName, todayISO, monthOf } from '../format.js';

/** ◀ month ▶ picker (never past the current month). */
export default function MonthNav({ month, setMonth }) {
  const { t, lang } = useLang();
  const curMonth = monthOf(todayISO());
  const goMonth = (m) => setMonth(m > curMonth ? curMonth : m);
  return (
    <div className="date-nav">
      <button className="btn icon" onClick={() => goMonth(addMonths(month, -1))} aria-label={t('prevMonth')}>
        ◀
      </button>
      <label className="date-pick">
        <span>{monthName(month, lang)}</span>
        <input type="month" value={month} max={curMonth} onChange={(e) => e.target.value && goMonth(e.target.value)} />
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
