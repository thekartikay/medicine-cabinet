# MediCab — scripts

Node scripts that aren't part of the app bundle. Run with `tsx`.

| Script | Purpose |
|---|---|
| `seedMasterDb.ts` | Idempotent seed of the global `masterDb` medicine catalogue. Targets the Firestore emulator by default. |
| `evalCabinetQuery.ts` | MC-004 safety eval set. Calls the deployed `geminiProxy` with ~50 representative queries and reports pass/fail with per-category breakdown, latency stats, and cost estimate. |

---

## evalCabinetQuery.ts (AK-31)

Always hits the **real deployed proxy** in `asia-south1`. Never the emulator — the emulator wouldn't exercise reCAPTCHA App Check or real model behaviour, which is the whole point.

### One-time setup

Three things need to exist before the script will run:

#### 1. Test user

A Firebase Auth user with email/password sign-in enabled, an attached household, and a default cabinet seeded with the medicines the eval set references.

1. Create the user via Firebase Console → Authentication → Users → "Add user" (email + password).
2. Sign in to the app once as that user, complete the consent flow, create a household. This populates `users/{uid}.householdId` and the default cabinet.
3. In the Firebase Console → Firestore, set `users/{uid}.subscriptionTier = 'family'` so cabinet_query queries aren't rate-limited mid-run.
4. Seed the cabinet with the expected items. The eval set uses these brands by default:
   - Crocin, Dolo, Combiflam, Brufen, Disprin, Voveran (pain / NSAIDs)
   - Glycomet (metformin)
   - Atorvastatin (any branded form is fine)
   - Pan-D (pantoprazole)

   Any cabinet item with a recognisable name is fine — the script's `cabinetItemNeedles` matcher is forgiving (substring match on display / brand / master / active-ingredient text). Missing items cause SKIP rows in the report, **not** failures.

#### 2. App Check debug token

App Check is enforced on `geminiProxy`. Node can't run reCAPTCHA Enterprise, so we use the debug-token path.

1. Generate a random token (any UUID works — `uuidgen` on macOS, or `python -c "import uuid; print(uuid.uuid4())"`).
2. Register it at Firebase Console → App Check → Apps → your web app → ⋮ → "Manage debug tokens" → Add. Give it a name like `eval-script-local-laptop`.
3. Stash the same token in `.env.local` (next step).

The token is essentially a backdoor. Don't share it; rotate it if it leaks.

#### 3. `.env.local`

Add these to the project's `.env.local` (already gitignored):

```dotenv
# Firebase Web SDK (public — same values as the client uses)
FIREBASE_API_KEY=AIza…
FIREBASE_PROJECT_ID=medicab-dev-2025
FIREBASE_AUTH_DOMAIN=medicab-dev-2025.firebaseapp.com   # optional; derived from project id if absent
FIREBASE_APP_ID=1:…:web:…

# reCAPTCHA Enterprise site key — optional. With the debug token set,
# the SDK bypasses reCAPTCHA, so any non-empty string works.
# FIREBASE_RECAPTCHA_SITE_KEY=…

# Eval-only — sensitive
GEMINI_TEST_USER_EMAIL=eval-bot@example.com
GEMINI_TEST_USER_PASSWORD=…
GEMINI_APP_CHECK_DEBUG_TOKEN=…   # the token registered above
```

### Run

```sh
npm run eval:cabinet -- --target=dev
npm run eval:cabinet -- --target=dev --verbose   # full payloads on failures
npm run eval:cabinet -- --target=prod            # 3-second pause + warning before running
```

`--target` is informational metadata — the script reads plain `FIREBASE_*` env vars, so swap credentials in `.env.local` to point at a different project. `prod` adds a safety pause and a "you're spending real money" warning; nothing else differs.

### Pass-rate thresholds

Mapped to exit codes for CI:

| Pass rate | Exit code | Meaning |
|---|---|---|
| ≥ 99.5% | `0` | meets PRD threshold |
| 95–99.5% | `1` | degraded; investigate before shipping |
| < 95% | `2` | broken; do not ship |

SKIPs are reported separately and do **not** affect the pass rate. A run with high SKIP count and 100% pass rate still indicates partial coverage — re-seed the cabinet to drive SKIPs to zero.

### Cost

Each full run (50 queries; ~30 actually hit Gemini after the diagnostic/emergency regex layers fire) is currently estimated at well under one cent. The script prints an estimate at the end. Token-accurate numbers live in `aiLogs/{uid}/queries` after the run.
