// GitHub Actions cron entry (free, no Blaze): node functions/cron.mjs
// Needs GOOGLE_APPLICATION_CREDENTIALS = Firebase service-account JSON (repo secret).
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { runAll } from './runner.js';

initializeApp({ projectId: 'project-c9157c64-e3e6-4b08-89f' });
// The repo is public, so Actions logs are public: print counts only (no farm ids, numbers, errors).
const r = await runAll(getFirestore(), { deadline: Date.now() + 8 * 60 * 1000, log: () => {}, fieldDelete: () => FieldValue.delete() });
console.log(`dairies connected: ${r.checked}, sending runs: ${r.sentRuns}`);
