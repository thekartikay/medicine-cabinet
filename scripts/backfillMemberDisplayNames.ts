// AK-153 — One-shot backfill for households/{hId}/members/{uid}.displayName.
// Sweeps every member doc; if displayName is null or empty, fills it from
// Firebase Auth's userRecord.displayName, falling back to a "Member · 1234"
// mask derived from the last four digits of userRecord.phoneNumber when Auth
// also has no displayName.
//
// Idempotent: members whose displayName is already set are skipped.
//
// Usage:
//   Emulator (Firestore + Auth must both be running):
//     FIRESTORE_EMULATOR_HOST=localhost:8080 FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 \
//       npx tsx scripts/backfillMemberDisplayNames.ts
//
//   Production (admin SDK with service-account JSON):
//     GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json \
//       npx tsx scripts/backfillMemberDisplayNames.ts

import { initializeApp, getApps, type App } from 'firebase-admin/app'
import { getFirestore, FieldValue, type Firestore } from 'firebase-admin/firestore'
import { getAuth, type Auth, type UserRecord } from 'firebase-admin/auth'

function ensureEnvironment(): void {
  const onEmulator = !!process.env.FIRESTORE_EMULATOR_HOST
  const hasCreds = !!process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!onEmulator && !hasCreds) {
    console.error('[backfillMemberDisplayNames] Refusing to run with no target.\n')
    console.error('Either point at the local emulator:')
    console.error(
      '  FIRESTORE_EMULATOR_HOST=localhost:8080 FIREBASE_AUTH_EMULATOR_HOST=localhost:9099 \\\n' +
      '    npx tsx scripts/backfillMemberDisplayNames.ts\n',
    )
    console.error('…or point at production with a service-account key:')
    console.error(
      '  GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json npx tsx scripts/backfillMemberDisplayNames.ts',
    )
    process.exit(1)
  }
  // Auth emulator is optional in prod, mandatory when targeting Firestore
  // emulator (Auth lookups would otherwise hit live Firebase Auth).
  if (onEmulator && !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    console.error(
      '[backfillMemberDisplayNames] FIRESTORE_EMULATOR_HOST set but ' +
      'FIREBASE_AUTH_EMULATOR_HOST is not. Auth lookups would hit ' +
      'production. Refusing to run.',
    )
    process.exit(1)
  }
}

function initApp(): App {
  const existing = getApps()
  if (existing.length) return existing[0]!
  // Hardcoded project id matches enrichMasterDb / Vite .env.local.
  return initializeApp({ projectId: 'medicab-dev-2025' })
}

interface MemberRecord {
  uid?: string
  displayName?: string | null
}

interface BackfillResult {
  total: number
  alreadySet: number
  filledFromAuth: number
  filledFromPhone: number
  skipped: number
  failed: number
}

function isEmpty(v: string | null | undefined): boolean {
  return v == null || v.trim() === ''
}

// "+919611279652" → "Member · 9652"; bad input → null.
function maskFromPhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 4) return null
  return `Member · ${digits.slice(-4)}`
}

async function backfill(db: Firestore, auth: Auth): Promise<BackfillResult> {
  const result: BackfillResult = {
    total: 0,
    alreadySet: 0,
    filledFromAuth: 0,
    filledFromPhone: 0,
    skipped: 0,
    failed: 0,
  }

  // collectionGroup walks every household's members subcollection in one query.
  const snap = await db.collectionGroup('members').get()
  result.total = snap.size

  for (const docSnap of snap.docs) {
    const data = docSnap.data() as MemberRecord
    // The path looks like households/{hId}/members/{uid}; use it as the audit
    // key in logs so a reviewer can locate any specific row.
    const path = docSnap.ref.path
    const uid = data.uid ?? docSnap.id

    if (!isEmpty(data.displayName)) {
      result.alreadySet++
      continue
    }

    let userRecord: UserRecord
    try {
      userRecord = await auth.getUser(uid)
    } catch (e) {
      console.error(
        `[backfillMemberDisplayNames] AUTH LOOKUP FAILED for ${path}: ${(e as Error).message}`,
      )
      result.failed++
      continue
    }

    let nextName: string | null = null
    let source: 'auth' | 'phone' = 'auth'
    if (!isEmpty(userRecord.displayName)) {
      nextName = userRecord.displayName!.trim()
      source = 'auth'
    } else {
      const masked = maskFromPhone(userRecord.phoneNumber)
      if (masked) {
        nextName = masked
        source = 'phone'
      }
    }

    if (nextName == null) {
      console.log(
        `[backfillMemberDisplayNames] SKIP ${path} (uid=${uid}): no Auth.displayName and no usable phone`,
      )
      result.skipped++
      continue
    }

    try {
      await docSnap.ref.update({
        displayName: nextName,
        updatedAt: FieldValue.serverTimestamp(),
      })
      console.log(
        `[backfillMemberDisplayNames] WROTE ${path} (uid=${uid}) → "${nextName}" (source=${source})`,
      )
      if (source === 'auth') result.filledFromAuth++
      else result.filledFromPhone++
    } catch (e) {
      console.error(
        `[backfillMemberDisplayNames] WRITE FAILED for ${path}: ${(e as Error).message}`,
      )
      result.failed++
    }
  }

  return result
}

async function main(): Promise<void> {
  ensureEnvironment()
  const target = process.env.FIRESTORE_EMULATOR_HOST
    ? `emulator @ ${process.env.FIRESTORE_EMULATOR_HOST}`
    : 'production Firestore'
  console.log(`[backfillMemberDisplayNames] Target: ${target}`)

  const app = initApp()
  const db = getFirestore(app)
  const auth = getAuth(app)
  const r = await backfill(db, auth)
  console.log(
    `[backfillMemberDisplayNames] Done. ${r.total} members scanned: ` +
    `${r.alreadySet} already set, ${r.filledFromAuth} from Auth, ` +
    `${r.filledFromPhone} from phone mask, ${r.skipped} skipped, ${r.failed} failed.`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfillMemberDisplayNames] FAILED:', err)
    process.exit(1)
  })
