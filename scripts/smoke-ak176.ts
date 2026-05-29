// AK-176 — bundle chunk-split assertion.
//
// Validates the build-time half of AK-176: the @firebase/firestore SDK code
// does NOT ship in the entry chunk and DOES ship in a separately-loadable
// lazy chunk. Inspects `dist/assets/` directly — that's the actual compiled
// output the user downloads, so this catches anything from a Vite config
// regression to an accidental top-level `import { db }` in a screen.
//
// The three behavioural assertions (memoization, cancel-before-resolve for
// the six real subscription wrappers, real round-trip) live in
// `tests/unit/ak176.test.ts` and run under Vitest against the Firestore
// emulator. They exercise the real `src/lib/firebase.ts` and
// `src/services/firestoreService.ts` exports — not a hand-copied pattern.
//
// Run:
//   npx tsx scripts/smoke-ak176.ts
//
// Builds first if no dist/ exists; reuses an existing build otherwise so it
// can run quickly after `npm run build` in CI.

import { execSync } from 'node:child_process'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

let pass = 0
let fail = 0
function expectTrue(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++
    console.log(`  ✓ PASS  ${name}`)
  } else {
    fail++
    console.log(`  ✗ FAIL  ${name}${detail ? ' — ' + detail : ''}`)
  }
}

function main(): void {
  console.log('\nAK-176 bundle assertion — inspecting dist/ for chunk-split correctness\n')

  if (!existsSync('dist/assets') || readdirSync('dist/assets').length === 0) {
    console.log('  (no dist yet — running npm run build)')
    execSync('npm run build', { stdio: 'pipe' })
  }

  const assets = readdirSync('dist/assets').filter((f) => f.endsWith('.js'))

  // The entry chunk is the index-*.js that contains the React-DOM mount
  // (createRoot). Vite chunks dynamic imports under their own filenames,
  // so the entry is identified by what it loads at startup, not by name
  // ordering.
  const candidates = assets.filter((f) => f.startsWith('index-'))
  let entry: string | undefined
  for (const c of candidates) {
    const content = readFileSync(join('dist/assets', c), 'utf8')
    if (content.includes('createRoot')) {
      entry = c
      break
    }
  }
  if (!entry) {
    console.error('  FATAL — could not identify entry chunk among ' + candidates.join(', '))
    process.exit(1)
  }
  console.log(`  Entry chunk: ${entry}`)

  const entryContent = readFileSync(join('dist/assets', entry), 'utf8')

  // SDK *definition* markers — class declarations that only ever appear
  // where the @firebase/firestore SDK source is bundled, never at call
  // sites in app code. Distinguishes "SDK shipped here" from "destructure
  // call referencing the SDK by name."
  const sdkDefinitionMarkers = [
    'class _QuerySnapshot',
    'class _FirestoreClient',
    '_FirestoreImpl',
    'class _PersistentLocalCache',
  ]
  const definitionHits = sdkDefinitionMarkers.filter((m) => entryContent.includes(m))
  expectTrue(
    'entry chunk does NOT contain Firestore SDK definitions',
    definitionHits.length === 0,
    definitionHits.length > 0 ? `found markers: ${definitionHits.join(', ')}` : undefined,
  )

  // Verify the SDK is actually present in some other (lazy) chunk.
  const lazyChunkWithSdk = assets
    .filter((f) => f !== entry)
    .find((f) => {
      const c = readFileSync(join('dist/assets', f), 'utf8')
      return c.includes('persistentLocalCache') && c.length > 50_000
    })
  expectTrue(
    'a separate lazy chunk contains the Firestore SDK',
    !!lazyChunkWithSdk,
    lazyChunkWithSdk ? `found in ${lazyChunkWithSdk}` : 'no large lazy chunk references persistentLocalCache',
  )

  // Bundle size sanity check — entry should be well below the AK-165
  // baseline of ~224 KB gzip (raw ~733 KB). We compare raw bytes here
  // because gzip requires a child-process call to gzip the file.
  const entryRawKB = Math.round(readFileSync(join('dist/assets', entry)).byteLength / 1024)
  console.log(`  Entry raw size: ${entryRawKB} KB`)
  // 600 KB raw is a generous upper bound; the actual entry after AK-176 is
  // ~418 KB raw. If the entry crosses 600 KB raw it means Firestore (or
  // similar weight) has crept back in.
  expectTrue(
    'entry chunk raw size is under 600 KB',
    entryRawKB < 600,
    `got ${entryRawKB} KB`,
  )

  console.log('\n──────────────────────────────────────────────────')
  console.log(`${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

try {
  main()
} catch (err) {
  console.error('\n[smoke-ak176] FATAL — uncaught error:', err)
  process.exit(1)
}
