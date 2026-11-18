'use strict';
/* ============================================================================
   TESTPRO — automatic notifications (GitHub Actions + Firestore + Web Push)
   ----------------------------------------------------------------------------
   Runs on a schedule (see .github/workflows/notifications.yml) and sends:
     1. Inactivity — a user with no attempt in the last 2 days gets a nudge
        (target = their uid). At most once per user per 3 days, and only if
        their last attempt was within the last 30 days (no nagging quitters).
     2. Topper change — a DIFFERENT user became #1 vs meta/topper.
        The same user staying #1 (even with more coins) sends nothing;
        only the meta baseline is updated.
        Same doc id (topper-<uid>-<coins>) and same meta guard as the in-app
        fast path, so the two never double-send. First run records the
        baseline only — no notification.
     3. Top-3 milestone — a user entering the leaderboard top 3 for the first
        time gets a congrats (target = their uid). First run records the
        baseline only — no notification.
     4. 7-day streak — attempts on 7 consecutive days (ending today or
        yesterday) gets a "7 din ki streak!" (target = their uid). Notified
        once per streak end date.
     5. Manual announcement — MODE=announce with ANNOUNCE_TITLE /
        ANNOUNCE_BODY (from workflow_dispatch inputs).
     6. Report corrections — fixed-report notifications recorded by the
        report-check cron in tools/notifications/report_notifs_pending.json
        (mirrored from the workspace pending file) are delivered here
        (target = the reporter uid). Runs in 'all'/'conditions' only, never
        in 'announce'. Doc id 'report-<responseId>' dedups, so a re-run
        never resends an already-delivered report notification.

   Every notification is BOTH a Firestore doc in `notifications`
   (the app bell reads it: {type, title, body, target, createdAt (ms
   number), data}) AND a Web Push to the matching subscriptions in
   `push_subscriptions/{deviceId}` ({endpoint, p256dh, auth, uid}).
   A user with no push subscription still sees the bell doc when they
   open the app. Subscriptions answering 404/410 are deleted.

   Modes (env MODE, default 'all'):
     all         all condition checks (topper / inactivity / milestone / streak)
     conditions  only topper / inactivity / milestone / streak
     announce    only a manual announcement (needs ANNOUNCE_TITLE + BODY)
   DRY_RUN=true  detect + log what WOULD be sent; write nothing, push nothing.

   Secrets (env, NEVER hardcoded): FIREBASE_SERVICE_ACCOUNT_JSON (required,
   JSON string), VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
   (needed only to send pushes; if missing, docs are still written and
   pushes are skipped with a warning — the run does not fail).
   APP_URL defaults to the Pages root.

   Defensive by design: each notification section is wrapped so one bad
   user/doc never aborts the run; empty collections and missing fields are
   skipped quietly; the run exits 0 unless the service account is missing
   or invalid. The final line is a JSON summary for the Actions log.
   ========================================================================== */

var admin = require('firebase-admin');
var webpush = require('web-push');

var APP_URL = process.env.APP_URL || 'https://shailuk2023-create.github.io/testpro/';
var IST_OFFSET_MS = 5.5 * 3600 * 1000;
var DAY_MS = 24 * 3600 * 1000;

/* ---- IST helpers (pure) ---- */
function istParts(ms) {
  var d = new Date(ms + IST_OFFSET_MS);
  return {
    date: d.toISOString().slice(0, 10),          /* YYYY-MM-DD in IST */
    hour: d.getUTCHours(),                        /* 0-23 in IST */
    weekday: d.getUTCDay()                        /* 0=Sun .. 6=Sat in IST */
  };
}
function istDate(ms) { return istParts(ms).date; }
function shiftDate(dateStr, days) {
  /* dateStr 'YYYY-MM-DD' (IST) shifted by N days, returned as 'YYYY-MM-DD'. */
  var base = Date.parse(dateStr + 'T00:00:00Z') + days * DAY_MS;
  return new Date(base).toISOString().slice(0, 10);
}

/* ---- streak detection (pure): distinct IST dates -> streak end or null ---- */
function detectStreakEnd(dateList, todayStr) {
  var set = {};
  (dateList || []).forEach(function (d) { if (d) set[d] = true; });
  var ends = [todayStr, shiftDate(todayStr, -1)];
  for (var e = 0; e < ends.length; e++) {
    var end = ends[e];
    var ok = true;
    for (var i = 0; i < 7; i++) {
      if (!set[shiftDate(end, -i)]) { ok = false; break; }
    }
    if (ok) return end;
  }
  return null;
}

function fail(msg) { console.error('FATAL: ' + msg); process.exit(1); }

async function main() {
  var mode = String(process.env.MODE || 'all').toLowerCase();
  var dryRun = String(process.env.DRY_RUN || 'false') === 'true';
  var now = Date.now();
  var today = istDate(now);

  var saRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!saRaw) fail('FIREBASE_SERVICE_ACCOUNT_JSON secret is not set');
  var serviceAccount;
  try { serviceAccount = JSON.parse(saRaw); }
  catch (e) { fail('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON'); }
  if (admin.apps.length === 0) {
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  }
  var db = admin.firestore();

  var vapidPublic = process.env.VAPID_PUBLIC_KEY || '';
  var vapidPrivate = process.env.VAPID_PRIVATE_KEY || '';
  var vapidSubject = process.env.VAPID_SUBJECT || '';
  var pushReady = Boolean(vapidPublic && vapidPrivate && vapidSubject);
  if (!pushReady) console.log('WARN: VAPID secrets incomplete — notification docs will still be written, pushes skipped');

  var summary = {
    mode: mode, dryRun: dryRun, istDate: today,
    topper: 'skipped', inactivity: [], milestone: [],
    streak: [], report: [], announcement: 'skipped',
    push: { sent: 0, failed: 0, deletedExpired: 0, skippedNoVapid: 0 },
    errors: []
  };

  /* ---- shared: load subscriptions once (for push fan-out) ---- */
  var subs = [];
  try {
    var subSnap = await db.collection('push_subscriptions').limit(5000).get();
    subSnap.forEach(function (d) {
      var s = d.data() || {};
      if (s.endpoint && s.p256dh && s.auth) {
        subs.push({ id: d.id, uid: s.uid || '', endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } });
      }
    });
  } catch (e) { summary.errors.push('subscriptions-load: ' + (e && e.message)); }

  /* ---- push helper: send to a list of subs, delete 404/410 ---- */
  async function fanOut(title, body, targetUid, urgency) {
    var list = targetUid ? subs.filter(function (s) { return s.uid === targetUid; }) : subs.slice();
    if (!list.length) return { sent: 0, failed: 0, deleted: 0, note: 'no-subscribers' };
    if (!pushReady) {
      summary.push.skippedNoVapid += list.length;
      return { sent: 0, failed: 0, deleted: 0, note: 'no-vapid' };
    }
    if (dryRun) return { sent: 0, failed: 0, deleted: 0, note: 'dry-run-would-send-' + list.length };
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    var payload = JSON.stringify({ title: title, body: body, url: APP_URL });
    var sent = 0, failed = 0, deleted = 0;
    var BATCH = 25;
    for (var i = 0; i < list.length; i += BATCH) {
      var slice = list.slice(i, i + BATCH);
      var results = await Promise.all(slice.map(function (s) {
        return webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 60 * 60 * 24, urgency: urgency || 'normal' })
          .then(function () { return 'sent'; })
          .catch(function (err) {
            if (err && (err.statusCode === 404 || err.statusCode === 410)) return 'expired:' + s.id;
            return 'failed';
          });
      }));
      for (var j = 0; j < results.length; j++) {
        if (results[j] === 'sent') sent++;
        else if (results[j] === 'failed') failed++;
        else if (results[j].indexOf('expired:') === 0) {
          deleted++;
          try { await db.collection('push_subscriptions').doc(results[j].slice(8)).delete(); } catch (e) {}
        }
      }
    }
    summary.push.sent += sent;
    summary.push.failed += failed;
    summary.push.deletedExpired += deleted;
    return { sent: sent, failed: failed, deleted: deleted };
  }

  /* ---- write helper: deterministic id, skip if already sent ---- */
  async function writeNotif(docId, doc) {
    var ref = db.doc('notifications/' + docId);
    var ex = await ref.get();
    if (ex.exists) return false;
    if (dryRun) return 'would-write';
    await ref.set(doc);
    return true;
  }

  /* ================= 1. MANUAL ANNOUNCEMENT ================= */
  if (mode === 'announce') {
    try {
      var aTitle = String(process.env.ANNOUNCE_TITLE || '').trim();
      var aBody = String(process.env.ANNOUNCE_BODY || '').trim();
      if (!aTitle || !aBody) {
        summary.announcement = 'skipped-missing-title-or-body';
      } else {
        var aId = 'announce-' + now;
        var aWrote = await writeNotif(aId, {
          type: 'announcement', title: aTitle, body: aBody,
          target: 'all', createdAt: now, data: {}
        });
        if (aWrote) {
          await fanOut(aTitle, aBody, '', 'high');
          summary.announcement = dryRun ? 'dry-run-would-send' : 'sent';
        } else summary.announcement = 'skipped-doc-exists';
      }
    } catch (e) { summary.errors.push('announcement: ' + (e && e.message)); summary.announcement = 'error'; }
  }

  /* ================= 2. CONDITION CHECKS ================= */
  if (mode === 'all' || mode === 'conditions') {
    /* ---- load leaderboard (coins desc, then q desc — same as the app) ---- */
    var entries = [];
    try {
      var lbSnap = await db.collection('leaderboard').get();
      lbSnap.forEach(function (d) {
        var x = d.data() || {};
        if (typeof x.coins !== 'number') return;
        entries.push({ uid: d.id, name: String(x.name || 'Student').slice(0, 24), coins: x.coins, q: +x.q || 0 });
      });
      entries.sort(function (a, b) { return (b.coins - a.coins) || (b.q - a.q); });
    } catch (e) { summary.errors.push('leaderboard-load: ' + (e && e.message)); }

    /* ---- user list = leaderboard uids + subscription uids ---- */
    var uidSet = {};
    entries.forEach(function (e) { uidSet[e.uid] = true; });
    subs.forEach(function (s) { if (s.uid) uidSet[s.uid] = true; });
    var uids = Object.keys(uidSet);

    /* ---- 2a. TOPPER CHANGE (meta/topper guard, same as in-app path) ---- */
    try {
      if (!entries.length) {
        summary.topper = 'skipped-no-users';
      } else {
        var top = entries[0];
        var metaRef = db.doc('meta/topper');
        var metaSnap = await metaRef.get();
        var md = metaSnap.exists ? (metaSnap.data() || {}) : null;
        if (!md || !md.uid) {
          if (!dryRun) await metaRef.set({ uid: top.uid, name: top.name, coins: top.coins, updatedAt: now }, { merge: true });
          summary.topper = dryRun ? 'dry-run-baseline-would-record' : 'first-run-baseline-recorded';
        } else if (md.uid === top.uid) {
          // Same user still #1 — only their coins grew. Update the meta
          // baseline, but send NO notification: a topper notification goes
          // out only when a DIFFERENT user becomes #1.
          if (!dryRun) await metaRef.set({ uid: top.uid, name: top.name, coins: top.coins, updatedAt: now }, { merge: true });
          summary.topper = 'unchanged-same-user';
        } else {
          var tTitle = 'New leaderboard topper!';
          var tBody = top.name + ' now leads with ' + top.coins + ' coins!';
          var tId = 'topper-' + top.uid + '-' + top.coins;
          var tWrote = await writeNotif(tId, {
            type: 'topper', title: tTitle, body: tBody, target: 'all',
            createdAt: now, data: { topperUid: top.uid, topperName: top.name, coins: top.coins }
          });
          if (tWrote) {
            if (!dryRun) await metaRef.set({ uid: top.uid, name: top.name, coins: top.coins, updatedAt: now }, { merge: true });
            await fanOut(tTitle, tBody, '', 'high');
            summary.topper = dryRun ? 'dry-run-would-send' : 'sent';
          } else summary.topper = 'skipped-doc-exists';
        }
      }
    } catch (e) { summary.errors.push('topper: ' + (e && e.message)); summary.topper = 'error'; }

    /* ---- 2b. TOP-3 MILESTONE (first time only; baseline on first run) ---- */
    try {
      var top3 = entries.slice(0, 3).map(function (e) { return e.uid; });
      var mRef = db.doc('notifications_meta/top3');
      var mSnap = await mRef.get();
      if (!mSnap.exists) {
        var notified0 = {};
        top3.forEach(function (u) { notified0[u] = true; });
        if (!dryRun) await mRef.set({ notified: notified0, updatedAt: now }, { merge: true });
        summary.milestone.push(dryRun ? 'dry-run-baseline-would-record' : 'first-run-baseline-recorded');
      } else {
        var notified = ((mSnap.data() || {}).notified) || {};
        var changed = false;
        for (var mi = 0; mi < top3.length; mi++) {
          var mu = top3[mi];
          if (notified[mu]) continue;
          var mEntry = null;
          for (var ei = 0; ei < entries.length; ei++) { if (entries[ei].uid === mu) { mEntry = entries[ei]; break; } }
          var mTitle = 'Top 3 me pahunch gaye! \uD83C\uDFC6';
          var mBody = (mEntry ? mEntry.name : 'Student') + ', badhai ho! Aap leaderboard ke top 3 me hain \u2014 aise hi aage badhte raho! \uD83C\uDF89';
          var mId = 'milestone-top3-' + mu;
          var mWrote = await writeNotif(mId, {
            type: 'milestone', title: mTitle, body: mBody, target: mu,
            createdAt: now, data: { uid: mu, rank: mi + 1 }
          });
          if (mWrote) {
            notified[mu] = true; changed = true;
            await fanOut(mTitle, mBody, mu, 'high');
            summary.milestone.push(dryRun ? ('dry-run-would-send:' + mu) : ('sent:' + mu));
          }
        }
        if (changed && !dryRun) await mRef.set({ notified: notified, updatedAt: now }, { merge: true });
        if (!summary.milestone.length) summary.milestone.push('none-new');
      }
    } catch (e) { summary.errors.push('milestone: ' + (e && e.message)); summary.milestone.push('error'); }

    /* ---- 2c. INACTIVITY + 2d. STREAK (per user, from attempts) ---- */
    var twoDaysAgo = shiftDate(today, -2);
    var thirtyDaysAgo = shiftDate(today, -30);
    var tenDaysAgoMs = now - 10 * DAY_MS;
    for (var ui = 0; ui < uids.length; ui++) {
      var uid = uids[ui];
      try {
        /* latest attempt (for inactivity) */
        var lastSnap = await db.collection('users/' + uid + '/attempts').orderBy('ts', 'desc').limit(1).get();
        var lastTs = null;
        lastSnap.forEach(function (d) {
          var dd = d.data() || {};
          if (typeof dd.ts === 'number') lastTs = dd.ts;
          else {
            var tail = String(d.id).split('_').pop();
            var parsed = parseInt(tail, 10);
            if (isFinite(parsed) && parsed > 1000000000000) lastTs = parsed;
          }
        });
        if (lastTs == null) continue; /* never attempted — do not nag */
        var lastDate = istDate(lastTs);

        /* inactivity: no attempt in the last 2 days, last attempt within 30 days */
        if (lastDate <= twoDaysAgo && lastDate >= thirtyDaysAgo) {
          var inRef = db.doc('notifications_meta/inactivity-' + uid);
          var inSnap = await inRef.get();
          var inData = inSnap.exists ? (inSnap.data() || {}) : {};
          var lastSent = inData.lastSent || '';
          if (!lastSent || lastSent <= shiftDate(today, -3)) {
            var lbName = 'Student';
            for (var li = 0; li < entries.length; li++) { if (entries[li].uid === uid) { lbName = entries[li].name; break; } }
            var iTitle = '2 din se attempt nahi kiya \uD83D\uDE14';
            var iBody = lbName + ', 2 din ho gaye \u2014 ek chhota sa quiz attempt karo, wapas track par aao! \uD83D\uDCAA';
            var iId = 'inactivity-' + uid + '-' + today;
            var iWrote = await writeNotif(iId, {
              type: 'inactivity', title: iTitle, body: iBody, target: uid,
              createdAt: now, data: { uid: uid, lastAttemptDate: lastDate }
            });
            if (iWrote) {
              if (!dryRun) await inRef.set({ lastSent: today, updatedAt: now }, { merge: true });
              await fanOut(iTitle, iBody, uid, 'normal');
              summary.inactivity.push(dryRun ? ('dry-run-would-send:' + uid) : ('sent:' + uid));
            }
          }
        }

        /* streak: 7 consecutive days ending today or yesterday */
        var recentSnap = await db.collection('users/' + uid + '/attempts')
          .where('ts', '>=', tenDaysAgoMs).orderBy('ts', 'desc').limit(200).get();
        var dates = [];
        recentSnap.forEach(function (d) {
          var dd = d.data() || {};
          if (typeof dd.ts === 'number') dates.push(istDate(dd.ts));
        });
        var streakEnd = detectStreakEnd(dates, today);
        if (streakEnd) {
          var stRef = db.doc('notifications_meta/streak-' + uid);
          var stSnap = await stRef.get();
          var stData = stSnap.exists ? (stSnap.data() || {}) : {};
          if (stData.lastEnd !== streakEnd) {
            var sName = 'Student';
            for (var si = 0; si < entries.length; si++) { if (entries[si].uid === uid) { sName = entries[si].name; break; } }
            var sTitle = '7 din ki streak! \uD83D\uDD25';
            var sBody = sName + ', 7 din lagatar attempt \u2014 kamaal ki consistency! Streak jari rakho! \uD83D\uDD25';
            var sId = 'streak7-' + uid + '-' + streakEnd;
            var sWrote = await writeNotif(sId, {
              type: 'streak', title: sTitle, body: sBody, target: uid,
              createdAt: now, data: { uid: uid, streakEnd: streakEnd, days: 7 }
            });
            if (sWrote) {
              if (!dryRun) await stRef.set({ lastEnd: streakEnd, updatedAt: now }, { merge: true });
              await fanOut(sTitle, sBody, uid, 'high');
              summary.streak.push(dryRun ? ('dry-run-would-send:' + uid) : ('sent:' + uid));
            }
          }
        }
      } catch (e) {
        summary.errors.push('user-' + uid + ': ' + (e && e.message));
        continue;
      }
    }
    if (!summary.inactivity.length) summary.inactivity.push('none');
    if (!summary.streak.length) summary.streak.push('none');

    /* ---- 2e. REPORT CORRECTIONS (from report_notifs_pending.json) ---- */
    /* The report-check cron appends fixed-report notifications to the
       workspace pending file and mirrors it to the repo at
       tools/notifications/report_notifs_pending.json; this step delivers
       them (Firestore doc + Web Push) on the hourly run. Doc id is
       deterministic ('report-' + responseId) so a re-run never resends. */
    try {
      var fs = require('fs');
      var path = require('path');
      var reportFile = path.join(__dirname, 'report_notifs_pending.json');
      var reportRaw = null;
      try { reportRaw = fs.readFileSync(reportFile, 'utf8'); }
      catch (e) { console.log('report: pending file not found, skipping'); }
      if (reportRaw) {
        var reportEntries = null;
        try { reportEntries = JSON.parse(reportRaw); }
        catch (e) { console.log('report: pending file unparsable, skipping'); }
        if (Array.isArray(reportEntries)) {
          for (var ri = 0; ri < reportEntries.length; ri++) {
            var re = reportEntries[ri];
            if (!re || typeof re !== 'object') continue;
            if (typeof re.responseId !== 'string' || !re.responseId) continue;
            if (typeof re.target !== 'string' || !re.target) continue;
            if (re.sent === true) continue;
            var safeId = String(re.responseId).replace(/[^A-Za-z0-9_-]/g, '');
            if (!safeId) continue;
            var rTitle = (typeof re.title === 'string' && re.title) ? re.title : 'Report fix ho gayi';
            var rBody = (typeof re.body === 'string') ? re.body : '';
            var rId = 'report-' + safeId;
            var rWrote = await writeNotif(rId, {
              type: 'report', title: rTitle, body: rBody, target: re.target,
              createdAt: (typeof re.createdAt === 'number' ? re.createdAt : Date.now()),
              data: (re.data && typeof re.data === 'object') ? re.data : {}
            });
            if (rWrote) {
              await fanOut(rTitle, rBody, re.target, 'normal');
              summary.report.push('sent:' + re.responseId);
            } else {
              summary.report.push('skipped-exists:' + re.responseId);
            }
          }
        }
      }
      if (!summary.report.length) summary.report.push('none');
    } catch (e) { summary.errors.push('report: ' + (e && e.message)); summary.report.push('error'); }
  }

  console.log(JSON.stringify(summary));
}

if (require.main === module) {
  main().catch(function (err) {
    console.error('FATAL: ' + (err && err.message ? err.message : err));
    process.exit(1);
  });
}

module.exports = { istParts: istParts, istDate: istDate, shiftDate: shiftDate, detectStreakEnd: detectStreakEnd };
