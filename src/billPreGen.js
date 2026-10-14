// Background bill-photo pre-generation.
// After the month's hisaab is computed, this quietly renders each customer's
// bill PNG and stores it in the on-phone cache (IndexedDB), so that sharing
// later sends the saved image directly instead of rendering on the fly.
// Runs one at a time with pauses to avoid blocking the UI.
import { renderBillImage } from './billImage.js';
import { getCachedPhoto, putCachedPhoto } from './billCache.js';

let running = false;

export function preGenerateBillPhotos(rows, month, settings) {
  if (running) return;
  running = true;
  const queue = rows.filter((r) => r.hasActivity || r.balancePaise !== 0);
  let i = 0;

  const step = async () => {
    if (i >= queue.length) {
      running = false;
      return;
    }
    const r = queue[i++];
    try {
      const cached = await getCachedPhoto(r.customerId, month);
      if (!cached) {
        const blob = await renderBillImage(r, month, settings);
        await putCachedPhoto(r.customerId, month, blob);
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
