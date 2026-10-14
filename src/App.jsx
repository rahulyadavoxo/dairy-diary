import { useEffect, useMemo, useRef, useState } from 'react';
import { LangContext, loadLang, saveLang, makeT, useLang } from './i18n.js';
import { isFirebaseConfigured, getFirebase } from './firebase.js';
import { listenAll } from './db.js';
import { todayISO, monthOf } from './format.js';
import NotConfigured from './screens/NotConfigured.jsx';
import Login from './screens/Login.jsx';
import Register from './screens/RegisterView.jsx';
import ImportReview from './screens/ImportReview.jsx';
import Customers from './screens/Customers.jsx';
import Hisaab from './screens/Hisaab.jsx';
import CustomerDetail from './screens/CustomerDetail.jsx';
import Delivery from './screens/Delivery.jsx';
import Settings from './screens/Settings.jsx';
import Welcome from './screens/Welcome.jsx';
import JoinFarm from './screens/JoinFarm.jsx';
import SetupFarm from './screens/SetupFarm.jsx';
import Removed from './screens/Removed.jsx';
import { listenFarm, deviceStatus, loadFarmId, wipeLocalData } from './devices.js';
import { App as CapApp } from '@capacitor/app';
import { handleBack, pushBackHandler } from './backStack.js';

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

  return (
    <LangContext.Provider value={ctx}>
      {isFirebaseConfigured() ? <Authed /> : <NotConfigured />}
    </LangContext.Provider>
  );
}

function Authed() {
  const { t } = useLang();
  const [fb, setFb] = useState(null);
  const [user, setUser] = useState(undefined); // undefined = checking
  const [initError, setInitError] = useState(null);

  useEffect(() => {
    let unsub = () => {};
    getFirebase()
      .then((f) => {
        setFb(f);
        unsub = f.authMod.onAuthStateChanged(f.auth, (u) => setUser(u || null));
      })
      .catch((e) => setInitError(String(e && e.message ? e.message : e)));
    return () => unsub();
  }, []);

  if (initError) {
    return (
      <div className="center-screen">
        <h2>{t('notConfiguredTitle')}</h2>
        <p className="error">{initError}</p>
      </div>
    );
  }
  if (!fb || user === undefined) return <div className="center-screen">{t('loading')}</div>;
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

  if (removed || flagGet()) {
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
  const anonFarmId = user && user.isAnonymous ? joinedFarm || loadFarmId(user.uid) : null;
  // Join screen is returned from the same position whether or not the anonymous sign-in
  // has happened yet, so its state survives the auth change mid-join.
  if ((!user && mode === 'join') || (user && user.isAnonymous && !anonFarmId)) {
    return <JoinFarm fb={fb} user={user} onJoined={(farmId) => setJoinedFarm(farmId)} onBack={user ? null : () => setMode('welcome')} />;
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
  useEffect(() => listenFarm(fb, farmId, setState), [fb, farmId]);
  useEffect(() => {
    const id = setTimeout(() => setSlow(true), 4000);
    return () => clearTimeout(id);
  }, []);
  const status = deviceStatus(state, user.uid);
  const lockOut = status === 'removed' && user.isAnonymous;

  useEffect(() => {
    if (!lockOut) return;
    // Removed from the farm (or access denied): wipe the local cache + identity, then lock.
    flagSet(true);
    wipeLocalData(fb).finally(onRemoved);
  }, [lockOut]); // eslint-disable-line react-hooks/exhaustive-deps

  const fbFarm = useMemo(() => ({ ...fb, farmId }), [fb, farmId]);

  if (lockOut) return <div className="center-screen">{t('loading')}</div>;
  if (status === 'authorized') return <Main fb={fbFarm} user={user} farm={state.farm} farmId={farmId} />;
  if (status === 'noFarm' && !user.isAnonymous) return <SetupFarm fb={fb} user={user} />;
  if (status === 'removed' || status === 'noFarm') {
    // owner account but denied / missing: almost always unpublished rules or wrong OWNER_EMAIL
    return (
      <div className="center-screen" data-testid="farm-error">
        <p className="error">{t('farmCheckFailed')}</p>
        {state.error && <p className="muted tiny">{String(state.error.code || state.error.message || state.error)}</p>}
        <button className="btn big" onClick={() => fb.authMod.signOut(fb.auth)}>
          {t('signOut')}
        </button>
      </div>
    );
  }
  return (
    <div className="center-screen">
      <p>{t('loading')}</p>
      {slow && <p className="muted small">{t('waitingForServer')}</p>}
    </div>
  );
}

function Main({ fb, user, farm, farmId }) {
  const { t } = useLang();
  const [tab, setTab] = useState('register');
  const [detail, setDetail] = useState(null); // { customerId, month }
  const [delivery, setDelivery] = useState(false);
  const [importReview, setImportReview] = useState(false);
  const [settings, setSettings] = useState({});
  const [customers, setCustomers] = useState([]);
  const [days, setDays] = useState({});
  const [pendingDays, setPendingDays] = useState({});
  const [payments, setPayments] = useState([]);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [month, setMonth] = useState(monthOf(todayISO()));
  const myDevice = farm && farm.devices ? farm.devices[user.uid] : null;
  const [displayName, setDisplayName] = useState(
    user.displayName || (myDevice && myDevice.name) || (user.email || '').split('@')[0],
  );

  useEffect(
    () =>
      listenAll(fb, {
        settings: setSettings,
        customers: setCustomers,
        days: (d, p) => {
          setDays(d);
          setPendingDays(p);
        },
        payments: setPayments,
        error: (e) => console.error('[listen]', e),
      }),
    [fb],
  );

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

  // Android hardware back button: close topmost overlay first (via backStack),
  // then app-level screens, else exit.
  const navRef = useRef({});
  navRef.current = { tab, detail, delivery, importReview };
  useEffect(() => {
    let handle;
    CapApp.addListener('backButton', () => {
      if (handleBack()) return; // a nested overlay handled it
      const { tab: tb, detail: dt, delivery: dl, importReview: ir } = navRef.current;
      if (dl) setDelivery(false);
      else if (ir) setImportReview(false);
      else if (dt) setDetail(null);
      else if (tb !== 'register') setTab('register');
      else CapApp.exitApp();
    }).then((h) => (handle = h));
    return () => handle && handle.remove && handle.remove();
  }, []);

  const data = { fb, user, settings, customers, days, pendingDays, payments, displayName, setDisplayName, online, farm, farmId };

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
  } else if (tab === 'register') screen = <Register {...data} onDelivery={() => setDelivery(true)} onImportReview={() => setImportReview(true)} />;
  else if (tab === 'hisaab')
    screen = <Hisaab {...data} month={month} setMonth={setMonth} openCustomer={(id) => setDetail({ customerId: id, month })} />;
  else if (tab === 'customers') screen = <Customers {...data} openCustomer={(id) => setDetail({ customerId: id, month })} />;
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
      <main className="content">{screen}</main>
      <nav className="tabbar">
        {tabs.map(([id, icon, label]) => (
          <button
            key={id}
            className={'tab' + (tab === id && !detail ? ' active' : '')}
            onClick={() => {
              setDetail(null);
              setDelivery(false);
              setImportReview(false);
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
