# Dairy Diary (डेयरी डायरी)

Android app for a family dairy: nightly milk/paneer register, customers in route order,
monthly hisaab with carry-forward, payments (cash/UPI) and WhatsApp bills.
One dairy farm account; only phones the owner has authorized can open it (device pairing with a
6-digit code). All phones share the same data through Firebase; everything works offline and syncs later.

- Package id: `in.dairydiary.app` · App name: Dairy Diary
- Stack: React 19 + Vite 7 + Capacitor 8 (Android, minSdk 24 / target 36) + Firebase JS SDK 12
  (Auth: email/password for the owner phone + anonymous per-phone identity for the others;
  Firestore with persistent offline cache; security rules enforce the device list)
- Language: Hindi (default) / English toggle, remembered on the phone
- Money is stored and calculated in integer **paise**; quantities in integer ml / grams

---

## 1. One-time Firebase setup (≈15 minutes, free "Spark" plan is enough)

1. Open <https://console.firebase.google.com> → **Create a project** (e.g. `dairy-diary`).
   Google Analytics is not needed — you can turn it off.
2. **Add a Web app**: on the project home click the **`</>` (Web)** icon → nickname `Dairy Diary` →
   *Register app* (do NOT tick Firebase Hosting). Firebase shows a `firebaseConfig = { … }` block —
   keep this page open (you can also find it later under ⚙️ *Project settings → General → Your apps*).
3. **Enable sign-in** — *Build → Authentication → Get started → Sign-in method*:
   - **Email/Password** → enable the first switch → *Save* (used only by the owner's phone).
   - **Anonymous** → enable → *Save* (every other phone gets its own permanent anonymous id).
4. **Create the database**: *Build → Firestore Database → Create database* →
   location **`asia-south1 (Mumbai)`** (cannot be changed later) → start in **production mode** → *Create*.
5. **Create ONE account — the farm owner**: Authentication → **Users → Add user** → e.g.
   `papa.dairy@gmail.com` + a strong password. Do **not** create accounts for the other phones —
   they are added by pairing code from inside the app. (Any email format works; it is only a login id.)
6. **Publish the rules**: open [`firestore.rules`](firestore.rules), replace `OWNER_EMAIL` (near the top,
   inside `return 'OWNER_EMAIL';`) with the owner email from step 5 **in lower case**, e.g.
   `return 'papa.dairy@gmail.com';`. Then Firestore → **Rules** tab → replace everything with that
   file → **Publish**. Only this email/password account can create the farm, and only once.
7. **Sign-up / delete settings**: Authentication → **Settings → User actions**:
   - **Keep "Enable create (sign-up)" TICKED.** Firebase counts every anonymous sign-in as a sign-up,
     so unticking it makes "Join with code" fail (`auth/admin-restricted-operation`).
     This is safe: the app has no sign-up screen, and even if a stranger creates an account through the
     API, the rules give them nothing — every read/write needs the caller's uid in the farm's device
     list, a phone can only add itself with a valid, unused, unexpired code, and only `OWNER_EMAIL`
     can create the farm (that email is already taken by the owner account from step 5).
   - Untick **"Enable delete"** → *Save*.
   - Optional: Authentication → Settings → *Email enumeration protection* on (default for new projects).
8. **Paste the config**: open `src/firebaseConfig.js` and replace the six `PASTE_…` values with the
   values from step 2 (keep the quotes). Nothing else needs to change.
9. **Rebuild the APK** (next section) and install it on every phone.

Not used on purpose: **App Check / Play Integrity** — the APK is sideloaded (not from the Play Store),
so Play Integrity attestation would reject it. Security relies on the device list in the rules instead.

Until step 8 is done the app opens on a clear **"Firebase सेट नहीं है / Firebase not configured"** screen.

### First run in the app
1. **Owner's phone (first phone only)**: open the app → *मालिक का फ़ोन / Owner's phone* → sign in with the
   step-5 email/password → give this phone a name (e.g. "Papa ka phone") and the dairy name →
   *डेयरी शुरू करें / Start the dairy*. This creates the farm; this phone is the **owner** device.
2. **Every other phone**: on an already-added phone open **सेटिंग / Settings → जुड़े हुए फ़ोन / Phones →
   फ़ोन जोड़ें / Add phone**. A 6-digit code appears (valid **10 minutes**, **one use**). On the new phone open
   the app → *नया फ़ोन जोड़ें / Add a new phone* → type the code and a name (e.g. "Bhaiya ka phone") → *Join*.
   Needs internet once; afterwards it works offline like before.
3. **सेटिंग / Settings**: milk rate ₹/L, paneer rate ₹/kg, dairy name and phone, and *Your name*
   (shown as "last edited by"; defaults to the phone's name).
4. **ग्राहक / Customers**: add each customer with usual litres, phone, area and any *old due*
   from the paper register (this becomes their opening balance). Use ▲/▼ to set route order.

### Phones (device authorization)
- **Settings → Phones** lists every authorized phone with its name and the date it was added.
- **Only the owner** can remove a phone (the owner phone itself can never be removed). Removal cuts access
  at once: the rules check the device list on every read and write. The removed phone sees
  *"यह फ़ोन हटा दिया गया है / This phone was removed"*, its local copy of the data is wiped, and it can only
  come back with a new code. (A phone that is offline when removed keeps showing its cached data until it
  next goes online — then it is locked and wiped.)
- A non-owner phone can remove itself (*Remove this phone from the dairy*); any phone can rename itself.
- Anonymous phones have no password, so they have no "Sign out" (it would lose the phone's identity).
  **Uninstalling the app or clearing its data also loses the identity** → pair again with a new code and
  remove the old entry. Updating the APK keeps it.
- The owner email/password is the master key: signing in with it on another phone makes that phone act as
  the owner device too. Keep that password private.
- Codes are 6 digits and live 10 minutes; codes can be fetched only by exact number (no listing). Guessing a
  live code within its 10 minutes is impractical, and any surprise phone shows up in the list for the owner
  to remove.

---

## 2. Rebuild the APK after editing `src/firebaseConfig.js`

On any PC/Mac with **Node 22+, JDK 21 and the Android SDK (platform 36)** — e.g. Android Studio installed:

```bash
npm ci
npm run apk          # = vite build → npx cap sync android → ./gradlew assembleDebug → dist-apk/dairy-diary.apk
```

(On Windows run the same steps by hand: `npm run build && npx cap sync android && cd android && gradlew.bat assembleDebug`;
the APK is `android/app/build/outputs/apk/debug/app-debug.apk`.)

Inside the Hark sandbox (Linux aarch64 behind a proxy) the toolchain is installed and the build run by:

```bash
bash scripts/sandbox/build-apk.sh          # sets up JDK/SDK if missing, starts gradle in background
tail -3 /tmp/gradle-build.log              # wait for "EXIT 0" (~1–2 min)
bash scripts/sandbox/build-apk.sh --copy   # copies to dist-apk/dairy-diary.apk
```

Alternative: push to GitHub and run the **Build APK** workflow in `.github/workflows/android.yml`
(Actions tab → Run workflow → download the artifact).

The debug signing key is stored in the repo (`android/app/dairy-diary-debug.keystore`), so every
rebuild installs as an **update** over the previous app — no need to uninstall. Data lives in
Firestore, so even a reinstall loses nothing that has synced.

Installing: copy the APK to the phone (WhatsApp-to-self / Drive / USB), tap it, allow
"Install unknown apps" for that source when Android asks.

---

## 3. How it works

| Screen | What it does |
|---|---|
| **रजिस्टर / Register** | Date (defaults to today, ◀ ▶ or tap to pick). Active customers in route order, pre-filled with usual litres. ± 0.5 L steppers, "नहीं लिया / Skip", optional paneer kg, note. Autosaves 1.2 s after each change; **सब सेव करें / Save all** saves every row (including untouched pre-filled ones). Grey dot = not saved yet, amber = saved on phone / sync pending, green = synced. Shows who last edited. Search by name/area/phone. Paused customers default to Skip. |
| **ग्राहक / Customers** | Add/edit/deactivate, name, phone, area, usual litres, special rate, old due, pause from/to, route order ▲/▼. |
| **हिसाब / Hisaab** | Pick month. Totals: billed, collected, pending (+ advance). Per customer: litres, milk ₹, paneer kg/₹, previous due carried forward, paid this month, balance — sorted by highest due. |
| **Customer detail** | Day-by-day calendar, record payment (Full = whole balance, or Part), cash/UPI, date; payment list with delete; **Share bill on WhatsApp** (bilingual text, opens `wa.me`). |
| **सेटिंग / Settings** | Rates, dairy name/phone, your name, language, **Phones** (list / add with code / remove), sign out (owner phone only). |

Billing rules (`src/billing.js`, tested in `tests/billing.test.js`):
- Only **saved** register entries are billed. Skip = no milk that day (paneer still billed if entered).
- The milk/paneer rate is **snapshotted on each entry when saved**, so changing the rate later does
  not change old bills. Rate priority: entry snapshot → customer special rate → settings rate.
- Previous due = opening (old) due + all bills before the month − all payments before the month.
- Balance = previous due + this month's bill − this month's payments (negative = advance).

### Firestore data model
```
farms/{farmId}                       { ownerUid, name, createdAt,
                                       devices: { [uid]: { name, addedAt, addedBy, code? } } }
                                       farmId == ownerUid (the owner's email/password account)
farms/{farmId}/settings/main         { milkRatePaise, paneerRatePaise, farmName, phone }
farms/{farmId}/customers/{id}        { name, phone, area, usualL, rateOverridePaise, openingDuePaise,
                                       order, active, pauseFrom, pauseTo, createdAt, updatedAt }
farms/{farmId}/days/{yyyy-mm-dd}     { date, lastEditedBy, lastEditedAt,
                                       entries: { [customerId]: { milkL, paneerKg, skip, note,
                                                  milkRatePaise, paneerRatePaise, updatedBy, updatedAt } } }
farms/{farmId}/payments/{id}         { customerId, date, amountPaise, mode: 'cash'|'upi', createdBy, createdAt }
pairingCodes/{6 digits}              { farmId, createdBy, createdAt (server time), used, usedBy?, usedAt? }
```
Joining is one atomic batch: mark the code used **and** add `devices.{myUid}` — the rules check each
half against the other (`getAfter`), so neither can happen alone. Each farm request costs one extra
document read for the rules' device-list check (still far inside the free tier).
Entries are addressed by date + customer inside one document per day. Writes use `merge`, so
the two phones can fill different customers on the same night without overwriting each other
(same customer edited on both = last save wins). One doc per day keeps a month's hisaab to
~30 reads and a year's history to ~365 docs — well inside the free tier.

---

## 4. Development

```bash
npm ci
npm test             # vitest: billing math, carry-forward, part payments, i18n, not-configured screen,
                     #   pairing codes / expiry / removal logic and the new screens (rules tests are skipped)
npm run test:rules   # Firestore rules tests (tests/rules) against the local emulator; needs Java 11+.
                     #   scripts/rules-test.sh fetches the emulator jar once from Google's Cloud SDK mirror
npm run dev          # browser preview (shows the not-configured screen until config is pasted)
node scripts/smoke.mjs <appUrl> <harnessUrl> <outDir>   # playwright screenshots (needs playwright)
```
`scripts/harness/` renders the signed-in screens with fake data for visual checks.
