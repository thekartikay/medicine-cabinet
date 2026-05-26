export const PATHS = {
  HOME: '/',
  LOGIN: '/login',
  ONBOARDING: '/onboarding',
  CABINET: '/cabinet',
  ADD_MEDICINE: '/cabinet/add',
  MEDICINE_DETAIL: '/cabinet/:id',
  SCHEDULES: '/schedules',
  ADD_SCHEDULE: '/schedules/add',
  FAMILY: '/family',
  SETTINGS: '/settings',
  MASTER_DB: '/master-db',
} as const

// Firestore path helpers — all path construction lives here, never inline strings elsewhere
export const userPath = (uid: string) => `users/${uid}`
export const householdPath = (hId: string) => `households/${hId}`
export const memberPath = (hId: string, uid: string) => `households/${hId}/members/${uid}`
export const cabinetPath = (hId: string, cId: string) => `households/${hId}/cabinets/${cId}`
export const itemPath = (hId: string, cId: string, iId: string) =>
  `households/${hId}/cabinets/${cId}/items/${iId}`
export const treatmentPath = (hId: string, tId: string) => `households/${hId}/treatments/${tId}`
export const regimenPath = (hId: string, tId: string, rId: string) =>
  `households/${hId}/treatments/${tId}/regimens/${rId}`
export const dosePath = (hId: string, tId: string, slotId: string) =>
  `households/${hId}/treatments/${tId}/logs/${slotId}`
export const dosesCollectionPath = (hId: string, tId: string) =>
  `households/${hId}/treatments/${tId}/logs`
export const todaySummaryPath = (hId: string, date: string) =>
  `households/${hId}/todaySummary/${date}`
export const cabinetsCollectionPath = (hId: string) => `households/${hId}/cabinets`
export const itemsCollectionPath = (hId: string, cId: string) =>
  `households/${hId}/cabinets/${cId}/items`
export const treatmentsCollectionPath = (hId: string) => `households/${hId}/treatments`
export const regimensCollectionPath = (hId: string, tId: string) =>
  `households/${hId}/treatments/${tId}/regimens`
export const membersCollectionPath = (hId: string) => `households/${hId}/members`
// AK-58 — caregiver grant sub-collection nested under each member.
export const caregiverGrantPath = (hId: string, mId: string, grantId: string) =>
  `households/${hId}/members/${mId}/caregiverGrants/${grantId}`
export const caregiverGrantsCollectionPath = (hId: string, mId: string) =>
  `households/${hId}/members/${mId}/caregiverGrants`
export const notificationsCollectionPath = (hId: string) =>
  `households/${hId}/notifications`
export const notificationPath = (hId: string, notifId: string) =>
  `households/${hId}/notifications/${notifId}`
export const restockRequestsCollectionPath = (hId: string) =>
  `households/${hId}/restockRequests`
export const restockRequestPath = (hId: string, requestId: string) =>
  `households/${hId}/restockRequests/${requestId}`
// AK-163 — Delivery address book scoped to a household.
export const addressesCollectionPath = (hId: string) =>
  `households/${hId}/addresses`
export const addressPath = (hId: string, addressId: string) =>
  `households/${hId}/addresses/${addressId}`
// AK-166 — Pending invite docs issued by admins. The invitee's auth.phoneNumber
// is matched against the doc's phoneE164 in joinHousehold before consumption.
export const pendingInvitesCol = (hId: string) =>
  `households/${hId}/pendingInvites`
export const pendingInviteDoc = (hId: string, inviteId: string) =>
  `households/${hId}/pendingInvites/${inviteId}`
export const consentLogPath = (uid: string) => `consentLog/${uid}`
// MC-017a — versioned consent subcollection. Append-only: each consent
// (initial + every policy-bump re-consent) writes a new doc; rules block
// update/delete so the audit trail is immutable.
export const consentVersionPath = (uid: string) => `consentLog/${uid}/versions`

// Bump this string whenever the privacy policy text in public/privacy-policy.md
// changes — App.tsx forces re-consent on next sign-in for any user whose stored
// policyVersion differs from this value.
export const CURRENT_POLICY_VERSION = '2026-05-06'

// Deterministic id of a household's default cabinet — mirrors the
// `${hId}-default` pattern that getOrCreateDefaultCabinet creates and is
// safe to use without a Firestore round-trip when only the id is needed
// (e.g. the cabinet-query proxy call).
export const getDefaultCabinetId = (hId: string): string => `${hId}-default`

export function buildSlotId(
  tId: string,
  rId: string,
  patientId: string,
  date: string,
  hhmm: string,
): string {
  return `${tId}-${rId}-${patientId}-${date}-${hhmm}`
}

export function todayISTString(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}
