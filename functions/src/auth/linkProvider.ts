// AK-104 — Email-first identity. When a user signs in via a new provider on
// a new device, this callable looks up the canonical Firebase Auth user by
// email and merges the duplicate UID into the canonical one so that the user
// retains a single hId/role custom-claim profile across devices.
//
// Direction logic:
//   - existing has hId, caller doesn't  → canonical = existing (caller absorbed)
//   - caller has hId, existing doesn't  → canonical = caller   (orphan absorbed)
//   - both have hId                     → throw failed-precondition (cannot merge)
//   - neither has hId                   → canonical = existing (existing has the
//                                         email on Auth; caller cannot prove
//                                         ownership without provider data. Falls
//                                         through to the security gate below.)
//
// Security gate: the caller must prove email ownership (one of their providers
// surfaces the email). Phone provider always carries email: null, so a phone-
// first user can never silently absorb a different-provider account that
// happens to own the same email — those callers get conflict_requires_owner_proof.
// The gate is skipped when caller IS canonical (i.e. when the caller has hId
// and is absorbing an orphan email user).

import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { getAuth, type UserRecord } from 'firebase-admin/auth'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'

interface LinkProviderRequest {
  email: string
  newProviderUid: string
  newProvider: 'phone' | 'google.com'
}

interface LinkProviderResponse {
  canonicalUid: string
  customToken: string
  claimsUpdated: boolean
  action: 'linked' | 'no_op' | 'conflict_requires_owner_proof'
}

export const linkProviderToExistingAccount = onCall<
  LinkProviderRequest,
  Promise<LinkProviderResponse>
>(
  { enforceAppCheck: true, region: 'asia-south1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.')
    }
    const callerUid = request.auth.uid

    const data = (request.data ?? {}) as Partial<LinkProviderRequest>
    const email =
      typeof data.email === 'string' ? data.email.trim().toLowerCase() : ''
    const newProviderUid =
      typeof data.newProviderUid === 'string' ? data.newProviderUid : ''
    const newProvider = data.newProvider
    if (
      !email ||
      !newProviderUid ||
      (newProvider !== 'phone' && newProvider !== 'google.com')
    ) {
      throw new HttpsError(
        'invalid-argument',
        'email, newProviderUid, and newProvider (phone | google.com) are all required.',
      )
    }
    if (newProviderUid !== callerUid) {
      throw new HttpsError(
        'permission-denied',
        'newProviderUid must match the authenticated caller.',
      )
    }

    const adminAuth = getAuth()
    const db = getFirestore()

    // 1. Look up existing user by email.
    let existingUser: UserRecord
    try {
      existingUser = await adminAuth.getUserByEmail(email)
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === 'auth/user-not-found') {
        // Record the email on caller's MediCab profile (D1) so the
        // EmailLinkPrompt gate doesn't re-prompt on the next sign-in.
        await db.doc(`users/${callerUid}`).set({ email }, { merge: true })
        return {
          canonicalUid: callerUid,
          customToken: '',
          claimsUpdated: false,
          action: 'no_op',
        }
      }
      throw new HttpsError(
        'internal',
        `auth lookup failed: ${(e as Error).message ?? code ?? 'unknown'}`,
      )
    }

    // 2. Same user? No-op.
    if (existingUser.uid === callerUid) {
      await db.doc(`users/${callerUid}`).set({ email }, { merge: true })
      return {
        canonicalUid: callerUid,
        customToken: '',
        claimsUpdated: false,
        action: 'no_op',
      }
    }

    // 3. Direction.
    const callerClaims = (request.auth.token ?? {}) as Record<string, unknown>
    const callerHasHId =
      typeof callerClaims.hId === 'string' && callerClaims.hId.length > 0
    const existingClaims = (existingUser.customClaims ?? {}) as Record<
      string,
      unknown
    >
    const existingHasHId =
      typeof existingClaims.hId === 'string' && existingClaims.hId.length > 0

    if (callerHasHId && existingHasHId) {
      throw new HttpsError(
        'failed-precondition',
        'Both accounts already belong to households. They cannot be merged.',
      )
    }

    // Directionality:
    //   existing has hId, caller doesn't  → canonical = existing (caller absorbed)
    //   caller has hId, existing doesn't  → canonical = caller   (orphan absorbed)
    //   both have hId                     → thrown above
    //   neither has hId                   → canonical = existing (tiebreaker)
    //
    // The neither-has-hId tiebreaker prefers existing because existing is the
    // user who already has the email on their Auth record — they have proof.
    // The caller typed the email but cannot prove ownership unless they own
    // it on their providerData (security gate below). The old tiebreaker
    // (canonical = caller) silently deleted the existing user whenever a
    // phone-OTP caller typed the email of an unestablished Google account,
    // destroying that account instead of merging into it.
    let canonicalUid: string
    if (existingHasHId)    canonicalUid = existingUser.uid
    else if (callerHasHId) canonicalUid = callerUid
    else                   canonicalUid = existingUser.uid
    const duplicateUid =
      canonicalUid === existingUser.uid ? callerUid : existingUser.uid

    // 4. Security gate. Skip when caller IS canonical (caller is absorbing an
    //    orphan; no need to prove ownership of the orphan's email).
    if (canonicalUid !== callerUid) {
      const callerProviderData = (await adminAuth.getUser(callerUid))
        .providerData
      const callerOwnsEmail = callerProviderData.some(
        (p) => p.email && p.email.toLowerCase() === email,
      )
      if (!callerOwnsEmail) {
        return {
          canonicalUid: existingUser.uid,
          customToken: '',
          claimsUpdated: false,
          action: 'conflict_requires_owner_proof',
        }
      }
    }

    // 5. Move the duplicate's distinguishing provider data onto the canonical
    //    user. For phone, that means stamping phoneNumber. For Google, the
    //    canonical user already has the email and there is nothing the Admin
    //    SDK can move (Google identity is bound to the Firebase UID via OAuth).
    if (newProvider === 'phone' && duplicateUid === callerUid) {
      const phoneNumber =
        (request.auth.token.phone_number as string | undefined) ?? null
      if (phoneNumber) {
        try {
          await adminAuth.updateUser(canonicalUid, { phoneNumber })
        } catch (e) {
          throw new HttpsError(
            'failed-precondition',
            `Could not attach phone to canonical account: ${(e as Error).message}`,
          )
        }
      }
    }

    // 5b. Record the typed email on canonical's MediCab profile (D1) so the
    //     EmailLinkPrompt gate doesn't re-prompt the user after they sign in
    //     as canonical via the custom token returned below. Lands before the
    //     token is minted, so there is no race with the client's subsequent
    //     onAuthStateChanged → createUserIfNew read.
    await db.doc(`users/${canonicalUid}`).set({ email }, { merge: true })

    // 6. Mint Custom Token for the canonical UID. The client uses this with
    //    signInWithCustomToken to swap their session.
    const customToken = await adminAuth.createCustomToken(canonicalUid)

    // 7. Delete the duplicate Auth user + its (possibly orphaned) Firestore
    //    profile. createUserIfNew runs on every onAuthStateChanged so the
    //    duplicate's users/{uid} doc almost certainly exists by now.
    try {
      await adminAuth.deleteUser(duplicateUid)
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code !== 'auth/user-not-found') {
        throw new HttpsError(
          'internal',
          `Failed to delete duplicate UID: ${(e as Error).message}`,
        )
      }
    }
    await db
      .doc(`users/${duplicateUid}`)
      .delete()
      .catch((e: unknown) => {
        // Race with createUserIfNew or doc never existed — fine to swallow.
        // eslint-disable-next-line no-console
        console.warn(
          `[linkProvider] users/${duplicateUid} delete failed:`,
          (e as Error).message,
        )
      })

    // 8. Audit log. Immutable; appended only.
    await db.collection('audit_account_linking').add({
      timestamp: FieldValue.serverTimestamp(),
      email,
      canonicalUid,
      deletedUid: duplicateUid,
      newProvider,
      action: 'linked',
    })

    return {
      canonicalUid,
      customToken,
      claimsUpdated: true,
      action: 'linked',
    }
  },
)
