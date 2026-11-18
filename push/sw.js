/* TESTPRO push service worker — sub-scope /testpro/push/.
   Owns Web Push for the app so system notifications arrive even when the
   app is closed (like SKQuizPro). Progressier's SW keeps controlling the
   app pages; this worker only handles push + notificationclick for the
   subscriptions created on ITS registration. No fetch handler — it never
   intercepts app traffic, so PWA install/offline via Progressier is
   untouched. No icon/badge is shown on purpose — the repo icons are the
   old "T" logo, so the notification shows only the app icon + text. */
var TP_APP_URL = 'https://shailuk2023-create.github.io/testpro/';
self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('push', function (event) {
  var p = { title: 'TESTPRO', body: '', url: TP_APP_URL };
  try {
    if (event.data) {
      var d = event.data.json();
      if (d) {
        if (d.title) p.title = String(d.title);
        if (d.body) p.body = String(d.body);
        if (d.url) p.url = String(d.url);
      }
    }
  } catch (e) {}
  event.waitUntil(
    self.registration.showNotification(p.title, {
      body: p.body,
      data: { url: p.url }
    })
  );
});
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || TP_APP_URL;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (clients) {
      for (var i = 0; i < clients.length; i++) {
        var c = clients[i];
        if (c.url && c.url.indexOf(self.location.origin) === 0) {
          if ('focus' in c) c.focus();
          if ('navigate' in c) { try { return c.navigate(targetUrl); } catch (e) {} }
          return;
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
