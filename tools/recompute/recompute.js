'use strict';
/* ============================================================================
   TESTPRO — Cloud Function formula port (Worker A: formula ONLY)
   ----------------------------------------------------------------------------
   Exact port of the v69 coin engine from the app master
   (~/workspace/goals/rrb-ntpc-graduate-cbt-1-me-86-marks/files/
    railway-super-1000-maths-tests.html, md5 60197c9c10bc, APP_VERSION 69).

   Source functions ported VERBATIM (logic, rounding, guards, edge cases):
     <script id="tp-coins">  coinTimePerQ, coinsTimeCoins, coinsFromParts,
                            coinApplyFactor, migrateCoinsEngagement,
                            getCoins (engagement read), awardEngagement
                            (award amounts / daily caps — see FORMULA_NOTE.md)
     <script id="tp-leaderboard">  testCoins(), entryCoins()
                            (1-decimal fractional totals; ranking by exact
                            fractional total)

   Pure Node.js — NO Firebase dependency, no DOM, no localStorage.
   The caller supplies attempts + the stored coins object (read from
   Firestore `users/{uid}/profile/data`, field `coins` — see FORMULA_NOTE.md)
   and persists whatever getMigratedCoinsObj() returns when it differs.

   All coin values carry exactly 1 decimal (v68 rescale = v62 values / 10).

   v71 addition (pure functions only, formula untouched): bestAttemptsByTest
   / aggregateQuestionStats / questionStatsPct — per-question "% answered
   correctly" aggregates, reusing the coin best-attempt selection. See the
   v71 section above the PUBLIC INTERFACE.
   ========================================================================== */

/* ---- Formula constants (v69) ---- */
var MAX_TEST_COINS = 150;      /* per-test cap: score + accuracy + time */
var MAX_SCORE = 100;           /* score coins cap */
var MAX_ACCURACY = 25;         /* accuracy coins cap */
var MAX_TIME = 25;             /* time coins cap (per test) */

var ACCURACY_FLOOR = 30;       /* acc <= 30% -> 0 accuracy coins (strict >30 pays) */
var ACCURACY_RUSH = 50;        /* rush guard only applies while acc < 50% */
var RUSH_MIN_MARKS = 25;       /* rush guard: marks >= 25 ... */
var RUSH_MAX_TIME_SECS = 150;  /* ... AND timeTaken <= 150s AND acc < 50% -> time 0 */
var ACCURACY_TIME_CUTOFF = 30; /* acc < 30% (STRICT) -> 0 time coins, any test */

var CA_FAST_SECS = 10;         /* GK/CA (testId starts 'ca-'): t <= 10s -> 1.0 */
var CA_SLOW_SECS = 30;         /* GK/CA: t >= 30s -> 0 */
var MATHS_FAST_SECS = 30;      /* Maths (all other tests): t <= 30s -> 1.0 */
var MATHS_SLOW_SECS = 50;      /* Maths: t >= 50s -> 0 */

var REATTEMPT_FACTOR = 0.5;    /* attempt no >= 2 earns 50% of its total */
var FIRST_ATTEMPT_NO = 1;      /* no == 1 (or no missing) earns 100% */

var ENG_MIGRATION_DIVISOR = 10; /* v68 rescale: old-scale engagement / 10 */
var ENG_OPEN = 5;              /* daily open award */
var ENG_OPEN_STREAK = 10;      /* daily open award when streak >= 7 */
var ENG_STREAK_DAYS = 7;       /* streak threshold for the +10 open award */
var ENG_USAGE_PER_10MIN = 1;   /* usage: +1 per 10 min active use */
var ENG_USAGE_BUCKET_SECS = 600; /* 10 minutes, in seconds */
var ENG_USAGE_DAILY_CAP = 10;  /* usage coins cap per day */
var ENG_SOLUTION_PER_Q = 0.5;  /* solution view: +0.5 per unique question/day */
var ENG_SOLUTION_DAILY_CAP = 5; /* solution coins cap per day */
var ENG_LEDGER_KEEP_DAYS = 31; /* per-day ledger pruned to most recent 31 days */

/* ---- internal helpers (not exported) ---- */
function r1(x){ return Math.round(x * 10) / 10; }

/* coinTimePerQ(secs, isCA) — verbatim from tp-coins.
   v68: per-question time coins = v62 integer value / 10 (1.0 fast, 0 slow,
   fractional between). Exactly 1 decimal. */
function coinTimePerQ(secs, isCA){
  secs = +secs || 0;
  if (isCA){
    if (secs <= CA_FAST_SECS) return 1;
    if (secs >= CA_SLOW_SECS) return 0;
    return Math.round(10 * (CA_SLOW_SECS - secs) / 20) / 10;
  }
  if (secs <= MATHS_FAST_SECS) return 1;
  if (secs >= MATHS_SLOW_SECS) return 0;
  return Math.round(10 * (MATHS_SLOW_SECS - secs) / 20) / 10;
}

/* coinsTimeCoins(correct, wrong, marks, timeTaken, accPct, qs, testId)
   — verbatim from tp-coins.
   Guards (whole test -> 0): (a) RUSH — marks >= 25 AND timeTaken <= 150s
   AND accPct < 50%; (b) accPct < 30% (STRICT less-than, any test, any time).
   Per-question times come from qs[].secs; when secs is missing, NaN or
   non-finite, the fallback is the average seconds per question
   (timeTaken / marks) for each attempted question. Skipped (sel == null)
   earn 0. When qs is absent entirely, the fallback applies to each
   attempted question (correct + wrong). */
function coinsTimeCoins(correct, wrong, marks, timeTaken, accPct, qs, testId){
  if (accPct < ACCURACY_TIME_CUTOFF) return 0;
  if (marks >= RUSH_MIN_MARKS && (+timeTaken || 0) <= RUSH_MAX_TIME_SECS && accPct < ACCURACY_RUSH) return 0;
  var isCA = (typeof testId === 'string' && testId.indexOf('ca-') === 0);
  var attempted = (+correct || 0) + (+wrong || 0);
  if (attempted <= 0) return 0;
  var avgSecs = marks ? (+timeTaken || 0) / marks : 0;
  var total = 0, i;
  if (Array.isArray(qs) && qs.length){
    qs.forEach(function(q){
      if (!q || q.sel == null) return; /* skipped: 0 time coins */
      var s = (q.secs != null && isFinite(+q.secs)) ? +q.secs : avgSecs;
      total += coinTimePerQ(s, isCA);
    });
  } else {
    for (i = 0; i < attempted; i++) total += coinTimePerQ(avgSecs, isCA);
  }
  return Math.min(MAX_TIME, r1(total)); /* v68: sum of 1-decimal
     per-question values, re-rounded to 1 decimal to clear float dust */
}

/* coinsFromParts(score, correct, wrong, marks, timeTaken, accOverride, qs,
   testId) — verbatim from tp-coins.
   score coins = max(0, round(score/marks*100*10)/10) (max 100).
   accuracy coins: acc <= 30% -> 0, acc = 100% -> 25, between ->
   min(25, round((acc-30)/70*250)/10). accPct is the attempt's accuracy
   field when present, else correct/(correct+wrong)*100. */
function coinsFromParts(score, correct, wrong, marks, timeTaken, accOverride, qs, testId){
  marks = +marks || 0;
  if (!marks) return {score: 0, accuracy: 0, time: 0, total: 0};
  var scoreC = Math.max(0, r1((+score || 0) / marks * 100)); /* v68: max 100 */
  var att = (+correct || 0) + (+wrong || 0);
  var accPct = (accOverride != null && !isNaN(+accOverride)) ? +accOverride : (att > 0 ? (+correct || 0) / att * 100 : 0);
  var accC = 0;
  if (accPct > ACCURACY_FLOOR) accC = Math.min(MAX_ACCURACY, Math.round((accPct - ACCURACY_FLOOR) / 70 * 250) / 10); /* v68: max 25 — NOTE: round the 250-scale value to an integer FIRST, then /10 (NOT a 1-decimal round of the 250-scale value) */
  var timeC = coinsTimeCoins(correct, wrong, marks, timeTaken, accPct, qs, testId);
  return {score: scoreC, accuracy: accC, time: timeC, total: r1(scoreC + accC + timeC)}; /* v68: max 150 */
}

/* coinApplyFactor(parts, factor) — verbatim from tp-coins.
   The factor is applied per part (rounded to 1 decimal — a halved 83.3
   becomes 41.7) and the total is the sum of the factored parts, so
   breakdowns always add up to the total. */
function coinApplyFactor(parts, factor){
  factor = (factor == null || isNaN(+factor)) ? 1 : +factor;
  var s = r1((+parts.score || 0) * factor);
  var a = r1((+parts.accuracy || 0) * factor);
  var ti = r1((+parts.time || 0) * factor);
  return {score: s, accuracy: a, time: ti, total: s + a + ti};
}

/* migrateCoinsEngagement(c) — verbatim from tp-coins, but NON-MUTATING
   here: the caller-facing wrapper is getMigratedCoinsObj() below, which
   works on a deep copy. Returns true when the migration was applied.
   Only values that are NOT re-derived are divided: eng (lifetime),
   usageCoins, solCoins (today's counters) and each day-ledger entry's
   open award. Per-day usage/sol are re-derived from usageSecs/solIds by
   the app (getCoins/coinDaysSum/mergeCoins, already in the new scale),
   so they must NOT be divided. Idempotent via the engV68 flag. */
function migrateCoinsEngagement(c){
  if (!c || typeof c !== 'object') return false;
  if (c.engV68) return false; /* already in v68 scale - never divide twice */
  if (typeof c.eng === 'number') c.eng = c.eng / ENG_MIGRATION_DIVISOR;
  if (typeof c.usageCoins === 'number') c.usageCoins = c.usageCoins / ENG_MIGRATION_DIVISOR;
  if (typeof c.solCoins === 'number') c.solCoins = c.solCoins / ENG_MIGRATION_DIVISOR;
  if (c.days && typeof c.days === 'object' && !Array.isArray(c.days)){
    Object.keys(c.days).forEach(function(k){
      var e = c.days[k];
      if (e && typeof e === 'object' && typeof e.open === 'number') e.open = e.open / ENG_MIGRATION_DIVISOR;
    });
  }
  c.engV68 = true;
  return true;
}

function deepCopy(v){
  return (v === undefined || v === null) ? v : JSON.parse(JSON.stringify(v));
}

/* Marks for one attempt. The app uses the test definition's marks
   (findTestById(testId).marks); when that is unavailable the app falls
   back to correct + wrong + skipped (testCoinsDetail). An explicit
   numeric `marks` on the attempt object is honoured first. */
function attemptMarks(a){
  if (a && a.marks != null && !isNaN(+a.marks) && +a.marks > 0) return +a.marks;
  return ((+a.correct || 0) + (+a.wrong || 0) + (+a.skipped || 0));
}

/* Best (max) factored total for ONE test across all its attempts.
   Mirrors testCoinsDetail(): coins are computed PER ATTEMPT (each with its
   own factor — 1 for the first attempt, 0.5 for re-attempts) and the test
   total is the MAX over attempts, NOT just the best-by-score attempt's
   coins. Re-attempting can never reduce a test's coins.
   v71: the selection lives in selectBestAttempt() so the question-stats
   aggregation can reuse the EXACT same best-attempt choice (same
   comparison, same first-wins tie-break). bestTestTotal() below is a
   thin wrapper over it — its return value is unchanged. */
function selectBestAttempt(testId, attempts){
  var best = null;
  (Array.isArray(attempts) ? attempts : []).forEach(function(a){
    if (!a) return;
    var marks = attemptMarks(a);
    var raw = coinsFromParts(a.score || 0, a.correct || 0, a.wrong || 0,
      marks, a.timeTaken || 0, a.accuracy, a.qs, testId);
    var f = (a.no != null && +a.no >= 2) ? REATTEMPT_FACTOR : 1;
    var d = coinApplyFactor(raw, f);
    if (!best || d.total > best.parts.total) best = {attempt: a, parts: d};
  });
  return best;
}

function bestTestTotal(testId, attempts){
  var best = selectBestAttempt(testId, attempts);
  return best ? best.parts : null;
}

/* ============================================================================
   v71 — per-question "% answered correctly" aggregation
   ----------------------------------------------------------------------------
   Pure functions, no Firebase dependency. The app displays, per question,
   pct = correct / attempted * 100 (1 decimal); the stored aggregate is the
   compact map { "<qNo>": { "a": attempted, "c": correct } } per test.

   Rules (same as the coin best-attempt rule — see selectBestAttempt):
     - ONE record per (user, test): that user's BEST attempt only.
       Re-attempts are never counted as a separate user.
     - attempted = the user SELECTED an answer for that question
       (sel != null). Skipped (sel == null) does NOT count.
     - correct = of the attempted, ok === true.
     - A question nobody attempted is ABSENT from the map (not {a:0,c:0});
       a test with no attempted question at all is ABSENT from the result.
   The coin formula above is NOT touched by any of this.
   ========================================================================== */

/* bestAttemptsByTest(attempts)
   attempts: one user's attempt objects (any tests mixed).
   Returns { testId: <best attempt object> } — the single best attempt
   per test, chosen by the same max-factored-total rule as the coins.
   The returned attempt objects are the caller's own objects (not copies);
   they are only read, never mutated, by aggregateQuestionStats(). */
function bestAttemptsByTest(attempts){
  var byTest = {};
  (Array.isArray(attempts) ? attempts : []).forEach(function(a){
    if (!a || typeof a.testId !== 'string' || !a.testId) return;
    if (!byTest[a.testId]) byTest[a.testId] = [];
    byTest[a.testId].push(a);
  });
  var out = {};
  Object.keys(byTest).forEach(function(testId){
    var best = selectBestAttempt(testId, byTest[testId]);
    if (best) out[testId] = best.attempt;
  });
  return out;
}

/* aggregateQuestionStats(perUserBest)
   perUserBest: array of per-user best-attempt maps, one entry per user,
     each as returned by bestAttemptsByTest() — i.e. at most ONE attempt
     per (user, test). Any other shape (null entries, missing qs) is
     skipped, never throws.
   Returns { testId: { "<qNo>": { "a": attempted, "c": correct } } }.
   Keys are String(q.n); q.n must be a finite number. Only questions with
   at least one attempted record appear. No per-user data is retained. */
function aggregateQuestionStats(perUserBest){
  var stats = {};
  (Array.isArray(perUserBest) ? perUserBest : []).forEach(function(bestMap){
    if (!bestMap || typeof bestMap !== 'object') return;
    Object.keys(bestMap).forEach(function(testId){
      var attempt = bestMap[testId];
      if (!attempt || !Array.isArray(attempt.qs)) return;
      attempt.qs.forEach(function(q){
        if (!q) return;
        var n = +q.n;
        if (!isFinite(n)) return;
        if (q.sel == null) return; /* skipped: not counted in attempted */
        var key = String(n);
        if (!stats[testId]) stats[testId] = {};
        if (!stats[testId][key]) stats[testId][key] = {a: 0, c: 0};
        stats[testId][key].a += 1;
        if (q.ok === true) stats[testId][key].c += 1;
      });
    });
  });
  return stats;
}

/* questionStatsPct(a, c) — display helper for the app (Worker B):
   percent answered correctly, 1 decimal, or null when nobody attempted. */
function questionStatsPct(a, c){
  a = +a || 0;
  c = +c || 0;
  if (a <= 0) return null;
  return Math.round(c / a * 1000) / 10;
}

/* ============================================================================
   PUBLIC INTERFACE
   ========================================================================== */

/* computeUserTotal(attempts, coinsObj)
   attempts: array of attempt objects, each with testId (string), no,
     score, correct, wrong, skipped, accuracy, timeTaken, qs (array of
     {n, sel, ok, secs, marked}), times. (The `times` field is not used by
     the coin formula — per-question times come from qs[].secs, with the
     timeTaken/marks fallback — and is ignored here, exactly as in the app.)
   coinsObj: the user's stored coins object (field `coins` of Firestore
     doc `users/{uid}/profile/data`), or null/undefined.
   Returns { total, testCoins, engagement, perTest, engagementMigrated }:
     total              — 1-decimal exact total (test coins + engagement),
                          mirroring entryCoins()/testCoins() rounding.
     testCoins          — sum of best-attempt test coins (1 decimal).
     engagement         — the (migrated) lifetime engagement total
                          (coinsObj.eng after the engV68 migration, if any).
     perTest            — map testId -> best total for that test (1 decimal,
                          mirroring leaderboard testCoins()).
     engagementMigrated — true iff the engV68 /10 migration was applied
                          in this call (i.e. coinsObj existed and had no
                          engV68 flag). */
function computeUserTotal(attempts, coinsObj){
  var perTest = {};
  var testCoins = 0;
  var byTest = {};
  (Array.isArray(attempts) ? attempts : []).forEach(function(a){
    if (!a || typeof a.testId !== 'string' || !a.testId) return;
    if (!byTest[a.testId]) byTest[a.testId] = [];
    byTest[a.testId].push(a);
  });
  Object.keys(byTest).forEach(function(testId){
    var best = bestTestTotal(testId, byTest[testId]);
    if (best){
      /* Mirror leaderboard testCoins(): max(0, round(total*10)/10). */
      var t = Math.max(0, r1(best.total));
      perTest[testId] = t;
      testCoins += t;
    }
  });
  testCoins = r1(testCoins);

  var engagement = 0;
  var engagementMigrated = false;
  if (coinsObj && typeof coinsObj === 'object'){
    var migrated = deepCopy(coinsObj);
    engagementMigrated = migrateCoinsEngagement(migrated);
    engagement = (typeof migrated.eng === 'number' && isFinite(migrated.eng)) ? migrated.eng : 0;
  }

  var total = r1(testCoins + engagement);
  return {total: total, testCoins: testCoins, engagement: engagement, perTest: perTest, engagementMigrated: engagementMigrated};
}

/* getMigratedCoinsObj(coinsObj)
   Returns the coins object to persist. If coinsObj exists and has NOT
   been migrated (no engV68 flag), returns a COPY with engagement / 10
   (eng, usageCoins, solCoins and each days[].open — exactly the fields
   migrateCoinsEngagement divides) and engV68: true. If already migrated
   or null/undefined, returns the input unchanged (or null). Idempotent:
   calling it on its own output returns the same object unchanged. The
   input is never mutated. */
function getMigratedCoinsObj(coinsObj){
  if (!coinsObj || typeof coinsObj !== 'object') return coinsObj == null ? null : coinsObj;
  if (coinsObj.engV68) return coinsObj;
  var copy = deepCopy(coinsObj);
  migrateCoinsEngagement(copy);
  return copy;
}

module.exports = {
  computeUserTotal: computeUserTotal,
  getMigratedCoinsObj: getMigratedCoinsObj,
  bestAttemptsByTest: bestAttemptsByTest,
  aggregateQuestionStats: aggregateQuestionStats,
  questionStatsPct: questionStatsPct,
  MAX_TEST_COINS: MAX_TEST_COINS,
  MAX_SCORE: MAX_SCORE,
  MAX_ACCURACY: MAX_ACCURACY,
  MAX_TIME: MAX_TIME,
  ACCURACY_FLOOR: ACCURACY_FLOOR,
  ACCURACY_RUSH: ACCURACY_RUSH,
  RUSH_MIN_MARKS: RUSH_MIN_MARKS,
  RUSH_MAX_TIME_SECS: RUSH_MAX_TIME_SECS,
  ACCURACY_TIME_CUTOFF: ACCURACY_TIME_CUTOFF,
  CA_FAST_SECS: CA_FAST_SECS,
  CA_SLOW_SECS: CA_SLOW_SECS,
  MATHS_FAST_SECS: MATHS_FAST_SECS,
  MATHS_SLOW_SECS: MATHS_SLOW_SECS,
  REATTEMPT_FACTOR: REATTEMPT_FACTOR,
  FIRST_ATTEMPT_NO: FIRST_ATTEMPT_NO,
  ENG_MIGRATION_DIVISOR: ENG_MIGRATION_DIVISOR,
  ENG_OPEN: ENG_OPEN,
  ENG_OPEN_STREAK: ENG_OPEN_STREAK,
  ENG_STREAK_DAYS: ENG_STREAK_DAYS,
  ENG_USAGE_PER_10MIN: ENG_USAGE_PER_10MIN,
  ENG_USAGE_BUCKET_SECS: ENG_USAGE_BUCKET_SECS,
  ENG_USAGE_DAILY_CAP: ENG_USAGE_DAILY_CAP,
  ENG_SOLUTION_PER_Q: ENG_SOLUTION_PER_Q,
  ENG_SOLUTION_DAILY_CAP: ENG_SOLUTION_DAILY_CAP,
  ENG_LEDGER_KEEP_DAYS: ENG_LEDGER_KEEP_DAYS
};
