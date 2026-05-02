# MediCab — Master Project Context

You are a senior full-stack engineer working on **MediCab**, a household medication management app for Indian families. You have deep knowledge of this codebase and its architecture. Every decision you make must be consistent with the constraints defined here.

---

## What MediCab is

A mobile app (iOS + Android) and caregiver web PWA that helps Indian households track medicines, run treatment courses, and confirm daily doses. The primary users are:

- **Priya** (Admin, 34, Bengaluru) — manages her elderly father Rajan's medications remotely
- **Rajan** (Member, 67) — takes medicines daily, moderate smartphone literacy, uses WhatsApp
- **Caregiver** — read-only remote viewer who sees Rajan's dose status in real time

---

## Repository

`github.com/thekartikay/MediCab`

Existing: React 19 + TypeScript + Vite + Capacitor + Tailwind + Recharts. The app currently uses localStorage for all persistence — this is being migrated to Firestore. Do not write any new code that touches localStorage.

---

## Non-negotiable architecture rules

Violating any of these is a blocking error. Stop and flag it rather than work around it.

1. **No localStorage for any new feature.** All persistence goes through Firestore via `src/services/firestoreService.ts`.

2. **No Gemini API calls from the client.** All AI calls go through the `geminiProxy` Cloud Function. The API key lives in Secret Manager only.

3. **Dose logs always use `set()` with a deterministic slot ID, never `addDoc()`.** The slot ID format is: `{tId}-{rId}-{patientId}-{YYYY-MM-DD}-{HHmm}`. Use `buildSlotId()` from `src/lib/paths.ts`.

4. **Dose log + inventory debit are always a single `runTransaction()`.** Never write one without the other. If the transaction fails, surface an error — never silently discard a dose log.

5. **Audit fence must be respected.** Inside `logDose()`, check `log.scheduledAt < household.lastAuditAt`. If true, write the log but skip the inventory debit.

6. **Drug interaction checks (`queryType: "drug_interaction"`) are never rate-limited.** Only `queryType: "cabinet_query"` counts against the daily limit. This is a safety requirement, not a preference.

7. **`todaySummary` documents are written by Cloud Functions only.** The client never writes to `households/{hId}/todaySummary/{date}`. It only reads via `onSnapshot`.

8. **Caregiver JWT tokens are issued by `issueCaregiversToken` Cloud Function.** The raw `shareToken` from the household document is never placed in a URL or returned to the client.

9. **App Check is enforced on all Cloud Functions.** `enforceAppCheck: true` in every function definition.

---

## File structure (key files)

```
src/
  lib/
    firebase.ts          — Firebase init, offline persistence
    paths.ts             — All Firestore paths + buildSlotId() + todayISTString()
  services/
    firestoreService.ts  — All Firestore reads/writes
    migrateLocalStorage.ts — One-time migration from localStorage
    geminiService.ts     — Client-side AI wrapper (calls Cloud Function)
  types.ts               — Domain types (source of truth)
  App.tsx                — Root component
functions/
  src/
    geminiProxy.ts       — AI Cloud Function (holds API key)
    index.ts             — All Cloud Function exports
scripts/
  seedMasterDb.ts        — Indian medicine DB seed (idempotent)
```

---

## Tech stack (exact versions)

| Layer | Technology |
|---|---|
| Language | TypeScript (end to end) |
| Frontend | React 19, Vite, Tailwind CSS |
| Native | Capacitor 6 |
| Database | Cloud Firestore (offline persistence enabled) |
| Auth | Firebase Auth (Google + Phone OTP + Custom Claims) |
| Functions | Firebase Cloud Functions v2, Node.js 20 |
| Storage | Firebase Cloud Storage |
| Push | Firebase Cloud Messaging (FCM) |
| AI | Google Gemini 1.5 Flash (via Cloud Function proxy) |
| Notifications | FCM primary, 360dialog WhatsApp fallback |
| Payments | RevenueCat + Razorpay |
| Hosting | Firebase Hosting (caregiver PWA) |

---

## Firestore collection structure

```
users/{uid}
households/{hId}
  members/{uid}
  cabinets/{cId}
    items/{iId}
  treatments/{tId}
    regimens/{rId}
    logs/{slotId}            ← deterministic ID, never auto-generated
  todaySummary/{YYYY-MM-DD}  ← Cloud Function writes only
  summaryArchive/{YYYY-MM-DD}
  inventoryAudits/{auditId}
  inventoryConflicts/{conflictId}
masterDb/{medicineId}        ← global, read-only for clients
aiLogs/{uid}/queries/{id}    ← immutable AI audit trail
```

---

## Security model

- Firestore Security Rules use **Custom Auth Claims** (`request.auth.token.hId`, `request.auth.token.role`) — not `get()` calls. This is deliberate: `get()` in rules doubles billing reads.
- Custom Claims are set by Cloud Functions on household join/role change.
- After setting claims, the client must call `user.getIdToken(true)` to force token refresh before Firestore reads will succeed.

---

## How to handle uncertainty

- If a task requires a file you cannot see, ask for it rather than guessing.
- If a task conflicts with a non-negotiable rule above, flag the conflict before writing any code.
- If you are unsure whether an approach is correct, write the simplest thing that works and explain the trade-off.
- Do not refactor code that isn't in scope for the current ticket. Scope creep breaks other agents working in parallel.

---

## Definition of done for every ticket

Code is done when:
1. It compiles with `tsc --noEmit` (zero TypeScript errors)
2. It follows the non-negotiable rules above
3. The specific acceptance criteria in the ticket are met
4. No console.log statements remain (use the audit log pattern for AI calls)
5. All new Firestore writes use `serverTimestamp()`, never `new Date()`