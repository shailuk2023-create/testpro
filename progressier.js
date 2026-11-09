importScripts("https://progressier.app/XI0kRddwFU4ZoDYaXp2f/sw.js");
/* TESTPRO v20: offline cache. Progressier ka apna SW GET requests cache
   nahi karta (sirf push/share) - isliye app shell yahin cache hota hai.
   Navigation aur version.txt: network-first (online hote hi naya version
   mile), offline hone par cached copy. Baaki same-origin files:
   cache-first + background update. Cross-origin requests (Progressier,
   Google Forms, YouTube) ko chhoote hi nahi. */
var TP_CACHE = 'testpro-v20';
var TP_SHELL = ['./', 'index.html', 'version.txt', 'icon-192.png', 'icon-512.png', 'manifest.json'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(TP_CACHE).then(function (c) {
    return Promise.all(TP_SHELL.map(function (u) { return c.add(u).catch(function () {}); }));
  }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== TP_CACHE; }).map(function (k) { return caches.delete(k); }));
  }));
});
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  var isNav = e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html');
  var isVersion = url.pathname.endsWith('version.txt');
  function cachePut(req, res) {
    if (res && res.ok) {
      var copy = res.clone();
      caches.open(TP_CACHE).then(function (c) { return c.put(req, copy); }).catch(function () {});
    }
  }
  if (isNav || isVersion) {
    e.respondWith(fetch(e.request).then(function (res) {
      cachePut(e.request, res);
      return res;
    }).catch(function () {
      return caches.match(e.request).then(function (r) { return r || caches.match('index.html'); });
    }));
    return;
  }
  e.respondWith(caches.match(e.request).then(function (cached) {
    var net = fetch(e.request).then(function (res) {
      cachePut(e.request, res);
      return res;
    }).catch(function () { return cached; });
    return cached || net;
  }));
});
