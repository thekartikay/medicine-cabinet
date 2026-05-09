import type { Timestamp } from 'firebase/firestore'

export interface AppUser {
  uid: string
  displayName: string | null
  email: string | null
  phoneNumber: string | null
  photoURL: string | null
  createdAt: Timestamp
  householdId?: string
  // Self-service preferences. All optional — older user docs created before
  // these fields existed will simply read as undefined.
  languagePref?: string                     // 'en' | 'hi' | 'kn' | 'ta' | 'te'
  pushNotificationsEnabled?: boolean        // default true if absent
  whatsappRemindersEnabled?: boolean        // default true if absent
  reminderMethod?: 'whatsapp' | 'push' | 'both'  // admin-only; default 'both'
  fcmToken?: string                         // FCM push registration
  fcmTokens?: string[]                      // multi-device FCM (cleared on soft-delete)
  whatsappOptOut?: boolean                  // legacy toggle
  whatsappSnoozeUntil?: Timestamp | null    // legacy snooze
  // MC-017a — soft-delete window. When deletedAt is set, the user is in the
  // 30-day recovery window. purgeDeletedAccounts hard-deletes once
  // deletionScheduledFor < now.
  deletedAt?: Timestamp | null
  deletionScheduledFor?: Timestamp | null
  // Captured at soft-delete time so purgeDeletedAccounts can reach into the
  // households the user belonged to without re-deriving membership after the
  // member docs are removed.
  deletionHouseholds?: string[]
}

// MC-017a — DPDP consent record. One per user, written by the client on
// first sign-in (or after a policy bump) and immutable thereafter.
export interface ConsentRecord {
  uid: string
  consentedAt: Timestamp
  policyVersion: string
  appVersion: string
  platform: string                          // 'web' | 'ios' | 'android'
}

export interface Household {
  hId: string
  name: string
  primaryAdminId: string
  adminIds: string[]
  memberUids: string[]
  createdAt: Timestamp
  lastAuditAt: Timestamp | null
}

export interface HouseholdMember {
  uid: string
  hId: string
  role: 'admin' | 'member' | 'caregiver'
  displayName: string | null
  joinedAt: Timestamp
}

export interface Cabinet {
  cId: string
  hId: string
  name: string
  createdAt: Timestamp
}

export type CabinetItemUnit = 'tablet' | 'ml' | 'capsule' | 'spray' | 'dose'

export type DosageForm =
  | 'tablet' | 'capsule' | 'syrup' | 'injection' | 'cream'
  | 'drops'  | 'spray'   | 'powder' | 'inhaler'  | 'patch'

export interface CabinetItem {
  iId: string
  cId: string
  hId: string
  medicineId: string
  displayNameOverride: string | null
  quantityOnHand: number
  unit: CabinetItemUnit
  expiryDate: string | null   // YYYY-MM-DD
  prescribed: boolean
  // Enrichment fields (all optional — older items have them undefined).
  brandName?: string | null
  dosageForm?: DosageForm | null
  strength?: string | null
  activeIngredients?: string | null
  marketer?: string | null
  storageInstructions?: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
}

export interface MasterMedicine {
  medicineId: string
  name: string
  activeIngredient: string | null
}

// ── Treatments ────────────────────────────────────────────────

export type TreatmentCategory = 'acute' | 'chronic' | 'preventive' | 'prn'
export type TreatmentStatus   = 'active' | 'paused' | 'completed'
export type ScheduleType      = 'daily' | 'specific-days' | 'as-needed'
export type FoodTiming        = 'before' | 'after' | 'with'

export interface TimeSlot {
  time: string        // "HH:MM"
  foodTiming: FoodTiming
}

export interface PauseEntry {
  pausedAt: Timestamp
  resumedAt: Timestamp | null
  pausedBy: string
}

export interface Treatment {
  tId: string
  hId: string
  name: string
  memberId: string
  memberName: string | null
  category: TreatmentCategory
  status: TreatmentStatus
  scheduleSummary: string     // denormalized by addRegimen for list view
  createdAt: Timestamp
  updatedAt: Timestamp
  // Set when the admin uses "End treatment" on a chronic/preventive course.
  // Optional — older treatment docs and active treatments simply read as undefined.
  endDate?: Timestamp | null
  // Append-only pause/resume audit. Most recent entry's resumedAt is null
  // while the treatment is paused; resumeTreatment() fills it on resume.
  pauseHistory?: PauseEntry[]
}

export interface Regimen {
  rId: string
  tId: string
  hId: string
  cabinetItemId: string
  medicineId: string
  displayName: string
  doseAmount: number
  doseUnit: string
  scheduleType: ScheduleType
  scheduleDays: number[] | null   // 0 = Sun … 6 = Sat; set only for 'specific-days'
  slots: TimeSlot[]
  startDate: string               // YYYY-MM-DD
  endDate: string | null
  ongoing: boolean
  createdAt: Timestamp
}

export interface DoseSlotDisplay {
  treatmentId: string
  treatmentName: string
  memberName: string | null
  medicineName: string
  doseAmount: number
  doseUnit: string
  time: string
  foodTiming: FoodTiming
  regimenId: string
  slotId: string           // pre-computed via buildSlotId(); used as the log doc id
  patientId: string        // = treatment.memberId
  cabinetItemId: string    // = regimen.cabinetItemId
}

// ── Today summary (Cloud-Function-maintained dashboard cache) ─

export interface TodaySummarySlot {
  treatmentId: string
  treatmentName: string
  regimenId: string
  medicineName: string
  scheduledTime: string         // "HH:MM"
  doseAmount: number
  doseUnit: string
  foodTiming: FoodTiming
  // Extended beyond the spec so DoseSlotDisplay can be reconstructed without
  // a second read: cabinetItemId is required to debit inventory on "Mark as
  // taken", lateNote/createdBy back the existing log-state UI.
  cabinetItemId: string
  status: DoseStatus | 'pending'
  loggedAt: Timestamp | null
  skipReason: string | null
  lateNote: string | null
  adminOverride: boolean
  createdBy: string | null
}

export interface TodaySummaryStockAlert {
  cabinetItemId: string
  medicineName: string
  quantityOnHand: number
  daysSupply: number | null      // null when the item isn't time-driven
  expiryDate: string | null       // YYYY-MM-DD; matches CabinetItem.expiryDate
  daysUntilExpiry: number | null
}

export interface TodaySummaryMember {
  displayName: string
  totalSlots: number
  takenCount: number
  missedCount: number
  skippedCount: number
  lateCount: number
  pendingCount: number
  adherenceTodayPct: number
  slots: Record<string, TodaySummarySlot>
  stockAlerts: TodaySummaryStockAlert[]
  auditNudgeText: string | null
}

export interface TodaySummary {
  date: string                   // YYYY-MM-DD IST
  generatedAt: Timestamp
  hId: string
  members: Record<string, TodaySummaryMember>
}

// ── Restock requests ────────────────────────────────────────

export type RestockRequestStatus = 'pending' | 'fulfilled' | 'dismissed'

export interface RestockRequest {
  requestId: string           // matches the doc id
  cabinetItemId: string
  medicineName: string
  requestedBy: string
  requestedAt: Timestamp
  status: RestockRequestStatus
  quantityAtRequest: number
  resolvedAt?: Timestamp | null  // set when admin marks fulfilled / dismissed
}

// ── Notifications ───────────────────────────────────────────

export type NotificationType =
  | 'missed_dose'
  | 'low_stock'
  | 'expiring_soon'
  | 'restock_request'
  | 'admin_override'
  | 'caregiver_reminder'

export interface Notification {
  notifId: string
  type: NotificationType
  message: string
  createdAt: Timestamp
  readBy: string[]
  relatedMemberId: string | null
  relatedMedicineId: string | null
}

// ── Dose logs ────────────────────────────────────────────────

export type DoseStatus = 'taken' | 'skipped' | 'late' | 'missed'

export interface DoseLog {
  slotId: string
  tId: string
  rId: string
  hId: string
  patientId: string
  scheduledAt: Timestamp
  scheduledDate: string    // YYYY-MM-DD
  scheduledTime: string    // HH:MM
  status: DoseStatus
  takenAt: Timestamp | null
  skipReason: string | null
  lateNote: string | null     // intended late time for status='late' (HH:MM in 24h, IST)
  doseAmount: number
  doseUnit: string
  cabinetItemId: string
  inventoryDebited: boolean
  createdBy: string
  createdAt: Timestamp
  // True when an admin used "Mark as taken" to override a missed log.
  // Surfaces "Updated by admin" in the dose card. Optional — older logs
  // and member-written logs simply read as undefined.
  adminOverride?: boolean
}
