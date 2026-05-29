// AK-176 — deferred Firestore init: behavioural tests against the REAL
// `src/lib/firebase.ts` and `src/services/firestoreService.ts`.
//
// What this exercises (and why each test exists):
//
//  1. Memoization — two synchronous calls to the REAL `getFirestoreContext()`
//     return the SAME promise. Pins the invariant that
//     `_firestoreCtx = (async () => { ... })()` is assigned *before* the IIFE
//     awaits; if anyone restructures the function and accidentally moves
//     assignment past an await, two concurrent first-callers would each
//     trigger a separate `initializeFirestore` → Firestore would throw
//     FailedPrecondition.
//
//  2. Cancel-before-resolve, all six real subscription wrappers. For each:
//     subscribe → synchronously unsubscribe → write a doc the listener would
//     fire on → wait past the init delay + buffer → assert callback never
//     fired. The first subscription test runs with the init promise in flight
//     (because of VITE_AK176_TEST_DELAY_MS=500); the next five run with the
//     memo already resolved. Both regimes hit the same cancelled-flag check
//     in the wrapper — the JS event loop guarantees a sync `unsub()` after
//     `subscribeXxx(...)` flips the closure flag before the `.then()`
//     microtask runs to attach onSnapshot. Validating all six (not a generic
//     wrapper) is the point — each is a separate copy of the pattern and
//     would have to break independently.
//
//  3. Round-trip — `updateUserProfile` (write) + `getUserDoc` (read), both
//     real firestoreService exports, both internally `await
//     getFirestoreContext()`. Confirms the resolved context actually
//     round-trips writes and reads through the emulator.
//
//  4. Attach-then-teardown lifecycle (cross-review fix #2). On two distinct
//     wrappers — subscribeTodaySummary (single-doc) and subscribeCabinetItems
//     (filtered collection): subscribe → wait for context resolve + listener
//     attach + initial snapshot → write a probe doc, assert the callback
//     count INCREASED → unsub() → write again, assert the callback count did
//     NOT increase. Pins that `realUnsub` is correctly wired and unsubscribe
//     actually detaches the listener — the symmetric case to test 2's "never
//     attached." Two wrappers covered explicitly; the pattern is identical
//     across all six, so the proof transfers by inspection.
//
//  5. Resolved-context cancel (cross-review fix #3). `await getFirestoreContext()`
//     first so the memo is unambiguously resolved, then synchronously
//     `subscribe → unsub`, write the probe, assert no fire. Makes the
//     resolved-context coverage explicit rather than depending on test
//     execution order (test 2's first iteration exercises the in-flight
//     case; this test pins the resolved case independently).
//
// Init-rejection coverage (cross-review fix #4) lives in a separate file:
// `tests/unit/ak176-init-rejection.test.ts`. Vitest's per-file isolation
// gives it a fresh module graph so the cached rejection doesn't poison
// the rest of the suite. See that file for the wrapper-doesn't-leak proof
// plus the empirical answer for #5 (memoized-rejection behavior).
//
// Prerequisites:
//   firebase emulators:start --only firestore,auth --project demo-medicab
//
// Run:
//   npm run test:unit

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHmac } from 'node:crypto'
import { signInWithCustomToken } from 'firebase/auth'

// AK-176 test-harness fix: this file deliberately does NOT import
// firebase-admin/auth or firebase-admin/firestore. Vitest 4's Vite-based
// module-runner intercepts node_modules requires inside worker threads and
// trips over jose's CJS relative requires (jose ships node/cjs/runtime/
// base64url.js with `require('../lib/buffer_utils.js')` which Node resolves
// fine but the module-runner cannot — confirmed against the same chain in
// plain Node). `inline:[...]` made it worse (picked .ts sources); pool=forks
// broke a different transitive. The clean fix is to talk to the emulator
// directly: forge an HS256 custom token for sign-in (Auth emulator does not
// verify signatures, only decodes the payload), and use the Firestore
// emulator REST API with `Authorization: Bearer owner` (the documented
// admin-bypass header the Admin SDK itself uses internally) for seed +
// probe writes. The client SDK + lib/firebase.ts code under test is
// unchanged — only the test scaffolding has been decoupled.

// Emulator endpoints. Set as process.env for parity with what FIRESTORE_EMULATOR_HOST /
// FIREBASE_AUTH_EMULATOR_HOST signal to any other Firebase tooling; the Auth
// connect happens via lib/firebase.ts DEV branch (localhost:9099 — same host).
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080'
process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'

// ★ THE REAL APP MODULES — these are what AK-176 must satisfy.
// Importing `auth` runs the eager DEV-branch emulator hookup in lib/firebase.ts
// (connectAuthEmulator on localhost:9099). Importing the firestoreService
// subscriptions pulls them in but does not init Firestore yet — that's
// deferred until the first getFirestoreContext() inside any subscription
// or one-shot function.
import { auth, getFirestoreContext } from '../../src/lib/firebase'
import {
  subscribeCabinetItems,
  subscribeTreatments,
  subscribeNotifications,
  subscribeTodaySummary,
  subscribeRestockRequests,
  subscribeAddresses,
  updateUserProfile,
  getUserDoc,
} from '../../src/services/firestoreService'
import { todayISTString } from '../../src/lib/paths'
import type { CabinetItem, TodaySummary } from '../../src/types'

const PROJECT_ID = 'demo-medicab'
// Random suffix per run so re-runs against a non-fresh emulator don't
// collide on existing docs. The afterAll cleanup is best-effort.
const SUFFIX = Math.random().toString(36).slice(2, 8)
const TEST_HID = `ak176-test-hh-${SUFFIX}`
const TEST_UID = `ak176-test-user-${SUFFIX}`
const TEST_CID = `${TEST_HID}-default`

const FIRESTORE_BASE = `http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents`
// Admin-bypass header that the Firestore emulator recognises. The Firebase
// Admin SDK sends `Authorization: Bearer owner` when FIRESTORE_EMULATOR_HOST
// is set; the emulator skips security-rule evaluation for any request
// carrying this token. Replicating it here gives us the same admin-write
// capability without pulling in the Admin SDK.
const ADMIN_HEADERS = {
  Authorization: 'Bearer owner',
  'Content-Type': 'application/json',
}

// ─── Helpers — forged auth + REST writes ────────────────────────────────────

// Base64url encoder. Node 22+ has Buffer.toString('base64url') natively but
// some bundler interop strips it; spelling it out is portable.
function b64url(input: string | Uint8Array): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : Buffer.from(input)
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

// Mint a Firebase custom token shaped like one createCustomToken() would
// produce. The Auth emulator decodes this token and trusts the claims
// without verifying the signature, so HS256 with any secret works.
function makeEmulatorCustomToken(uid: string, claims: Record<string, unknown>): string {
  const header = { alg: 'HS256', typ: 'JWT' }
  const now = Math.floor(Date.now() / 1000)
  const payload = {
    iss: `firebase-adminsdk-test@${PROJECT_ID}.iam.gserviceaccount.com`,
    sub: `firebase-adminsdk-test@${PROJECT_ID}.iam.gserviceaccount.com`,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid,
    claims,
  }
  const headerB64 = b64url(JSON.stringify(header))
  const payloadB64 = b64url(JSON.stringify(payload))
  const sig = createHmac('sha256', 'ak176-test-secret')
    .update(`${headerB64}.${payloadB64}`)
    .digest()
  return `${headerB64}.${payloadB64}.${b64url(sig)}`
}

// Convert a plain object into Firestore REST's value-tagged shape. Covers
// the types this test actually writes — strings, numbers, booleans, null,
// arrays, nested objects, and Dates (→ timestampValue).
function toFirestoreFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    out[k] = toFirestoreValue(v)
  }
  return out
}
function toFirestoreValue(v: unknown): Record<string, unknown> {
  if (v === null || v === undefined) return { nullValue: null }
  if (typeof v === 'string') return { stringValue: v }
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v }
  }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (v instanceof Date) return { timestampValue: v.toISOString() }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toFirestoreValue) } }
  }
  if (typeof v === 'object') {
    return { mapValue: { fields: toFirestoreFields(v as Record<string, unknown>) } }
  }
  throw new Error(`toFirestoreValue: unsupported type ${typeof v}`)
}

// Write a doc via the Firestore emulator REST API, admin-bypassing rules.
// `merge=true` issues an updateMask covering only the fields in `data`,
// matching client SDK setDoc(..., { merge: true }) semantics. `merge=false`
// (default) overwrites the doc.
async function emulatorSet(
  docPath: string,
  data: Record<string, unknown>,
  merge = false,
): Promise<void> {
  const url = new URL(`${FIRESTORE_BASE}/${docPath}`)
  if (merge) {
    for (const k of Object.keys(data)) {
      url.searchParams.append('updateMask.fieldPaths', k)
    }
  }
  const res = await fetch(url, {
    method: 'PATCH',
    headers: ADMIN_HEADERS,
    body: JSON.stringify({ fields: toFirestoreFields(data) }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`emulatorSet ${docPath} (${res.status}): ${text}`)
  }
}

// Best-effort doc delete. Subcollections need recursive walk via :runQuery;
// for this test's afterAll cleanup we just leave them — emulator data is
// throwaway, and the per-run random suffix keeps tests isolated.
async function emulatorDelete(docPath: string): Promise<void> {
  try {
    await fetch(`${FIRESTORE_BASE}/${docPath}`, {
      method: 'DELETE',
      headers: ADMIN_HEADERS,
    })
  } catch {
    // Swallowed.
  }
}

beforeAll(async () => {
  // Seed household + member via the emulator REST API. The Admin-bypass
  // header lets us write any document without rules tripping us up.
  await emulatorSet(`households/${TEST_HID}`, {
    hId: TEST_HID,
    name: 'AK-176 test household',
    primaryAdminId: TEST_UID,
    adminIds: [TEST_UID],
    memberUids: [TEST_UID],
    createdAt: new Date(),
    lastAuditAt: null,
  })
  await emulatorSet(`households/${TEST_HID}/members/${TEST_UID}`, {
    uid: TEST_UID,
    hId: TEST_HID,
    role: 'admin',
    displayName: 'AK-176 Test User',
    joinedAt: new Date(),
  })

  // Sign in client SDK with a forged custom token. Same shape Cloud Function
  // mint produces (uid + claims block); the Auth emulator only decodes.
  const token = makeEmulatorCustomToken(TEST_UID, {
    hId: TEST_HID,
    role: 'admin',
  })
  await signInWithCustomToken(auth, token)
})

afterAll(async () => {
  // Best-effort: drop the seed docs only. Subcollections (cabinet items,
  // probes, etc.) are throwaway per-run.
  await emulatorDelete(`households/${TEST_HID}`)
  await emulatorDelete(`users/${TEST_UID}`)
})

// ───────────────────────────────────────────────────────────────────────────
// Assertion 1: memoization
// ───────────────────────────────────────────────────────────────────────────
describe('AK-176 — getFirestoreContext memoization', () => {
  it('two synchronous calls return the SAME promise (load-bearing invariant)', async () => {
    // Both calls happen before any await — the second call must see the
    // memo set by the first. If `_firestoreCtx = (async () => {...})()` got
    // refactored to assign after an internal await, p1 !== p2 and the
    // production race window opens up.
    const p1 = getFirestoreContext()
    const p2 = getFirestoreContext()
    expect(p1).toBe(p2)
    const [ctx1, ctx2] = await Promise.all([p1, p2])
    expect(ctx1).toBe(ctx2)
    expect(ctx1.db).toBeDefined()
    // The destructured Firestore primitives must be present on the context
    // (firestoreService functions destructure these by name from the context).
    expect(typeof ctx1.doc).toBe('function')
    expect(typeof ctx1.collection).toBe('function')
    expect(typeof ctx1.onSnapshot).toBe('function')
    expect(typeof ctx1.serverTimestamp).toBe('function')
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Assertion 2: cancel-before-resolve — all six real subscription wrappers.
// Each test exercises a distinct exported function — if any one of them
// drifts away from the cancelled-flag pattern, the corresponding test fails.
// ───────────────────────────────────────────────────────────────────────────

// Buffer chosen to comfortably exceed the 500 ms VITE_AK176_TEST_DELAY_MS
// hook plus a generous round-trip allowance for the emulator. The first
// subscription test pays the full delay; the remaining five run against
// a resolved memo and use the same buffer for code-simplicity.
const CANCEL_WAIT_MS = 1200

describe('AK-176 — cancel-before-resolve, all 6 real subscription wrappers', () => {
  it('subscribeCabinetItems: sync unsubscribe does not attach listener', async () => {
    let fired = false
    const unsub = subscribeCabinetItems(TEST_HID, TEST_CID, () => {
      fired = true
    })
    unsub() // synchronous — runs before the .then() microtask

    // Write a cabinet item the listener would have surfaced.
    await emulatorSet(`households/${TEST_HID}/cabinets/${TEST_CID}/items/probe-${Date.now()}`, {
        iId: 'probe',
        hId: TEST_HID,
        cId: TEST_CID,
        medicineId: 'probe-med',
        displayNameOverride: null,
        quantityOnHand: 1,
        unit: 'tablet',
        expiryDate: null,
        prescribed: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

    await new Promise((r) => setTimeout(r, CANCEL_WAIT_MS))
    expect(fired).toBe(false)
  })

  it('subscribeTreatments: sync unsubscribe does not attach listener', async () => {
    let fired = false
    const unsub = subscribeTreatments(TEST_HID, () => {
      fired = true
    })
    unsub()

    await emulatorSet(`households/${TEST_HID}/treatments/probe-${Date.now()}`, {
      tId: 'probe',
      hId: TEST_HID,
      name: 'probe',
      memberId: TEST_UID,
      memberName: 'AK-176 Test User',
      category: 'preventive',
      status: 'active',
      scheduleSummary: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    await new Promise((r) => setTimeout(r, CANCEL_WAIT_MS))
    expect(fired).toBe(false)
  })

  it('subscribeNotifications: sync unsubscribe does not attach listener', async () => {
    let fired = false
    const unsub = subscribeNotifications(TEST_HID, () => {
      fired = true
    })
    unsub()

    // createdAt must fall within the wrapper's 30-day cutoff window.
    // serverTimestamp() resolves to "now" which always does.
    await emulatorSet(`households/${TEST_HID}/notifications/probe-${Date.now()}`, {
        notifId: 'probe',
        type: 'admin_override',
        message: 'probe',
        createdAt: new Date(),
        readBy: [],
      })

    await new Promise((r) => setTimeout(r, CANCEL_WAIT_MS))
    expect(fired).toBe(false)
  })

  it('subscribeTodaySummary: sync unsubscribe does not attach listener', async () => {
    const dateStr = todayISTString()
    let fired = false
    const unsub = subscribeTodaySummary(TEST_HID, dateStr, () => {
      fired = true
    })
    unsub()

    await emulatorSet(`households/${TEST_HID}/todaySummary/${dateStr}`, {
      date: dateStr,
      doses: [],
      summary: 'probe',
      generatedAt: new Date(),
    })

    await new Promise((r) => setTimeout(r, CANCEL_WAIT_MS))
    expect(fired).toBe(false)
  })

  it('subscribeRestockRequests: sync unsubscribe does not attach listener', async () => {
    let fired = false
    const unsub = subscribeRestockRequests(TEST_HID, () => {
      fired = true
    })
    unsub()

    // status MUST be 'pending' — the wrapper's query filters on it.
    await emulatorSet(`households/${TEST_HID}/restockRequests/probe-${Date.now()}`, {
        requestId: 'probe',
        cabinetItemId: 'i1',
        medicineName: 'probe',
        requestedBy: TEST_UID,
        requestedAt: new Date(),
        status: 'pending',
        quantityAtRequest: 1,
      })

    await new Promise((r) => setTimeout(r, CANCEL_WAIT_MS))
    expect(fired).toBe(false)
  })

  it('subscribeAddresses: sync unsubscribe does not attach listener', async () => {
    let fired = false
    const unsub = subscribeAddresses(TEST_HID, () => {
      fired = true
    })
    unsub()

    await emulatorSet(`households/${TEST_HID}/addresses/probe-${Date.now()}`, {
        addressId: 'probe',
        hId: TEST_HID,
        label: 'probe',
        recipientName: 'AK-176 Test User',
        recipientPhone: '+919876543210',
        houseNumber: '1',
        apartmentName: null,
        area: 'area',
        city: 'city',
        state: 'state',
        pincode: '560001',
        country: 'IN',
        landmark: null,
        placeId: 'p',
        latitude: 12.9,
        longitude: 77.6,
        formattedAddress: '1 area, city, state 560001, IN',
        isDefault: false,
        disposedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

    await new Promise((r) => setTimeout(r, CANCEL_WAIT_MS))
    expect(fired).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Assertion 3: real one-shot read/write round-trip after deferred init.
// Pins that a real firestoreService write + read pair actually transits the
// emulator after getFirestoreContext() has resolved (the dominant production
// path once the app is warm).
// ───────────────────────────────────────────────────────────────────────────
describe('AK-176 — real one-shot read/write round-trip', () => {
  it('updateUserProfile + getUserDoc through firestoreService', async () => {
    const probeName = `ak176-roundtrip-${Date.now()}`
    await updateUserProfile(TEST_UID, { displayName: probeName })
    const user = await getUserDoc(TEST_UID)
    expect(user).not.toBeNull()
    expect(user?.displayName).toBe(probeName)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Assertion 4 (cross-review fix #2): attach-then-teardown lifecycle on two
// wrappers. Verifies that the resolved-context path actually wires onSnapshot
// up correctly AND that unsub() actually detaches it. Compares callback
// counts before/after a probe write, then again before/after a post-unsub
// write. The cancel-before-resolve tests in Assertion 2 prove "never
// attached"; this proves the symmetric "attached then detached."
//
// Buffer choice: 1500 ms for the initial wait (covers the 500 ms init delay
// if this is the first context-resolving consumer, plus Firestore's initial-
// snapshot delivery from the emulator), 500 ms for in-flight write
// propagation, 700 ms for the post-unsub silence window. All comfortably
// larger than typical emulator latencies but small enough to keep the test
// under the per-test timeout.
// ───────────────────────────────────────────────────────────────────────────
const ATTACH_RESOLVE_WAIT_MS = 1500
const PROPAGATION_WAIT_MS = 500
const POST_UNSUB_QUIET_WAIT_MS = 700

describe('AK-176 — attach-then-teardown lifecycle', () => {
  it('subscribeTodaySummary: initial snapshot + write fires; unsub stops further fires', async () => {
    const dateStr = todayISTString()
    let count = 0
    let last: TodaySummary | null = null

    const unsub = subscribeTodaySummary(TEST_HID, dateStr, (data) => {
      count++
      last = data
    })

    // Wait for context resolve + onSnapshot attach + initial snapshot delivery.
    // The initial snapshot always fires once when onSnapshot attaches, even
    // if the doc doesn't exist (wrapper translates exists()===false to null).
    await new Promise((r) => setTimeout(r, ATTACH_RESOLVE_WAIT_MS))
    const initialCount = count
    expect(initialCount).toBeGreaterThanOrEqual(1)

    // Probe write — listener should fire with the new doc state. Admin SDK
    // bypasses Firestore schema; we set `date` (which is on TodaySummary)
    // plus a unique non-schema marker the client doesn't need to read — the
    // test only cares that the doc actually changes so the listener fires.
    await emulatorSet(`households/${TEST_HID}/todaySummary/${dateStr}`, {
      date: dateStr,
      generatedAt: new Date(),
      hId: TEST_HID,
      members: {},
      ak176Probe: `attach-${Date.now()}`,
    })
    await new Promise((r) => setTimeout(r, PROPAGATION_WAIT_MS))

    expect(count).toBeGreaterThan(initialCount)
    // Sanity: the callback received non-null data, not the empty initial
    // snapshot. The wrapper translates exists()===false to null; getting a
    // non-null TodaySummary back proves the write propagated through.
    // The `as TodaySummary | null` cast defeats TS's closure-flow narrowing
    // (it can't see that the subscribe callback reassigns `last`).
    const lastSnap = last as TodaySummary | null
    expect(lastSnap).not.toBeNull()
    expect(lastSnap?.date).toBe(dateStr)

    // Teardown: unsub() must actually detach the listener.
    const countBeforeUnsub = count
    unsub()

    // Second write while detached — count must NOT change. We touch the
    // same probe marker so this is unambiguously a doc change Firestore
    // would have surfaced.
    await emulatorSet(`households/${TEST_HID}/todaySummary/${dateStr}`, 
      { ak176Probe: `post-unsub-${Date.now()}` },
      true,
    )
    await new Promise((r) => setTimeout(r, POST_UNSUB_QUIET_WAIT_MS))

    expect(count).toBe(countBeforeUnsub)
  })

  it('subscribeCabinetItems: initial snapshot + write fires; unsub stops further fires', async () => {
    let count = 0
    let lastItems: CabinetItem[] = []

    const unsub = subscribeCabinetItems(TEST_HID, TEST_CID, (items) => {
      count++
      lastItems = items
    })

    await new Promise((r) => setTimeout(r, ATTACH_RESOLVE_WAIT_MS))
    const initialCount = count
    const initialLen = lastItems.length
    expect(initialCount).toBeGreaterThanOrEqual(1)

    // Probe write — listener should fire and the new item should appear.
    const probeIid = `attach-probe-${Date.now()}`
    await emulatorSet(`households/${TEST_HID}/cabinets/${TEST_CID}/items/${probeIid}`, {
        iId: probeIid,
        cId: TEST_CID,
        hId: TEST_HID,
        medicineId: 'attach-test-med',
        displayNameOverride: 'attach test',
        quantityOnHand: 1,
        unit: 'tablet',
        expiryDate: null,
        prescribed: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    await new Promise((r) => setTimeout(r, PROPAGATION_WAIT_MS))

    expect(count).toBeGreaterThan(initialCount)
    expect(lastItems.length).toBeGreaterThan(initialLen)
    // Sanity: the probe item is in the surfaced list (not filtered out by
    // the wrapper's disposedAt filter).
    expect(lastItems.some((i) => i.iId === probeIid)).toBe(true)

    const countBeforeUnsub = count
    unsub()

    // Second write while detached — count must NOT change.
    const postUnsubIid = `post-unsub-${Date.now()}`
    await emulatorSet(`households/${TEST_HID}/cabinets/${TEST_CID}/items/${postUnsubIid}`, {
        iId: postUnsubIid,
        cId: TEST_CID,
        hId: TEST_HID,
        medicineId: 'post-unsub-med',
        displayNameOverride: 'post unsub',
        quantityOnHand: 1,
        unit: 'tablet',
        expiryDate: null,
        prescribed: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    await new Promise((r) => setTimeout(r, POST_UNSUB_QUIET_WAIT_MS))

    expect(count).toBe(countBeforeUnsub)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Assertion 5 (cross-review fix #3): resolved-context cancel made explicit.
//
// In Assertion 2 the FIRST cancel test to run happens to exercise the
// in-flight init (because of VITE_AK176_TEST_DELAY_MS=500); the remaining
// five exercise the resolved-context path implicitly via execution order.
// This test makes that resolved-context coverage explicit and order-
// independent: it `await`s getFirestoreContext() to force resolved state,
// THEN does a synchronous `subscribe → unsub` and asserts no fire.
//
// The JS event-loop guarantee: even with a resolved promise, `.then()`
// queues its callback as a MICROTASK that runs after all synchronous code
// in the current stack frame finishes. So `subscribeXxx(...); unsub();` is
// a sync pair where unsub() flips cancelled=true before the .then() reads it.
// ───────────────────────────────────────────────────────────────────────────
describe('AK-176 — explicit resolved-context cancel', () => {
  it('subscribeAddresses: sync unsubscribe after explicit await resolves does not attach', async () => {
    // Force resolution. After this returns, _firestoreCtx is a resolved promise.
    await getFirestoreContext()

    let fired = false
    const unsub = subscribeAddresses(TEST_HID, () => {
      fired = true
    })
    unsub() // synchronous — beats the .then microtask even on a resolved promise

    // Trigger a write the listener would have surfaced.
    await emulatorSet(`households/${TEST_HID}/addresses/resolved-cancel-${Date.now()}`, {
        addressId: 'resolved-cancel',
        hId: TEST_HID,
        label: 'resolved-cancel-probe',
        recipientName: 'AK-176 Test User',
        recipientPhone: '+919876543210',
        houseNumber: '1',
        apartmentName: null,
        area: 'area',
        city: 'city',
        state: 'state',
        pincode: '560001',
        country: 'IN',
        landmark: null,
        placeId: 'p',
        latitude: 12.9,
        longitude: 77.6,
        formattedAddress: '1 area, city, state 560001, IN',
        isDefault: false,
        disposedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      })

    await new Promise((r) => setTimeout(r, POST_UNSUB_QUIET_WAIT_MS))
    expect(fired).toBe(false)
  })
})
