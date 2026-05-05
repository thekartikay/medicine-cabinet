// Seed script for the global masterDb medicine catalogue.
//
// Runs against the Firestore emulator by default. ESM-friendly — uses static
// `import` (the project is `"type": "module"`) and `tsx` to execute TypeScript.
// Idempotent: every doc is written with set+merge keyed by a stable `medicineId`,
// so re-running the script is safe.
//
// Usage:
//   1. Start the Firestore emulator in another terminal:
//        firebase emulators:start --only firestore
//   2. Run the seed:
//        FIRESTORE_EMULATOR_HOST=localhost:8080 npx tsx scripts/seedMasterDb.ts
//
// Or one-shot via `firebase emulators:exec`:
//   firebase emulators:exec --only firestore "npx tsx scripts/seedMasterDb.ts"
//
// Targeting production requires GOOGLE_APPLICATION_CREDENTIALS pointing at a
// service-account JSON file. The script refuses to run if neither env var is set.

import { initializeApp, getApps, type App } from 'firebase-admin/app'
import { getFirestore, type Firestore } from 'firebase-admin/firestore'

interface MasterMedicine {
  medicineId: string
  name: string
  activeIngredient: string | null
}

// Curated list of common Indian-market medicines. The medicineId is stable so
// the seed is idempotent across runs.
const MEDICINES: MasterMedicine[] = [
  // ── Pain / fever / NSAIDs ───────────────────────────────────────────────
  { medicineId: 'crocin-500',         name: 'Crocin 500',          activeIngredient: 'Paracetamol 500mg' },
  { medicineId: 'crocin-650',         name: 'Crocin 650',          activeIngredient: 'Paracetamol 650mg' },
  { medicineId: 'crocin-pain-relief', name: 'Crocin Pain Relief',  activeIngredient: 'Paracetamol + Caffeine' },
  { medicineId: 'dolo-650',           name: 'Dolo 650',            activeIngredient: 'Paracetamol 650mg' },
  { medicineId: 'dolo-500',           name: 'Dolo 500',            activeIngredient: 'Paracetamol 500mg' },
  { medicineId: 'calpol-500',         name: 'Calpol 500',          activeIngredient: 'Paracetamol 500mg' },
  { medicineId: 'calpol-650',         name: 'Calpol 650',          activeIngredient: 'Paracetamol 650mg' },
  { medicineId: 'paracip-500',        name: 'Paracip 500',         activeIngredient: 'Paracetamol 500mg' },
  { medicineId: 'p-250',              name: 'P 250',               activeIngredient: 'Paracetamol 250mg (paediatric)' },
  { medicineId: 'combiflam',          name: 'Combiflam',           activeIngredient: 'Ibuprofen 400mg + Paracetamol 325mg' },
  { medicineId: 'brufen-400',         name: 'Brufen 400',          activeIngredient: 'Ibuprofen 400mg' },
  { medicineId: 'brufen-600',         name: 'Brufen 600',          activeIngredient: 'Ibuprofen 600mg' },
  { medicineId: 'disprin',            name: 'Disprin',             activeIngredient: 'Aspirin 350mg' },
  { medicineId: 'saridon',            name: 'Saridon',             activeIngredient: 'Paracetamol + Caffeine + Propyphenazone' },
  { medicineId: 'anacin',             name: 'Anacin',              activeIngredient: 'Paracetamol + Caffeine' },
  { medicineId: 'meftal-spas',        name: 'Meftal Spas',         activeIngredient: 'Mefenamic Acid + Dicyclomine' },
  { medicineId: 'meftal-p',           name: 'Meftal-P',            activeIngredient: 'Mefenamic Acid (paediatric)' },
  { medicineId: 'voveran-50',         name: 'Voveran 50',          activeIngredient: 'Diclofenac Sodium 50mg' },
  { medicineId: 'voveran-sr-100',     name: 'Voveran SR 100',      activeIngredient: 'Diclofenac Sodium 100mg (sustained release)' },
  { medicineId: 'naprosyn-500',       name: 'Naprosyn 500',        activeIngredient: 'Naproxen 500mg' },

  // ── Diabetes ────────────────────────────────────────────────────────────
  { medicineId: 'glycomet-500',       name: 'Glycomet 500',        activeIngredient: 'Metformin 500mg' },
  { medicineId: 'glycomet-850',       name: 'Glycomet 850',        activeIngredient: 'Metformin 850mg' },
  { medicineId: 'glycomet-gp1',       name: 'Glycomet GP1',        activeIngredient: 'Metformin + Glimepiride 1mg' },
  { medicineId: 'glycomet-gp2',       name: 'Glycomet GP2',        activeIngredient: 'Metformin + Glimepiride 2mg' },
  { medicineId: 'janumet-50-500',     name: 'Janumet 50/500',      activeIngredient: 'Sitagliptin 50mg + Metformin 500mg' },
  { medicineId: 'janumet-50-1000',    name: 'Janumet 50/1000',     activeIngredient: 'Sitagliptin 50mg + Metformin 1000mg' },
  { medicineId: 'amaryl-1',           name: 'Amaryl 1',            activeIngredient: 'Glimepiride 1mg' },
  { medicineId: 'amaryl-2',           name: 'Amaryl 2',            activeIngredient: 'Glimepiride 2mg' },
  { medicineId: 'galvus-50',          name: 'Galvus 50',           activeIngredient: 'Vildagliptin 50mg' },
  { medicineId: 'galvus-met',         name: 'Galvus Met',          activeIngredient: 'Vildagliptin + Metformin' },
  { medicineId: 'lantus-pen',         name: 'Lantus SoloStar',     activeIngredient: 'Insulin Glargine' },
  { medicineId: 'humalog',            name: 'Humalog',             activeIngredient: 'Insulin Lispro' },
  { medicineId: 'mixtard-30',         name: 'Mixtard 30',          activeIngredient: 'Premix Insulin (NPH + Regular)' },
  { medicineId: 'pioglar-15',         name: 'Pioglar 15',          activeIngredient: 'Pioglitazone 15mg' },

  // ── Hypertension / cardiac ──────────────────────────────────────────────
  { medicineId: 'amlong-5',           name: 'Amlong 5',            activeIngredient: 'Amlodipine 5mg' },
  { medicineId: 'amlong-10',          name: 'Amlong 10',           activeIngredient: 'Amlodipine 10mg' },
  { medicineId: 'stamlo-5',           name: 'Stamlo 5',            activeIngredient: 'Amlodipine 5mg' },
  { medicineId: 'telma-40',           name: 'Telma 40',            activeIngredient: 'Telmisartan 40mg' },
  { medicineId: 'telma-80',           name: 'Telma 80',            activeIngredient: 'Telmisartan 80mg' },
  { medicineId: 'telma-h',            name: 'Telma H',             activeIngredient: 'Telmisartan + Hydrochlorothiazide' },
  { medicineId: 'losar-50',           name: 'Losar 50',            activeIngredient: 'Losartan 50mg' },
  { medicineId: 'losar-h',            name: 'Losar H',             activeIngredient: 'Losartan + Hydrochlorothiazide' },
  { medicineId: 'concor-5',           name: 'Concor 5',            activeIngredient: 'Bisoprolol 5mg' },
  { medicineId: 'aten-50',            name: 'Aten 50',             activeIngredient: 'Atenolol 50mg' },
  { medicineId: 'aten-25',            name: 'Aten 25',             activeIngredient: 'Atenolol 25mg' },
  { medicineId: 'metolar-50',         name: 'Metolar 50',          activeIngredient: 'Metoprolol 50mg' },
  { medicineId: 'inderal-40',         name: 'Inderal 40',          activeIngredient: 'Propranolol 40mg' },
  { medicineId: 'cardivas-6.25',      name: 'Cardivas 6.25',       activeIngredient: 'Carvedilol 6.25mg' },
  { medicineId: 'cilacar-10',         name: 'Cilacar 10',          activeIngredient: 'Cilnidipine 10mg' },
  { medicineId: 'nicardia-10',        name: 'Nicardia 10',         activeIngredient: 'Nifedipine 10mg' },
  { medicineId: 'lasix-40',           name: 'Lasix 40',            activeIngredient: 'Furosemide 40mg' },
  { medicineId: 'ecosprin-75',        name: 'Ecosprin 75',         activeIngredient: 'Aspirin 75mg' },
  { medicineId: 'ecosprin-150',       name: 'Ecosprin 150',        activeIngredient: 'Aspirin 150mg' },
  { medicineId: 'ecosprin-av-75',     name: 'Ecosprin AV 75',      activeIngredient: 'Aspirin 75mg + Atorvastatin 10mg' },
  { medicineId: 'clopilet-75',        name: 'Clopilet 75',         activeIngredient: 'Clopidogrel 75mg' },
  { medicineId: 'plavix-75',          name: 'Plavix 75',           activeIngredient: 'Clopidogrel 75mg' },
  { medicineId: 'sorbitrate-10',      name: 'Sorbitrate 10',       activeIngredient: 'Isosorbide Dinitrate 10mg' },

  // ── Cholesterol ─────────────────────────────────────────────────────────
  { medicineId: 'atorva-10',          name: 'Atorva 10',           activeIngredient: 'Atorvastatin 10mg' },
  { medicineId: 'atorva-20',          name: 'Atorva 20',           activeIngredient: 'Atorvastatin 20mg' },
  { medicineId: 'storvas-10',         name: 'Storvas 10',          activeIngredient: 'Atorvastatin 10mg' },
  { medicineId: 'rosuvas-10',         name: 'Rosuvas 10',          activeIngredient: 'Rosuvastatin 10mg' },
  { medicineId: 'rosuvas-20',         name: 'Rosuvas 20',          activeIngredient: 'Rosuvastatin 20mg' },
  { medicineId: 'crestor-10',         name: 'Crestor 10',          activeIngredient: 'Rosuvastatin 10mg' },
  { medicineId: 'lipitor-10',         name: 'Lipitor 10',          activeIngredient: 'Atorvastatin 10mg' },
  { medicineId: 'simlup-20',          name: 'Simlup 20',           activeIngredient: 'Simvastatin 20mg' },

  // ── Antibiotics ─────────────────────────────────────────────────────────
  { medicineId: 'mox-500',            name: 'Mox 500',             activeIngredient: 'Amoxicillin 500mg' },
  { medicineId: 'augmentin-625',      name: 'Augmentin 625',       activeIngredient: 'Amoxicillin 500mg + Clavulanic Acid 125mg' },
  { medicineId: 'clavam-625',         name: 'Clavam 625',          activeIngredient: 'Amoxicillin 500mg + Clavulanic Acid 125mg' },
  { medicineId: 'azee-500',           name: 'Azee 500',            activeIngredient: 'Azithromycin 500mg' },
  { medicineId: 'azithral-500',       name: 'Azithral 500',        activeIngredient: 'Azithromycin 500mg' },
  { medicineId: 'taxim-o-200',        name: 'Taxim-O 200',         activeIngredient: 'Cefixime 200mg' },
  { medicineId: 'cifran-500',         name: 'Cifran 500',          activeIngredient: 'Ciprofloxacin 500mg' },
  { medicineId: 'levoflox-500',       name: 'Levoflox 500',        activeIngredient: 'Levofloxacin 500mg' },
  { medicineId: 'norflox-400',        name: 'Norflox 400',         activeIngredient: 'Norfloxacin 400mg' },
  { medicineId: 'doxy-100',           name: 'Doxy 100',            activeIngredient: 'Doxycycline 100mg' },
  { medicineId: 'flagyl-400',         name: 'Flagyl 400',          activeIngredient: 'Metronidazole 400mg' },
  { medicineId: 'metrogyl-400',       name: 'Metrogyl 400',        activeIngredient: 'Metronidazole 400mg' },
  { medicineId: 'septran-ds',         name: 'Septran DS',          activeIngredient: 'Sulfamethoxazole 800mg + Trimethoprim 160mg' },
  { medicineId: 'roxid-150',          name: 'Roxid 150',           activeIngredient: 'Roxithromycin 150mg' },

  // ── GI / antacid / PPI ──────────────────────────────────────────────────
  { medicineId: 'pan-d',              name: 'Pan-D',               activeIngredient: 'Pantoprazole 40mg + Domperidone 30mg' },
  { medicineId: 'pan-40',             name: 'Pan 40',              activeIngredient: 'Pantoprazole 40mg' },
  { medicineId: 'omez-20',            name: 'Omez 20',             activeIngredient: 'Omeprazole 20mg' },
  { medicineId: 'omez-d',             name: 'Omez D',              activeIngredient: 'Omeprazole + Domperidone' },
  { medicineId: 'razo-20',            name: 'Razo 20',             activeIngredient: 'Rabeprazole 20mg' },
  { medicineId: 'nexpro-40',          name: 'Nexpro 40',           activeIngredient: 'Esomeprazole 40mg' },
  { medicineId: 'aciloc-150',         name: 'Aciloc 150',          activeIngredient: 'Ranitidine 150mg' },
  { medicineId: 'zinetac-150',        name: 'Zinetac 150',         activeIngredient: 'Ranitidine 150mg' },
  { medicineId: 'digene-gel',         name: 'Digene Gel',          activeIngredient: 'Magaldrate + Simethicone' },
  { medicineId: 'digene-tablet',      name: 'Digene Tablet',       activeIngredient: 'Aluminium Hydroxide + Magnesium Hydroxide' },
  { medicineId: 'eno-fruit-salt',     name: 'ENO Fruit Salt',      activeIngredient: 'Sodium Bicarbonate + Citric Acid' },

  // ── Allergy / antihistamine ─────────────────────────────────────────────
  { medicineId: 'cetzine-10',         name: 'Cetzine 10',          activeIngredient: 'Cetirizine 10mg' },
  { medicineId: 'allegra-120',        name: 'Allegra 120',         activeIngredient: 'Fexofenadine 120mg' },
  { medicineId: 'allegra-180',        name: 'Allegra 180',         activeIngredient: 'Fexofenadine 180mg' },
  { medicineId: 'levoset-5',          name: 'Levoset 5',           activeIngredient: 'Levocetirizine 5mg' },
  { medicineId: 'avil-25',            name: 'Avil 25',             activeIngredient: 'Pheniramine Maleate 25mg' },
  { medicineId: 'montair-lc',         name: 'Montair LC',          activeIngredient: 'Montelukast 10mg + Levocetirizine 5mg' },
  { medicineId: 'monticope',          name: 'Monticope',           activeIngredient: 'Montelukast + Levocetirizine' },

  // ── Cough / cold ────────────────────────────────────────────────────────
  { medicineId: 'benadryl-cough',     name: 'Benadryl Cough Syrup',activeIngredient: 'Diphenhydramine + Ammonium Chloride' },
  { medicineId: 'corex',              name: 'Corex Cough Syrup',   activeIngredient: 'Chlorpheniramine + Codeine' },
  { medicineId: 'ascoril-ls',         name: 'Ascoril LS',          activeIngredient: 'Ambroxol + Levosalbutamol + Guaiphenesin' },
  { medicineId: 'sinarest',           name: 'Sinarest',            activeIngredient: 'Paracetamol + Phenylephrine + Chlorpheniramine' },
  { medicineId: 'sinarest-lp',        name: 'Sinarest LP',         activeIngredient: 'Paracetamol + Phenylephrine' },
  { medicineId: 'vicks-action-500',   name: 'Vicks Action 500',    activeIngredient: 'Paracetamol + Phenylephrine + Caffeine' },
  { medicineId: 'solvin-cold',        name: 'Solvin Cold',         activeIngredient: 'Phenylephrine + Chlorpheniramine + Paracetamol' },
  { medicineId: 't-minic',            name: 'T-Minic',             activeIngredient: 'Phenylephrine + Chlorpheniramine' },

  // ── Vitamins / supplements ──────────────────────────────────────────────
  { medicineId: 'becosules',          name: 'Becosules',           activeIngredient: 'B-complex with Vitamin C' },
  { medicineId: 'becozinc',           name: 'Becozinc',            activeIngredient: 'B-complex + Zinc' },
  { medicineId: 'neurobion-forte',    name: 'Neurobion Forte',     activeIngredient: 'Vitamin B1 + B6 + B12' },
  { medicineId: 'shelcal-500',        name: 'Shelcal 500',         activeIngredient: 'Calcium Carbonate 500mg + Vitamin D3' },
  { medicineId: 'calcium-sandoz',     name: 'Calcium Sandoz',      activeIngredient: 'Calcium Lactate Gluconate + Calcium Carbonate' },
  { medicineId: 'calcirol',           name: 'Calcirol',            activeIngredient: 'Vitamin D3 60000 IU' },
  { medicineId: 'uprise-d3',          name: 'Uprise D3',           activeIngredient: 'Vitamin D3 60000 IU' },
  { medicineId: 'limcee-500',         name: 'Limcee 500',          activeIngredient: 'Vitamin C 500mg' },
  { medicineId: 'folvite-5',          name: 'Folvite 5',           activeIngredient: 'Folic Acid 5mg' },
  { medicineId: 'livogen',            name: 'Livogen',             activeIngredient: 'Iron + Folic Acid' },
  { medicineId: 'zincovit',           name: 'Zincovit',            activeIngredient: 'Multivitamin + Zinc' },
  { medicineId: 'revital-h',          name: 'Revital H',           activeIngredient: 'Multivitamin + Ginseng' },

  // ── Asthma / respiratory ────────────────────────────────────────────────
  { medicineId: 'asthalin-inhaler',   name: 'Asthalin Inhaler',    activeIngredient: 'Salbutamol' },
  { medicineId: 'levolin-inhaler',    name: 'Levolin Inhaler',     activeIngredient: 'Levosalbutamol' },
  { medicineId: 'foracort-200',       name: 'Foracort 200',        activeIngredient: 'Formoterol + Budesonide 200mcg' },
  { medicineId: 'seroflo-250',        name: 'Seroflo 250',         activeIngredient: 'Salmeterol + Fluticasone 250mcg' },
  { medicineId: 'budecort',           name: 'Budecort',            activeIngredient: 'Budesonide' },
  { medicineId: 'duolin-inhaler',     name: 'Duolin Inhaler',      activeIngredient: 'Levosalbutamol + Ipratropium' },

  // ── Thyroid ─────────────────────────────────────────────────────────────
  { medicineId: 'eltroxin-50',        name: 'Eltroxin 50',         activeIngredient: 'Levothyroxine 50mcg' },
  { medicineId: 'eltroxin-100',       name: 'Eltroxin 100',        activeIngredient: 'Levothyroxine 100mcg' },
  { medicineId: 'thyronorm-50',       name: 'Thyronorm 50',        activeIngredient: 'Levothyroxine 50mcg' },
  { medicineId: 'thyronorm-100',      name: 'Thyronorm 100',       activeIngredient: 'Levothyroxine 100mcg' },
  { medicineId: 'thyrox-25',          name: 'Thyrox 25',           activeIngredient: 'Levothyroxine 25mcg' },

  // ── Anti-anxiety / sleep ────────────────────────────────────────────────
  { medicineId: 'alprax-0.25',        name: 'Alprax 0.25',         activeIngredient: 'Alprazolam 0.25mg' },
  { medicineId: 'restyl-0.5',         name: 'Restyl 0.5',          activeIngredient: 'Alprazolam 0.5mg' },
  { medicineId: 'calmpose-5',         name: 'Calmpose 5',          activeIngredient: 'Diazepam 5mg' },
]

function ensureEnvironment(): void {
  const onEmulator = !!process.env.FIRESTORE_EMULATOR_HOST
  const hasCreds = !!process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (!onEmulator && !hasCreds) {
    console.error('[seedMasterDb] Refusing to run with no target.\n')
    console.error('Either point at the local emulator:')
    console.error('  FIRESTORE_EMULATOR_HOST=localhost:8080 npx tsx scripts/seedMasterDb.ts\n')
    console.error('…or point at production with a service-account key:')
    console.error('  GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json npx tsx scripts/seedMasterDb.ts')
    process.exit(1)
  }
}

function initApp(): App {
  const existing = getApps()
  if (existing.length) return existing[0]!
  return initializeApp({
    // For the emulator any non-empty project id is fine; the env var the
    // Firebase CLI sets when running `emulators:exec` is GCLOUD_PROJECT.
    projectId:
      process.env.GOOGLE_CLOUD_PROJECT
      ?? process.env.GCLOUD_PROJECT
      ?? 'demo-medicab',
  })
}

async function seed(db: Firestore): Promise<{ written: number; total: number }> {
  // Firestore caps batches at 500 ops; chunk to be safe.
  const CHUNK = 400
  let written = 0
  for (let i = 0; i < MEDICINES.length; i += CHUNK) {
    const slice = MEDICINES.slice(i, i + CHUNK)
    const batch = db.batch()
    for (const med of slice) {
      const ref = db.collection('masterDb').doc(med.medicineId)
      batch.set(ref, med, { merge: true })
    }
    await batch.commit()
    written += slice.length
  }
  return { written, total: MEDICINES.length }
}

async function main(): Promise<void> {
  ensureEnvironment()
  const target = process.env.FIRESTORE_EMULATOR_HOST
    ? `emulator @ ${process.env.FIRESTORE_EMULATOR_HOST}`
    : 'production Firestore'

  console.log(`[seedMasterDb] Target: ${target}`)
  console.log(`[seedMasterDb] Seeding ${MEDICINES.length} medicines…`)

  const app = initApp()
  const db  = getFirestore(app)
  const { written, total } = await seed(db)

  // Count what's actually in the collection so the seed doubles as a smoke test.
  const snap = await db.collection('masterDb').count().get()
  console.log(`[seedMasterDb] Wrote ${written}/${total} entries.`)
  console.log(`[seedMasterDb] masterDb now contains ${snap.data().count} documents.`)
}

// Top-level await isn't ideal in CommonJS-shimmed environments; use a thenable
// chain so process.exit fires deterministically and the process unblocks even
// when firebase-admin keeps a gRPC connection alive in the background.
main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('[seedMasterDb] FAILED:', err)
    process.exit(1)
  })
