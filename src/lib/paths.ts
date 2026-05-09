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
export const notificationsCollectionPath = (hId: string) =>
  `households/${hId}/notifications`
export const notificationPath = (hId: string, notifId: string) =>
  `households/${hId}/notifications/${notifId}`
export const restockRequestsCollectionPath = (hId: string) =>
  `households/${hId}/restockRequests`
export const restockRequestPath = (hId: string, requestId: string) =>
  `households/${hId}/restockRequests/${requestId}`
export const consentLogPath = (uid: string) => `consentLog/${uid}`

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
