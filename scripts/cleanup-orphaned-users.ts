// One-off cleanup for medicab-dev-2025: deletes /users/{uid} Firestore docs
// whose corresponding Firebase Auth user no longer exists. Mirrors the
// behaviour of the cleanupOrphanedUsers Cloud Function but runs locally via
// the Admin SDK so it doesn't need callable-invocation gymnastics (the
// firebase-admin SDK has no httpsCallable).
//
// Auth: relies on Application Default Credentials. Either run
//   gcloud auth application-default login
// or set GOOGLE_APPLICATION_CREDENTIALS to a service-account key JSON.
//
// Project ID is hardcoded as a safety belt — change PROJECT_ID below if you
// ever need to run this against a different Firebase project.
//
// Usage:
//   npx tsx scripts/cleanup-orphaned-users.ts

import { initializeApp, applicationDefault } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

const PROJECT_ID = 'medicab-dev-2025'

initializeApp({
  credential: applicationDefault(),
  projectId: PROJECT_ID,
})

interface ResultRow {
  uid: string
  status: 'deleted' | 'preserved' | 'failed'
  reason?: string
}

async function main(): Promise<void> {
  console.log(`Invoking cleanup on ${PROJECT_ID}...`)
  const auth = getAuth()
  const db = getFirestore()

  // 1. Page through every Auth user. listUsers caps at 1000 per page.
  const authUids = new Set<string>()
  let pageToken: string | undefined
  do {
    const page = await auth.listUsers(1000, pageToken)
    for (const u of page.users) authUids.add(u.uid)
    pageToken = page.pageToken
  } while (pageToken)

  // 2. Snapshot every users/{uid} doc.
  const snap = await db.collection('users').get()

  // 3. Walk: delete orphans, record preserved ones for the report.
  const results: ResultRow[] = []
  for (const docSnap of snap.docs) {
    const uid = docSnap.id
    if (authUids.has(uid)) {
      results.push({ uid, status: 'preserved' })
      continue
    }
    try {
      await db.collection('users').doc(uid).delete()
      results.push({ uid, status: 'deleted' })
    } catch (e) {
      results.push({
        uid,
        status: 'failed',
        reason: (e as Error).message,
      })
    }
  }

  const deletedCount = results.filter((r) => r.status === 'deleted').length
  const failedCount = results.filter((r) => r.status === 'failed').length

  console.log('Response received:')
  console.log(`  Total Auth users: ${authUids.size}`)
  console.log(`  Total Firestore users: ${snap.size}`)
  console.log(`  Orphaned deleted: ${deletedCount}`)
  console.log(`  Results:`)
  for (const r of results) {
    if (r.status === 'deleted') {
      console.log(`    - users/${r.uid}: deleted ✓`)
    } else if (r.status === 'preserved') {
      console.log(`    - users/${r.uid}: preserved (auth user exists)`)
    } else {
      console.log(`    - users/${r.uid}: FAILED — ${r.reason}`)
    }
  }
  console.log(
    `Cleanup complete. ${deletedCount} orphaned documents removed.` +
      (failedCount ? ` (${failedCount} failed)` : ''),
  )
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Cleanup failed:', err)
    process.exit(1)
  })
