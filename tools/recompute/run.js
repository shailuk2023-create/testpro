'use strict';
/* ============================================================================
   TESTPRO — GitHub Actions runner: recompute ALL users' leaderboard coins
   ----------------------------------------------------------------------------
   Reads every user's attempts + engagement coins object from Firestore,
   recomputes the total with the v69 formula (recompute.js — the exact port
   of the app master, APP_VERSION 69), and writes back ONLY
   {coins: <new total>, u: <now ms>} to leaderboard/{uid} (merge:true).

   Never touches leaderboard fields t / name / avatar / q / att / tn / avg /
   rating / acc. Users with no attempts are SKIPPED (never zeroed).
   If the engagement coins object needed the v68 /10 migration, the migrated
   object is written back to users/{uid}/profile/data (field `coins`,
   merge:true) so it is never divided twice.

   v70 ledger repair: a stored engagement `eng` can be stale old-scale
   (~395 instead of ~39.5) even with engV68 already true (the sync-merge
   max-rule resurrected the pre-v68 value while the flag blocked a second
   /10). Before computing the total, eng is re-derived from the per-day
   ledger (days[].open + capped usage/sol) and repaired when the ledger
   proves it stale — the SAME rule as the app-side v70 repair (Worker A).
   A repaired eng is written back to users/{uid}/profile/data (field
   `coins`, merge:true) so the app sees it on next pull, and the repair is
   logged old -> new per user.

   v70 scope: run.js ONLY. recompute.js (the formula) is byte-identical to
   functions/recompute.js and is NOT touched; the workflow .yml and
   package.json are unchanged.

   Credentials: the service account JSON is read ONLY from the environment
   variable FIREBASE_SERVICE_ACCOUNT_JSON (a JSON string). No key file is
   read by default and no credential is hardcoded.

   Usage (GitHub Actions):
     FIREBASE_SERVICE_ACCOUNT_JSON='<service-account-json>' node run.js
   ========================================================================== */

var recompute = require('./recompute');
var computeUserTotal = recompute.computeUserTotal;
var getMigratedCoinsObj = recompute.getMigratedCoinsObj;
var ENG_USAGE_DAILY_CAP = recompute.ENG_USAGE_DAILY_CAP;
var ENG_USAGE_BUCKET_SECS = recompute.ENG_USAGE_BUCKET_SECS;
var ENG_SOLUTION_DAILY_CAP = recompute.ENG_SOLUTION_DAILY_CAP;
var ENG_SOLUTION_PER_Q = recompute.ENG_SOLUTION_PER_Q;

/* ---- Firestore access helpers (work with real firebase-admin Firestore
   AND with a mock that exposes collection(name).doc(id).get()/set() plus
   a way to list all docs in a collection) ---- */

/* Resolve a collection reference from a '/'-separated path.
   Real Firestore accepts a multi-segment path in collection(); a mock
   that only supports single-segment names gets the nested
   collection().doc().collection() walk instead. */
function collectionRef(db, path){
  if (typeof db.collection === 'function'){
    try {
      var ref = db.collection(path);
      if (ref) return ref;
    } catch (e) { /* fall through to the nested walk */ }
  }
  var parts = path.split('/').filter(Boolean);
  var cur = db;
  for (var i = 0; i < parts.length; i += 2){
    cur = cur.collection(parts[i]);
    if (i + 1 < parts.length) cur = cur.doc(parts[i + 1]);
  }
  return cur;
}

/* Resolve a document reference from a '/'-separated path. */
function docRef(db, path){
  if (typeof db.doc === 'function'){
    try {
      var ref = db.doc(path);
      if (ref) return ref;
    } catch (e) { /* fall through to the nested walk */ }
  }
  var parts = path.split('/').filter(Boolean);
  var cur = db;
  for (var i = 0; i < parts.length; i += 2){
    cur = cur.collection(parts[i]).doc(parts[i + 1]);
  }
  return cur;
}

/* List all docs in a collection. Returns [{id, data}] where data is the
   plain document object ({} when the doc does not exist / has no data).
   Accepts: QuerySnapshot with .docs (each with .id and .data()), a plain
   array of docs, a snapshot with .forEach, or a ref exposing
   .listDocuments() (then each doc ref is fetched with .get()). */
async function listDocs(ref){
  var snap;
  if (typeof ref.get === 'function'){
    snap = await ref.get();
  } else if (typeof ref.listDocuments === 'function'){
    var docRefs = await ref.listDocuments();
    var out = [];
    for (var i = 0; i < docRefs.length; i++){
      var d = await docRefs[i].get();
      out.push({id: docRefs[i].id, data: (d && typeof d.data === 'function') ? (d.data() || {}) : {}});
    }
    return out;
  } else {
    throw new Error('collection reference has neither get() nor listDocuments()');
  }
  if (Array.isArray(snap)) {
    return snap.map(function(d){
      return {id: d.id, data: (typeof d.data === 'function') ? (d.data() || {}) : (d.data || {})};
    });
  }
  if (snap && Array.isArray(snap.docs)){
    return snap.docs.map(function(d){
      return {id: d.id, data: (typeof d.data === 'function') ? (d.data() || {}) : {}};
    });
  }
  if (snap && typeof snap.forEach === 'function'){
    var docs = [];
    snap.forEach(function(d){
      docs.push({id: d.id, data: (typeof d.data === 'function') ? (d.data() || {}) : {}});
    });
    return docs;
  }
  throw new Error('unrecognised snapshot shape from collection get()');
}

/* Read one document. Returns the plain data object, or null when the
   document does not exist. */
async function getDocData(ref){
  var snap = await ref.get();
  if (!snap) return null;
  if (typeof snap.exists === 'boolean' && !snap.exists) return null;
  if (typeof snap.data === 'function'){
    var data = snap.data();
    return (data == null) ? null : data;
  }
  return snap;
}

/* ============================================================================
   v70 — ledger-based repair of a stale old-scale engagement `eng`
   ----------------------------------------------------------------------------
   Bug: a profile can hold eng ~395 (old v59–v68 scale) with engV68 already
   true, because the sync-merge max-rule resurrected the pre-v68 value
   while the flag blocked re-division. The v68 migration alone therefore
   cannot fix it, and the recompute must not trust the stored eng.

   Repair rule (identical to the app-side v70 repair, Worker A):
     ledgerSum = sum over coins.days of
       open + min(10, floor(usageSecs/600)) + min(5, 0.5 * solIds.length)
     - empty / missing ledger  -> keep eng (nothing proves staleness)
     - eng < ledgerSum         -> eng := ledgerSum
     - eng > ledgerSum AND |eng/10 - ledgerSum| < |eng - ledgerSum|
                               -> eng := eng/10
     - otherwise               -> keep eng
   The repair runs on the EFFECTIVE coins object (after the v68 /10
   migration, so days[].open is already new-scale, matching the usage/sol
   caps) and never mutates its input. All values are 1-decimal.
   ========================================================================== */
function r1(x){ return Math.round(x * 10) / 10; }

function deepCopyCoins(v){
  return (v === undefined || v === null) ? v : JSON.parse(JSON.stringify(v));
}

/* Re-derive lifetime engagement from the per-day ledger (the source of
   truth for what the user actually earned). Per day: the stored open
   award + usage coins re-derived from usageSecs (+1 per 10 min, cap 10)
   + solution coins re-derived from solIds (+0.5 per unique question,
   cap 5). Returns null when there is no usable ledger (no days object,
   empty, or no day with any usable field) so the caller keeps eng. */
function ledgerEngagementSum(coinsObj){
  if (!coinsObj || typeof coinsObj !== 'object') return null;
  var days = coinsObj.days;
  if (!days || typeof days !== 'object' || Array.isArray(days)) return null;
  var keys = Object.keys(days);
  if (!keys.length) return null;
  var sum = 0;
  var sawDay = false;
  var i, d, open, usageSecs, usage, solCount, sol;
  for (i = 0; i < keys.length; i++){
    d = days[keys[i]];
    if (!d || typeof d !== 'object') continue;
    open = (typeof d.open === 'number' && isFinite(d.open)) ? d.open : 0;
    usageSecs = (typeof d.usageSecs === 'number' && isFinite(d.usageSecs)) ? d.usageSecs : 0;
    if (Array.isArray(d.solIds)) solCount = d.solIds.length;
    else if (typeof d.solIds === 'number' && isFinite(d.solIds)) solCount = d.solIds;
    else solCount = 0;
    if (typeof d.open === 'number' || typeof d.usageSecs === 'number' || d.solIds != null) sawDay = true;
    usage = Math.min(ENG_USAGE_DAILY_CAP, Math.floor(usageSecs / ENG_USAGE_BUCKET_SECS));
    sol = Math.min(ENG_SOLUTION_DAILY_CAP, ENG_SOLUTION_PER_Q * solCount);
    sum += open + usage + sol;
  }
  if (!sawDay) return null;
  return r1(sum);
}

/* Decide whether the stored eng (on the EFFECTIVE, post-migration coins
   object) is stale against the ledger. Returns
   {changed, oldEng, newEng, ledgerSum}. Never mutates its input.
   A non-numeric / missing eng counts as 0 when a ledger exists. */
function repairEngagement(coinsObj){
  var none = {changed: false, oldEng: null, newEng: null, ledgerSum: null};
  if (!coinsObj || typeof coinsObj !== 'object') return none;
  var ledgerSum = ledgerEngagementSum(coinsObj);
  if (ledgerSum == null) return none; /* empty ledger -> keep eng */
  var eng = (typeof coinsObj.eng === 'number' && isFinite(coinsObj.eng)) ? coinsObj.eng : 0;
  if (eng < ledgerSum){
    return {changed: true, oldEng: eng, newEng: r1(ledgerSum), ledgerSum: ledgerSum};
  }
  if (eng > ledgerSum){
    var divided = r1(eng / 10);
    if (Math.abs(divided - ledgerSum) < Math.abs(eng - ledgerSum)){
      return {changed: true, oldEng: eng, newEng: divided, ledgerSum: ledgerSum};
    }
  }
  return {changed: false, oldEng: eng, newEng: eng, ledgerSum: ledgerSum};
}

/* ============================================================================
   PUBLIC INTERFACE — async recomputeAllUsers(db)
   ========================================================================== */
async function recomputeAllUsers(db){
  if (!db) throw new Error('recomputeAllUsers(db): db is required');

  var leaderboardDocs = await listDocs(collectionRef(db, 'leaderboard'));
  var usersUpdated = 0;
  var usersSkipped = 0;
  var results = [];

  for (var i = 0; i < leaderboardDocs.length; i++){
    var entry = leaderboardDocs[i];
    var uid = entry.id;
    var lbData = entry.data || {};
    var oldCoins = (typeof lbData.coins === 'number') ? lbData.coins : null;

    try {
      /* (2a) ALL attempts for this user. */
      var attemptDocs = await listDocs(collectionRef(db, 'users/' + uid + '/attempts'));
      var attempts = attemptDocs.map(function(d){ return d.data; });

      /* (6) SKIP users with no attempts — never zero them. */
      if (!attempts.length){
        usersSkipped++;
        console.log('[skip] ' + uid + ': no attempts (kept coins=' + oldCoins + ')');
        continue;
      }

      /* (2b) Engagement coins object from users/{uid}/profile/data. */
      var profileData = await getDocData(docRef(db, 'users/' + uid + '/profile/data'));
      var coinsObj = (profileData && profileData.coins != null) ? profileData.coins : null;

      /* (3) Recompute with the v69 formula. */
      var computed = computeUserTotal(attempts, coinsObj);

      /* (3b) v70 ledger repair: the stored eng may be stale old-scale
         even with engV68 already true. Repair it from the per-day ledger
         (same rule as the app-side v70 repair) and use the repaired eng
         for the total. The repair runs on the EFFECTIVE (post-migration)
         coins object, so days[].open is new-scale. */
      var effectiveCoins = getMigratedCoinsObj(coinsObj);
      var repair = repairEngagement(effectiveCoins);
      var engagement = repair.changed ? repair.newEng : computed.engagement;
      var newCoins = r1(computed.testCoins + engagement);

      /* (4) Write ONLY {coins, u} to the leaderboard doc (merge:true). */
      await collectionRef(db, 'leaderboard').doc(uid).set(
        {coins: newCoins, u: Date.now()},
        {merge: true}
      );

      /* (5) Persist the engagement object when it was migrated (engV68)
         and/or repaired (v70 ledger repair), so the app sees the repaired
         value on next pull and the fix is never applied twice. The write
         is a deep copy with the repaired eng set — the stored object is
         never mutated in place. */
      if (computed.engagementMigrated || repair.changed){
        var toPersist = deepCopyCoins(effectiveCoins);
        if (repair.changed) toPersist.eng = repair.newEng;
        await docRef(db, 'users/' + uid + '/profile/data').set(
          {coins: toPersist},
          {merge: true}
        );
        if (computed.engagementMigrated){
          console.log('[migrate] ' + uid + ': engagement coins object migrated to v68 scale');
        }
        if (repair.changed){
          console.log('[repair] ' + uid + ': eng ' + repair.oldEng + ' -> ' + repair.newEng + ' (ledger ' + repair.ledgerSum + ')');
        }
      }

      /* (7) Log old -> new total. */
      console.log('[update] ' + uid + ': ' + oldCoins + ' -> ' + newCoins);
      usersUpdated++;
      results.push({uid: uid, oldCoins: oldCoins, newCoins: newCoins,
        engRepair: repair.changed ? {oldEng: repair.oldEng, newEng: repair.newEng, ledgerSum: repair.ledgerSum} : null});
    } catch (err){
      /* One bad user must not abort the whole run; the error is logged
         and the user is counted as skipped (their coins are untouched). */
      console.error('[error] ' + uid + ': ' + (err && err.message ? err.message : err));
      usersSkipped++;
    }
  }

  return {usersUpdated: usersUpdated, usersSkipped: usersSkipped, results: results};
}

module.exports = {recomputeAllUsers: recomputeAllUsers, repairEngagement: repairEngagement, ledgerEngagementSum: ledgerEngagementSum};

/* ---- Direct run: node run.js --------------------------------------------
   Service account JSON comes ONLY from env var
   FIREBASE_SERVICE_ACCOUNT_JSON. Prints the JSON summary to stdout,
   exits 0 on success, non-zero on fatal error. ---------------------------- */
async function main(){
  var raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw){
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON env var is not set');
  }
  var serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch (e){
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + e.message);
  }
  /* firebase-admin is required lazily so that require('./run') works in
     test harnesses (Worker B mocks) without firebase-admin installed. */
  var admin = require('firebase-admin');
  if (admin.apps.length === 0){
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
  var db = admin.firestore();
  var summary = await recomputeAllUsers(db);
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module){
  main().then(function(){
    process.exit(0);
  }).catch(function(err){
    console.error('FATAL: ' + (err && err.message ? err.message : err));
    process.exit(1);
  });
}
