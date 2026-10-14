/* Dairy Diary OTA service worker.
 *
 * Gives the app over-the-air web-bundle updates without reinstalling the APK.
 *
 * How it works:
 *  - Only same-origin GET requests for /index.html and /assets/* are intercepted.
 *  - If a complete OTA bundle was downloaded earlier, its files are served from
 *    Cache Storage; otherwise the request falls through to the APK's bundled files.
 *  - Update checks run when the app asks (once a day) and never block startup.
 *    A new bundle is activated only after EVERY file downloads AND its SHA-256
 *    matches the manifest. Any failure leaves the current app untouched.
 *  - The update takes effect on the next app launch (never mid-entry).
 */
const OTA_BASE = 'https://cdn.jsdelivr.net/gh/rahulyadavoxo/dairy-diary@main/ota';
const BUNDLED_VERSION = '1.10.2'; // MUST equal package.json "version" of the APK build
const CACHE_PREFIX = 'dd-ota-';
const COMPLETE_MARKER = '/__dd_complete';
const CHECK_TIMEOUT_MS = 10000;

function verParts(v) {
  return String(v || '0').split('.').map(function (x) { return parseInt(x, 10) || 0; });
}
function verCmp(a, b) {
  var A = verParts(a), B = verParts(b);
  var n = Math.max(A.length, B.length);
  for (var i = 0; i < n; i++) {
    var d = (A[i] || 0) - (B[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function sha256hex(buf) {
  var h = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(h)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

/* Versions that were fully downloaded AND hash-verified. Partial/failed
   downloads never get the marker, so they can never be served. */
async function completeOtaVersions() {
  var out = [];
  var keys = await caches.keys();
  for (var k of keys) {
    if (k.indexOf(CACHE_PREFIX) !== 0) continue;
    var v = k.slice(CACHE_PREFIX.length);
    // An OTA bundle that is not NEWER than the code inside this APK is obsolete (the APK was
    // updated). Serving it would shadow the new APK with old code forever — drop it instead.
    if (verCmp(v, BUNDLED_VERSION) <= 0) {
      try { await caches.delete(k); } catch (e) { /* ignore */ }
      continue;
    }
    try {
      var c = await caches.open(k);
      if (await c.match(COMPLETE_MARKER)) out.push(v);
    } catch (e) { /* ignore */ }
  }
  out.sort(verCmp);
  return out;
}

async function fetchJson(url) {
  var ctl = new AbortController();
  var t = setTimeout(function () { ctl.abort(); }, CHECK_TIMEOUT_MS);
  try {
    var r = await fetch(url + (url.indexOf('?') >= 0 ? '&' : '?') + 'ts=' + Date.now(),
      { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function checkForUpdate() {
  var cacheName = null;
  var completed = false;
  try {
    var man = await fetchJson(OTA_BASE + '/version.json');
    if (!man || !man.version || !Array.isArray(man.files) || !man.files.length) return;
    var vs = await completeOtaVersions();
    var cur = vs.length ? vs[vs.length - 1] : BUNDLED_VERSION;
    if (verCmp(man.version, cur) <= 0) return;            // nothing newer available
    if (verCmp(man.version, BUNDLED_VERSION) <= 0) return; // never go below the bundled version

    cacheName = CACHE_PREFIX + man.version;
    var cache = await caches.open(cacheName);
    for (var f of man.files) {
      if (!f || !f.path || !f.key || !f.sha256) throw new Error('bad manifest entry');
      var r = await fetch(OTA_BASE + '/' + man.version + '/' + f.path + '?ts=' + Date.now(),
        { cache: 'no-store' });
      if (!r.ok) throw new Error('download failed: ' + f.path);
      var buf = await r.arrayBuffer();
      if (!buf.byteLength) throw new Error('empty file: ' + f.path);
      var hex = await sha256hex(buf);
      if (hex !== String(f.sha256).toLowerCase()) throw new Error('hash mismatch: ' + f.path);
      await cache.put(f.key, new Response(buf, { headers: { 'Content-Type': f.type || 'application/octet-stream' } }));
    }
    // completeness: every manifest file must be present before we trust this cache
    for (var g of man.files) {
      if (!(await cache.match(g.key))) throw new Error('incomplete bundle');
    }
    await cache.put(COMPLETE_MARKER, new Response('1'));
    completed = true;

    // drop older OTA bundles only now that the new one is fully verified
    var keys = await caches.keys();
    for (var k of keys) {
      if (k.indexOf(CACHE_PREFIX) === 0 && k !== cacheName) {
        try { await caches.delete(k); } catch (e) { /* ignore */ }
      }
    }

    var clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (var c of clients) {
      try { c.postMessage({ type: 'dd-ota-ready', version: man.version }); } catch (e) { /* ignore */ }
    }
  } catch (e) {
    // Never break the app: discard the partial bundle, keep serving the current one.
    if (!completed && cacheName) {
      try { await caches.delete(cacheName); } catch (e2) { /* ignore */ }
    }
  }
}

self.addEventListener('install', function () { self.skipWaiting(); });

self.addEventListener('activate', function (e) {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'dd-check-update') e.waitUntil(checkForUpdate());
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var u;
  try { u = new URL(e.request.url); } catch (err) { return; }
  if (u.origin !== self.location.origin) return;
  var key = u.pathname;
  if (key === '/') key = '/index.html';
  if (key !== '/index.html' && key.indexOf('/assets/') !== 0) return;
  e.respondWith((async function () {
    try {
      var vs = await completeOtaVersions();
      for (var i = vs.length - 1; i >= 0; i--) {
        var c = await caches.open(CACHE_PREFIX + vs[i]);
        var m = await c.match(key);
        if (m) return m;
      }
    } catch (err) { /* fall through to bundled files */ }
    return fetch(e.request);
  })());
});
