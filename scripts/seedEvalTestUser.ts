// MC-004 / AK-31 — eval test-user seed.
//
// Provisions everything `evalCabinetQuery.ts` expects to find when it
// signs in: an Auth user with custom claims, a `users/{uid}` profile, a
// dedicated household with the user as admin, a default cabinet, and a
// handful of cabinet items resolved from masterDb. Idempotent on re-runs.
//
// Usage:
//   1. Populate .env.local (see scripts/README.md). Required:
//        FIREBASE_PROJECT_ID
//        GEMINI_TEST_USER_EMAIL
//        GEMINI_TEST_USER_PASSWORD
//        GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
//      (FIREBASE_API_KEY isn't read here — Admin SDK doesn't need it —
//      but evalCabinetQuery does.)
//   2. Run:
//        npm run setup:eval-user
//      To wipe and recreate the user (Auth + Firestore docs):
//        npm run setup:eval-user -- --reset
//
// Targets production Firebase by default. Emulator usage is supported
// for parity with seedMasterDb: set FIRESTORE_EMULATOR_HOST + the Auth
// equivalent FIREBASE_AUTH_EMULATOR_HOST and the Admin SDK will route
// to the local stack automatically.
//
// Process exit codes:
//    0 — success, test user is ready
//    1 — config error (missing env vars, bad credentials)
//    2 — partial failure mid-run (the user may be in an inconsistent
//        state; --reset is the way out)

import { config as loadDotenv } from 'dotenv'
import { initializeApp, getApps, applicationDefault, type App } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore, FieldValue, type Firestore } from 'firebase-admin/firestore'

// ── 0. dotenv ─────────────────────────────────────────────────────────────
loadDotenv({ path: '.env.local' })
loadDotenv({ path: '.env' })

// ── 1. CLI flags ──────────────────────────────────────────────────────────
const RESET = process.argv.slice(2).includes('--reset')

// ── 2. Constants ──────────────────────────────────────────────────────────
const HID = 'eval-test-household'
const CID = `${HID}-default`
const HOUSEHOLD_NAME = 'Eval Test Household'
const DISPLAY_NAME = 'Eval Test'

// Substring needles matched against masterDb {name, activeIngredient}, case-
// insensitively. Each needle gets the first matching masterDb doc seeded into
// the cabinet. These mirror the brand/molecule names the eval set assumes.
const CABINET_NEEDLES = [
  'Crocin',
  'Dolo',
  'Combiflam',
  'Brufen',
  'Disprin',
  'Voveran',
  'Glycomet',
  'Atorvastatin',
  'Pan-D',
] as const

// Cabinet items expire 180 days from today (eval doesn't exercise expiry but
// CabinetItem requires expiryDate to be a YYYY-MM-DD string).
const EXPIRY_DAYS = 180

// ── 3. Env-var validation ─────────────────────────────────────────────────
function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v || v.length === 0) {
    console.error(`[seedEvalTestUser] Missing required env var: ${name}`)
    console.error('[seedEvalTestUser] See scripts/README.md for the .env.local template.')
    process.exit(1)
  }
  return v
}

const PROJECT_ID = requireEnv('FIREBASE_PROJECT_ID')
const TEST_EMAIL = requireEnv('GEMINI_TEST_USER_EMAIL')
const TEST_PASSWORD = requireEnv('GEMINI_TEST_USER_PASSWORD')

// Production credentials are required UNLESS we're pointed at the emulators.
// Same shape as seedMasterDb's `ensureEnvironment`.
const ON_FIRESTORE_EMULATOR = !!process.env.FIRESTORE_EMULATOR_HOST
const ON_AUTH_EMULATOR = !!process.env.FIREBASE_AUTH_EMULATOR_HOST
const HAS_CREDS = !!process.env.GOOGLE_APPLICATION_CREDENTIALS

if (!HAS_CREDS && !(ON_FIRESTORE_EMULATOR && ON_AUTH_EMULATOR)) {
  console.error('[seedEvalTestUser] Refusing to run with no target.\n')
  console.error('Production:')
  console.error('  GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json npm run setup:eval-user\n')
  console.error('Emulators:')
  console.error('  FIRESTORE_EMULATOR_HOST=localhost:8080 \\')
  console.error('  FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 \\')
  console.error('  npm run setup:eval-user')
  process.exit(1)
}

// ── 4. Header ─────────────────────────────────────────────────────────────
console.log('[seedEvalTestUser] target:', ON_FIRESTORE_EMULATOR ? 'emulator' : 'production')
console.log('[seedEvalTestUser] project:', PROJECT_ID)
console.log('[seedEvalTestUser] email:', TEST_EMAIL)
console.log('[seedEvalTestUser] hId:', HID)
console.log('[seedEvalTestUser] cId:', CID)
console.log('[seedEvalTestUser] reset:', RESET)
console.log()

// ── 5. Init Admin SDK ─────────────────────────────────────────────────────
function initApp(): App {
  const existing = getApps()
  if (existing.length) return existing[0]!
  // applicationDefault() reads GOOGLE_APPLICATION_CREDENTIALS; the emulator
  // path doesn't need real creds and the SDK will pick the env vars up.
  return initializeApp({
    projectId: PROJECT_ID,
    credential: HAS_CREDS ? applicationDefault() : undefined,
  })
}

const app = initApp()
const auth = getAuth(app)
const db = getFirestore(app)

// ── 6. Reset (only if --reset and the email matches the configured one) ───
async function maybeReset(): Promise<void> {
  if (!RESET) return
  console.log('[seedEvalTestUser] --reset: looking up existing user…')
  let existing
  try {
    existing = await auth.getUserByEmail(TEST_EMAIL)
  } catch (err) {
    if ((err as { code?: string }).code === 'auth/user-not-found') {
      console.log('[seedEvalTestUser] no existing user to reset.')
      return
    }
    throw err
  }
  // Guard: refuse to delete anything that doesn't have the configured email.
  // Belt-and-braces for the case where Auth UID lookup hits a wrong record.
  if (existing.email !== TEST_EMAIL) {
    console.error(
      `[seedEvalTestUser] FATAL: looked up uid ${existing.uid} but its email ` +
      `(${existing.email}) doesn't match GEMINI_TEST_USER_EMAIL (${TEST_EMAIL}). ` +
      'Refusing to delete. Resolve this manually.',
    )
    process.exit(2)
  }
  console.log(`[seedEvalTestUser] deleting Auth user ${existing.uid} (${existing.email})…`)
  await auth.deleteUser(existing.uid)
  // Firestore docs are not auto-deleted; we leave them in place because the
  // upserts below will overwrite them with the new uid's data, and an
  // orphaned users/{old-uid} doc with `deletedAt` unset is harmless. Document
  // it so the operator isn't surprised.
  console.log('[seedEvalTestUser] note: previous users/{uid} doc is left in place. ' +
              'It will not be reused — the new run gets a fresh uid.')
}

// ── 7. Create or fetch the Auth user ──────────────────────────────────────
async function ensureAuthUser(): Promise<string> {
  try {
    const created = await auth.createUser({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
      emailVerified: true,
      displayName: DISPLAY_NAME,
    })
    console.log(`[seedEvalTestUser] created Auth user uid=${created.uid}`)
    return created.uid
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code !== 'auth/email-already-exists') throw err
    const existing = await auth.getUserByEmail(TEST_EMAIL)
    console.log(`[seedEvalTestUser] Auth user already exists uid=${existing.uid} — proceeding idempotently.`)
    return existing.uid
  }
}

// ── 8. Custom claims ──────────────────────────────────────────────────────
// setCustomUserClaims overwrites; no exists-check needed. Mirrors the
// shape that createHousehold sets ({ hId, role: 'admin' }) so security
// rules treat this user identically to a real-admin sign-in.
async function setClaims(uid: string): Promise<void> {
  await auth.setCustomUserClaims(uid, { hId: HID, role: 'admin' })
  console.log(`[seedEvalTestUser] custom claims set: { hId: '${HID}', role: 'admin' }`)
}

// ── 9. Firestore upserts ──────────────────────────────────────────────────
// Field shapes match src/types.ts exactly. Keys not declared on the types
// are intentionally omitted (shareToken, ownerId, status, etc.) — see the
// pre-flight notes in the prompt thread for the rationale on each.

// Today + N days as YYYY-MM-DD (CabinetItem.expiryDate is a string).
function expiryDateString(daysFromNow: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + daysFromNow)
  // 'sv-SE' locale outputs ISO 8601 calendar order — same trick used by
  // todayISTDateString in functions/src/util/istDate.ts.
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

async function upsertUserDoc(uid: string): Promise<void> {
  // AppUser fields per src/types.ts. `subscriptionTier` is not declared on
  // the type but the runtime reads it (Dashboard + proxy rate limiter) —
  // known typing gap.
  await db.doc(`users/${uid}`).set(
    {
      uid,
      displayName: DISPLAY_NAME,
      email: TEST_EMAIL,
      phoneNumber: null,
      photoURL: null,
      createdAt: FieldValue.serverTimestamp(),
      householdId: HID,
      subscriptionTier: 'family',
    },
    { merge: true },
  )
  console.log(`[seedEvalTestUser] upserted users/${uid}`)
}

async function upsertHousehold(uid: string): Promise<void> {
  // Household fields per src/types.ts. shareToken intentionally not written.
  await db.doc(`households/${HID}`).set(
    {
      hId: HID,
      name: HOUSEHOLD_NAME,
      primaryAdminId: uid,
      adminIds: [uid],
      memberUids: [uid],
      createdAt: FieldValue.serverTimestamp(),
      lastAuditAt: null,
    },
    { merge: true },
  )
  console.log(`[seedEvalTestUser] upserted households/${HID}`)
}

async function upsertMemberDoc(uid: string): Promise<void> {
  // HouseholdMember fields per src/types.ts. `name` is not on the type;
  // the field is `displayName`. `isAdult` is not on the type at all.
  await db.doc(`households/${HID}/members/${uid}`).set(
    {
      uid,
      hId: HID,
      role: 'admin',
      displayName: DISPLAY_NAME,
      joinedAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
  console.log(`[seedEvalTestUser] upserted households/${HID}/members/${uid}`)
}

async function upsertDefaultCabinet(): Promise<void> {
  // Cabinet type only declares { cId, hId, name, createdAt }. Membership
  // is implicit at the household level — no ownerId/memberUids/isPrivate.
  await db.doc(`households/${HID}/cabinets/${CID}`).set(
    {
      cId: CID,
      hId: HID,
      name: 'Main Cabinet',
      createdAt: FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
  console.log(`[seedEvalTestUser] upserted households/${HID}/cabinets/${CID}`)
}

// ── 10. Resolve cabinet items from masterDb ───────────────────────────────
interface MasterDoc {
  medicineId: string
  name: string
  activeIngredient: string | null
}

async function loadMatchedMasterDocs(): Promise<Array<{ needle: string; doc: MasterDoc | null }>> {
  // Pull masterDb once (it's seeded with ~120 docs — cheap; one read).
  const snap = await db.collection('masterDb').get()
  const all: MasterDoc[] = snap.docs.map((d) => {
    const data = d.data()
    return {
      medicineId: (data.medicineId as string) ?? d.id,
      name: (data.name as string) ?? '',
      activeIngredient: (data.activeIngredient as string | null | undefined) ?? null,
    }
  })

  return CABINET_NEEDLES.map((needle) => {
    const lower = needle.toLowerCase()
    const hit = all.find(
      (m) =>
        m.name.toLowerCase().includes(lower)
        || (m.activeIngredient ?? '').toLowerCase().includes(lower),
    ) ?? null
    return { needle, doc: hit }
  })
}

async function seedCabinetItems(): Promise<{ added: number; skipped: number; missing: string[] }> {
  const matches = await loadMatchedMasterDocs()
  let added = 0
  let skipped = 0
  const missing: string[] = []

  for (const { needle, doc: master } of matches) {
    if (!master) {
      missing.push(needle)
      console.log(`[seedEvalTestUser] [skip] not in masterDb: ${needle}`)
      continue
    }

    // Deterministic doc id keeps re-runs idempotent without a query-first step.
    const iId = `eval-${master.medicineId}`
    const itemRef = db.doc(`households/${HID}/cabinets/${CID}/items/${iId}`)
    const existing = await itemRef.get()
    if (existing.exists) {
      // Refresh updatedAt only — preserves quantityOnHand if the operator
      // adjusted it manually for a follow-up run.
      await itemRef.set({ updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      skipped++
      console.log(`[seedEvalTestUser] [exists] ${needle} → ${master.medicineId}`)
      continue
    }

    // CabinetItem fields per src/types.ts. unit ∈ {tablet, ml, capsule, spray, dose};
    // expiryDate is a YYYY-MM-DD string; createdAt/updatedAt are Timestamps;
    // prescribed is required (eval items default to false). brandName +
    // activeIngredients enriched from masterDb so the cabinet rendering
    // looks right in the app and the proxy's name index has surfaces to
    // match against.
    await itemRef.set({
      iId,
      cId: CID,
      hId: HID,
      medicineId: master.medicineId,
      displayNameOverride: null,
      quantityOnHand: 10,
      unit: 'tablet',
      expiryDate: expiryDateString(EXPIRY_DAYS),
      prescribed: false,
      brandName: master.name,
      activeIngredients: master.activeIngredient,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })
    added++
    console.log(`[seedEvalTestUser] [add] ${needle} → ${master.medicineId} (${master.name})`)
  }

  return { added, skipped, missing }
}

// ── 11. Driver ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await maybeReset()

  const uid = await ensureAuthUser()
  await setClaims(uid)
  await upsertUserDoc(uid)
  await upsertHousehold(uid)
  await upsertMemberDoc(uid)
  await upsertDefaultCabinet()
  const { added, skipped, missing } = await seedCabinetItems()

  console.log()
  console.log('───────────────────────────────────────────────────────────')
  console.log(' Eval test user is ready')
  console.log('───────────────────────────────────────────────────────────')
  console.log(`  uid:                ${uid}`)
  console.log(`  email:              ${TEST_EMAIL}`)
  console.log(`  hId:                ${HID}`)
  console.log(`  cId:                ${CID}`)
  console.log(`  custom claims:      { hId: '${HID}', role: 'admin' }`)
  console.log(`  cabinet items:      ${added} added, ${skipped} already present`)
  console.log(`  cabinet items requested: ${CABINET_NEEDLES.length}`)
  if (missing.length > 0) {
    console.log(`  not found in masterDb:  ${missing.join(', ')}`)
    console.log('  (those queries will SKIP in the eval, not FAIL — re-seed masterDb to fix)')
  }
  console.log()
  console.log('  Ready to run npm run eval:cabinet -- --target=dev')
  console.log('───────────────────────────────────────────────────────────')
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\n[seedEvalTestUser] FAILED mid-run:', err)
    console.error('[seedEvalTestUser] The test user may be in a partial state.')
    console.error('[seedEvalTestUser] Re-run with --reset to wipe and start over:')
    console.error('[seedEvalTestUser]   npm run setup:eval-user -- --reset')
    process.exit(2)
  })
