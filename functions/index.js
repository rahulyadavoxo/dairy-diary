// Optional Blaze version (Cloud Scheduler). The free GitHub Actions cron (.github/workflows/
// autobill.yml + cron.mjs) does the same job; deploy this only if the project moves to Blaze,
// and then turn the GitHub cron off so the two don't race.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { runAll } from './runner.js';

initializeApp();
export const autoBillTick = onSchedule(
  { schedule: 'every 15 minutes', timeZone: 'Asia/Kolkata', region: 'asia-south1', timeoutSeconds: 540, memory: '512MiB' },
  async () => runAll(getFirestore(), { deadline: Date.now() + 480 * 1000, fieldDelete: () => FieldValue.delete() }),
);
