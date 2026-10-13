// Visual smoke-test harness: renders the signed-in screens with fake data and a no-op Firebase.
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { LangContext, makeT } from '../../src/i18n.js';
import Register from '../../src/screens/Register.jsx';
import Hisaab from '../../src/screens/Hisaab.jsx';
import CustomerDetail from '../../src/screens/CustomerDetail.jsx';
import Customers from '../../src/screens/Customers.jsx';
import Settings from '../../src/screens/Settings.jsx';
import Welcome from '../../src/screens/Welcome.jsx';
import JoinFarm from '../../src/screens/JoinFarm.jsx';
import SetupFarm from '../../src/screens/SetupFarm.jsx';
import Removed from '../../src/screens/Removed.jsx';
import '../../src/styles.css';
import { todayISO, monthOf, addDays } from '../../src/format.js';

const writes = (window.__writes = []);
const noop = (...a) => { writes.push(a); return Promise.resolve(); };
const codes = { '482913': { farmId: 'own', createdBy: 'own', createdAt: Date.now() - 11 * 60e3, used: false } }; // expired
const fsMod = {
  doc: (_db, ...p) => ({ id: p.length ? p[p.length - 1] : 'x' + writes.length, path: p.join('/') }),
  collection: () => ({}), setDoc: noop, deleteDoc: noop, updateDoc: noop, serverTimestamp: () => 'TS', deleteField: () => 'DEL',
  getDoc: async (r) => ({ exists: () => !!codes[r.id], data: () => codes[r.id] }),
  writeBatch: () => ({ update: noop, commit: noop }),
};
const fb = { db: {}, fsMod, farmId: 'own', auth: { currentUser: {} }, authMod: { signOut: noop, updateProfile: noop, signInAnonymously: async () => ({ user: { uid: 'anon' } }) } };
const DAY = 86400e3;
const farm = { ownerUid: 'own', devices: { own: { name: 'Papa ka phone', addedAt: Date.now() - 30 * DAY, addedBy: 'own' }, p2: { name: 'Bhaiya ka phone', addedAt: Date.now() - 12 * DAY, addedBy: 'own', code: '111111' }, p3: { name: 'Rahul (Delhi)', addedAt: Date.now() - DAY, addedBy: 'p2', code: '222222' } } };

const names = ['Ramesh Yadav', 'Sunita Devi', 'Mohan Lal', 'Pappu Singh', 'Anita Kumari', 'Dr. Sinha', 'Bittu Halwai'];
const customers = names.map((n, i) => ({ id: 'c' + i, name: n, phone: i % 2 ? '98765432' + (10 + i) : '', area: ['Danapur', 'Khagaul', 'Saguna More'][i % 3], usualL: [1, 2, 1.5, 0.5, 1, 3, 5][i], order: (i + 1) * 10, active: true, openingDuePaise: i === 0 ? 50000 : 0, rateOverridePaise: i === 6 ? 5500 : null }));
const today = todayISO();
const days = {};
for (let k = 1; k <= 20; k++) {
  const d = addDays(today, -k);
  days[d] = { date: d, lastEditedBy: k % 2 ? 'Papa' : 'Bhaiya', lastEditedAt: Date.now(), entries: Object.fromEntries(customers.map((c, i) => [c.id, { milkL: c.usualL, skip: (k + i) % 9 === 0, paneerKg: i === 5 && k % 5 === 0 ? 0.5 : 0, milkRatePaise: c.rateOverridePaise || 6000, paneerRatePaise: 40000 }])) };
}
days[today] = { date: today, lastEditedBy: 'Papa', lastEditedAt: Date.now(), entries: { c0: { milkL: 1.5, skip: false, paneerKg: 0, updatedBy: 'Papa' }, c1: { milkL: 2, skip: true, updatedBy: 'Papa' } } };
const payments = [{ id: 'p1', customerId: 'c0', date: addDays(today, -3), amountPaise: 30000, mode: 'upi', createdBy: 'Bhaiya' }, { id: 'p2', customerId: 'c2', date: addDays(today, -2), amountPaise: 150000, mode: 'cash', createdBy: 'Papa' }];
const settings = { milkRatePaise: 6000, paneerRatePaise: 40000, farmName: 'Yadav Dairy Farm', phone: '9876543210' };

function H() {
  const p = new URLSearchParams(location.search);
  const lang = p.get('lang') || 'hi';
  const screen = p.get('s') || 'register';
  const [month, setMonth] = useState(monthOf(today));
  const asUid = p.get('uid') || 'own';
  const user = asUid === 'own' ? { uid: 'own', email: 'papa@example.com', isAnonymous: false } : { uid: asUid, isAnonymous: true };
  const data = { fb, farm, farmId: 'own', user, settings, customers, days, pendingDays: { [today]: true }, payments, displayName: 'Papa', setDisplayName: () => {}, online: true };
  const el = {
    register: <Register {...data} />,
    hisaab: <Hisaab {...data} month={month} setMonth={setMonth} openCustomer={() => {}} />,
    detail: <CustomerDetail {...data} customerId="c0" month={month} setMonth={setMonth} onBack={() => {}} />,
    customers: <Customers {...data} openCustomer={() => {}} />,
    settings: <Settings {...data} />,
    welcome: <Welcome onOwner={() => {}} onJoin={() => {}} />,
    join: <JoinFarm fb={fb} user={null} onJoined={() => {}} onBack={() => {}} />,
    setup: <SetupFarm fb={fb} user={{ uid: 'own', email: 'papa@example.com' }} />,
    removed: <Removed onRejoin={() => {}} />,
  }[screen];
  return (
    <LangContext.Provider value={{ lang, t: makeT(lang), setLang: () => {} }}>
      <div className="app"><main className="content">{el}</main></div>
    </LangContext.Provider>
  );
}
createRoot(document.getElementById('root')).render(<H />);
