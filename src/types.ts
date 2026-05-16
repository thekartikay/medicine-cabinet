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

// AK-58 — A grant of read-only access to a single household member's data,
// issued by an admin and consumed by an external caregiver via a magic link.
// Lives at: households/{hId}/members/{mId}/caregiverGrants/{grantId}
//
// The raw grant secret is NEVER stored — only its bcrypt hash. If the link
// is lost, the admin must issue a new grant.
export interface CaregiverGrant {
  // Document ID; also embedded in the magic link
  grantId: string
  // Email address or E.164 phone number the admin shared with
  contactEmailOrPhone: string
  // bcrypt hash of the grant secret. Verified server-side only.
  grantSecretHash: string
  // UID of the admin who issued the grant
  createdBy: string
  // When the grant was created
  createdAt: Timestamp
  // When the caregiver first redeemed the link. Null until accepted.
  acceptedAt: Timestamp | null
  // When the admin revoked the grant. Null = active.
  revokedAt: Timestamp | null
  // Updated on every successful caregiver Firestore read (audit)
  lastUsedAt: Timestamp | null
  // Member ID this grant gives visibility into. Denormalised from the parent
  // path to keep it available on the JWT custom claim without a path parse.
  visibleMemberId: string
}

export interface Cabinet {
  cId: string
  hId: string
  name: string
  createdAt: Timestamp
}

export type CabinetItemUnit =
  | 'tablet' | 'ml' | 'capsule' | 'spray' | 'dose'
  // Catalog-enrichment expansion — count units that match the new
  // dosage-form variants (inhaler puffs, drop bottles, transdermal patches,
  // topical applications). 'other' is the sentinel for "user typed a custom
  // unit"; the saved CabinetItem.unit field carries the typed string verbatim.
  | 'puff' | 'drop' | 'application' | 'patch' | 'other'

export type DosageForm =
  | 'tablet' | 'capsule' | 'syrup' | 'injection' | 'cream'
  | 'drops'  | 'spray'   | 'powder' | 'inhaler'  | 'patch'
  // Catalog-enrichment additions — semicolon between cream/ointment distinct
  // (ointments are oil-based, creams are water-based), and dispersible
  // tablets are common in paediatric cabinets.
  | 'ointment' | 'dispersible'

// AK-39 / catalog-enrichment — units the strength input can carry. The form
// stores the numeric value separately from the unit so we can keep autocomplete
// and validation predictable. Both `mg` and `mcg` are common for the same
// medicine family (e.g. paracetamol mg, salbutamol mcg).
export type StrengthUnit = 'mg' | 'mcg' | 'g' | 'ml' | 'IU' | '%'
export const STRENGTH_UNITS: StrengthUnit[] = ['mg', 'mcg', 'g', 'ml', 'IU', '%']

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
  // AK-151 — Stamped at add time when the user picked from the masterDb
  // autocomplete (the AK-128 masterLocked path). Absent/null means the
  // item was free-text typed; only those items are editable from the
  // detail-sheet Edit flow. Older items predating AK-151 read as
  // undefined and default to editable, which is acceptable: the values
  // were always free-form anyway and there's no catalog data to
  // accidentally overwrite.
  masterDbId?: string | null
  createdAt: Timestamp
  updatedAt: Timestamp
  // AK-39 — Passive interaction tag. Stamped by a background check after the
  // item is added: geminiProxy ran a drug_interaction query against the rest
  // of the cabinet, and the model surfaced a known interaction. Null/absent
  // means either "no interaction found" or "no check ran yet". Informational
  // only — never blocks the user.
  interactionWarning?: {
    withMedicineNames: string[]
    riskLevel: 'moderate' | 'high'
    description: string
    checkedAt: Timestamp
  } | null
  // AK-150 — Soft-delete marker. Set by disposeCabinetItem (user-initiated
  // batch or medicine deletion from the cabinet detail sheet). The service
  // layer filters disposed items out of subscribeCabinetItems and
  // getCabinetItems, so disposed items never reach the UI. Absent/null
  // means the item is live. Dose logs referencing a disposed item's iId
  // remain valid historical records — the iId itself is unchanged.
  disposedAt?: Timestamp | null
}

export interface MasterMedicine {
  medicineId: string
  name: string
  activeIngredient: string | null
  // AK-39 / catalog-enrichment — populated by scripts/enrichMasterDb.ts.
  // Older / un-enriched docs read as undefined; the cabinet add-medicine
  // form pre-fills these when present and leaves the field blank otherwise.
  brandName?: string | null
  strength?: string | null
  dosageForm?: string | null
  activeIngredients?: string | null
  // AK-125 — lowercased copy of `name` for case-insensitive prefix search.
  // searchMasterDb queries this field; consumers ignore it. Optional because
  // un-enriched docs predate the field; once the enrichment script runs
  // against a corpus, every doc carries it.
  nameLower?: string
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
  // PRN-only safety cap. Number of times this regimen can be taken in one
  // IST day; undefined = no client-side limit (older regimens read as such).
  // Only meaningful when scheduleType === 'as-needed'; ignored otherwise.
  maxDosesPerDay?: number
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
  // AK-121 — True when the log was written during the past-date catch-up
  // flow at treatment-create time, not at the actual scheduledAt instant.
  // Surfaces in dose history as "Logged retroactively"; never debits
  // inventory (inventoryDebited stays false) because the retro flow can't
  // know whether stock was already consumed at the historical time.
  retroactive?: boolean
  // Inventory-clamp telemetry (bug #3 fix). When `inventoryDebited` is true
  // but the cabinet item didn't have enough stock to cover the full
  // doseAmount, `inventoryClamped` is true and `actualDebit` records the
  // physical decrement that actually landed (<= doseAmount). Audit
  // reconciliation can use this to surface "logged 5, but only 2 in stock"
  // without flagging the log as a discrepancy. Both fields are optional —
  // older logs read as undefined and behave as if not clamped.
  inventoryClamped?: boolean
  actualDebit?: number
}
