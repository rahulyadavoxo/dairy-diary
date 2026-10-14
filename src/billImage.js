// Render a customer's monthly bill as a PNG image (canvas 2D).
// Design: header + month calendar (date-wise milk) + structured summary + footer.
import { fmtQty, monthName, rupees, todayISO, weekdaysMonFirst } from './format.js';

const W = 1080;
const CELL_H = 104;
const GREEN = '#1f6f43';
const GREEN_DARK = '#14532d';
const GREEN_LIGHT = '#e8f5e9';
const INK = '#1a1a1a';
const MUTED = '#6b7280';
const RED = '#c0392b';

function line(g, x1, y1, x2, y2, color = '#e5e7eb', w = 2) {
  g.strokeStyle = color;
  g.lineWidth = w;
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
}

function text(g, s, x, y, { size = 40, color = INK, bold = false, align = 'left' } = {}) {
  g.fillStyle = color;
  g.font = `${bold ? '700' : '400'} ${size}px sans-serif`;
  g.textAlign = align;
  g.fillText(s, x, y);
}

/** Shorten s with "…" until it is at most maxW pixels wide in the current font. */
export function fitText(g, s, maxW) {
  const str = String(s || '');
  if (!(maxW > 0) || g.measureText(str).width <= maxW) return str;
  const chars = Array.from(str);
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (g.measureText(chars.slice(0, mid).join('').trimEnd() + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join('').trimEnd() + '…';
}

const fontOf = (size, bold) => `${bold ? '700' : '400'} ${size}px sans-serif`;

/** Height the bill needs: no big empty band at the bottom (it was a fixed 1920 px). */
export function billHeight(row, month) {
  const [yy, mm] = month.split('-').map(Number);
  const firstDay = (new Date(yy, mm - 1, 1).getDay() + 6) % 7;
  const weeks = Math.ceil((firstDay + new Date(yy, mm, 0).getDate()) / 7);
  let sumRows = 2; // milk + this month
  if (row.paneerG > 0 || row.paneerPaise > 0) sumRows++;
  if (row.previousDuePaise !== 0) sumRows++;
  if (row.paidPaise !== 0) sumRows++;
  // header 200 + calendar title/weekdays 115 + weeks + gap 35 + summary title 60 + rows + balance + footer
  return 200 + 115 + weeks * CELL_H + 35 + 60 + sumRows * 68 + 16 + 60 + 170;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Draw the bill with a hard timeout; resolves with a PNG Blob. */
export function renderBillImage(row, month, settings = {}) {
  const render = new Promise((resolve, reject) => {
    try {
      const H = billHeight(row, month);
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      if (!g) throw new Error('no 2d context');
      const cu = row.customer;
      const farm = settings.farmName || 'Dairy Diary';
      const daily = row.daily || {};

    // background
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, W, H);

    // ===== header bar =====
    g.fillStyle = GREEN;
    g.fillRect(0, 0, W, 200);
    // Long names are shortened with "…" so they never run under the month or off the image.
    g.font = fontOf(54, true);
    text(g, fitText(g, '🥛 ' + farm, W - 120), 60, 90, { size: 54, color: '#fff', bold: true });
    const monthTxt = `${monthName(month, 'hi')} / ${monthName(month, 'en')}`;
    g.font = fontOf(32, false);
    const monthW = g.measureText(monthTxt).width;
    text(g, monthTxt, W - 60, 150, { size: 32, color: '#c8e6c9', align: 'right' });
    g.font = fontOf(38, true);
    text(g, fitText(g, cu.name, W - 120 - monthW - 30), 60, 150, { size: 38, color: '#fff', bold: true });

    let y = 265;

    // ===== calendar =====
    text(g, '📅 दिन-वार हिसाब / Daily record', 60, y, { size: 36, bold: true, color: GREEN_DARK });
    y += 25;

    const [yy, mm] = month.split('-').map(Number);
    const firstDay = (new Date(yy, mm - 1, 1).getDay() + 6) % 7; // Monday-first
    const daysInMonth = new Date(yy, mm, 0).getDate();
    const cols = 7;
    const cellW = (W - 120) / cols;
    const cellH = CELL_H;
    const wdHi = weekdaysMonFirst('hi');
    const wdEn = weekdaysMonFirst('en');
    const todayStr = todayISO(); // local (IST) date, not UTC

    // weekday header (Hindi / English, like the rest of the bill)
    for (let i = 0; i < cols; i++) {
      const cx = 60 + i * cellW;
      text(g, `${wdHi[i]} / ${wdEn[i]}`, cx + cellW / 2, y + 28, { size: 24, color: MUTED, bold: true, align: 'center' });
    }
    y += 48;

    let d = 1;
    const startY = y;
    const weeks = Math.ceil((firstDay + daysInMonth) / 7);
    for (let week = 0; week < 6 && d <= daysInMonth; week++) {
      for (let col = 0; col < cols; col++) {
        if (d > daysInMonth) break;
        if (week === 0 && col < firstDay) continue;
        const iso = `${yy}-${String(mm).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const cx = 60 + col * cellW;
        const cy = startY + week * cellH;
        const info = daily[iso];
        const hasMilk = info && !info.skip && (info.milkMl || 0) > 0;
        const isGap = info && iso <= todayStr && !hasMilk;

        // cell bg
        g.fillStyle = hasMilk ? GREEN_LIGHT : '#fafafa';
        roundRect(g, cx + 4, cy + 4, cellW - 8, cellH - 8, 12);
        g.fill();
        if (hasMilk) {
          g.strokeStyle = GREEN;
          g.lineWidth = 2;
          roundRect(g, cx + 4, cy + 4, cellW - 8, cellH - 8, 12);
          g.stroke();
        }

        text(g, String(d), cx + cellW / 2, cy + 38, { size: 26, color: MUTED, align: 'center' });
        if (hasMilk) {
          text(g, fmtQty(info.milkMl / 1000), cx + cellW / 2, cy + 72, {
            size: 30, bold: true, color: GREEN_DARK, align: 'center',
          });
        } else if (isGap) {
          text(g, '✕', cx + cellW / 2, cy + 72, { size: 28, bold: true, color: RED, align: 'center' });
        }
        d++;
      }
    }
    y = startY + weeks * cellH + 35;

    // ===== summary =====
    text(g, '🧾 हिसाब / Summary', 60, y, { size: 36, bold: true, color: GREEN_DARK });
    y += 60;

    const srow = (label, value, opts = {}) => {
      text(g, label, 60, y, { size: 36, color: opts.dim ? MUTED : INK });
      text(g, value, W - 60, y, { size: 36, bold: !!opts.bold, align: 'right', color: opts.color || INK });
      y += 68;
    };

    const rates = [...(row.milkRates || [])];
    const rateTxt = rates.length === 1 ? ` × ${rupees(rates[0])}` : '';
    srow(`दूध / Milk  ${fmtQty(row.milkMl / 1000)} L${rateTxt}`, rupees(row.milkPaise));
    if (row.paneerG > 0 || row.paneerPaise > 0) {
      srow(`पनीर / Paneer  ${fmtQty(row.paneerG / 1000)} kg`, rupees(row.paneerPaise));
    }
    // separators sit midway between two rows (y - 30 touched the next row's text)
    line(g, 60, y - 46, W - 60, y - 46);
    srow('इस महीने / This month', rupees(row.billedPaise), { bold: true });
    if (row.previousDuePaise !== 0) srow('पिछला बाकी / Previous', rupees(row.previousDuePaise), { dim: true });
    if (row.paidPaise !== 0) srow('जमा / Paid', rupees(row.paidPaise), { dim: true });
    line(g, 60, y - 46, W - 60, y - 46, GREEN, 4);
    y += 16;
    if (row.balancePaise >= 0) {
      text(g, 'कुल बाकी / Balance', 60, y, { size: 44, bold: true, color: GREEN });
      text(g, rupees(row.balancePaise), W - 60, y, { size: 44, bold: true, align: 'right', color: GREEN });
    } else {
      text(g, 'एडवांस / Advance', 60, y, { size: 44, bold: true, color: GREEN });
      text(g, rupees(-row.balancePaise), W - 60, y, { size: 44, bold: true, align: 'right', color: GREEN });
    }

    // ===== footer =====
    y = H - 100;
    line(g, 60, y - 45, W - 60, y - 45);
    text(g, 'धन्यवाद / Thank you 🙏', 60, y, { size: 34, color: MUTED });
    if (settings.phone) {
      g.font = fontOf(30, false);
      text(g, fitText(g, `${farm}: ${settings.phone}`, W - 120 - 420), W - 60, y, { size: 30, align: 'right', color: MUTED });
    }

    // Safety: toBlob can hang forever in some WebViews — time out after 15s.
    // (Declared BEFORE toBlob so a synchronous callback can never hit the TDZ.)
    const timer = setTimeout(() => reject(new Error('toBlob timeout')), 15000);
    c.toBlob(
      (blob) => {
        clearTimeout(timer);
        if (blob) resolve(blob);
        else reject(new Error('toBlob failed'));
      },
      'image/png',
    );
    } catch (e) {
      reject(e);
    }
  });
  // Hard timeout: never hang longer than 20s total (timer cleared once the race settles)
  let hard;
  const timeout = new Promise((_, reject) => {
    hard = setTimeout(() => reject(new Error('render timeout')), 20000);
  });
  return Promise.race([render, timeout]).finally(() => clearTimeout(hard));
}

/** Everything the bill image shows; used as the photo-cache fingerprint. */
export function billFingerprint(row, settings = {}) {
  if (!row) return '';
  return JSON.stringify([
    row.customer && row.customer.name,
    row.milkMl, row.milkPaise, row.paneerG, row.paneerPaise,
    row.billedPaise, row.previousDuePaise, row.paidPaise, row.balancePaise,
    [...(row.milkRates || [])].sort(),
    row.daily || {},
    settings.farmName || '', settings.phone || '',
    todayISO(), // the ✕ "gap" marks depend on today's date
  ]);
}

/** Share a PNG blob via the system share sheet, falling back to a download. */
export async function shareImage(blob, filename) {
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({ files: [file], title: filename });
    return 'shared';
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return 'downloaded';
}

export function billFileName(customerName, month) {
  const safe = String(customerName || 'bill').replace(/[^\w\u0900-\u097F-]+/g, '_').slice(0, 40);
  return `bill-${month}-${safe}.png`;
}
