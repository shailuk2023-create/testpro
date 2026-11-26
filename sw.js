/* TESTPRO service worker (v108) — own PWA worker, replaces Progressier.
 *
 * Purpose: make the whole TESTPRO app work offline after first visit.
 *   - Precaches the app shell (index.html, manifest.json, icons)
 *     plus the 33 UI art images (images/ui-*). Maths solution
 *     screenshots, CA/GA bank and solution images, and report images
 *     are NOT precached — they load on demand from the repo (online
 *     URLs) and take zero install space.
 *   - Navigations are network-first so a new app version arrives when
 *     online; the cached copy serves when offline.
 *   - Other same-origin GETs are cache-first.
 *   - version.txt is NEVER cached (network-only passthrough) so the app's
 *     update check always sees the live version number.
 *   - Cross-origin requests (Firebase, Google APIs, fonts, hotlinked news
 *     images) are never intercepted.
 *
 * Cache name: 'testpro-v115'. On activate, ONLY caches whose name starts
 * with 'testpro-v' (other than this one) are deleted — this removes the
 * old 'testpro-v17' / 'testpro-v20' shells but NEVER touches the app's
 * in-page image cache 'testpro-images-v1' or any other cache.
 *
 * v107 change vs v106: the 54 orphan images (36 CA solution photos +
 * 18 GA solution images, 3,890,077 B) are DELETED from the repo and
 * removed from the precache. They had zero references in the app
 * (those filenames occur 0 times in index.html, which uses cabank-
 * and gabank- images instead) and were precached in v106 only because
 * the orphan question was still open (see v106 build-sw-note.md M-1).
 * Logo restore (same v107 release): icon-192.png / icon-512.png are
 * replaced by the user's actual TESTPRO logo (full lockup on white);
 * manifest background_color is now #ffffff to match. The two icon
 * revisions below are the first 12 chars of the NEW files' git blob
 * SHAs (computed locally — the files are not in the repo yet).
 * Precache is now 37 entries (was 537); install is about 7.79 MiB
 * (was about 15.52 MiB).
 *
 * v108 change vs v107: precache shrinks to the app shell + 33 UI
 * images only (37 entries). The 426 Maths solution screenshots
 * (images/m-*), CA/GA bank images (images/cabank-*, images/gabank-*)
 * and all 17 report images (images/rep-*, formerly base64-embedded
 * in the solution text) are NOT precached — they load on demand
 * over the network when their question/solution is shown. Install
 * drops from about 15.52 MiB to about 7.79 MiB. The 17 base64
 * solution images were extracted to repo files (images/rep-*.jpg/
 * .png) with relative URLs, so index.html itself shrinks by ~1.9 MB.
 *
 * Revisions: every precache entry has a content revision recorded in
 * precache-list.json (37 entries). Image and icon revisions are the
 * first 12 chars of the file's git blob SHA in repo
 * shailuk2023-create/testpro @ main (tree 15a68a8b8a73...);
 * 'index.html' uses revision 'v108' and 'manifest.json' uses
 * revision 'v107' because the v108 file content does not exist in
 * the repo yet (manifest.json is unchanged since v107). PRECACHE_REV below is a
 * copy of that same mapping, so this file changes whenever the list
 * changes and the browser re-installs it. If any precache fetch fails,
 * install fails atomically and the browser retries on the next visit.
 *
 * NO push / notificationclick / sync / periodicSync handlers here —
 * push lives entirely in push/sw.js (scope 'push/'), which must never
 * be touched by this worker.
 */
'use strict';

var CACHE = 'testpro-v115';

/* Full precache URL list (37 entries). Revisions live in
   precache-list.json and are mirrored in PRECACHE_REV below. */
var PRECACHE = [
  'index.html',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'images/ui-001.webp',
  'images/ui-002.webp',
  'images/ui-003.webp',
  'images/ui-004.webp',
  'images/ui-005.webp',
  'images/ui-006.webp',
  'images/ui-007.webp',
  'images/ui-008.webp',
  'images/ui-009.webp',
  'images/ui-010.webp',
  'images/ui-011.webp',
  'images/ui-012.webp',
  'images/ui-013.webp',
  'images/ui-014.webp',
  'images/ui-015.webp',
  'images/ui-016.webp',
  'images/ui-017.webp',
  'images/ui-018.webp',
  'images/ui-019.webp',
  'images/ui-020.webp',
  'images/ui-021.webp',
  'images/ui-022.webp',
  'images/ui-023.webp',
  'images/ui-024.webp',
  'images/ui-025.webp',
  'images/ui-026.webp',
  'images/ui-027.webp',
  'images/ui-028.webp',
  'images/ui-029.webp',
  'images/ui-030.webp',
  'images/ui-031.webp',
  'images/ui-032.webp',
  'images/ui-033.webp'
];

/* url -> revision (git blob SHA, first 12 chars; 'v108' for
   'index.html' and 'v107' for 'manifest.json' — see header comment). */
var PRECACHE_REV = {
  'index.html': 'v110',
  'manifest.json': 'v107',
  'icon-192.png': 'f6ba28916a1c',
  'icon-512.png': '5755abd73ea3',
  'images/ui-001.webp': 'c3d41dbadbea',
  'images/ui-002.webp': '95db839cee0a',
  'images/ui-003.webp': '95db839cee0a',
  'images/ui-004.webp': 'e382b7274cbe',
  'images/ui-005.webp': '00ab1d2fb916',
  'images/ui-006.webp': 'e382b7274cbe',
  'images/ui-007.webp': '00ab1d2fb916',
  'images/ui-008.webp': 'c9088404fc1b',
  'images/ui-009.webp': '36142295e8db',
  'images/ui-010.webp': '5762422a1056',
  'images/ui-011.webp': '668888dd0b38',
  'images/ui-012.webp': '0f59eb2e5993',
  'images/ui-013.webp': '4991b48ac07b',
  'images/ui-014.webp': '1b0529c67a64',
  'images/ui-015.webp': 'd2a9a4f8f160',
  'images/ui-016.webp': 'a2e315cc28f2',
  'images/ui-017.webp': '23be341a4690',
  'images/ui-018.webp': '329ebea57148',
  'images/ui-019.webp': '4e95e8a5ed18',
  'images/ui-020.webp': '5dec8061e2ed',
  'images/ui-021.webp': 'd10b85692444',
  'images/ui-022.webp': 'c618f40363fd',
  'images/ui-023.webp': 'b6578dba75ac',
  'images/ui-024.webp': '0ae7d3d34389',
  'images/ui-025.webp': '3c447b36dc91',
  'images/ui-026.webp': '1704648d09ba',
  'images/ui-027.webp': '315d13a5e187',
  'images/ui-028.webp': '49f04bd9d08b',
  'images/ui-029.webp': '3c4510bb6366',
  'images/ui-030.webp': '03e330d2e1a1',
  'images/ui-031.webp': '50a69eb8e416',
  'images/ui-032.webp': 'b2313a73d2d5',
  'images/ui-033.webp': '5b42da93f544'
};

/* Install: atomic precache of the whole list, then take over at once.
   If ANY addAll fetch fails, install fails and the browser retries
   the install on the next visit — a half-filled cache is never used. */
self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE)
      .then(function (c) { return c.addAll(PRECACHE); })
      .then(function () { return self.skipWaiting(); })
  );
});

/* Activate: delete ONLY old versioned app caches ('testpro-v*' except
   this one). 'testpro-images-v1' (the app's in-page image cache) starts
   with 'testpro-i', not 'testpro-v', so the prefix test leaves it alone,
   as it does any other cache. Then claim all clients immediately. */
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k !== CACHE && k.indexOf('testpro-v') === 0;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* Belt-and-braces with the auto-skipWaiting() in install: the app's
   update flow posts { type: 'SKIP_WAITING' } to the waiting worker,
   which activates it immediately instead of waiting for all tabs
   to close. */
self.addEventListener('message', function (e) {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;

  var url = new URL(e.request.url);

  /* version.txt: network-only passthrough, NO cache read or put.
     The app polls version.txt with cache:'no-store' for update checks;
     a stale cached copy would hide a new version and break updates. */
  if (url.pathname.endsWith('/version.txt')) {
    e.respondWith(fetch(e.request));
    return;
  }

  /* Cross-origin: do not intercept (Firebase, Google APIs, fonts,
     hotlinked news images in CA/GA solutions, etc.). */
  if (url.origin !== self.location.origin) return;

  if (e.request.mode === 'navigate') {
    /* Network-first for navigations: fresh HTML when online, cached
       copy when offline. Only cache successful same-origin ('basic')
       responses. */
    e.respondWith(
      fetch(e.request).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(e.request).then(function (hit) {
          if (hit) return hit;
          /* './' is no longer precached (it duplicates index.html, so
             precaching both fetched the same 8.5 MB file twice). A root
             navigation ('/testpro/') would miss under its own cache key,
             so try the precached 'index.html' key next before the
             ignoreSearch attempt. */
          return caches.match('index.html').then(function (shell) {
            if (shell) return shell;
            return caches.match(e.request, { ignoreSearch: true });
          });
        });
      })
    );
    return;
  }

  /* Same-origin non-navigation GET: cache-first. On a miss, fetch and
     store successful same-origin ('basic') responses for next time. */
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      if (hit) return hit;
      return fetch(e.request).then(function (res) {
        if (res && res.ok && res.type === 'basic') {
          var copy = res.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        }
        return res;
      }).catch(function () { return undefined; });
    })
  );
});
