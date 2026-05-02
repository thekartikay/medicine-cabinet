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
export const todaySummaryPath = (hId: string, date: string) =>
  `households/${hId}/todaySummary/${date}`

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
