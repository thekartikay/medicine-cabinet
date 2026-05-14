// AK-39 — Stamps an interactionWarning on the first cabinet item found in
// the first household / first cabinet of the local emulator. Used to demo
// the passive interaction-tag UI without depending on a live Gemini call.
//
// ESM-friendly — matches scripts/seedMasterDb.ts (the project is
// `"type": "module"` and uses `tsx` to run TypeScript directly).
//
// Usage:
//   1. Start the emulator suite in another terminal:
//        firebase emulators:start --import=./emulator-data
//   2. Run the seed:
//        FIRESTORE_EMULATOR_HOST=localhost:8080 npx tsx scripts/seedInteractionWarning.ts
//
// Production is gated by GOOGLE_APPLICATION_CREDENTIALS but in practice this
// script should only ever run against the emulator — it's a UI demo helper.

import { initializeApp, getApps, type App } from 'firebase-admin/app'
import { getFirestore, Timestamp, type Firestore } from 'firebase-admin/firestore'

const INTERACTION_WARNING = {
  withMedicineNames: ['Warfarin'],
  riskLevel: 'high' as const,
  description:
    'Ibuprofen significantly increases bleeding risk when combined with Warfarin.',
  checkedAt: Timestamp.now(),
}

function ensureEnvironment(): void {
  const onEmulator = !!process.env.FIRESTORE_EMULATOR_HOST
  const hasCreds = !!process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!onEmulator && !hasCreds) {
    console.error('[seedInteractionWarning] Refusing to run with no target.\n')
    console.error('Either point at the local emulator:')
    console.error(
      '  FIRESTORE_EMULATOR_HOST=localhost:8080 npx tsx scripts/seedInteractionWarning.ts\n',
    )
    console.error('…or point at production with a service-account key:')
    console.error(
      '  GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json npx tsx scripts/seedInteractionWarning.ts',
    )
    process.exit(1)
  }
}

function initApp(): App {
  const existing = getApps()
  if (existing.length) return existing[0]!
  // Hardcoded — this script is emulator-only and the dev project ID is the
  // same id the Vite client uses (.env.local VITE_FIREBASE_PROJECT_ID). The
  // earlier env-var fallback ('demo-medicab') silently wrote to a parallel
  // namespace inside the emulator, so the app never saw the update.
  return initializeApp({ projectId: 'medicab-dev-2025' })
}

async function seed(db: Firestore): Promise<void> {
  // 1. First household.
  const households = await db.collection('households').limit(1).get()
  if (households.empty) {
    throw new Error(
      'No households found in Firestore. Sign in via the app first so the auth flow creates one.',
    )
  }
  const householdDoc = households.docs[0]!
  const hId = householdDoc.id

  // 2. First cabinet in that household.
  const cabinets = await householdDoc.ref.collection('cabinets').limit(1).get()
  if (cabinets.empty) {
    throw new Error(`Household ${hId} has no cabinets.`)
  }
  const cabinetDoc = cabinets.docs[0]!
  const cId = cabinetDoc.id

  // 3. First item in that cabinet.
  const items = await cabinetDoc.ref.collection('items').limit(1).get()
  if (items.empty) {
    throw new Error(
      `Cabinet ${hId}/${cId} has no items. Add a medicine via the app first.`,
    )
  }
  const itemDoc = items.docs[0]!
  const iId = itemDoc.id
  const data = itemDoc.data()
  const itemName =
    (data.displayNameOverride as string | undefined)
    ?? (data.brandName as string | undefined)
    ?? (data.medicineId as string | undefined)
    ?? iId

  // 4. Stamp the warning. updatedAt uses serverTimestamp via FieldValue is
  // unnecessary here — Admin SDK Timestamp.now() is wall-clock from the
  // server running the script, which is fine for a local seed helper.
  await itemDoc.ref.update({
    interactionWarning: INTERACTION_WARNING,
    updatedAt: Timestamp.now(),
  })

  console.log(`[seedInteractionWarning] Updated households/${hId}/cabinets/${cId}/items/${iId}`)
  console.log(`[seedInteractionWarning] Item: ${itemName}`)
  console.log(`[seedInteractionWarning] interactionWarning payload stamped:`)
  console.log(`  withMedicineNames: ${JSON.stringify(INTERACTION_WARNING.withMedicineNames)}`)
  console.log(`  riskLevel:         ${INTERACTION_WARNING.riskLevel}`)
  console.log(`  description:       "${INTERACTION_WARNING.description}"`)
}

async function main(): Promise<void> {
  ensureEnvironment()
  const target = process.env.FIRESTORE_EMULATOR_HOST
    ? `emulator @ ${process.env.FIRESTORE_EMULATOR_HOST}`
    : 'production Firestore'

  console.log(`[seedInteractionWarning] Target: ${target}`)

  const app = initApp()
  const db = getFirestore(app)
  await seed(db)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seedInteractionWarning] FAILED:', err)
    process.exit(1)
  })
