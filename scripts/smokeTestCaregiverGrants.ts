// AK-58 sub-task 1 — one-shot integration smoke test for the four caregiver
// grant Cloud Functions. Exercises the full lifecycle (create → accept →
// authenticated read → revoke → list → cleanup) end-to-end. Intended as a
// write-once, run-once integration check; can be deleted or kept around as a
// regression hammer.
//
// Usage:
//   # Emulator (default for safety):
//   firebase emulators:start --only functions,firestore,auth --project demo-medicab
//   SMOKE_TEST_TARGET=emulator GOOGLE_CLOUD_PROJECT=demo-medicab \
//     npx tsx scripts/smokeTestCaregiverGrants.ts
//
//   # Real dev project (only after deploy of AK-58 functions to dev):
//   GOOGLE_APPLICATION_CREDENTIALS=~/.firebase/medicab-dev-2025-sa.json \
//   GOOGLE_CLOUD_PROJECT=medicab-dev-2025 \
//     npx tsx scripts/smokeTestCaregiverGrants.ts
//
// Production safeguard: refuses to run unless either the project ID is
// medicab-dev-2025 (real-dev branch) or SMOKE_TEST_TARGET=emulator (with a
// demo-* project ID).

import {
  initializeApp as initAdminApp,
  getApps as getAdminApps,
  applicationDefault,
} from 'firebase-admin/app'
import { getAuth as getAdminAuth } from 'firebase-admin/auth'
import {
  getFirestore as getAdminFirestore,
  FieldValue,
  type Timestamp as AdminTimestamp,
} from 'firebase-admin/firestore'
import { initializeApp as initClientApp } from 'firebase/app'
import {
  getAuth as getClientAuth,
  connectAuthEmulator,
  signInWithEmailAndPassword,
  signInWithCustomToken,
  signOut,
} from 'firebase/auth'
import {
  initializeFirestore as initClientFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
} from 'firebase/firestore'
import {
  getFunctions,
  connectFunctionsEmulator,
  httpsCallable,
} from 'firebase/functions'
import { initializeAppCheck, CustomProvider } from 'firebase/app-check'

// ─── Configuration ───────────────────────────────────────────────────────────

const TARGET = (process.env.SMOKE_TEST_TARGET ?? 'dev').trim()
const PROJECT_ID = (process.env.GOOGLE_CLOUD_PROJECT ?? '').trim()
const TEST_EMAIL = 'evaltest@medicab.dev'
const TEST_PASSWORD = 'evalpass123'
const HID = 'eval-test-household'
const TARGET_MEMBER_ID = 'caregiver-smoke-target'
const TARGET_MEMBER_NAME = 'Smoke Test Target'

// Production-safety gate. Refuse to run unless one of the two whitelisted
// shapes:
//   • SMOKE_TEST_TARGET=emulator AND project ID begins with `demo-`
//     (Firebase emulator convention).
//   • SMOKE_TEST_TARGET=dev AND project ID === 'medicab-dev-2025'.
if (TARGET === 'emulator') {
  if (!PROJECT_ID.startsWith('demo-')) {
    console.error(`[smoke] FATAL: SMOKE_TEST_TARGET=emulator requires GOOGLE_CLOUD_PROJECT to start with "demo-". Got: ${PROJECT_ID || '<unset>'}`)
    process.exit(1)
  }
} else if (TARGET === 'dev') {
  if (PROJECT_ID !== 'medicab-dev-2025') {
    console.error(`[smoke] FATAL: refusing to run against project ${PROJECT_ID || '<unset>'}. Only medicab-dev-2025 is allowed for SMOKE_TEST_TARGET=dev.`)
    process.exit(1)
  }
} else {
  console.error(`[smoke] FATAL: SMOKE_TEST_TARGET must be "dev" or "emulator". Got: ${TARGET}`)
  process.exit(1)
}

// Point Admin SDK at the local emulators when applicable.
if (TARGET === 'emulator') {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080'
  process.env.FIREBASE_AUTH_EMULATOR_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099'
}

// ─── Admin SDK init ──────────────────────────────────────────────────────────

const adminApp = (() => {
  const existing = getAdminApps()
  if (existing.length) return existing[0]!
  // Emulator: omit `credential` entirely (Admin SDK detects
  // FIREBASE_AUTH_EMULATOR_HOST + FIRESTORE_EMULATOR_HOST and routes there
  // without needing real credentials). Setting credential:undefined fails the
  // SDK's validator — must be absent, not undefined.
  return initAdminApp(
    TARGET === 'emulator'
      ? { projectId: PROJECT_ID }
      : { projectId: PROJECT_ID, credential: applicationDefault() },
  )
})()
const adminAuth = getAdminAuth(adminApp)
const adminDb = getAdminFirestore(adminApp)

// ─── Client SDK init ─────────────────────────────────────────────────────────

const clientApp = initClientApp(
  {
    apiKey: 'fake-api-key-emulator-ok',
    projectId: PROJECT_ID,
    authDomain: `${PROJECT_ID}.firebaseapp.com`,
  },
  'smoke-test-client',
)
const clientAuth = getClientAuth(clientApp)
const clientDb = initClientFirestore(clientApp, {})
const clientFunctions = getFunctions(clientApp, 'asia-south1')

if (TARGET === 'emulator') {
  connectAuthEmulator(clientAuth, 'http://127.0.0.1:9099', { disableWarnings: true })
  connectFirestoreEmulator(clientDb, '127.0.0.1', 8080)
  connectFunctionsEmulator(clientFunctions, '127.0.0.1', 5001)

  // The Functions emulator still honours `enforceAppCheck: true` on callables
  // and rejects requests without an App Check header. Use a CustomProvider
  // returning a stub token; the emulator does not verify the signature.
  initializeAppCheck(clientApp, {
    provider: new CustomProvider({
      getToken: async () => ({
        token: 'smoke-test-emulator-app-check-stub',
        expireTimeMillis: Date.now() + 60 * 60 * 1000,
      }),
    }),
    isTokenAutoRefreshEnabled: true,
  })
}

// ─── Result tracking ─────────────────────────────────────────────────────────

interface Result { op: string; ok: boolean; detail: string; critical?: boolean }
const results: Result[] = []
function record(r: Result): void {
  results.push(r)
  const tag = r.ok ? 'PASS' : (r.critical ? 'CRITICAL FAIL' : 'FAIL')
  console.log(`[${r.op}] ${tag} — ${r.detail}`)
}
function pass(op: string, detail: string): void {
  record({ op, ok: true, detail })
}
function fail(op: string, detail: string, critical = false): void {
  record({ op, ok: false, detail, critical })
}

function describeError(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown }
  const code = typeof e?.code === 'string' ? e.code : ''
  const msg = typeof e?.message === 'string' ? e.message : String(err)
  return code ? `[${code}] ${msg}` : msg
}

function isPermissionDenied(err: unknown): boolean {
  const msg = String((err as { message?: unknown })?.message ?? err).toLowerCase()
  const code = String((err as { code?: unknown })?.code ?? '').toLowerCase()
  return msg.includes('permission') || code.includes('permission-denied')
}

function todayISTDateString(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

// ─── Op 1 — Setup ────────────────────────────────────────────────────────────

async function ensureAdminAuthUser(): Promise<string> {
  try {
    const u = await adminAuth.getUserByEmail(TEST_EMAIL)
    return u.uid
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/user-not-found') throw err
  }
  const created = await adminAuth.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    emailVerified: true,
    displayName: 'Eval Test',
  })
  return created.uid
}

async function op1Setup(): Promise<{ adminUid: string }> {
  try {
    const adminUid = await ensureAdminAuthUser()
    await adminAuth.setCustomUserClaims(adminUid, { hId: HID, role: 'admin' })

    await adminDb.doc(`households/${HID}`).set(
      {
        hId: HID,
        name: 'Eval Test Household',
        primaryAdminId: adminUid,
        adminIds: [adminUid],
        memberUids: [adminUid],
        createdAt: FieldValue.serverTimestamp(),
        lastAuditAt: null,
      },
      { merge: true },
    )
    await adminDb.doc(`households/${HID}/members/${adminUid}`).set(
      {
        uid: adminUid,
        hId: HID,
        role: 'admin',
        displayName: 'Eval Test',
        joinedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )
    await adminDb.doc(`households/${HID}/members/${TARGET_MEMBER_ID}`).set(
      {
        uid: TARGET_MEMBER_ID,
        hId: HID,
        role: 'member',
        displayName: TARGET_MEMBER_NAME,
        joinedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    )

    await signInWithEmailAndPassword(clientAuth, TEST_EMAIL, TEST_PASSWORD)
    const tokenResult = await clientAuth.currentUser!.getIdTokenResult(true)
    const claims = tokenResult.claims as { hId?: string; role?: string }
    if (claims.hId !== HID || claims.role !== 'admin') {
      fail('OP1', `claims wrong after sign-in: ${JSON.stringify(claims)}`)
      return { adminUid }
    }

    pass('OP1', `admin uid=${adminUid}, claims OK, target member ${TARGET_MEMBER_ID} seeded`)
    return { adminUid }
  } catch (err) {
    fail('OP1', `setup error: ${describeError(err)}`)
    throw err
  }
}

// ─── Op 2 — createCaregiverGrant ─────────────────────────────────────────────

interface CreateGrantResp { grantId: string; magicLink: string }
interface ParsedLink { hId: string; mId: string; grantId: string; grantSecret: string }

async function op2Create(): Promise<ParsedLink | null> {
  try {
    const callable = httpsCallable<{ memberId: string; contactEmailOrPhone: string }, CreateGrantResp>(
      clientFunctions,
      'createCaregiverGrant',
    )
    const resp = await callable({
      memberId: TARGET_MEMBER_ID,
      contactEmailOrPhone: 'smoke-test@example.com',
    })
    const { grantId, magicLink } = resp.data

    const url = new URL(magicLink)
    const gid = url.searchParams.get('gid')
    const linkHId = url.searchParams.get('hId')
    const linkMId = url.searchParams.get('mId')
    const s = url.searchParams.get('s')
    const sMasked = s ? `${s.slice(0, 6)}...` : '<missing>'

    if (!gid || !linkHId || !linkMId || !s) {
      fail('OP2', `magic link missing params: gid=${gid}, hId=${linkHId}, mId=${linkMId}, s=${sMasked}`)
      return null
    }
    if (gid !== grantId || linkHId !== HID || linkMId !== TARGET_MEMBER_ID) {
      fail('OP2', `magic link content mismatch: gid=${gid} grantId=${grantId} hId=${linkHId} mId=${linkMId}`)
      return null
    }

    const grantSnap = await adminDb
      .doc(`households/${HID}/members/${TARGET_MEMBER_ID}/caregiverGrants/${grantId}`)
      .get()
    if (!grantSnap.exists) {
      fail('OP2', `grant doc not found in Firestore at the expected path`)
      return null
    }
    const grant = grantSnap.data() as {
      grantSecretHash?: unknown
      revokedAt?: unknown
      acceptedAt?: unknown
      visibleMemberId?: unknown
    }
    if (typeof grant.grantSecretHash !== 'string' || grant.grantSecretHash.length === 0) {
      fail('OP2', `grantSecretHash missing or empty`)
      return null
    }
    const hashPrefix = grant.grantSecretHash.slice(0, 7)
    if (hashPrefix !== '$2a$10$' && hashPrefix !== '$2b$10$') {
      fail('OP2', `grantSecretHash not bcrypt cost-10: prefix="${hashPrefix}"`)
      // continue — soft failure on hash format
    }
    if (grant.revokedAt !== null) {
      fail('OP2', `revokedAt should be null at creation; got ${String(grant.revokedAt)}`)
    }
    if (grant.acceptedAt !== null) {
      fail('OP2', `acceptedAt should be null at creation; got ${String(grant.acceptedAt)}`)
    }
    if (grant.visibleMemberId !== TARGET_MEMBER_ID) {
      fail('OP2', `visibleMemberId mismatch: ${String(grant.visibleMemberId)}`)
    }

    pass(
      'OP2',
      `grantId=${grantId}, magic link params verified (s=${sMasked}), hash prefix=${hashPrefix}`,
    )
    return { hId: HID, mId: TARGET_MEMBER_ID, grantId, grantSecret: s }
  } catch (err) {
    fail('OP2', `error: ${describeError(err)}`)
    return null
  }
}

// ─── Op 3 — acceptCaregiverGrant ─────────────────────────────────────────────

interface AcceptGrantResp { customToken: string; expiresAt: number; visibleMemberId: string }

async function op3Accept(parsed: ParsedLink): Promise<{ customToken: string } | null> {
  try {
    await signOut(clientAuth)
    const callable = httpsCallable<ParsedLink, AcceptGrantResp>(
      clientFunctions,
      'acceptCaregiverGrant',
    )
    const resp = await callable(parsed)
    const { customToken, expiresAt, visibleMemberId } = resp.data

    if (typeof customToken !== 'string' || customToken.length < 50) {
      fail('OP3', `customToken not a plausible JWT: length=${typeof customToken === 'string' ? customToken.length : 'n/a'}`)
      return null
    }

    const now = Date.now()
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    const drift = Math.abs(expiresAt - now - sevenDays)
    if (drift > 60_000) {
      fail('OP3', `expiresAt drifts by ${drift}ms from 7 days`)
    }
    if (visibleMemberId !== TARGET_MEMBER_ID) {
      fail('OP3', `visibleMemberId mismatch: ${visibleMemberId}`)
    }

    const grantRef = adminDb.doc(
      `households/${parsed.hId}/members/${parsed.mId}/caregiverGrants/${parsed.grantId}`,
    )
    const snap = await grantRef.get()
    const grant = snap.data() as { acceptedAt?: unknown }
    if (!grant.acceptedAt) {
      fail('OP3', 'acceptedAt not set after accept')
    }

    await signInWithCustomToken(clientAuth, customToken)
    const expectedUid = `caregiver-${parsed.grantId}`
    if (clientAuth.currentUser?.uid !== expectedUid) {
      fail('OP3', `synthetic uid wrong: got ${clientAuth.currentUser?.uid}, expected ${expectedUid}`)
      return { customToken }
    }

    const tokenResult = await clientAuth.currentUser!.getIdTokenResult(true)
    const claims = tokenResult.claims as { hId?: string; memberId?: string; grantId?: string; role?: string }
    if (
      claims.hId !== parsed.hId
      || claims.memberId !== parsed.mId
      || claims.grantId !== parsed.grantId
      || claims.role !== 'caregiver'
    ) {
      fail('OP3', `claims mismatch: ${JSON.stringify(claims)}`)
      return { customToken }
    }

    pass(
      'OP3',
      `synthetic uid=${expectedUid}, claims verified, expiresAt drift=${drift}ms`,
    )
    return { customToken }
  } catch (err) {
    fail('OP3', `error: ${describeError(err)}`)
    return null
  }
}

// ─── Op 4 — caregiver reads (positive + negatives) ───────────────────────────

async function op4Reads(): Promise<void> {
  const todayIST = todayISTDateString()

  // Positive: todaySummary
  try {
    const snap = await getDoc(doc(clientDb, `households/${HID}/todaySummary/${todayIST}`))
    if (snap.exists()) {
      pass(
        'OP4-positive',
        `todaySummary read PERMITTED, doc found, ${Object.keys(snap.data() ?? {}).length} fields`,
      )
    } else {
      pass('OP4-positive', `todaySummary read PERMITTED (doc missing OK)`)
    }
  } catch (err) {
    fail('OP4-positive', `todaySummary read FAILED: ${describeError(err)}`)
  }

  // Negative: cabinets
  try {
    await getDoc(doc(clientDb, `households/${HID}/cabinets/${HID}-default`))
    fail('OP4-neg-cabinet', 'cabinets read PERMITTED — should be denied', /* critical */ true)
  } catch (err) {
    if (isPermissionDenied(err)) pass('OP4-neg-cabinet', 'cabinets read DENIED (correct)')
    else fail('OP4-neg-cabinet', `unexpected error: ${describeError(err)}`)
  }

  // Negative: members
  try {
    await getDoc(doc(clientDb, `households/${HID}/members/${TARGET_MEMBER_ID}`))
    fail('OP4-neg-member', 'members read PERMITTED — should be denied', /* critical */ true)
  } catch (err) {
    if (isPermissionDenied(err)) pass('OP4-neg-member', 'members read DENIED (correct)')
    else fail('OP4-neg-member', `unexpected error: ${describeError(err)}`)
  }

  // Negative: cross-household todaySummary
  try {
    await getDoc(doc(clientDb, `households/some-other-household/todaySummary/${todayIST}`))
    fail('OP4-neg-cross', 'cross-household read PERMITTED — should be denied', /* critical */ true)
  } catch (err) {
    if (isPermissionDenied(err)) pass('OP4-neg-cross', 'cross-household read DENIED (correct)')
    else fail('OP4-neg-cross', `unexpected error: ${describeError(err)}`)
  }
}

// ─── Op 5 — revoke + verify rules-level enforcement ──────────────────────────

async function op5Revoke(parsed: ParsedLink, customToken: string): Promise<void> {
  let firstRevokedAtMs: number | null = null
  try {
    await signOut(clientAuth)
    await signInWithEmailAndPassword(clientAuth, TEST_EMAIL, TEST_PASSWORD)

    const callable = httpsCallable<{ memberId: string; grantId: string }, { ok: true }>(
      clientFunctions,
      'revokeCaregiverGrant',
    )
    const resp = await callable({ memberId: parsed.mId, grantId: parsed.grantId })
    if (!resp.data.ok) {
      fail('OP5', 'revoke response.ok was not true')
      return
    }

    const snap = await adminDb
      .doc(`households/${HID}/members/${parsed.mId}/caregiverGrants/${parsed.grantId}`)
      .get()
    const revokedAt = snap.data()?.revokedAt as AdminTimestamp | null | undefined
    if (!revokedAt) {
      fail('OP5', 'revokedAt not set after revoke')
    } else {
      firstRevokedAtMs = revokedAt.toMillis()
    }

    // Sign back in as the same caregiver UID using the original customToken,
    // then force-refresh the ID token so claims are current. The grant doc
    // itself is now revoked, so the rules-level get() should deny on the
    // next read.
    await signOut(clientAuth)
    await signInWithCustomToken(clientAuth, customToken)
    await clientAuth.currentUser!.getIdToken(true)

    const todayIST = todayISTDateString()
    try {
      await getDoc(doc(clientDb, `households/${HID}/todaySummary/${todayIST}`))
      fail('OP5', 'todaySummary read PERMITTED after revoke', /* critical */ true)
    } catch (err) {
      if (isPermissionDenied(err)) {
        pass('OP5', 'post-revoke todaySummary read DENIED (rules-level revocation enforced)')
      } else {
        fail('OP5', `unexpected error after revoke: ${describeError(err)}`)
      }
    }

    // Idempotency check.
    await signOut(clientAuth)
    await signInWithEmailAndPassword(clientAuth, TEST_EMAIL, TEST_PASSWORD)

    const resp2 = await callable({ memberId: parsed.mId, grantId: parsed.grantId })
    if (!resp2.data.ok) {
      fail('OP5b', 'second revoke response.ok was not true')
      return
    }
    const snap2 = await adminDb
      .doc(`households/${HID}/members/${parsed.mId}/caregiverGrants/${parsed.grantId}`)
      .get()
    const secondRevokedAt = snap2.data()?.revokedAt as AdminTimestamp | null | undefined
    if (!secondRevokedAt || firstRevokedAtMs === null) {
      fail('OP5b', 'revokedAt timestamps missing for idempotency comparison')
      return
    }
    const secondMs = secondRevokedAt.toMillis()
    if (secondMs !== firstRevokedAtMs) {
      fail('OP5b', `idempotent revoke re-stamped revokedAt: ${firstRevokedAtMs} -> ${secondMs}`)
    } else {
      pass('OP5b', `second revoke is no-op, revokedAt unchanged (${firstRevokedAtMs})`)
    }
  } catch (err) {
    fail('OP5', `error: ${describeError(err)}`)
  }
}

// ─── Op 6 — listCaregiverGrants ──────────────────────────────────────────────

async function op6List(parsed: ParsedLink): Promise<void> {
  try {
    const callable = httpsCallable<{ memberId: string }, { grants: Array<Record<string, unknown>> }>(
      clientFunctions,
      'listCaregiverGrants',
    )
    const resp = await callable({ memberId: parsed.mId })
    const grants = resp.data.grants
    if (!Array.isArray(grants)) {
      fail('OP6a', 'grants response is not an array')
      return
    }
    const ours = grants.find((g) => g.grantId === parsed.grantId)
    if (!ours) {
      fail('OP6a', `our grant ${parsed.grantId} not found in list (n=${grants.length})`)
      return
    }
    const leaks = grants.filter((g) => 'grantSecretHash' in g)
    if (leaks.length > 0) {
      fail('OP6a', `${leaks.length} grants leak grantSecretHash`, /* critical */ true)
      return
    }
    pass('OP6a', `n=${grants.length}, our grant present, no grantSecretHash leaks`)
  } catch (err) {
    fail('OP6a', `error: ${describeError(err)}`)
  }
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

async function cleanup(parsed: ParsedLink | null): Promise<void> {
  let ok = true
  if (parsed) {
    try {
      await adminDb
        .doc(`households/${HID}/members/${parsed.mId}/caregiverGrants/${parsed.grantId}`)
        .delete()
    } catch (err) {
      ok = false
      console.log(`[OP6b] grant delete error: ${describeError(err)}`)
    }
  }
  try {
    await adminDb.doc(`households/${HID}/members/${TARGET_MEMBER_ID}`).delete()
  } catch (err) {
    ok = false
    console.log(`[OP6b] target member delete error: ${describeError(err)}`)
  }
  try {
    await signOut(clientAuth)
  } catch {
    /* ignore */
  }
  if (ok) pass('OP6b', 'grant + target member deleted, signed out')
  else fail('OP6b', 'cleanup had non-fatal errors (see above)')
}

// ─── Driver ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`=== AK-58 sub-task 1 smoke test ===`)
  console.log(`Target:           ${TARGET}`)
  console.log(`Project:          ${PROJECT_ID}`)
  console.log(`Tested commit:    24cf369 (local source via Functions emulator)`)
  console.log(``)

  let parsed: ParsedLink | null = null
  let customToken: string | null = null

  try {
    await op1Setup()
    parsed = await op2Create()
    if (parsed) {
      const acceptResult = await op3Accept(parsed)
      customToken = acceptResult?.customToken ?? null
    }
    if (parsed && customToken) {
      await op4Reads()
      await op5Revoke(parsed, customToken)
      await op6List(parsed)
    } else {
      console.log(`\n[smoke] skipping ops 4-6: prior op did not yield required data`)
    }
  } catch (err) {
    console.log(`\n[smoke] mid-run abort: ${describeError(err)}`)
  } finally {
    await cleanup(parsed)
  }

  console.log(``)
  console.log(`=== Summary ===`)
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  const critical = failed.filter((r) => r.critical)
  console.log(`Passed:           ${passed}/${results.length}`)
  console.log(`Failed:           ${failed.length}`)
  console.log(`Critical issues:  ${critical.length}`)
  if (failed.length > 0) {
    console.log(``)
    console.log(`Failures:`)
    for (const r of failed) {
      console.log(`  [${r.op}]${r.critical ? ' CRITICAL' : ''}: ${r.detail}`)
    }
  }
  console.log(``)
  console.log(`Detail:`)
  for (const r of results) {
    console.log(`  ${r.ok ? 'PASS' : (r.critical ? 'CRIT' : 'FAIL')} [${r.op}] — ${r.detail}`)
  }

  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error('[smoke] top-level error:', err)
  process.exit(2)
})
