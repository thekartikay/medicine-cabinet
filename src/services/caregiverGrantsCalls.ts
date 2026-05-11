// AK-58 — Shared httpsCallable<> definitions for the four caregiver-grant
// Cloud Functions. Imported directly by the consuming components; no wrapper
// functions or service-layer abstraction. Exists only to deduplicate the
// four type signatures across components and to give sub-task 3 a single
// import location for acceptCaregiverGrantFn.

import { httpsCallable } from 'firebase/functions'
import { functions } from '../lib/firebase'

// Wire shape of a Firestore Timestamp returned in a callable response. The
// firebase callable SDK serialises Timestamps to {_seconds, _nanoseconds}
// pairs and does not deserialise them back to Timestamp instances on the
// client.
export interface WireTimestamp {
  _seconds: number
  _nanoseconds: number
}

// listCaregiverGrants response shape — grantSecretHash is intentionally
// absent because the function strips it server-side.
export interface CaregiverGrantSafe {
  grantId: string
  contactEmailOrPhone: string
  createdBy: string
  visibleMemberId: string
  createdAt: WireTimestamp | null
  acceptedAt: WireTimestamp | null
  revokedAt: WireTimestamp | null
  lastUsedAt: WireTimestamp | null
}

export const createCaregiverGrantFn = httpsCallable<
  { memberId: string; contactEmailOrPhone: string },
  { grantId: string; magicLink: string }
>(functions, 'createCaregiverGrant')

export const acceptCaregiverGrantFn = httpsCallable<
  { hId: string; mId: string; grantId: string; grantSecret: string },
  { customToken: string; expiresAt: number; visibleMemberId: string }
>(functions, 'acceptCaregiverGrant')

export const revokeCaregiverGrantFn = httpsCallable<
  { memberId: string; grantId: string },
  { ok: true }
>(functions, 'revokeCaregiverGrant')

export const listCaregiverGrantsFn = httpsCallable<
  { memberId: string },
  { grants: CaregiverGrantSafe[] }
>(functions, 'listCaregiverGrants')
