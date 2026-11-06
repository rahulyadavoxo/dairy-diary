import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { LangContext, loadLang, saveLang, makeT, useLang } from './i18n.js';
import { isFirebaseConfigured, getFirebase, offlineSaveBroken, MEMCACHE_EVENT } from './firebase.js';
import { initPendingSync, pendingCount } from './pendingSync.js';
import { listenAll, saveSettings } from './db.js';
import { maybeLockPaneer } from './paneerLock.js';
import { todayISO, monthOf, dmy, addMonths } from './format.js';
import NotConfigured from './screens/NotConfigured.jsx';
import Login from './screens/Login.jsx';
import Register from './screens/RegisterView.jsx';
import ImportReview from './screens/ImportReview.jsx';
import Customers from './screens/Customers.jsx';
import Hisaab from './screens/Hisaab.jsx';
import CustomerDetail from './screens/CustomerDetail.jsx';
import { defaultCustomerMonth } from './firstMonth.js';
import { swipeTarget, blockedTarget } from './swipeTabs.js';
import Delivery from './screens/Delivery.jsx';
import Settings from './screens/Settings.jsx';
import Welcome from './screens/Welcome.jsx';
import JoinFarm from './screens/JoinFarm.jsx';
import SetupFarm from './screens/SetupFarm.jsx';
import Removed from './screens/Removed.jsx';
import { useScrollKeep } from './scrollKeep.js';
import Splash from './components/Splash.jsx';
import UpdateGate from './components/UpdateGate.jsx';
import { listenFarm, deviceStatus, loadFarmId, wipeLocalData, confirmRemoved } from './devices.js';
import { App as CapApp } from '@capacitor/app';
import { handleBack, pushBackHandler } from './backStack.js';
import { migrateLegacyPin, legacyPinCleared } from './pinLock.js';
import { IMPORT_DATES } from './octoberImport.js';
import { syncRings, ringTimes, cancelAllRings, _forceRingResync } from './reminders.js';

const REMOVED_KEY = 'dd_removed';
const flagGet = () => {
  try {
    return localStorage.getItem(REMOVED_KEY) === '1';
  } catch {
    return false;
  }
};
const flagSet = (on) => {
  try {
    if (on) localStorage.setItem(REMOVED_KEY, '1');
    else localStorage.removeItem(REMOVED_KEY);
  } catch {
    /* ignore */
  }
};

export function LangToggle() {
  const { t, lang, setLang } = useLang();
  return (
    <button className="lang-toggle" onClick={() => setLang(lang === 'hi' ? 'en' : 'hi')} aria-label="language">
      {t('langToggle')}
    </button>
  );
}

export default function App() {
  const [lang, setLangState] = useState(loadLang);
  const setLang = (l) => {
    saveLang(l);
    setLangState(l);
  };
  const ctx = useMemo(() => ({ lang, setLang, t: makeT(lang) }), [lang]);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  useAppBackButton();

  return (
    <LangContext.Provider value={ctx}>
      <UpdateGate>{isFirebaseConfigured() ? <Authed /> : <NotConfigured />}</UpdateGate>
    </LangContext.Provider>
  );
}

// v1.10.73: ONE Android back-button listener for the whole app (it used to live in Main only, so
// Back on Welcome/Login/Join/Setup closed the app). Order: the update wall / overlays (backStack),
// then Main's own screens, else background (unsynced entries) or exit.
let mainBack = null; // set by Main: returns true when it handled Back
export function appBack() {
  if (handleBack()) return 'handled';
  if (mainBack && mainBack()) return 'handled';
  // Entries still waiting for the server: go to the background instead of closing, so the
  // upload finishes by itself when the internet comes back (v1.10.49).
  if (pendingCount() > 0) {
    CapApp.minimizeApp();
    return 'minimize';
  }
  CapApp.exitApp();
  return 'exit';
}
function useAppBackButton() {
  useEffect(() => {
    let handle;
    let cancelled = false;
    Promise.resolve(CapApp.addListener('backButton', () => appBack()))
      .then((h) => {
        handle = h;
        // unmounted before addListener resolved: remove now, or two listeners pile up and one
        // back press closes two screens / exits the app
        if (cancelled && h && h.remove) h.remove();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (handle && handle.remove) handle.remove();
    };
  }, []);
}

function Authed() {
  const { t } = useLang();
  const [fb, setFb] = useState(null);
  const [user, setUser] = useState(undefined); // undefined = checking
  const [initError, setInitError] = useState(null);

  useEffect(() => {
    let unsub = () => {};
    let alive = true; // unmounted before getFirebase() resolved -> don't attach a leaking listener
    getFirebase()
      .then((f) => {
        if (!alive) return;
        setFb(f);
        initPendingSync(f);
        unsub = f.authMod.onAuthStateChanged(f.auth, (u) => setUser(u || null));
      })
      .catch((e) => alive && setInitError(String(e && e.message ? e.message : e)));
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  if (initError) {
    return (
      <div className="center-screen">
        <h2>{t('notConfiguredTitle')}</h2>
        <p className="error">{initError}</p>
      </div>
    );
  }
  if (!fb || user === undefined) return <Splash text={t('loading')} />;
  return <Gate fb={fb} user={user} />;
}

/**
 * Who may use the app on this phone:
 *  - removed flag      → lock screen (data already wiped)
 *  - nobody signed in  → Welcome → owner Login, or Join with a pairing code (anonymous auth)
 *  - owner (email)     → farmId = own uid; SetupFarm if the farm doc does not exist yet
 *  - anonymous phone   → farmId saved at join time; JoinFarm if none
 *  - then FarmGate checks this uid is in farms/{farmId}.devices on every snapshot.
 */
export function Gate({ fb, user }) {
  const [removed, setRemoved] = useState(flagGet);
  const [mode, setMode] = useState('welcome');
  const [joinedFarm, setJoinedFarm] = useState(null);

  const isRemoved = removed || flagGet();
  const anonFarmId = user && user.isAnonymous ? joinedFarm || loadFarmId(user.uid) : null;
  const onJoin = (!user && mode === 'join') || (user && user.isAnonymous && !anonFarmId);
  const onLogin = !user && mode === 'login';
  // v1.10.73: hardware Back on Login / Join goes back to Welcome (it used to close the app).
  useEffect(() => {
    if (isRemoved || (!onJoin && !onLogin)) return undefined;
    const back = user
      ? () => fb.authMod.signOut(fb.auth).catch(() => {}).finally(() => setMode('welcome'))
      : () => setMode('welcome');
    return pushBackHandler(back);
  }, [isRemoved, onJoin, onLogin, !!user]); // eslint-disable-line react-hooks/exhaustive-deps
  if (isRemoved) {
    return (
      <Removed
        onRejoin={() => {
          // Firestore was terminated by the wipe: start fresh with a reload.
          flagSet(false);
          setRemoved(false);
          window.location.reload();
        }}
      />
    );
  }
  // Join screen is returned from the same position whether or not the anonymous sign-in
  // has happened yet, so its state survives the auth change mid-join.
  if (onJoin) {
    // An anonymous phone whose join failed used to be stuck here with no way back to the owner
    // login. It has not joined any farm yet, so signing out loses nothing.
    const back = user
      ? () => fb.authMod.signOut(fb.auth).catch(() => {}).finally(() => setMode('welcome'))
      : () => setMode('welcome');
    return <JoinFarm fb={fb} user={user} onJoined={(farmId) => setJoinedFarm(farmId)} onBack={back} />;
  }
  if (!user && mode === 'login') return <Login fb={fb} onBack={() => setMode('welcome')} />;
  if (!user) return <Welcome onOwner={() => setMode('login')} onJoin={() => setMode('join')} />;
  const farmId = user.isAnonymous ? anonFarmId : user.uid;
  return <FarmGate key={farmId} fb={fb} user={user} farmId={farmId} onRemoved={() => setRemoved(true)} />;
}

function FarmGate({ fb, user, farmId, onRemoved }) {
  const { t } = useLang();
  const [state, setState] = useState({ loaded: false });
  const [slow, setSlow] = useState(false);
  const [listenTry, setListenTry] = useState(0); // bump = start the farm listener again
  useEffect(() => listenFarm(fb, farmId, setState), [fb, farmId, listenTry]);
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(id);
  }, []);
  const status = deviceStatus(state, user.uid);
  // v1.10.73: the last farm this phone was authorised for. A listener error (network, quota
  // 'resource-exhausted', a denied snapshot still being checked) keeps the app usable on it.
  const lastOk = useRef(null);
  if (status === 'authorized') lastOk.current = state.farm;
  // Wait for the server to confirm a removal (not just this phone's own queued 'leave' write).
  const removedAnon = status === 'removed' && user.isAnonymous && !state.pending;
  // A server snapshot without this uid = really removed. A permission-denied error alone is
  // checked with the server first (a bad rules publish used to wipe every helper phone).
  const lockOut = removedAnon && !state.denied;
  const deniedAnon = removedAnon && !!state.denied;
  const wiping = useRef(false);
  const wipe = () => {
    if (wiping.current) return;
    wiping.current = true;
    // Removed from the farm (or access denied): wipe the local cache + identity, then lock.
    flagSet(true);
    wipeLocalData(fb).finally(onRemoved);
  };

  useEffect(() => {
    if (lockOut) wipe();
  }, [lockOut]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!deniedAnon) return undefined;
    let stop = false;
    let timer = null;
    confirmRemoved(fb, farmId, user.uid).then((v) => {
      if (stop) return;
      if (v === 'removed') return wipe();
      // still a member / could not check: keep everything, start the listener again later
      timer = setTimeout(() => setListenTry((n) => n + 1), v === 'member' ? 30000 : 60000);
    });
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [deniedAnon ? state : null]); // eslint-disable-line react-hooks/exhaustive-deps

  // v1.10.73: Back on SetupFarm (owner signed in, no farm yet) goes to Welcome: nothing to lose.
  const onSetup = status === 'noFarm' && !user.isAnonymous;
  useEffect(
    () =>
      onSetup
        ? pushBackHandler(() => {
            cancelAllRings();
            fb.authMod.signOut(fb.auth).catch(() => {});
          })
        : undefined,
    [onSetup], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const fbFarm = useMemo(() => ({ ...fb, farmId }), [fb, farmId]);

  if (status === 'authorized') return <Main fb={fbFarm} user={user} farm={state.farm} farmId={farmId} />;
  // denied, being checked with the server: keep the app on the last good farm (no wipe yet)
  if (deniedAnon && lastOk.current && !wiping.current) return <Main fb={fbFarm} user={user} farm={lastOk.current} farmId={farmId} />;
  // lockOut: wiping. Pending: our own 'leave' is still on its way to the server, just wait; never
  // offer Sign out to an anonymous phone (it would strand the queued 'leave' and skip the wipe).
  if (status === 'removed' && user.isAnonymous) return <Splash text={t('loading')} />;
  if (status === 'error') {
    // v1.10.73: the listener retries by itself (listenFarm). Data is in the offline cache: stay in
    // the app on the last authorised farm instead of the "waiting for server" wall.
    if (lastOk.current) return <Main fb={fbFarm} user={user} farm={lastOk.current} farmId={farmId} />;
    // A network/unknown error on the farm listener is NOT "farm does not exist": never offer
    // SetupFarm (which would try to create the farm again) — let the user retry.
    return (
      <div className="center-screen" data-testid="farm-error">
        <p className="error">{t('waitingForServer')}</p>
        {state.error && <p className="muted tiny">{String(state.error.code || state.error.message || state.error)}</p>}
        <button className="btn big" onClick={() => window.location.reload()}>
          {t('loading')} ↻
        </button>
      </div>
    );
  }
  if (status === 'noFarm' && !user.isAnonymous) return <SetupFarm fb={fb} user={user} />;
  if (status === 'removed' || status === 'noFarm') {
    // owner account but denied / missing: almost always unpublished rules or wrong OWNER_EMAIL
    return (
      <div className="center-screen" data-testid="farm-error">
        <p className="error">{t('farmCheckFailed')}</p>
        {state.error && <p className="muted tiny">{String(state.error.code || state.error.message || state.error)}</p>}
        <button
          className="btn big"
          onClick={() => {
            cancelAllRings(); // signOut keeps the native ring's token: stop this phone ringing
            fb.authMod.signOut(fb.auth);
          }}
        >
          {t('signOut')}
        </button>
      </div>
    );
  }
  return (
    <Splash text={t('loading')}>{slow && <p className="muted small">{t('waitingForServer')}</p>}</Splash>
  );
}

/** Dairy name typed at setup was stored only on the farm doc (1.9.7 and earlier): use it until
    a name is saved in Settings, so bills and the Settings field are not empty. */
export function withFarmName(settings, farm) {
  if ((settings && settings.farmName) || !farm || !farm.name) return settings;
  return { ...settings, farmName: farm.name };
}

function Main({ fb, user, farm, farmId }) {
  const { t, lang } = useLang();
  const [tab, setTab] = useState('register');
  const swipeStart = useRef(null); // touch start for tab swipe
  const [detail, setDetail] = useState(null); // { customerId, month }
  const [delivery, setDelivery] = useState(false);
  const [importReview, setImportReview] = useState(false);
  // Customer detail / delivery / import review replace the tab's list: keep its scroll position.
  useScrollKeep(!!detail || delivery || importReview, tab);
  // A different tab (tapped or swiped) opens at its top, not at the old tab's scroll position.
  const firstTab = useRef(true);
  useLayoutEffect(() => {
    if (firstTab.current) {
      firstTab.current = false;
      return;
    }
    window.scrollTo(0, 0);
  }, [tab]);
  const [settings, setSettings] = useState({});
  const [customers, setCustomers] = useState([]);
  const [days, setDays] = useState({});
  const [pendingDays, setPendingDays] = useState({});
  const [daysLive, setDaysLive] = useState(false); // last days snapshot came from the server
  const [histOk, setHistOk] = useState(true); // false: history older than the live window not on this phone yet
  const [payments, setPayments] = useState([]);
  const [loaded, setLoaded] = useState({ days: false, customers: false });
  const lockSrc = useRef({ settings: null, customers: null }); // true = last snapshot came from the server
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  // Firestore could not use the phone's storage (full): offline entries would be lost on close.
  const [memOnly, setMemOnly] = useState(offlineSaveBroken);
  useEffect(() => {
    const h = () => setMemOnly(true);
    window.addEventListener(MEMCACHE_EVENT, h);
    if (offlineSaveBroken()) setMemOnly(true);
    return () => window.removeEventListener(MEMCACHE_EVENT, h);
  }, []);
  const [month, setMonth] = useState(monthOf(todayISO()));
  // App left open into a new month: Hisaab follows if it was showing the (old) current month.
  const curMonth = useRef(monthOf(todayISO()));
  useEffect(() => {
    const id = setInterval(() => {
      const m = monthOf(todayISO());
      if (m === curMonth.current) return;
      setMonth((x) => (x === curMonth.current ? m : x === addMonths(curMonth.current, -1) ? addMonths(m, -1) : x));
      curMonth.current = m;
    }, 60 * 1000);
    return () => clearInterval(id);
  }, []);
  const myDevice = farm && farm.devices ? farm.devices[user.uid] : null;
  const [displayName, setDisplayName] = useState(
    user.displayName || (myDevice && myDevice.name) || (user.email || '').split('@')[0],
  );

  useEffect(
    () =>
      listenAll(fb, {
        settings: (s, fromCache) => {
          lockSrc.current.settings = !fromCache; // NEW-3: paneer lock needs a server copy
          migrateLegacyPin(s); // before render, so Hisaab sees the PIN in the same update
          // The old synced hash (unsalted SHA-256 of a 4-digit PIN) is readable by every paired
          // phone and trivially reversible. Once copied to this phone, delete it from Firestore.
          if (s && s.totalsPinHash && legacyPinCleared() && fb.fsMod.deleteField) {
            saveSettings(fb, { totalsPinHash: fb.fsMod.deleteField() });
          }
          setSettings(s);
        },
        customers: (c, fromCache) => {
          lockSrc.current.customers = !fromCache;
          setCustomers(c);
          setLoaded((l) => (l.customers ? l : { ...l, customers: true }));
        },
        days: (d, p, fromCache, oldOk) => {
          setDays(d);
          setHistOk(oldOk !== false);
          setPendingDays(p);
          setDaysLive(!fromCache);
          setLoaded((l) => (l.days ? l : { ...l, days: true }));
        },
        payments: setPayments,
        error: (e) => console.error('[listen]', e),
      }),
    [fb],
  );

  // Money #1 one-time repair: freeze Oct/Nov paneer days stored without a rate at today's amount.
  // Runs once per phone, only after server-confirmed days, customers and settings and with old
  // history on the phone (histOk). No Settings paneer rate -> skipped, not marked done (paneerLock.js).
  useEffect(() => {
    const src = lockSrc.current;
    maybeLockPaneer({
      fb, loaded: { ...loaded, settings: src.settings !== null }, daysLive, histOk,
      customersLive: src.customers === true, settingsLive: src.settings === true, settings, customers, days,
    });
  }, [loaded, daysLive, histOk, settings, customers, days, fb]);

  // 22:00 / 08:00 register rings on this phone (see reminders.js). Only once both lists loaded,
  // so an empty first render never cancels or schedules the wrong rings.
  const hasCustomers = customers.some((c) => c.active !== false);
  // v1.10.73: the native receiver clears the plan on a 403 / token error (RingReceiver NO_ACCESS).
  // Re-send it every time the app comes back to the front, not only after a restart.
  const [ringResume, setRingResume] = useState(0);
  useEffect(() => {
    let handle;
    let cancelled = false;
    Promise.resolve(
      CapApp.addListener('resume', () => {
        _forceRingResync();
        setRingResume((n) => n + 1);
      }),
    )
      .then((h) => {
        handle = h;
        if (cancelled && h && h.remove) h.remove();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (handle && handle.remove) handle.remove();
    };
  }, []);
  useEffect(() => {
    if (!loaded.days || !loaded.customers) return;
    const o = (fb.app && fb.app.options) || {};
    const u = fb.auth && fb.auth.currentUser;
    const auth = { apiKey: o.apiKey, projectId: o.projectId, farmId: fb.farmId, refreshToken: u && u.refreshToken };
    syncRings({ days, pendingDays, hasCustomers, t, dmy: (iso) => dmy(iso, lang), times: ringTimes(settings), auth });
  }, [loaded, days, pendingDays, hasCustomers, lang, settings.ringNight, settings.ringMorning, ringResume]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // Android hardware back button (one listener in App, see appBack): overlays first (backStack),
  // then these app-level screens; false = not handled here (App minimises / exits).
  const navRef = useRef({});
  navRef.current = { tab, detail, delivery, importReview };
  useEffect(() => {
    const mine = () => {
      const { tab: tb, detail: dt, delivery: dl, importReview: ir } = navRef.current;
      if (dl) setDelivery(false);
      else if (ir) setImportReview(false);
      else if (dt) setDetail(null);
      else if (tb !== 'register') setTab('register');
      else return false;
      return true;
    };
    mainBack = mine;
    return () => {
      if (mainBack === mine) mainBack = null;
    };
  }, []);

  const farmName = farm && farm.name;
  const effSettings = useMemo(() => withFarmName(settings, farmName ? { name: farmName } : null), [settings, farmName]);
  const data = { fb, user, settings: effSettings, customers, days, daysLive, histOk, pendingDays, payments, displayName, setDisplayName, online, farm, farmId };

  let screen;
  if (delivery) {
    screen = <Delivery {...data} onBack={() => setDelivery(false)} />;
  } else if (importReview) {
    screen = <ImportReview {...data} onDone={() => setImportReview(false)} />;
  } else if (detail) {
    screen = (
      <CustomerDetail
        {...data}
        customerId={detail.customerId}
        month={detail.month}
        setMonth={(m) => setDetail({ ...detail, month: m })}
        onBack={() => setDetail(null)}
      />
    );
  } else if (tab === 'register') screen = <Register {...data} onDelivery={() => setDelivery(true)} onImportReview={IMPORT_DATES.length ? () => setImportReview(true) : undefined} />;
  else if (tab === 'hisaab')
    screen = <Hisaab {...data} month={month} setMonth={setMonth} openCustomer={(id) => setDetail({ customerId: id, month: defaultCustomerMonth(days) })} />;
  else if (tab === 'customers') screen = <Customers {...data} openCustomer={(id) => setDetail({ customerId: id, month: defaultCustomerMonth(days) })} />;
  else screen = <Settings {...data} />;

  const tabs = [
    ['register', '📒', t('tabRegister')],
    ['hisaab', '₹', t('tabHisaab')],
    ['customers', '👥', t('tabCustomers')],
    ['settings', '⚙️', t('tabSettings')],
  ];

  return (
    <div className="app">
      {!online && <div className="offline-bar">{t('offline')}</div>}
      {memOnly && (
        <div className="offline-bar" role="alert" data-testid="storage-full">
          {t('storageFull')}
        </div>
      )}
      <main
        className="content"
        onTouchStart={(e) => {
          const p = e.touches && e.touches[0];
          swipeStart.current =
            p && e.touches.length === 1 && !detail && !delivery && !importReview && !blockedTarget(e.target)
              ? { x: p.clientX, y: p.clientY, t: Date.now() }
              : null;
        }}
        onTouchEnd={(e) => {
          const st = swipeStart.current;
          swipeStart.current = null;
          const p = e.changedTouches && e.changedTouches[0];
          if (!st || !p) return;
          const next = swipeTarget(tab, st, { x: p.clientX, y: p.clientY, t: Date.now() });
          if (next) setTab(next);
        }}
      >
        {screen}
      </main>
      <nav className="tabbar">
        {tabs.map(([id, icon, label]) => (
          <button
            key={id}
            className={'tab' + (tab === id && !detail ? ' active' : '')}
            onClick={() => {
              setDetail(null);
              setDelivery(false);
              setImportReview(false);
              // Hisaab opens on the month before the running month (user, 3 Nov 2026).
              if (id === 'hisaab') setMonth(defaultCustomerMonth(days));
              setTab(id);
            }}
          >
            <span className="tab-icon">{icon}</span>
            <span className="tab-label">{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
