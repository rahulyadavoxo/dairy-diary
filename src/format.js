// Formatting helpers: Indian number format, ₹, dd-mm-yyyy dates.
// Internally dates are ISO strings 'yyyy-mm-dd' and months 'yyyy-mm'.

const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qty = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 });

/** paise (integer) -> "₹1,23,456" or "₹1,23,456.50" */
export function rupees(paise) {
  const p = Math.round(Number(paise) || 0);
  const neg = p < 0;
  const abs = Math.abs(p);
  const whole = abs % 100 === 0;
  const s = whole ? inr0.format(abs / 100) : inr2.format(abs / 100);
  return (neg ? '-₹' : '₹') + s;
}

/** rupee input string/number -> integer paise. "60" -> 6000, "60.5" -> 6050 */
export function toPaise(rupeeValue) {
  if (rupeeValue === '' || rupeeValue === null || rupeeValue === undefined) return null;
  const n = Number(String(rupeeValue).replace(/[,₹\s]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** paise -> plain rupee string for inputs ("60" or "60.5") */
export function paiseToInput(paise) {
  if (paise === null || paise === undefined || paise === '') return '';
  return String(Math.round(paise) / 100);
}

export function fmtQty(n) {
  return qty.format(Number(n) || 0);
}

export function pad(n) {
  return String(n).padStart(2, '0');
}

/** Date -> 'yyyy-mm-dd' using LOCAL time (phones are in IST). */
export function isoDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayISO() {
  return isoDate(new Date());
}

export function monthOf(iso) {
  return iso.slice(0, 7);
}

/** 'yyyy-mm-dd' -> 'dd-mm-yyyy' */
/** Full date for the screen: "15 October 2026" (Hindi: "15 अक्टूबर 2026"). */
export function dmy(iso, lang = 'en') {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  return `${d} ${(MONTHS[lang] || MONTHS.en)[m - 1]} ${y}`;
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return isoDate(dt);
}

export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(y, m - 1 + n, 1);
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
}

export function daysInMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

export function monthDates(ym) {
  const n = daysInMonth(ym);
  return Array.from({ length: n }, (_, i) => `${ym}-${pad(i + 1)}`);
}

/** weekday index (0=Sun) of the 1st of the month */
export function firstWeekday(ym) {
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).getDay();
}

export const MONTHS = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  hi: ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'],
};

export function monthName(ym, lang = 'en') {
  const [y, m] = ym.split('-').map(Number);
  return `${(MONTHS[lang] || MONTHS.en)[m - 1]} ${y}`;
}

/** Weekday letters, Sunday first (index = Date#getDay()). */
export const WEEK = { hi: ['र', 'सो', 'मं', 'बु', 'गु', 'शु', 'श'], en: ['S', 'M', 'T', 'W', 'T', 'F', 'S'] };

/** Weekday letters, Monday first — every calendar in the app (and the bill photo) is Monday-first. */
export function weekdaysMonFirst(lang = 'en') {
  const w = WEEK[lang] || WEEK.en;
  return [...w.slice(1), w[0]];
}

/** Blank cells before the 1st in a Monday-first month grid. */
export function mondayOffset(ym) {
  return (firstWeekday(ym) + 6) % 7;
}

const SHORT_MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "14 Oct" / "14 अक्टूबर" */
export function shortDate(iso, lang = 'en') {
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${lang === 'hi' ? MONTHS.hi[m - 1] : SHORT_MONTHS_EN[m - 1]}`;
}

export function timeHM(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Normalise an Indian phone number for wa.me (adds 91 for 10-digit numbers). */
export function waNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 11 && digits.startsWith('0')) return '91' + digits.slice(1);
  return digits;
}
