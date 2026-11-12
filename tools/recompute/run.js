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

   Credentials: the service account JSON is read ONLY from the environment
   variable FIREBASE_SERVICE_ACCOUNT_JSON (a JSON string). No key file is
   read by default and no credential is hardcoded.

   Usage (GitHub Actions):
     FIREBASE_SERVICE_ACCOUNT_JSON='<service-account-json>' node run.js
   ========================================================================== */

var recompute = require('./recompute');
var computeUserTotal = recompute.computeUserTotal;
var getMigratedCoinsObj = recompute.getMigratedCoinsObj;

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
      var newCoins = computed.total;

      /* (4) Write ONLY {coins, u} to the leaderboard doc (merge:true). */
      await collectionRef(db, 'leaderboard').doc(uid).set(
        {coins: newCoins, u: Date.now()},
        {merge: true}
      );

      /* (5) If the engagement object was migrated (engV68), persist the
         migrated object so it is never divided twice. */
      if (computed.engagementMigrated){
        var migrated = getMigratedCoinsObj(coinsObj);
        await docRef(db, 'users/' + uid + '/profile/data').set(
          {coins: migrated},
          {merge: true}
        );
        console.log('[migrate] ' + uid + ': engagement coins object migrated to v68 scale');
      }

      /* (7) Log old -> new total. */
      console.log('[update] ' + uid + ': ' + oldCoins + ' -> ' + newCoins);
      usersUpdated++;
      results.push({uid: uid, oldCoins: oldCoins, newCoins: newCoins});
    } catch (err){
      /* One bad user must not abort the whole run; the error is logged
         and the user is counted as skipped (their coins are untouched). */
      console.error('[error] ' + uid + ': ' + (err && err.message ? err.message : err));
      usersSkipped++;
    }
  }

  return {usersUpdated: usersUpdated, usersSkipped: usersSkipped, results: results};
}

module.exports = {recomputeAllUsers: recomputeAllUsers};

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
