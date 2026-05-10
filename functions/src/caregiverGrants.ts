// AK-58 — Caregiver grant Cloud Functions.
//
// Four asia-south1 callables backing the closed-beta caregiver dashboard:
//
//   • createCaregiverGrant   — admin issues a per-member, link-based grant.
//                               Returns a one-time magic link. The raw secret
//                               is in the URL and never stored server-side;
//                               only its bcrypt hash is persisted.
//   • acceptCaregiverGrant   — caregiver redeems the magic link. Verifies
//                               bcrypt + revocation + one-time-use, then
//                               mints a Firebase Custom Token with synthetic
//                               UID 'caregiver-{grantId}' and claims
//                               { hId, memberId, grantId, role }. Public —
//                               no Auth required, but App Check is enforced.
//   • revokeCaregiverGrant   — admin sets revokedAt; idempotent. Revocation
//                               is enforced via Firestore Rules get() on
//                               every read (see firestore.rules), not via
//                               token-level revocation.
//   • listCaregiverGrants    — admin reads grant metadata for one member.
//                               grantSecretHash is stripped before return.
//
// The magic link is structured as:
//   https://medicab.app/caregiver/accept?gid={grantId}&hId={hId}&mId={memberId}&s={grantSecret}
// Including memberId in the URL lets acceptCaregiverGrant do a direct doc
// lookup instead of a collection-group query, avoiding a permanent index
// management dependency.

import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import { getFirestore, FieldValue } from 'firebase-admin/firestore'
import { getAuth } from 'firebase-admin/auth'
import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const E164_RE = /^\+[1-9]\d{1,14}$/
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000

// Shared admin gate. Reads role + hId from the auth token (custom claims),
// not from a Firestore membership doc — matches the claim-based authz model
// in CLAUDE.md.
function assertAdmin(request: CallableRequest<unknown>): { uid: string; hId: string } {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.')
  }
  const token = request.auth.token as { role?: string; hId?: string }
  if (token.role !== 'admin') {
    throw new HttpsError('permission-denied', 'Admins only.')
  }
  if (!token.hId) {
    throw new HttpsError('failed-precondition', 'No household claim on the auth token.')
  }
  return { uid: request.auth.uid, hId: token.hId }
}

export const createCaregiverGrant = onCall(
  { enforceAppCheck: true, region: 'asia-south1' },
  async (request) => {
    const { uid, hId } = assertAdmin(request)

    const raw = (request.data ?? {}) as {
      memberId?: unknown
      contactEmailOrPhone?: unknown
    }
    const memberId =
      typeof raw.memberId === 'string' ? raw.memberId.trim() : ''
    const contactEmailOrPhone =
      typeof raw.contactEmailOrPhone === 'string'
        ? raw.contactEmailOrPhone.trim()
        : ''
    if (!memberId) {
      throw new HttpsError('invalid-argument', 'memberId is required.')
    }
    if (!EMAIL_RE.test(contactEmailOrPhone) && !E164_RE.test(contactEmailOrPhone)) {
      throw new HttpsError(
        'invalid-argument',
        'contactEmailOrPhone must be a valid email or E.164 phone number.',
      )
    }

    const db = getFirestore()
    const memberSnap = await db
      .doc(`households/${hId}/members/${memberId}`)
      .get()
    if (!memberSnap.exists) {
      throw new HttpsError('not-found', 'Member not found in this household.')
    }

    // 256 bits of entropy in the URL secret; 128 bits for the doc id.
    const grantSecret = randomBytes(32).toString('base64url')
    const grantId = randomBytes(16).toString('hex')
    const grantSecretHash = bcrypt.hashSync(grantSecret, 10)

    await db
      .doc(`households/${hId}/members/${memberId}/caregiverGrants/${grantId}`)
      .set({
        grantId,
        contactEmailOrPhone,
        grantSecretHash,
        createdBy: uid,
        createdAt: FieldValue.serverTimestamp(),
        acceptedAt: null,
        revokedAt: null,
        lastUsedAt: null,
        visibleMemberId: memberId,
      })

    // Raw grantSecret leaves the server exactly once — in this response.
    // The admin shares it with the caregiver out-of-band. It is never logged
    // or persisted.
    const magicLink =
      `https://medicab.app/caregiver/accept` +
      `?gid=${encodeURIComponent(grantId)}` +
      `&hId=${encodeURIComponent(hId)}` +
      `&mId=${encodeURIComponent(memberId)}` +
      `&s=${encodeURIComponent(grantSecret)}`

    return { grantId, magicLink }
  },
)

export const acceptCaregiverGrant = onCall(
  // App Check still enforced even though Auth is not — anyone with the link
  // can call this, but the caller must be an attested MediCab build.
  { enforceAppCheck: true, region: 'asia-south1' },
  async (request) => {
    const raw = (request.data ?? {}) as {
      hId?: unknown
      mId?: unknown
      grantId?: unknown
      grantSecret?: unknown
    }
    const hId = typeof raw.hId === 'string' ? raw.hId.trim() : ''
    const mId = typeof raw.mId === 'string' ? raw.mId.trim() : ''
    const grantId = typeof raw.grantId === 'string' ? raw.grantId.trim() : ''
    const grantSecret =
      typeof raw.grantSecret === 'string' ? raw.grantSecret : ''
    if (!hId || !mId || !grantId || !grantSecret) {
      throw new HttpsError(
        'invalid-argument',
        'hId, mId, grantId, and grantSecret are all required.',
      )
    }

    const db = getFirestore()
    const grantRef = db.doc(
      `households/${hId}/members/${mId}/caregiverGrants/${grantId}`,
    )
    const grantSnap = await grantRef.get()
    // Generic error — same wording for missing-doc and wrong-secret so we
    // don't leak which grant ids exist in which households.
    if (!grantSnap.exists) {
      throw new HttpsError('not-found', 'Invalid or expired link.')
    }
    const grant = grantSnap.data() as {
      grantSecretHash: string
      acceptedAt: FirebaseFirestore.Timestamp | null
      revokedAt: FirebaseFirestore.Timestamp | null
      visibleMemberId: string
    }
    if (grant.revokedAt !== null) {
      throw new HttpsError(
        'failed-precondition',
        'Link has been revoked. Ask the household admin for a new one.',
      )
    }
    if (grant.acceptedAt !== null) {
      throw new HttpsError(
        'failed-precondition',
        'Link has already been used. Ask the household admin for a new one.',
      )
    }
    if (!bcrypt.compareSync(grantSecret, grant.grantSecretHash)) {
      throw new HttpsError('not-found', 'Invalid or expired link.')
    }

    // Atomically stamp acceptedAt + lastUsedAt. The transaction re-reads the
    // doc inside so two concurrent redemptions can't both succeed.
    await db.runTransaction(async (tx) => {
      const fresh = await tx.get(grantRef)
      const data = fresh.data() as {
        acceptedAt: FirebaseFirestore.Timestamp | null
        revokedAt: FirebaseFirestore.Timestamp | null
      }
      if (data.revokedAt !== null) {
        throw new HttpsError(
          'failed-precondition',
          'Link has been revoked. Ask the household admin for a new one.',
        )
      }
      if (data.acceptedAt !== null) {
        throw new HttpsError(
          'failed-precondition',
          'Link has already been used. Ask the household admin for a new one.',
        )
      }
      tx.update(grantRef, {
        acceptedAt: FieldValue.serverTimestamp(),
        lastUsedAt: FieldValue.serverTimestamp(),
      })
    })

    const auth = getAuth()
    const syntheticUid = `caregiver-${grantId}`
    const claims = {
      hId,
      memberId: grant.visibleMemberId,
      grantId,
      role: 'caregiver',
    }
    const customToken = await auth.createCustomToken(syntheticUid, claims)

    // Firebase Custom Tokens carry a 1-hour exchange window and the resulting
    // ID token has a 1-hour lifetime. The 7-day "session" is conceptual: the
    // client refreshes the ID token transparently, and revocation is enforced
    // by the rules-level get() on the grant doc — so a revoked grant stops
    // working on the next read regardless of token lifetime.
    return {
      customToken,
      expiresAt: Date.now() + SESSION_DURATION_MS,
      visibleMemberId: grant.visibleMemberId,
    }
  },
)

export const revokeCaregiverGrant = onCall(
  { enforceAppCheck: true, region: 'asia-south1' },
  async (request) => {
    const { hId } = assertAdmin(request)
    const raw = (request.data ?? {}) as {
      memberId?: unknown
      grantId?: unknown
    }
    const memberId =
      typeof raw.memberId === 'string' ? raw.memberId.trim() : ''
    const grantId = typeof raw.grantId === 'string' ? raw.grantId.trim() : ''
    if (!memberId || !grantId) {
      throw new HttpsError('invalid-argument', 'memberId and grantId are required.')
    }

    const db = getFirestore()
    const grantRef = db.doc(
      `households/${hId}/members/${memberId}/caregiverGrants/${grantId}`,
    )
    const grantSnap = await grantRef.get()
    if (!grantSnap.exists) {
      throw new HttpsError('not-found', 'Grant not found.')
    }
    const grant = grantSnap.data() as {
      revokedAt: FirebaseFirestore.Timestamp | null
    }
    if (grant.revokedAt !== null) {
      // Idempotent. Don't re-stamp the timestamp on a duplicate revoke.
      return { ok: true as const }
    }
    await grantRef.update({ revokedAt: FieldValue.serverTimestamp() })
    return { ok: true as const }
  },
)

export const listCaregiverGrants = onCall(
  { enforceAppCheck: true, region: 'asia-south1' },
  async (request) => {
    const { hId } = assertAdmin(request)
    const raw = (request.data ?? {}) as { memberId?: unknown }
    const memberId =
      typeof raw.memberId === 'string' ? raw.memberId.trim() : ''
    if (!memberId) {
      throw new HttpsError('invalid-argument', 'memberId is required.')
    }

    const db = getFirestore()
    const snap = await db
      .collection(`households/${hId}/members/${memberId}/caregiverGrants`)
      .get()
    // grantSecretHash MUST NOT leave the server. Strip it from each doc.
    const grants = snap.docs.map((d) => {
      const data = { ...d.data() } as Record<string, unknown>
      delete data.grantSecretHash
      return data
    })
    return { grants }
  },
)
