# TESTPRO — automatic notifications

Free, automatic notifications — no paid service, no new backend server.
Runs on GitHub Actions (free) on a schedule, reads Firestore with the Admin
SDK, writes notification docs to the `notifications` collection (the app bell
reads them), and sends Web Push to the subscriptions in `push_subscriptions`
via VAPID keys.

## What it sends

| Type | When | Target |
|---|---|---|
| `reminder` | Daily, 5 PM IST only (17:00 hour), rotating message by weekday | all users |
| `inactivity` | No attempt in the last 2 days (last attempt within 30 days), max once per user per 3 days | that user |
| `topper` | The #1 user by total coins changes (same guard + doc id as the in-app fast path, so no duplicates) | all users |
| `milestone` | A user enters the leaderboard top 3 for the first time | that user |
| `streak` | Attempts on 7 consecutive days (ending today or yesterday) | that user |
| `announcement` | Manual, via Actions > Run workflow with a title + body | all users |

First run only records baselines (topper, top-3) — it does not notify, so
nobody gets a flood of "welcome" notifications on launch day.

## Files

- `send.js` — the sender. Modes via env `MODE`: `all` (default), `reminder`,
  `conditions`, `announce`. `DRY_RUN=true` logs what WOULD be sent and
  writes/sends nothing. `ANNOUNCE_TITLE` / `ANNOUNCE_BODY` for manual sends.
- `package.json` — `firebase-admin` + `web-push`.

## Secrets (repo Settings > Secrets and variables > Actions)

- `FIREBASE_SERVICE_ACCOUNT_JSON` — already set (used by recompute-coins).
- `VAPID_PUBLIC_KEY` — must match `NTF_VAPID_PUBLIC_KEY` in the app.
- `VAPID_PRIVATE_KEY` — never in the app, repo, or logs.
- `VAPID_SUBJECT` — a `mailto:` contact, e.g. `mailto:owner@example.com`.

Push sending is best-effort: if the VAPID secrets are missing, notification
docs are still written (the bell works) and pushes are skipped with a warning.

## Workflow

`.github/workflows/notifications.yml` — daily 11:30 UTC (17:00 IST) +
hourly at :45, plus manual `workflow_dispatch` (mode / title / body / dry run).
