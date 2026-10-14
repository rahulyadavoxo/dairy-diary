// Background bill-photo pre-generation.
// After the month's hisaab is computed, this quietly renders each customer's
// bill PNG and stores it in the on-phone cache (IndexedDB), so that sharing
// later sends the saved image directly instead of rendering on the fly.
// Runs one at a time with pauses to avoid blocking the UI.
import { renderBillImage, billFingerprint } from './billImage.js';
import { getCachedPhoto, putCachedPhoto } from './billCache.js';

let runId = 0;

export function preGenerateBillPhotos(rows, month, settings) {
  // A newer call (other month / fresh data) cancels the older run instead of being ignored.
  const myRun = ++runId;
  const queue = rows.filter((r) => r.hasActivity || r.balancePaise !== 0);
  let i = 0;

  const step = async () => {
    if (myRun !== runId || i >= queue.length) return;
    const r = queue[i++];
    try {
      const fp = billFingerprint(r, settings);
      const cached = await getCachedPhoto(r.customerId, month, fp);
      if (!cached && myRun === runId) {
        const blob = await renderBillImage(r, month, settings);
        await putCachedPhoto(r.customerId, month, blob, fp);
      }
    } catch {
      /* skip failures — on-demand generation remains as fallback */
    }
    // pause between renders to keep the UI smooth
    setTimeout(step, 1500);
  };
  // start after a short delay so the screen paints first
  setTimeout(step, 3000);
}
