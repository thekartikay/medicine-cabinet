// One-off admin utility: delete /users/{uid} Firestore docs whose matching
// Firebase Auth user no longer exists. These orphans arise when an Auth user
// is deleted directly (e.g. from the Firebase console) without a paired
// Firestore cleanup — the stale `householdId` on the orphan profile blocks
// the same human from re-signing-in or rejoining a household.
//
// Caller must be an authenticated admin already in a household (custom claims
// must carry role='admin' and a non-empty hId). App Check is intentionally
// NOT enforced here: the utility is invoked manually from a signed-in admin
// browser session and the caller's identity + role gate is sufficient for a
// dev-environment cleanup tool.

import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

interface CleanupResult {
  uid: string
  deleted: boolean
  reason: string
}

interface CleanupResponse {
  totalAuthUsers: number
  totalFirestoreUsers: number
  orphanedDeleted: number
  results: CleanupResult[]
}

export const cleanupOrphanedUsers = onCall<
  Record<string, never>,
  Promise<CleanupResponse>
>(
  { region: 'asia-south1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.')
    }
    const claims = (request.auth.token ?? {}) as Record<string, unknown>
    const role = claims.role
    const hId = claims.hId
    if (role !== 'admin' || typeof hId !== 'string' || hId.length === 0) {
      throw new HttpsError(
        'permission-denied',
        'Admin in a household required to invoke cleanup.',
      )
    }

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

    // 2. Fetch every users/{uid} doc.
    const snap = await db.collection('users').get()
    const totalFirestoreUsers = snap.size

    // 3. Delete any doc whose UID is no longer in Auth.
    const results: CleanupResult[] = []
    for (const docSnap of snap.docs) {
      const uid = docSnap.id
      if (authUids.has(uid)) continue
      try {
        await db.collection('users').doc(uid).delete()
        // eslint-disable-next-line no-console
        console.log(`[cleanupOrphanedUsers] deleted users/${uid}`)
        results.push({ uid, deleted: true, reason: 'auth-user-not-found' })
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(
          `[cleanupOrphanedUsers] failed to delete users/${uid}:`,
          e,
        )
        results.push({
          uid,
          deleted: false,
          reason: `delete-failed: ${(e as Error).message}`,
        })
      }
    }

    const orphanedDeleted = results.filter((r) => r.deleted).length
    // eslint-disable-next-line no-console
    console.log(
      `[cleanupOrphanedUsers] Deleted ${orphanedDeleted} orphaned users out of ${totalFirestoreUsers} Firestore docs (Auth had ${authUids.size} users)`,
    )

    return {
      totalAuthUsers: authUids.size,
      totalFirestoreUsers,
      orphanedDeleted,
      results,
    }
  },
)
