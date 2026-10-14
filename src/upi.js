// UPI collect QR: the customer scans it with any UPI app (GPay, PhonePe, Paytm, BHIM)
// and the amount + dairy's UPI ID are pre-filled. Money goes straight to the owner's account.
import qrcode from 'qrcode-generator';

/** "name@bank" style VPA. Returns the trimmed ID or null. */
export function validUpiId(id) {
  const s = String(id || '').trim();
  return /^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9.-]{1,63}$/.test(s) ? s : null;
}

/** upi://pay deep link (NPCI spec). amountPaise must be > 0. */
export function upiLink({ upiId, payeeName, amountPaise, note }) {
  const pa = validUpiId(upiId);
  if (!pa || !(amountPaise > 0)) return null;
  const q = [
    ['pa', pa],
    ['pn', (payeeName || 'Dairy').slice(0, 50)],
    ['am', (amountPaise / 100).toFixed(2)],
    ['cu', 'INR'],
  ];
  if (note) q.push(['tn', String(note).slice(0, 60)]);
  return 'upi://pay?' + q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/** PNG/GIF data URL of a QR code for `text`. */
export function qrDataUrl(text, cellSize = 8) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(cellSize, cellSize * 2);
}
