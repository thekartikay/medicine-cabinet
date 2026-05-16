// One-shot enrichment pass for the masterDb medicine catalogue. Reads every
// existing doc, parses brandName / strength / dosageForm out of the `name`
// and `activeIngredient` strings, and writes the four enrichment fields
// (brandName, strength, dosageForm, activeIngredients) back via update().
//
// Idempotent — re-running on already-enriched docs simply re-derives and
// re-writes the same values.
//
// Usage:
//   FIRESTORE_EMULATOR_HOST=localhost:8080 npx tsx scripts/enrichMasterDb.ts

import { initializeApp, getApps, type App } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'
// AK-148 — Pull the curated seed list so enrichment can honour explicit
// `dosageForm` overrides for medicines whose name doesn't carry a form
// keyword (insulins, plain-name capsules, etc.) or where the keyword
// inference is actively wrong (Digene Gel is an oral antacid).
import { MEDICINES, type MasterMedicine } from './seedMasterDb'

const SEED_BY_ID = new Map<string, MasterMedicine>(
  MEDICINES.map(m => [m.medicineId, m]),
)

function ensureEnvironment(): void {
  const onEmulator = !!process.env.FIRESTORE_EMULATOR_HOST
  const hasCreds = !!process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!onEmulator && !hasCreds) {
    console.error('[enrichMasterDb] Refusing to run with no target.\n')
    console.error('Either point at the local emulator:')
    console.error(
      '  FIRESTORE_EMULATOR_HOST=localhost:8080 npx tsx scripts/enrichMasterDb.ts\n',
    )
    console.error('…or point at production with a service-account key:')
    console.error(
      '  GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json npx tsx scripts/enrichMasterDb.ts',
    )
    process.exit(1)
  }
}

function initApp(): App {
  const existing = getApps()
  if (existing.length) return existing[0]!
  // Hardcoded — emulator-only utility, project id matches Vite's .env.local.
  return initializeApp({ projectId: 'medicab-dev-2025' })
}

// Brand = everything in the name before the first number OR a known
// dosage-form keyword. "Benadryl Cough Syrup" → "Benadryl" because the
// keyword list catches "Cough" before "Syrup".
function extractBrandName(name: string): string {
  const m = name.match(
    /\s+(\d|Inhaler\b|Cough\b|Syrup\b|Drops\b|Cream\b|Ointment\b|Gel\b|Injection\b|Inj\b|Capsule\b|Cap\b)/i,
  )
  if (m && m.index !== undefined) return name.slice(0, m.index).trim()
  return name.trim()
}

// Strength = first number in the name string, paired with whatever unit
// suffix the activeIngredient mentions for that same number ("500" in name +
// "Paracetamol 500mg" in ingredient → "500mg"). Falls back to "mg" if the
// ingredient is silent on the unit; falls back to ingredient-only when the
// name has no number. Returns null when neither carries a numeric dose.
function extractStrength(name: string, ingredient: string | null): string | null {
  const nameNumMatch = name.match(/\b(\d+(?:\.\d+)?)\b/)
  if (nameNumMatch) {
    const num = nameNumMatch[1]
    if (ingredient) {
      const escaped = num.replace('.', '\\.')
      const unitRe = new RegExp(`\\b${escaped}\\s*(mg|mcg|ml|g|IU|%)\\b`, 'i')
      const unitMatch = ingredient.match(unitRe)
      if (unitMatch) {
        const unit = unitMatch[1].toLowerCase() === 'iu' ? ' IU' : unitMatch[1]
        return `${num}${unit}`
      }
    }
    return `${num}mg`
  }
  if (ingredient) {
    const ingMatch = ingredient.match(/\b(\d+(?:\.\d+)?)\s*(mg|mcg|ml|g|IU|%)\b/i)
    if (ingMatch) {
      const unit = ingMatch[2].toLowerCase() === 'iu' ? ' IU' : ingMatch[2]
      return `${ingMatch[1]}${unit}`
    }
  }
  return null
}

// Dosage form picker. Keyword scan, priority order matches the spec; default
// is 'tablet'. Note: spec asked for 'topical' for cream/ointment/gel, but
// the DosageForm union in src/types.ts has 'cream' and no 'topical' — using
// 'cream' here so values round-trip cleanly through the Cabinet form's
// DosageForm select.
function extractDosageForm(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('inhaler')) return 'inhaler'
  if (n.includes('syrup')) return 'syrup'
  if (n.includes('drops')) return 'drops'
  if (/\b(cream|ointment|gel)\b/.test(n)) return 'cream'
  if (n.includes('injection') || /\binj\b/.test(n)) return 'injection'
  if (n.includes('capsule') || /\bcap\b/.test(n)) return 'capsule'
  return 'tablet'
}

interface MasterDbRecord {
  medicineId?: string
  name?: string
  activeIngredient?: string | null
}

async function enrich(db: Firestore): Promise<{ total: number; ok: number; fail: number }> {
  const snap = await db.collection('masterDb').get()
  let ok = 0
  let fail = 0
  for (const docSnap of snap.docs) {
    const data = docSnap.data() as MasterDbRecord
    const name = data.name ?? docSnap.id
    const ingredient = data.activeIngredient ?? null
    try {
      const brandName = extractBrandName(name)
      const strength = extractStrength(name, ingredient)
      // AK-148 — Explicit seed override wins over name-keyword inference.
      // This lets the curated list correct cases the heuristic gets wrong
      // (insulins extract as 'tablet'; Digene Gel extracts as 'cream').
      const seedEntry = SEED_BY_ID.get(docSnap.id)
      const dosageForm = seedEntry?.dosageForm ?? extractDosageForm(name)
      await docSnap.ref.update({
        brandName,
        strength,
        dosageForm,
        activeIngredients: ingredient,
        // AK-125 — Lowercased copy for case-insensitive prefix search.
        // Stamped on every enrichment pass so re-runs keep nameLower in
        // sync if a doc's `name` is ever edited out-of-band.
        nameLower: name.toLowerCase(),
      })
      console.log(
        `[enrichMasterDb] ${name} → brand=${brandName}, strength=${strength ?? 'null'}, form=${dosageForm}, lower=${name.toLowerCase()}`,
      )
      ok++
    } catch (e) {
      console.error(
        `[enrichMasterDb] FAILED on ${name}: ${(e as Error).message}`,
      )
      fail++
    }
  }
  return { total: snap.size, ok, fail }
}

async function main(): Promise<void> {
  ensureEnvironment()
  const target = process.env.FIRESTORE_EMULATOR_HOST
    ? `emulator @ ${process.env.FIRESTORE_EMULATOR_HOST}`
    : 'production Firestore'
  console.log(`[enrichMasterDb] Target: ${target}`)

  const app = initApp()
  const db = getFirestore(app)
  const { total, ok, fail } = await enrich(db)
  console.log(
    `[enrichMasterDb] Done. ${ok}/${total} enriched (${fail} failed).`,
  )
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[enrichMasterDb] FAILED:', err)
    process.exit(1)
  })
