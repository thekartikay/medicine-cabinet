// AK-171 — One-shot backfill for the new `timezone` field on
// HouseholdMember and Regimen documents. Stamps 'Asia/Kolkata' on every
// document that's missing the field (the beta default — all current
// patients are in India). Phase 2 will introduce a per-patient timezone
// picker; after that, members can override the backfilled value.
//
// Idempotent: docs that already carry a `timezone` field are skipped.
// Safe to re-run.
//
// Usage:
//   Emulator (Firestore only — no Auth dependency):
//     FIRESTORE_EMULATOR_HOST=localhost:8080 \
//       npx tsx scripts/backfillTimezones.ts
//
//   Production (admin SDK with service-account JSON):
//     GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json \
//       npx tsx scripts/backfillTimezones.ts

import { initializeApp, getApps, type App } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

const DEFAULT_TZ = 'Asia/Kolkata'

function ensureEnvironment(): void {
  const onEmulator = !!process.env.FIRESTORE_EMULATOR_HOST
  const hasCreds = !!process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!onEmulator && !hasCreds) {
    console.error('[backfillTimezones] Refusing to run with no target.\n')
    console.error('Either point at the local emulator:')
    console.error('  FIRESTORE_EMULATOR_HOST=localhost:8080 npx tsx scripts/backfillTimezones.ts\n')
    console.error('…or point at production with a service-account key:')
    console.error('  GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json npx tsx scripts/backfillTimezones.ts')
    process.exit(1)
  }
}

function initApp(): App {
  const existing = getApps()
  if (existing.length) return existing[0]!
  return initializeApp({ projectId: 'medicab-dev-2025' })
}

async function backfillMembers(
  db: Firestore,
  hId: string,
): Promise<{ updated: number; skipped: number }> {
  let updated = 0
  let skipped = 0
  const snap = await db.collection(`households/${hId}/members`).get()
  for (const doc of snap.docs) {
    const existing = (doc.data().timezone as string | undefined) ?? null
    if (existing) { skipped++; continue }
    await doc.ref.update({ timezone: DEFAULT_TZ })
    updated++
  }
  return { updated, skipped }
}

async function backfillRegimens(
  db: Firestore,
  hId: string,
): Promise<{ updated: number; skipped: number }> {
  let updated = 0
  let skipped = 0
  const treatments = await db.collection(`households/${hId}/treatments`).get()
  for (const tDoc of treatments.docs) {
    const regimens = await db
      .collection(`households/${hId}/treatments/${tDoc.id}/regimens`)
      .get()
    for (const rDoc of regimens.docs) {
      const existing = (rDoc.data().timezone as string | undefined) ?? null
      if (existing) { skipped++; continue }
      await rDoc.ref.update({ timezone: DEFAULT_TZ })
      updated++
    }
  }
  return { updated, skipped }
}

async function main(): Promise<void> {
  ensureEnvironment()
  const app = initApp()
  const db = getFirestore(app)

  const target = process.env.FIRESTORE_EMULATOR_HOST
    ? `emulator (${process.env.FIRESTORE_EMULATOR_HOST})`
    : 'PRODUCTION'
  console.log(`[backfillTimezones] Target: ${target}`)
  console.log(`[backfillTimezones] Default timezone: ${DEFAULT_TZ}`)

  const households = await db.collection('households').get()
  console.log(`[backfillTimezones] Households to scan: ${households.size}`)

  let totalMembersUpdated = 0
  let totalMembersSkipped = 0
  let totalRegimensUpdated = 0
  let totalRegimensSkipped = 0

  for (const hDoc of households.docs) {
    const hId = hDoc.id
    const members = await backfillMembers(db, hId)
    const regimens = await backfillRegimens(db, hId)
    totalMembersUpdated += members.updated
    totalMembersSkipped += members.skipped
    totalRegimensUpdated += regimens.updated
    totalRegimensSkipped += regimens.skipped
    if (members.updated || regimens.updated) {
      console.log(
        `  ${hId}: members +${members.updated}/skip ${members.skipped}, ` +
        `regimens +${regimens.updated}/skip ${regimens.skipped}`,
      )
    }
  }

  console.log('[backfillTimezones] Done.')
  console.log(`  Members:  updated=${totalMembersUpdated} skipped=${totalMembersSkipped}`)
  console.log(`  Regimens: updated=${totalRegimensUpdated} skipped=${totalRegimensSkipped}`)
}

main().catch((err) => {
  console.error('[backfillTimezones] Failed:', err)
  process.exit(1)
})
