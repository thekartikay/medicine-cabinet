import { useEffect, useRef, useState } from 'react'
import {
  ChevronLeft, Plus, X, Clock, AlertTriangle,
  Pause, Play, StopCircle, Trash2, ChevronDown, CalendarHeart,
} from 'lucide-react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../lib/firebase'
import { todayISTString } from '../lib/paths'
import { auth } from '../lib/firebase'
import {
  createTreatment,
  addRegimen,
  subscribeTreatments,
  subscribeCabinetItems,
  getOrCreateDefaultCabinet,
  getHouseholdMembers,
  loadLogsForDateRange,
  loadAllActiveRegimens,
  pauseTreatment,
  resumeTreatment,
  endTreatment,
  getActiveTreatmentMedicines,
  getActiveTreatmentsWithRegimensForMember,
  recordConflictAcknowledgement,
  recordInteractionAcknowledgement,
  logRetroactiveDoses,
  addCabinetItem,
  searchMasterDb,
  updateCabinetItemInteractionWarning,
  deleteCabinetItem,
  updateTreatment,
  updateRegimen,
} from '../services/firestoreService'
import { buildSlotId } from '../lib/paths'
import { checkCabinetInteractions } from '../services/geminiService'
import { InteractionWarningModal } from '../components/InteractionWarningModal'
import { TreatmentInteractionWarningModal } from '../components/TreatmentInteractionWarningModal'
import { TreatmentConflictModal, type ConflictType } from '../components/TreatmentConflictModal'
import { PastDateModal } from '../components/PastDateModal'
import { RetroLogSheet, type RetroSlot } from '../components/RetroLogSheet'
import type {
  CabinetItem,
  CabinetItemUnit,
  DosageForm,
  FoodTiming,
  HouseholdMember,
  MasterMedicine,
  Regimen,
  ScheduleType,
  TimeSlot,
  Treatment,
  TreatmentCategory,
  TreatmentStatus,
} from '../types'

type TxView = 'list' | 'step1' | 'step2' | 'step3' | 'step4' | 'edit'

interface Props {
  hId: string
  // Used to stamp pauseHistory.pausedBy when the admin pauses a treatment.
  currentUid: string
  // When provided, the screen renders as read-only and the list is scoped to
  // treatments where memberId === filterByPatientUid.
  readOnly?: boolean
  filterByPatientUid?: string
}

const CATEGORY_LABELS: Record<TreatmentCategory, string> = {
  acute: 'Acute',
  chronic: 'Chronic',
  preventive: 'Preventive',
  prn: 'PRN',
}

const CATEGORY_SUB: Record<TreatmentCategory, string> = {
  acute: 'Short course',
  chronic: 'Ongoing',
  preventive: 'Prevention',
  prn: 'As needed',
}

const SCHEDULE_LABELS: Record<ScheduleType, string> = {
  daily: 'Daily',
  'specific-days': 'Specific days',
  'as-needed': 'As needed',
  // AK-131 — Once-a-day, no fixed time. Reminder fires at the 09:00 IST
  // anchor; the user can log the dose any time before end-of-day.
  'flexible-daily': 'Once a day, any time',
}

const FOOD_LABELS: Record<FoodTiming, string> = {
  before: 'Before food',
  after: 'After food',
  with: 'With food',
}

const STATUS_BADGE: Record<TreatmentStatus, { label: string; cls: string }> = {
  active:    { label: 'Active',    cls: 'cb-badge--in-stock'  },
  paused:    { label: 'Paused',    cls: 'cb-badge--low-stock' },
  completed: { label: 'Completed', cls: 'cb-badge--completed' },
}

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const DAY_NAMES  = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function fmtDate(yyyymmdd: string): string {
  return new Date(yyyymmdd + 'T00:00:00').toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

// Returns the IST date one day after the provided YYYY-MM-DD string. Used by
// the step 2 → step 3 transition to push a fresh treatment's start date out
// when the selected medicine's stock is insufficient (Change 1).
function tomorrowISTString(today: string): string {
  // Pivot at noon IST so date arithmetic is unambiguous regardless of UTC
  // offset. setUTCDate handles month/year rollover.
  const d = new Date(`${today}T12:00:00+05:30`)
  d.setUTCDate(d.getUTCDate() + 1)
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

// AK-122 — Smart defaults for time-driven dose slots. Ordered by typical
// real-world cadence (morning → midday → evening → early morning). The form
// caps the slot count at 4 and walks this list when adding new slots so the
// default value never collides with an existing one.
const SLOT_DEFAULTS = ['08:00', '13:00', '20:00', '06:00']
const MAX_SLOTS_PER_DAY = 4

function nextSlotDefault(existingSlots: TimeSlot[]): string | null {
  const usedTimes = new Set(existingSlots.map(s => s.time))
  return SLOT_DEFAULTS.find(t => !usedTimes.has(t)) ?? null
}

// AK-121 — Enumerate every (date × slot) pair from startDate to yesterday
// inclusive, newest-first. Caps at 30 most-recent days (the RetroLogSheet
// surfaces the cap via wasCapped → amber note). Slot IDs are computed via
// the canonical buildSlotId helper so the resulting Firestore writes line
// up with the rest of the dose-log naming convention.
// AK-129 — Title-case singular label for the read-only unit pill in the
// treatment-creation form. `ml` is preserved lowercase by convention; any
// other string (including user-typed custom units saved as 'other') is
// title-cased on its first character so a saved value of "puff" reads as
// "Puff", "drop" as "Drop", etc.
function unitPillLabel(unit: string): string {
  if (!unit) return ''
  if (unit === 'ml') return 'ml'
  return unit.charAt(0).toUpperCase() + unit.slice(1)
}

// AK-133 — inline-add helpers replicated from Cabinet.tsx (per the AK-149
// read-only pill pattern). Kept local rather than imported because Cabinet.tsx
// owns the master add flow and cross-screen imports would couple the two.
const ALLOWED_DOSAGE_FORMS: DosageForm[] = [
  'tablet', 'capsule', 'syrup', 'injection', 'cream',
  'ointment', 'dispersible', 'drops', 'spray', 'powder', 'inhaler', 'patch',
]

const DOSAGE_FORM_LABELS: Record<DosageForm, string> = {
  tablet:      'Tablet',
  capsule:     'Capsule',
  syrup:       'Syrup',
  injection:   'Injection',
  cream:       'Cream',
  ointment:    'Ointment',
  dispersible: 'Dispersible Tablet',
  drops:       'Drops',
  spray:       'Spray',
  powder:      'Powder',
  inhaler:     'Inhaler',
  patch:       'Patch',
}

function suggestUnitForForm(form: DosageForm): CabinetItemUnit {
  switch (form) {
    case 'inhaler':     return 'puff'
    case 'drops':       return 'drop'
    case 'patch':       return 'patch'
    case 'syrup':       return 'ml'
    case 'cream':
    case 'ointment':    return 'application'
    case 'injection':   return 'dose'
    case 'capsule':     return 'capsule'
    case 'spray':       return 'spray'
    case 'tablet':
    case 'dispersible':
    case 'powder':
    default:            return 'tablet'
  }
}

function dosageFormFromMaster(m: MasterMedicine): DosageForm {
  const raw = m.dosageForm
  if (raw && ALLOWED_DOSAGE_FORMS.includes(raw as DosageForm)) {
    return raw as DosageForm
  }
  return 'tablet'
}

function unitFromMaster(m: MasterMedicine): CabinetItemUnit {
  return suggestUnitForForm(dosageFormFromMaster(m))
}

function masterDisplayName(m: MasterMedicine): string {
  return m.brandName ?? m.name
}

const MAX_RETRO_DAYS = 30

function generatePastSlots(
  startDate: string,
  slots: TimeSlot[],
  patientId: string,
  tId: string,
  rId: string,
  scheduleType: ScheduleType = 'daily',
): { slots: RetroSlot[]; wasCapped: boolean } {
  const today = todayISTString()
  // AK-131 — flexible-daily carries no fixed slots; emit one synthetic
  // slot per past day instead. Any other mode with empty slots stays a
  // no-op (this guard previously short-circuited all flexible regimens).
  const isFlexible = scheduleType === 'flexible-daily'
  if (startDate >= today || (!isFlexible && slots.length === 0)) {
    return { slots: [], wasCapped: false }
  }
  // Iterate dates anchored at noon IST. UTC-day increments are unambiguous
  // because IST has no DST. The iteration window itself is capped at
  // MAX_RETRO_DAYS (walking back from yesterday) so a user-entered start
  // date far in the past doesn't spin a giant loop just to discard most of
  // the results during slicing.
  const startNoon = new Date(`${startDate}T12:00:00+05:30`)
  const todayNoon = new Date(`${today}T12:00:00+05:30`)
  const capStart = new Date(todayNoon)
  capStart.setUTCDate(capStart.getUTCDate() - MAX_RETRO_DAYS)
  const wasCapped = startNoon < capStart
  const effectiveStart = wasCapped ? capStart : startNoon

  const datesAscending: string[] = []
  for (
    const cursor = new Date(effectiveStart);
    cursor < todayNoon;
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  ) {
    datesAscending.push(
      new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(cursor),
    )
  }
  const dates = datesAscending.reverse()

  const out: RetroSlot[] = []
  for (const date of dates) {
    const displayDate = fmtDate(date)
    if (isFlexible) {
      // Mirrors the Cloud Function slotId scheme so logRetroactiveDoses
      // and maintainTodaySummary address the same doc. The synthetic time
      // '09:00' matches the reminder/scheduledAt anchor.
      out.push({
        slotId: `${tId}-${rId}-${patientId}-${date}-flex`,
        date,
        displayDate,
        time: '09:00',
        foodTiming: 'after',
        scheduleType: 'flexible-daily',
      })
      continue
    }
    for (const slot of slots) {
      const hhmm = slot.time.replace(':', '')
      out.push({
        slotId: buildSlotId(tId, rId, patientId, date, hhmm),
        date,
        displayDate,
        time: slot.time,
        foodTiming: slot.foodTiming,
      })
    }
  }
  return { slots: out, wasCapped }
}

// AK-39 sub-task 3 — Tokenise a CabinetItem.activeIngredients string into
// a normalised Set so deterministic same-ingredient lookups are case- and
// whitespace-insensitive. Empty / null inputs produce an empty Set so
// callers can treat absence as "no overlap" without extra null guards.
function normalizeIngredientTokens(s: string | null | undefined): Set<string> {
  if (!s) return new Set()
  return new Set(
    s
      .trim()
      .toLowerCase()
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  )
}

// AK-39 sub-task 3 — Deterministic pre-check that fires before the
// Gemini-backed interaction check at the step 2 → step 3 boundary.
// Catches the "same active ingredient, different brand / medicineId" case
// that the AK-123 medicineId-only duplicate detection silently misses.
// Returns the first match found (cabinet-item id + display name + the
// shared ingredient token) so the modal copy can name what's overlapping.
function detectIngredientCollision(
  selectedItem: CabinetItem,
  otherMedicines: Array<{ cabinetItemId: string; displayName: string; medicineId: string }>,
  cabinetItems: CabinetItem[],
  currentMedicineId: string,
): {
  conflictingCabinetItemId: string
  conflictingMedicineName: string
  overlapToken: string
} | null {
  const newTokens = normalizeIngredientTokens(selectedItem.activeIngredients)
  if (newTokens.size === 0) return null
  for (const other of otherMedicines) {
    // AK-123 already hard-blocks same-medicineId duplicates with a different
    // modal; skip here so the user doesn't get hit by two modals in a row.
    if (other.medicineId === currentMedicineId) continue
    const otherItem = cabinetItems.find((i) => i.iId === other.cabinetItemId)
    if (!otherItem) continue
    const otherTokens = normalizeIngredientTokens(otherItem.activeIngredients)
    for (const t of newTokens) {
      if (otherTokens.has(t)) {
        return {
          conflictingCabinetItemId: other.cabinetItemId,
          conflictingMedicineName: other.displayName,
          overlapToken: t,
        }
      }
    }
  }
  return null
}

// AK-123 — Classify how a new treatment's date range relates to an existing
// regimen's range. Operates on YYYY-MM-DD strings (lexicographic comparison)
// + null = "open-ended" sentinel. Returns null for disjoint ranges (no
// conflict at all). Caller uses the classification to drive a hard-block
// modal (duplicate / subset) or a soft-warn modal (overlap).
//
// Spec:
//   No conflict:
//     - existing ended before new starts: newStart > existingEnd
//     - new ends before existing starts:  existingStart > newEnd
//   Otherwise, overlap exists. Classify:
//     duplicate — identical ranges (treat null === null as equal)
//     subset   — one range is wholly inside the other (inclusive endpoints,
//                with null meaning "extends to infinity" on that side)
//     overlap  — partial intersection that isn't duplicate or subset
function detectConflict(
  newStart: string,
  newEnd: string | null,
  existingStart: string,
  existingEnd: string | null,
): ConflictType | null {
  // Disjoint ranges. If either end is null/ongoing, that side never ends,
  // so the corresponding inequality can't be satisfied.
  if (existingEnd !== null && newStart > existingEnd) return null
  if (newEnd !== null && existingStart > newEnd) return null

  // Identical ranges (null === null evaluates true, covering "both ongoing
  // from the same start date").
  if (newStart === existingStart && newEnd === existingEnd) return 'duplicate'

  // new contained in existing.
  const newInsideExisting =
    newStart >= existingStart
    && (existingEnd === null
        || (newEnd !== null && newEnd <= existingEnd))

  // existing contained in new.
  const existingInsideNew =
    existingStart >= newStart
    && (newEnd === null
        || (existingEnd !== null && existingEnd <= newEnd))

  if (newInsideExisting || existingInsideNew) return 'subset'

  return 'overlap'
}

function summarize(scheduleType: ScheduleType, days: number[], slots: TimeSlot[]): string {
  if (scheduleType === 'as-needed') return 'As needed'
  if (scheduleType === 'flexible-daily') return 'Once a day, any time'
  const times = slots.map(s => s.time).join(', ')
  if (scheduleType === 'daily') return `Daily at ${times}`
  const dayList = days.slice().sort((a, b) => a - b).map(d => DAY_NAMES[d]).join(', ')
  return `${dayList} at ${times}`
}

export function TreatmentsTab({ hId, currentUid, readOnly = false, filterByPatientUid }: Props) {
  const [view, setView] = useState<TxView>('list')

  // List
  const [treatments, setTreatments] = useState<Treatment[]>([])
  const [loadingList, setLoadingList] = useState(true)

  // Wizard reference data
  const [members, setMembers] = useState<HouseholdMember[]>([])
  const [cabinetItems, setCabinetItems] = useState<CabinetItem[]>([])
  // Bug #1 fix — surface cabinet-load errors instead of swallowing them.
  // Empty string when healthy; otherwise an inline error message rendered
  // in the step-2 picker.
  const [cabinetError, setCabinetError] = useState('')
  // AK-133 — Lifted from the subscription effect so the inline-add flow can
  // call addCabinetItem against the same default cabinet the picker reads.
  // Empty until the effect resolves; the mini-form's Add button stays
  // disabled in the brief window before then.
  const [cId, setCId] = useState('')

  // Step 1
  const [formName, setFormName] = useState('')
  const [formMemberId, setFormMemberId] = useState('')
  const [formMemberName, setFormMemberName] = useState<string | null>(null)
  const [formCategory, setFormCategory] = useState<TreatmentCategory>('acute')

  // Step 2
  const [formCabinetItemId, setFormCabinetItemId] = useState('')
  const [formMedicineId, setFormMedicineId] = useState('')
  const [formDoseAmount, setFormDoseAmount] = useState('')
  const [formDoseUnit, setFormDoseUnit] = useState<CabinetItemUnit>('tablet')
  const [formDisplayName, setFormDisplayName] = useState('')

  // Step 3
  const [formScheduleType, setFormScheduleType] = useState<ScheduleType>('daily')
  const [formScheduleDays, setFormScheduleDays] = useState<number[]>([1, 2, 3, 4, 5])
  const [formSlots, setFormSlots] = useState<TimeSlot[]>([{ time: '08:00', foodTiming: 'after' }])
  // AK-122 — Per-slot inline error messages, keyed by slot index. Populated
  // when the user edits a slot to match another slot's time; cleared when
  // the conflict is resolved, when the slot is removed, or on step-3 advance.
  const [slotErrors, setSlotErrors] = useState<Record<number, string>>({})
  const [formStartDate, setFormStartDate] = useState(todayISTString())
  const [formEndDate, setFormEndDate] = useState('')
  const [formOngoing, setFormOngoing] = useState(true)
  // PRN-only safety cap (Change 2). Default 4 mirrors a typical paracetamol/
  // ibuprofen ceiling and is editable by the admin before save.
  const [formMaxDosesPerDay, setFormMaxDosesPerDay] = useState(4)
  // Change 1 — set true when the step 2 → step 3 transition detects that the
  // selected medicine's stock can't cover one dose. Drives the start-date
  // minimum (tomorrow) and the amber explanation message in step 3.
  // Only meaningful when formScheduleType !== 'as-needed'.
  const [stockInsufficientForRestock, setStockInsufficientForRestock] = useState(false)

  // UI
  const [stepError, setStepError] = useState('')
  const [saveLoading, setSaveLoading] = useState(false)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  // AK-39 sub-task 2 + sub-task 3 — Interaction check gate at step2 → step3
  // transition. Sub-task 3 upgraded the soft "Add anyway" exit to a
  // hard-block with an admin-override-with-justification path. The extra
  // fields below feed the audit row recordInteractionAcknowledgement writes
  // when the user confirms the override.
  const [checkingInteraction, setCheckingInteraction] = useState(false)
  const [pendingInteractionWarning, setPendingInteractionWarning] = useState<{
    description: string
    withMedicineNames: string[]
    riskLevel: 'moderate' | 'high'
    conflictingCabinetItemId: string
    conflictingMedicineName: string
    source: 'deterministic' | 'gemini'
  } | null>(null)
  // Buffered override intent — populated when the admin confirms the
  // hard-block override in the modal at step 2, drained in handleSave once
  // the treatment doc exists so the ack row addresses a real tId.
  const [interactionOverride, setInteractionOverride] = useState<{
    conflictingCabinetItemId: string
    conflictingMedicineName: string
    interactionSummary: string
    justification: string
  } | null>(null)
  // AK-123 — Conflict check gate at step3 → step4 transition. Hard blocks
  // ('duplicate' / 'subset') stay on step 3; soft warns ('overlap') set
  // conflictAcknowledged + acknowledgedConflictingTreatmentId before
  // advancing so handleSave can stamp an audit row.
  const [checkingConflict, setCheckingConflict] = useState(false)
  const [pendingConflict, setPendingConflict] = useState<{
    type: ConflictType
    existingTreatmentName: string
    medicineName: string
    existingTreatmentId: string
  } | null>(null)
  const [conflictAcknowledged, setConflictAcknowledged] = useState(false)
  const [acknowledgedConflictingTreatmentId, setAcknowledgedConflictingTreatmentId] = useState('')
  // AK-121 — Past-date / retroactive-log flow. Pipeline:
  //   1. pastDateModal opens when the wizard's start date is in the past
  //      (and the schedule isn't PRN). Two branches:
  //        a. "Track from today" → reset formStartDate, advance to step 4
  //        b. "Log past doses"   → leave formStartDate, advance, mark willLogPastDoses
  //   2. handleSave succeeds; if willLogPastDoses, generate retroSlots and
  //      open retroSheet instead of returning to the list.
  //   3. handleRetroSave writes the chosen logs via logRetroactiveDoses.
  const [pastDateModal, setPastDateModal] = useState(false)
  const [willLogPastDoses, setWillLogPastDoses] = useState(false)
  const [retroSheet, setRetroSheet] = useState(false)
  const [retroTId, setRetroTId] = useState('')
  const [retroRId, setRetroRId] = useState('')
  const [retroChecks, setRetroChecks] = useState<Record<string, boolean>>({})
  const [retroSlots, setRetroSlots] = useState<RetroSlot[]>([])
  const [retroWasCapped, setRetroWasCapped] = useState(false)

  // AK-133 — Step 2 two-source combobox state. Search query feeds a debounced
  // masterDb lookup; cabinetItems are filtered client-side against the same
  // query. The mini-form (inlineAddMaster non-null) takes over the picker
  // surface while the user is filling in qty / expiry / Rx for a masterDb
  // pick that isn't yet in the cabinet.
  const [medicineSearchQuery, setMedicineSearchQuery] = useState('')
  const [masterSearchResults, setMasterSearchResults] = useState<MasterMedicine[]>([])
  const [masterSearchLoading, setMasterSearchLoading] = useState(false)
  const medicineSearchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [inlineAddMaster, setInlineAddMaster] = useState<MasterMedicine | null>(null)
  const [inlineAddQty, setInlineAddQty] = useState('')
  const [inlineAddExpiry, setInlineAddExpiry] = useState('')
  const [inlineAddPrescribed, setInlineAddPrescribed] = useState(false)
  const [inlineAddLoading, setInlineAddLoading] = useState(false)
  const [inlineAddError, setInlineAddError] = useState('')
  // Brief success confirmation surfaced just below the picker after a
  // successful inline add. Auto-clears after 3s via the effect below.
  const [inlineAddSuccess, setInlineAddSuccess] = useState('')

  // AK-138 — Edit sheet state. The sheet is keyed off `view === 'edit'`;
  // editingTId tracks which treatment is being edited and persists across
  // re-renders during save. editRegimenId switches between regimens when a
  // treatment has more than one (regimen picker — auto-selected when N=1).
  // Original values are snapshotted at open time so the Save button can
  // diff against them to know whether anything changed.
  const [editingTId, setEditingTId] = useState<string | null>(null)
  const [editRegimenId, setEditRegimenId] = useState<string>('')
  const [editName, setEditName] = useState('')
  const [editDoseAmount, setEditDoseAmount] = useState('')
  const [editEndDate, setEditEndDate] = useState('')
  const [editOngoing, setEditOngoing] = useState(true)
  const [editOriginal, setEditOriginal] = useState<{
    name: string
    doseAmount: string
    endDate: string
    ongoing: boolean
  } | null>(null)
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState('')
  // AK-138 — Mirrors the AK-132 affirmation pattern: a short success flash
  // shown briefly after the sheet closes so the user has visual confirmation
  // the save landed before the Firestore subscription's re-render arrives.
  const [editSavedMessage, setEditSavedMessage] = useState('')

  // AK-124 (replicated for AK-133) — Cross-member active-treatment interaction
  // warning surfaced after an inline add. Mirrors Cabinet.tsx's state shape so
  // the same TreatmentInteractionWarningModal can render against it.
  const [treatmentInteractionWarning, setTreatmentInteractionWarning] = useState<{
    description: string
    withMedicineNames: string[]
    riskLevel: 'moderate' | 'high'
    iId: string
    cabinetId: string
  } | null>(null)

  // ── Per-treatment regimens (used for OOS detection in the list view) ──
  // Loaded alongside adherence so a single Firestore round-trip serves both.
  const [regimensByTId, setRegimensByTId] = useState<Record<string, Regimen[]>>({})

  // Selected treatment for the detail bottom sheet (Fix 3).
  const [selectedTreatmentId, setSelectedTreatmentId] = useState<string | null>(null)

  // Treatment lifecycle (admin actions): pause / resume / end / delete.
  // Each gets its own modal slot so multiple confirms can't race. `actionPending`
  // disables the modal buttons while the network call is in flight.
  const [pauseConfirm, setPauseConfirm] = useState<Treatment | null>(null)
  const [endConfirm, setEndConfirm] = useState<Treatment | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<Treatment | null>(null)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [actionPending, setActionPending] = useState(false)
  const [pastExpanded, setPastExpanded] = useState(false)

  async function handlePause(t: Treatment) {
    setActionPending(true)
    try { await pauseTreatment(hId, t.tId, currentUid) }
    finally { setActionPending(false); setPauseConfirm(null) }
  }
  async function handleResume(t: Treatment) {
    setActionPending(true)
    try { await resumeTreatment(hId, t.tId) }
    finally { setActionPending(false) }
  }
  async function handleEnd(t: Treatment) {
    setActionPending(true)
    try { await endTreatment(hId, t.tId) }
    finally { setActionPending(false); setEndConfirm(null) }
  }
  async function handleDelete(t: Treatment) {
    setActionPending(true)
    try {
      const callable = httpsCallable(functions, 'deleteTreatment')
      await callable({ hId, tId: t.tId })
    } finally {
      setActionPending(false)
      setDeleteConfirm(null)
      setDeleteConfirmText('')
    }
  }

  // AK-138 — Open the edit sheet for the currently-selected treatment.
  // Pre-fills every field from the first regimen (or the only one). The
  // original-values snapshot drives the Save-button enable check.
  function openEditSheet(t: Treatment) {
    const regs = regimensByTId[t.tId] ?? []
    if (regs.length === 0) return  // can't edit a treatment with no regimens
    const firstReg = regs[0]
    const reEnd = firstReg.endDate ?? ''
    setEditingTId(t.tId)
    setEditRegimenId(firstReg.rId)
    setEditName(t.name)
    setEditDoseAmount(String(firstReg.doseAmount))
    setEditEndDate(reEnd)
    setEditOngoing(firstReg.ongoing)
    setEditOriginal({
      name: t.name,
      doseAmount: String(firstReg.doseAmount),
      endDate: reEnd,
      ongoing: firstReg.ongoing,
    })
    setEditError('')
    setView('edit')
  }

  // AK-138 — Switch the per-regimen fields when the user picks a different
  // regimen in a multi-regimen treatment. Treatment-level (name) state is
  // unaffected; only the dose/endDate/ongoing snapshot is replaced.
  function switchEditRegimen(rId: string) {
    if (!editingTId) return
    const regs = regimensByTId[editingTId] ?? []
    const reg = regs.find(r => r.rId === rId)
    if (!reg) return
    const reEnd = reg.endDate ?? ''
    setEditRegimenId(rId)
    setEditDoseAmount(String(reg.doseAmount))
    setEditEndDate(reEnd)
    setEditOngoing(reg.ongoing)
    setEditOriginal(prev => prev ? {
      ...prev,
      doseAmount: String(reg.doseAmount),
      endDate: reEnd,
      ongoing: reg.ongoing,
    } : null)
  }

  function cancelEdit() {
    setView('list')
    setEditingTId(null)
    setEditError('')
    // selectedTreatmentId stays set → detail sheet reappears underneath.
  }

  async function handleEditSave() {
    if (!editingTId || !editRegimenId || !editOriginal) return
    const t = treatments.find(x => x.tId === editingTId)
    if (!t) return
    const regs = regimensByTId[t.tId] ?? []
    const reg = regs.find(r => r.rId === editRegimenId)
    if (!reg) { setEditError('Could not load this regimen.'); return }

    // Validation
    const trimmedName = editName.trim()
    if (!trimmedName) { setEditError('Treatment name is required.'); return }
    const doseNum = parseFloat(editDoseAmount)
    if (isNaN(doseNum) || doseNum <= 0) {
      setEditError('Dose amount must be a positive number.')
      return
    }
    let resolvedEndDate: string | null = null
    if (!editOngoing) {
      if (!editEndDate) {
        setEditError('Set an end date or choose ongoing.')
        return
      }
      if (editEndDate <= reg.startDate) {
        setEditError('End date must be after the treatment start date.')
        return
      }
      // Past-date warning is informational — user may be correcting history.
      resolvedEndDate = editEndDate
    }

    setEditError('')
    setEditSaving(true)

    const promises: Promise<unknown>[] = []
    if (trimmedName !== editOriginal.name) {
      promises.push(updateTreatment(hId, editingTId, { name: trimmedName }))
    }
    const regUpdates: Parameters<typeof updateRegimen>[3] = {}
    if (editDoseAmount !== editOriginal.doseAmount) {
      regUpdates.doseAmount = doseNum
    }
    if (editOngoing !== editOriginal.ongoing || editEndDate !== editOriginal.endDate) {
      regUpdates.ongoing = editOngoing
      regUpdates.endDate = resolvedEndDate
    }
    if (Object.keys(regUpdates).length > 0) {
      promises.push(updateRegimen(hId, editingTId, editRegimenId, regUpdates))
    }

    try {
      await Promise.all(promises)
      setEditSavedMessage('Saved.')
      setEditSaving(false)
      setEditingTId(null)
      setView('list')
      // selectedTreatmentId stays set → detail sheet refreshes itself once
      // the regimen / treatment subscriptions fire with the new data.
    } catch {
      setEditError('Could not save changes. Please try again.')
      setEditSaving(false)
    }
  }

  // Subscribe to treatments
  useEffect(() => {
    const unsub = subscribeTreatments(hId, items => {
      setTreatments(items)
      setLoadingList(false)
    })
    return unsub
  }, [hId])

  // Bug #1 fix — Members are loaded once (rarely change during a wizard
  // session); cabinet items use a real-time subscription so the step-2
  // picker reflects items added in another tab/window without remounting,
  // and so a transient permissions/network blip surfaces an inline error
  // instead of silently producing an empty dropdown.
  useEffect(() => {
    getHouseholdMembers(hId)
      .then(setMembers)
      .catch(() => { /* member-select will show its empty state */ })
  }, [hId])

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    async function setup() {
      setCabinetError('')
      try {
        const resolvedCId = await getOrCreateDefaultCabinet(hId)
        if (cancelled) return
        setCId(resolvedCId)
        unsubscribe = subscribeCabinetItems(
          hId,
          resolvedCId,
          (items) => {
            if (cancelled) return
            setCabinetItems(items)
            setCabinetError('')
          },
          () => {
            if (cancelled) return
            setCabinetItems([])
            setCabinetError('Could not load your cabinet. Check your connection.')
          },
        )
      } catch {
        if (!cancelled) {
          setCabinetItems([])
          setCabinetError('Could not load your cabinet. Check your connection.')
        }
      }
    }
    setup()
    return () => { cancelled = true; unsubscribe?.() }
  }, [hId])

  // AK-133 — Debounced masterDb prefix search. Mirrors Cabinet.tsx's 300ms
  // window so the typing cadence feels identical across the two screens.
  // Empty query short-circuits to an empty result set (no Firestore read).
  useEffect(() => {
    if (medicineSearchDebounceRef.current) {
      clearTimeout(medicineSearchDebounceRef.current)
    }
    const trimmed = medicineSearchQuery.trim()
    if (!trimmed) {
      setMasterSearchResults([])
      setMasterSearchLoading(false)
      return
    }
    medicineSearchDebounceRef.current = setTimeout(async () => {
      setMasterSearchLoading(true)
      try {
        const results = await searchMasterDb(trimmed)
        setMasterSearchResults(results)
      } catch {
        setMasterSearchResults([])
      } finally {
        setMasterSearchLoading(false)
      }
    }, 300)
    return () => {
      if (medicineSearchDebounceRef.current) {
        clearTimeout(medicineSearchDebounceRef.current)
      }
    }
  }, [medicineSearchQuery])

  // Brief success flash auto-clears after 3s so it doesn't linger across
  // step changes or repeated adds.
  useEffect(() => {
    if (!inlineAddSuccess) return
    const t = setTimeout(() => setInlineAddSuccess(''), 3000)
    return () => clearTimeout(t)
  }, [inlineAddSuccess])

  // AK-138 — same auto-clear pattern for the post-save edit confirmation.
  useEffect(() => {
    if (!editSavedMessage) return
    const t = setTimeout(() => setEditSavedMessage(''), 2500)
    return () => clearTimeout(t)
  }, [editSavedMessage])

  // Per-treatment adherence over the trailing 7 days, plus the latest end-date
  // across that treatment's regimens (used for "X days remaining" on acute
  // treatments). Re-runs whenever the live treatments list changes so a newly
  // added treatment shows up with adherence "—" until the first dose is logged.
  const [adherenceByTId, setAdherenceByTId] = useState<Record<string, number | null>>({})
  const [endDateByTId,   setEndDateByTId]   = useState<Record<string, string | null>>({})
  useEffect(() => {
    let cancelled = false
    async function load() {
      const today = todayISTString()
      const fromDate = (() => {
        const d = new Date(today + 'T00:00:00')
        d.setDate(d.getDate() - 6)               // last 7 days inclusive
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      })()

      const [logs, { regimensByTreatment }] = await Promise.all([
        loadLogsForDateRange(hId, fromDate, today),
        loadAllActiveRegimens(hId),
      ])
      if (cancelled) return

      // Cabinet snapshot comes from the real-time subscription set up above.
      setRegimensByTId(regimensByTreatment)

      const adherence: Record<string, number | null> = {}
      const ends:      Record<string, string | null> = {}

      for (const tId of Object.keys(regimensByTreatment)) {
        const regs = regimensByTreatment[tId]

        // Latest end date across this treatment's regimens (for "X days remaining").
        let latestEnd: string | null = null
        for (const r of regs) {
          if (!r.endDate) continue
          if (!latestEnd || r.endDate > latestEnd) latestEnd = r.endDate
        }
        ends[tId] = latestEnd

        // Sum expected slots over the past 7 days for this treatment.
        let expected = 0
        for (let i = 0; i < 7; i++) {
          const d = new Date(today + 'T00:00:00')
          d.setDate(d.getDate() - i)
          const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
          for (const r of regs) {
            if (r.startDate > dateStr) continue
            if (r.endDate && r.endDate < dateStr) continue
            if (r.scheduleType === 'as-needed') continue
            // AK-131 — flexible-daily contributes exactly one expected dose per
            // applicable day, regardless of slots.length (which is always 0).
            if (r.scheduleType === 'flexible-daily') { expected += 1; continue }
            if (r.scheduleType === 'daily') { expected += r.slots.length; continue }
            // specific-days
            const dow = d.getDay()
            if (r.scheduleDays?.includes(dow)) expected += r.slots.length
          }
        }

        const taken = logs.filter(l =>
          l.tId === tId && (l.status === 'taken' || l.status === 'late'),
        ).length

        adherence[tId] = expected > 0 ? Math.round((taken / expected) * 100) : null
      }

      setAdherenceByTId(adherence)
      setEndDateByTId(ends)
    }
    load().catch(() => { /* keep silent — list still renders without adherence */ })
    return () => { cancelled = true }
  }, [hId, treatments.length])

  function startAdd() {
    setFormName('')
    setFormCategory('acute')
    setFormMemberId(members[0]?.uid ?? '')
    setFormMemberName(members[0]?.displayName ?? null)
    setFormCabinetItemId('')
    setFormMedicineId('')
    setFormDoseAmount('')
    setFormDisplayName('')
    setFormScheduleType('daily')
    setFormScheduleDays([1, 2, 3, 4, 5])
    setFormSlots([{ time: '08:00', foodTiming: 'after' }])
    setFormStartDate(todayISTString())
    setFormEndDate('')
    setFormOngoing(true)
    setFormMaxDosesPerDay(4)
    setStockInsufficientForRestock(false)
    setSlotErrors({})
    setPendingConflict(null)
    setConflictAcknowledged(false)
    setAcknowledgedConflictingTreatmentId('')
    setPastDateModal(false)
    setWillLogPastDoses(false)
    setRetroSheet(false)
    setRetroTId('')
    setRetroRId('')
    setRetroChecks({})
    setRetroSlots([])
    setRetroWasCapped(false)
    setStepError('')
    setView('step1')
  }

  function validate(v: TxView): string {
    if (v === 'step1') {
      if (!formName.trim()) return 'Treatment name is required.'
      if (!formMemberId) return 'Please select a member.'
    }
    if (v === 'step2') {
      if (!formCabinetItemId) return 'Please select a medicine.'
      const qty = parseFloat(formDoseAmount)
      if (!formDoseAmount || isNaN(qty) || qty <= 0) return 'Enter a valid dose amount.'
      if (!formDisplayName.trim()) return 'Please enter the medicine name.'
    }
    if (v === 'step3') {
      if (formScheduleType === 'specific-days' && formScheduleDays.length === 0)
        return 'Select at least one day.'
      // AK-131 — flexible-daily carries no fixed slots, so the empty-slot
      // and duplicate-time checks are skipped alongside PRN.
      const isTimeDriven =
        formScheduleType !== 'as-needed' && formScheduleType !== 'flexible-daily'
      if (isTimeDriven && formSlots.length === 0)
        return 'Add at least one dose time.'
      // AK-122 — safety net for slots that drift into a duplicate time via
      // direct time-input edits after the addSlot guard.
      if (isTimeDriven) {
        const slotTimes = formSlots.map(s => s.time)
        if (new Set(slotTimes).size !== slotTimes.length) {
          return 'Each dose time must be unique.'
        }
      }
      if (!formOngoing && !formEndDate)
        return 'Set an end date or choose ongoing.'
    }
    return ''
  }

  async function goNext() {
    const err = validate(view)
    if (err) { setStepError(err); return }
    setStepError('')
    if (view === 'step3') {
      // AK-122 — validate('step3') confirmed there are no duplicates; clear
      // any per-slot errors that may have lingered from prior edits.
      setSlotErrors({})
    setPendingConflict(null)
    setConflictAcknowledged(false)
    setAcknowledgedConflictingTreatmentId('')
    setPastDateModal(false)
    setWillLogPastDoses(false)
    setRetroSheet(false)
    setRetroTId('')
    setRetroRId('')
    setRetroChecks({})
    setRetroSlots([])
    setRetroWasCapped(false)
    }
    const next: Record<TxView, TxView> = {
      list: 'step1', step1: 'step2', step2: 'step3', step3: 'step4', step4: 'step4',
      // AK-138 — Edit view doesn't participate in goNext (it has its own
      // Save handler) but the map needs full coverage for the union.
      edit: 'edit',
    }

    // AK-39 sub-task 2 — Soft interaction check at the step2 → step3 boundary
    // only. The medicine is chosen on step2; the check compares it against the
    // member's other active-treatment regimens. Any error (no other meds, no
    // interaction, Gemini failure, no cabinet match) advances normally; only a
    // positive hit opens the confirm modal and pauses the transition.
    // AK-123 — Conflict check at the step 3 → step 4 boundary. Compares the
    // wizard's medicine + date range against every active treatment the same
    // member already has for the same medicineId. Hard blocks stay on step 3;
    // soft warns mark the deliberate-override flag so handleSave can stamp an
    // audit row. Any error (read failure, no matching active treatments)
    // advances normally — the check is informational, not load-bearing.
    if (view === 'step3') {
      setCheckingConflict(true)
      // A prior attempt may have left these set if the user dismissed the
      // soft-warn modal, edited the dates, and now retries. Reset before
      // the new check so a successful no-conflict advance doesn't carry a
      // stale acknowledgement into handleSave.
      setConflictAcknowledged(false)
      setAcknowledgedConflictingTreatmentId('')
      try {
        const memberTreatments = await getActiveTreatmentsWithRegimensForMember(
          hId,
          formMemberId,
        )
        const newEnd = formOngoing ? null : (formEndDate || null)
        // Walk every regimen across the member's active treatments. First
        // conflict wins — captured in a local variable so we can branch
        // outside the loop without leaning on stale state during this tick.
        let found: {
          type: ConflictType
          existingTreatmentName: string
          existingTreatmentId: string
        } | null = null
        outer: for (const { treatment, regimens } of memberTreatments) {
          for (const regimen of regimens) {
            if (regimen.medicineId !== formMedicineId) continue
            const existingEnd = regimen.ongoing ? null : (regimen.endDate || null)
            const conflict = detectConflict(
              formStartDate,
              newEnd,
              regimen.startDate,
              existingEnd,
            )
            if (conflict) {
              found = {
                type: conflict,
                existingTreatmentName: treatment.name,
                existingTreatmentId: treatment.tId,
              }
              break outer
            }
          }
        }
        if (found) {
          setPendingConflict({
            type: found.type,
            existingTreatmentName: found.existingTreatmentName,
            medicineName: formDisplayName,
            existingTreatmentId: found.existingTreatmentId,
          })
          setCheckingConflict(false)
          return
        }
        // No conflict — AK-121 past-date branch. Only fires for time-driven
        // schedules; PRN treatments don't have meaningful past doses to
        // retro-log (no slots → nothing to enumerate).
        if (
          formScheduleType !== 'as-needed'
          && formStartDate < todayISTString()
        ) {
          setCheckingConflict(false)
          setPastDateModal(true)
          return
        }
        setView(next[view])
      } catch {
        setView(next[view])
      } finally {
        setCheckingConflict(false)
      }
      return
    }

    if (view === 'step2') {
      const selectedItem = cabinetItems.find(i => i.iId === formCabinetItemId)
      if (!selectedItem) { setView(next[view]); return }

      // Change 1 — dose-vs-stock auto-shift. If the selected medicine doesn't
      // have enough on hand to cover even one dose and the schedule is time-
      // driven (not as-needed), push the start date to tomorrow so the user
      // has a restock window. PRN treatments are intentionally exempt — they
      // can be taken on demand whenever stock arrives.
      const doseAmt = parseFloat(formDoseAmount)
      const stockInsufficient =
        !isNaN(doseAmt) && doseAmt > selectedItem.quantityOnHand
      if (stockInsufficient && formScheduleType !== 'as-needed') {
        const today = todayISTString()
        if (!formStartDate || formStartDate <= today) {
          setFormStartDate(tomorrowISTString(today))
        }
        setStockInsufficientForRestock(true)
      } else {
        setStockInsufficientForRestock(false)
      }

      setCheckingInteraction(true)
      try {
        const otherMedicines = await getActiveTreatmentMedicines(hId, formMemberId)
        if (otherMedicines.length === 0) {
          setView(next[view])
          return
        }

        // AK-39 sub-task 3 — Deterministic same-ingredient pre-check runs
        // before the Gemini call. Free Firestore read (cabinetItems is
        // already subscribed), zero model latency, catches the obvious
        // "same drug, different brand" double-dosing case that AK-123's
        // medicineId-only check would miss.
        const collision = detectIngredientCollision(
          selectedItem,
          otherMedicines,
          cabinetItems,
          formMedicineId,
        )
        if (collision) {
          const memberLabel = formMemberName ?? 'this member'
          setPendingInteractionWarning({
            description:
              `This medicine contains ${collision.overlapToken}, which ${memberLabel} is already taking via ${collision.conflictingMedicineName}. Adding it would double their dose.`,
            withMedicineNames: [collision.conflictingMedicineName],
            riskLevel: 'high',
            conflictingCabinetItemId: collision.conflictingCabinetItemId,
            conflictingMedicineName: collision.conflictingMedicineName,
            source: 'deterministic',
          })
          return
        }

        const result = await checkCabinetInteractions(
          selectedItem,
          otherMedicines.map(m => m.cabinetItemId),
        )
        if (result?.hasInteraction) {
          // Resolve the first cabinet-item id that matches one of Gemini's
          // returned medicine names so the audit row can reference a real
          // doc. Falls back to the first otherMedicine if no name matches
          // (rare — Gemini occasionally paraphrases the display name).
          const firstWithName = result.withMedicineNames[0] ?? ''
          const matched = otherMedicines.find(
            (m) => m.displayName.trim().toLowerCase() === firstWithName.trim().toLowerCase(),
          ) ?? otherMedicines[0]
          setPendingInteractionWarning({
            description: result.description,
            withMedicineNames: result.withMedicineNames,
            riskLevel: result.riskLevel,
            conflictingCabinetItemId: matched?.cabinetItemId ?? '',
            conflictingMedicineName: result.withMedicineNames.join(', '),
            source: 'gemini',
          })
          // Stay on step2; modal drives the next action.
          return
        }
        setView(next[view])
      } catch {
        // Silent fail — the check is informational, not load-bearing.
        setView(next[view])
      } finally {
        setCheckingInteraction(false)
      }
      return
    }

    setView(next[view])
  }

  function goBack() {
    setStepError('')
    const prev: Record<TxView, TxView> = {
      list: 'list', step1: 'list', step2: 'step1', step3: 'step2', step4: 'step3',
      edit: 'list',
    }
    setView(prev[view])
  }

  // Discards all wizard state and returns to the list. Wired to the Cancel
  // confirmation modal — never invoked directly by a tap.
  function discardAndExitWizard() {
    setShowCancelConfirm(false)
    setFormName('')
    setFormMemberId('')
    setFormMemberName(null)
    setFormCategory('acute')
    setFormCabinetItemId('')
    setFormMedicineId('')
    setFormDoseAmount('')
    setFormDisplayName('')
    setFormScheduleType('daily')
    setFormScheduleDays([1, 2, 3, 4, 5])
    setFormSlots([{ time: '08:00', foodTiming: 'after' }])
    setFormStartDate(todayISTString())
    setFormEndDate('')
    setFormOngoing(true)
    setFormMaxDosesPerDay(4)
    setStockInsufficientForRestock(false)
    setSlotErrors({})
    setPendingConflict(null)
    setConflictAcknowledged(false)
    setAcknowledgedConflictingTreatmentId('')
    setPastDateModal(false)
    setWillLogPastDoses(false)
    setRetroSheet(false)
    setRetroTId('')
    setRetroRId('')
    setRetroChecks({})
    setRetroSlots([])
    setRetroWasCapped(false)
    setStepError('')
    // AK-133 — clear inline-add + search surfaces too so re-entering the
    // wizard doesn't carry stale state across.
    setMedicineSearchQuery('')
    setMasterSearchResults([])
    setInlineAddMaster(null)
    setInlineAddQty('')
    setInlineAddExpiry('')
    setInlineAddPrescribed(false)
    setInlineAddError('')
    setInlineAddSuccess('')
    setTreatmentInteractionWarning(null)
    // AK-39 sub-task 3 — drop any buffered override so it can't bleed into
    // the next treatment-creation flow.
    setPendingInteractionWarning(null)
    setInteractionOverride(null)
    setView('list')
  }

  async function handleSave() {
    setSaveLoading(true)
    setStepError('')
    try {
      const tId = await createTreatment(hId, {
        name: formName.trim(),
        memberId: formMemberId,
        memberName: formMemberName,
        category: formCategory,
      })
      // AK-121 — bind rId so the retro-log path can address the right
      // regimen when generating historical slot IDs.
      const rId = await addRegimen(hId, tId, {
        cabinetItemId: formCabinetItemId,
        medicineId: formMedicineId,
        displayName: formDisplayName.trim(),
        doseAmount: parseFloat(formDoseAmount),
        doseUnit: formDoseUnit,
        scheduleType: formScheduleType,
        scheduleDays: formScheduleType === 'specific-days' ? formScheduleDays : null,
        // AK-131 — flexible-daily mirrors PRN's empty-slots persistence;
        // the Cloud Function synthesises the per-day slot from scheduleType.
        slots:
          formScheduleType === 'as-needed' || formScheduleType === 'flexible-daily'
            ? []
            : formSlots,
        startDate: formStartDate,
        endDate: formOngoing ? null : (formEndDate || null),
        ongoing: formOngoing,
        // PRN-only — conditional spread so the field is omitted entirely
        // (rather than written as undefined → Firestore would reject) for
        // time-driven regimens.
        ...(formScheduleType === 'as-needed' ? { maxDosesPerDay: formMaxDosesPerDay } : {}),
        // AK-171 — denormalize the patient's timezone onto the regimen so the
        // dose-reminder cron can compute slot instants without an extra member
        // read. Falls back to 'Asia/Kolkata' for the AK-171 rollout window when
        // member docs predating the field have no timezone set yet.
        timezone: members.find(m => m.uid === formMemberId)?.timezone ?? 'Asia/Kolkata',
      })
      // AK-123 — Audit row stamped only after both writes above succeed,
      // and only when the admin actively acknowledged a soft-warn overlap.
      // Best-effort: a failed audit write must NOT roll back the treatment.
      if (conflictAcknowledged && acknowledgedConflictingTreatmentId) {
        try {
          await recordConflictAcknowledgement(hId, tId, {
            conflictingTreatmentId: acknowledgedConflictingTreatmentId,
            conflictType: 'overlap',
            acknowledgedByUid: auth.currentUser?.uid ?? currentUid,
            acknowledgedByName: auth.currentUser?.displayName ?? '',
          })
        } catch {
          // Audit write failed; treatment is already created. Surface via
          // logs only — don't error the user. The conflict-tracking is a
          // nice-to-have, not a correctness requirement.
        }
      }
      // AK-39 sub-task 3 — Same shape as the AK-123 ack write above. The
      // treatment + regimen writes already succeeded; the interaction-ack
      // is best-effort and must NOT roll back the creation. Failure logs
      // silently so the admin still gets the treatment they meant to save.
      if (interactionOverride) {
        try {
          await recordInteractionAcknowledgement(hId, tId, {
            conflictingCabinetItemId: interactionOverride.conflictingCabinetItemId,
            conflictingMedicineName: interactionOverride.conflictingMedicineName,
            interactionSummary: interactionOverride.interactionSummary,
            justification: interactionOverride.justification,
            acknowledgedByUid: auth.currentUser?.uid ?? currentUid,
            acknowledgedByName: auth.currentUser?.displayName ?? '',
          })
        } catch {
          // Same swallow as the AK-123 path; treatment is already saved.
        }
      }
      // AK-121 — If the user picked "log past doses" on the PastDateModal,
      // generate the retro slot list now (using the real tId + rId) and open
      // the RetroLogSheet instead of returning to the list. handleRetroSave
      // closes the wizard.
      if (willLogPastDoses) {
        const generated = generatePastSlots(
          formStartDate,
          formSlots,
          formMemberId,
          tId,
          rId,
          formScheduleType,
        )
        if (generated.slots.length > 0) {
          const initialChecks: Record<string, boolean> = {}
          for (const s of generated.slots) initialChecks[s.slotId] = true
          setRetroTId(tId)
          setRetroRId(rId)
          setRetroSlots(generated.slots)
          setRetroWasCapped(generated.wasCapped)
          setRetroChecks(initialChecks)
          setRetroSheet(true)
          return
        }
        // Edge: PRN got through somehow, or startDate === today. Fall
        // through to the normal close — no slots to log.
      }
      setView('list')
    } catch {
      setStepError('Failed to save. Please try again.')
    } finally {
      setSaveLoading(false)
    }
  }

  // AK-121 — Persist the user's retro checklist choices and close the
  // wizard. Failure here doesn't roll back the treatment (already saved);
  // the sheet stays open so the user can retry.
  async function handleRetroSave() {
    try {
      await logRetroactiveDoses(hId, retroTId, {
        rId: retroRId,
        patientId: formMemberId,
        cabinetItemId: formCabinetItemId,
        doseAmount: parseFloat(formDoseAmount),
        doseUnit: formDoseUnit,
        createdBy: auth.currentUser?.uid ?? currentUid,
        slots: retroSlots.map(s => ({
          slotId: s.slotId,
          scheduledDate: s.date,
          scheduledTime: s.time,
          status: (retroChecks[s.slotId] ?? true) ? 'taken' : 'skipped',
        })),
      })
      setRetroSheet(false)
      setView('list')
    } catch {
      setStepError('Could not save past doses. Try again, or skip for now.')
    }
  }

  function handleRetroSkip() {
    setRetroSheet(false)
    setView('list')
  }

  function toggleRetroCheck(slotId: string) {
    setRetroChecks(prev => ({
      ...prev,
      [slotId]: !(prev[slotId] ?? true),
    }))
  }

  // Slot helpers — AK-122 smart defaults + duplicate guards.
  function addSlot() {
    // Hard cap on slot count. The button below is also disabled past 4, but
    // we re-check here as a defense-in-depth: keyboard users can press the
    // button before disabled state updates, and the cap is a real product
    // constraint (not just a UI affordance).
    if (formSlots.length >= MAX_SLOTS_PER_DAY) {
      setStepError(`Maximum of ${MAX_SLOTS_PER_DAY} dose times allowed per day.`)
      return
    }
    const newSlotTime = nextSlotDefault(formSlots)
    if (newSlotTime === null) {
      // All defaults are taken (e.g. the user manually edited slots to
      // cover every default). Fall back to the cap message — they can
      // remove or edit an existing slot if they really need a 5th time,
      // though the count cap above will also block that.
      setStepError(`Maximum of ${MAX_SLOTS_PER_DAY} dose times allowed per day.`)
      return
    }
    setStepError('')
    setFormSlots(prev => [...prev, { time: newSlotTime, foodTiming: 'after' }])
  }

  function removeSlot(i: number) {
    setFormSlots(prev => prev.filter((_, idx) => idx !== i))
    // Indices shift after a removal, so any prior per-slot errors are now
    // off-by-one. Cheapest correct path: wipe the error map; users will
    // re-trigger detection on their next edit.
    setSlotErrors({})
    setPendingConflict(null)
    setConflictAcknowledged(false)
    setAcknowledgedConflictingTreatmentId('')
    setPastDateModal(false)
    setWillLogPastDoses(false)
    setRetroSheet(false)
    setRetroTId('')
    setRetroRId('')
    setRetroChecks({})
    setRetroSlots([])
    setRetroWasCapped(false)
  }

  function setSlotTime(i: number, time: string) {
    const duplicate = formSlots.some((s, idx) => idx !== i && s.time === time)
    if (duplicate) {
      // Don't apply the duplicate value. The controlled input snaps back
      // to the prior valid time on the next render, and the inline error
      // explains why.
      setSlotErrors(prev => ({ ...prev, [i]: 'This time is already used.' }))
      return
    }
    setSlotErrors(prev => {
      if (!(i in prev)) return prev
      const next = { ...prev }
      delete next[i]
      return next
    })
    setFormSlots(prev => prev.map((s, idx) => idx === i ? { ...s, time } : s))
  }
  function setSlotFood(i: number, food: FoodTiming) {
    setFormSlots(prev => prev.map((s, idx) => idx === i ? { ...s, foodTiming: food } : s))
  }
  function toggleDay(d: number) {
    setFormScheduleDays(prev =>
      prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort((a, b) => a - b)
    )
  }
  function selectCabinetItem(iId: string) {
    // AK-39 sub-task 3 — any buffered override targets the previously-selected
    // medicine; dropping it on a fresh pick avoids carrying a stale audit
    // payload into a treatment for a different drug.
    setInteractionOverride(null)
    if (!iId) {
      setFormCabinetItemId('')
      setFormMedicineId('')
      setFormDisplayName('')
      return
    }
    const item = cabinetItems.find(i => i.iId === iId)
    if (!item) return
    setFormCabinetItemId(item.iId)
    setFormMedicineId(item.medicineId)
    setFormDoseUnit(item.unit)
    setFormDisplayName(item.displayNameOverride ?? item.medicineId)
  }

  // AK-133 — Pick a cabinet item from the two-source combobox results. Wraps
  // selectCabinetItem so the search query / dropdown collapses on confirm.
  function selectCabinetItemFromSearch(iId: string) {
    selectCabinetItem(iId)
    setMedicineSearchQuery('')
    setMasterSearchResults([])
  }

  // AK-133 — Open the inline mini-form for a masterDb result. Defaults
  // mirror Cabinet.tsx: Rx defaults to false (OTC); qty/expiry left blank for
  // the user to fill in. Clears any prior error/success surface.
  function openInlineAddFor(master: MasterMedicine) {
    setInlineAddMaster(master)
    setInlineAddQty('')
    setInlineAddExpiry('')
    setInlineAddPrescribed(false)
    setInlineAddError('')
    setInlineAddSuccess('')
  }

  function cancelInlineAdd() {
    setInlineAddMaster(null)
    setInlineAddQty('')
    setInlineAddExpiry('')
    setInlineAddPrescribed(false)
    setInlineAddError('')
  }

  // AK-133 — Replicates the AK-39 (passive cabinet-sibling) + AK-124
  // (cross-member active-treatment) interaction checks from Cabinet.tsx
  // L710-758. Fire-and-forget: errors are swallowed and never block the
  // wizard. The new item's iId is excluded from the AK-124 candidate pool
  // so the just-added doc doesn't appear to interact with itself.
  function runPostAddInteractionChecks(
    newIid: string,
    cabinetIdLocal: string,
    newItem: CabinetItem,
    otherItems: CabinetItem[],
  ) {
    if (otherItems.length > 0) {
      checkCabinetInteractions(newItem, otherItems.map(it => it.iId))
        .then(result => {
          if (result?.hasInteraction) {
            return updateCabinetItemInteractionWarning(
              hId,
              cabinetIdLocal,
              newIid,
              {
                withMedicineNames: result.withMedicineNames,
                riskLevel: result.riskLevel,
                description: result.description,
              },
            )
          }
        })
        .catch(() => {
          // Passive background check — never blocks or surfaces.
        })
    }

    const memberUids = members.map(m => m.uid)
    if (memberUids.length > 0) {
      Promise.all(
        memberUids.map(uid => getActiveTreatmentsWithRegimensForMember(hId, uid)),
      )
        .then(results => {
          const treatmentItemIds = results
            .flat()
            .flatMap(({ regimens }) => regimens.map(r => r.cabinetItemId))
            .filter(id => id && id !== newIid)
          if (treatmentItemIds.length === 0) return null
          return checkCabinetInteractions(newItem, treatmentItemIds)
        })
        .then(result => {
          if (!result?.hasInteraction) return
          setTreatmentInteractionWarning({
            description: result.description,
            withMedicineNames: result.withMedicineNames,
            riskLevel: result.riskLevel,
            iId: newIid,
            cabinetId: cabinetIdLocal,
          })
        })
        .catch(() => {
          // Informational warning, never blocks the add.
        })
    }
  }

  async function handleInlineAdd() {
    if (!inlineAddMaster) return
    if (!cId) {
      setInlineAddError(
        'No cabinet is set up yet for this household. Try again in a moment.',
      )
      return
    }
    const qty = parseInt(inlineAddQty, 10)
    if (!inlineAddQty || isNaN(qty) || qty < 0) {
      setInlineAddError('Enter a valid quantity.')
      return
    }
    if (!inlineAddExpiry) {
      setInlineAddError('Expiry date is required.')
      return
    }
    setInlineAddError('')
    setInlineAddLoading(true)

    const master = inlineAddMaster
    const cabinetIdLocal = cId
    // Snapshot the comparison set BEFORE the subscription fires with the
    // post-add list — mirrors Cabinet.tsx's pattern.
    const otherItems = cabinetItems
    const resolvedUnit = unitFromMaster(master)
    const resolvedDosageForm = dosageFormFromMaster(master)
    const resolvedMedicineId = master.medicineId

    try {
      const newIid = await addCabinetItem(hId, cabinetIdLocal, {
        medicineId: resolvedMedicineId,
        brandName: masterDisplayName(master),
        displayNameOverride: null,
        quantityOnHand: qty,
        unit: resolvedUnit,
        expiryDate: inlineAddExpiry,
        prescribed: inlineAddPrescribed,
        dosageForm: resolvedDosageForm,
        strength: master.strength ?? null,
        activeIngredients: master.activeIngredient ?? null,
        marketer: null,
        storageInstructions: null,
        masterDbId: master.medicineId,
      })

      // Wire the new item into the wizard. The subscription will catch up
      // shortly with the full doc, but the user expects immediate feedback,
      // so we mirror the relevant fields onto wizard state directly rather
      // than waiting for cabinetItems to refresh.
      setFormCabinetItemId(newIid)
      setFormMedicineId(resolvedMedicineId)
      setFormDoseUnit(resolvedUnit)
      setFormDisplayName(masterDisplayName(master))

      // Build the CabinetItem-shaped payload the interaction check reads.
      // Server-stamped timestamp fields are absent — checkCabinetInteractions
      // only inspects identity/strength/activeIngredients, so a cast is safe.
      const newItem = {
        iId: newIid,
        cId: cabinetIdLocal,
        hId,
        medicineId: resolvedMedicineId,
        displayNameOverride: null,
        quantityOnHand: qty,
        unit: resolvedUnit,
        expiryDate: inlineAddExpiry,
        prescribed: inlineAddPrescribed,
        brandName: masterDisplayName(master),
        dosageForm: resolvedDosageForm,
        strength: master.strength ?? null,
        activeIngredients: master.activeIngredient ?? null,
        marketer: null,
        storageInstructions: null,
        masterDbId: master.medicineId,
      } as CabinetItem
      runPostAddInteractionChecks(newIid, cabinetIdLocal, newItem, otherItems)

      // Collapse the mini-form, clear the search surface, flash the success.
      cancelInlineAdd()
      setMedicineSearchQuery('')
      setMasterSearchResults([])
      setInlineAddSuccess(`${masterDisplayName(master)} added to your cabinet`)
    } catch {
      setInlineAddError('Could not add medicine. Please try again.')
    } finally {
      setInlineAddLoading(false)
    }
  }

  const stepNum = view === 'step1' ? 1 : view === 'step2' ? 2 : view === 'step3' ? 3 : 4
  const stepTitle =
    view === 'step1' ? 'Treatment details' :
    view === 'step2' ? 'Medicine & dose'   :
    view === 'step3' ? 'Schedule'          :
    'Confirm treatment'

  // ── List view ───────────────────────────────────────────────
  // AK-138 — Edit reuses the list-view shell so the detail sheet beneath the
  // edit overlay stays mounted; setView('edit') flips the visible sheet
  // without unmounting list state.
  if (view === 'list' || view === 'edit') {
    const today = todayISTString()
    const visibleTreatments = filterByPatientUid
      ? treatments.filter(t => t.memberId === filterByPatientUid)
      : treatments

    // OOS detection: cabinet items are "blocked" when out of stock or expired.
    // We track which OOS medicine name is the offending one so the warning
    // badge can be specific ("Out of stock — Crocin 650").
    const itemsById = new Map<string, CabinetItem>()
    for (const item of cabinetItems) itemsById.set(item.iId, item)
    function blockedMedicineFor(tId: string): string | null {
      const regs = regimensByTId[tId] ?? []
      for (const r of regs) {
        const item = itemsById.get(r.cabinetItemId)
        if (!item) continue
        const isOOS = item.quantityOnHand === 0
        const isExpired = item.expiryDate != null && item.expiryDate < today
        if (isOOS || isExpired) {
          return item.displayNameOverride ?? item.brandName ?? r.displayName
        }
      }
      return null
    }

    const needsAttention: Array<{ t: Treatment; blockedName: string }> = []
    const active: Treatment[] = []
    const paused: Treatment[] = []
    const past: Treatment[] = []
    for (const t of visibleTreatments) {
      if (t.status === 'completed') { past.push(t); continue }
      if (t.status === 'paused')    { paused.push(t); continue }
      // status === 'active'
      const blocked = blockedMedicineFor(t.tId)
      if (blocked) needsAttention.push({ t, blockedName: blocked })
      else active.push(t)
    }
    // Newest-completed first.
    past.sort((a, b) => {
      const am = a.endDate?.toMillis() ?? 0
      const bm = b.endDate?.toMillis() ?? 0
      return bm - am
    })

    function fmtDateTimestamp(ts: { toDate: () => Date }): string {
      return ts.toDate().toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
    }

    function renderTreatmentCard(t: Treatment, attention: { blockedName: string } | null) {
      const badge = STATUS_BADGE[t.status]
      const adherence = adherenceByTId[t.tId]
      const endDate   = endDateByTId[t.tId]
      let daysRemaining: number | null = null
      if (t.category === 'acute' && endDate) {
        const todayMs = new Date(today + 'T00:00:00').getTime()
        const endMs   = new Date(endDate + 'T00:00:00').getTime()
        daysRemaining = Math.max(0, Math.ceil((endMs - todayMs) / 86400000))
      }
      const cardCls = attention
        ? 'db-card tr-treatment-card tr-treatment-card--attention cb-item-card--tappable'
        : 'db-card tr-treatment-card cb-item-card--tappable'
      return (
        <li
          key={t.tId}
          className={cardCls}
          onClick={() => setSelectedTreatmentId(t.tId)}
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setSelectedTreatmentId(t.tId) }}
        >
          {attention && (
            <div className="tr-attention-badge">
              <AlertTriangle size={12} />
              <span>Out of stock — {attention.blockedName}</span>
            </div>
          )}
          <div className="cb-item-top">
            <span className="cb-item-name">{t.name}</span>
            <span className={`cb-badge ${badge.cls}`}>{badge.label}</span>
          </div>
          <p className="tr-treatment-meta">
            {t.memberName ?? 'Unknown member'} · {CATEGORY_LABELS[t.category]}
          </p>
          {t.scheduleSummary && (
            <p className="tr-treatment-schedule">{t.scheduleSummary}</p>
          )}
          <div className="tr-adherence">
            <div className="tr-adherence-row">
              <span className="tr-adherence-label">Adherence this week</span>
              <span className="tr-adherence-value">
                {adherence === null || adherence === undefined ? '—' : `${adherence}%`}
              </span>
            </div>
            <div className="tr-adherence-bar" role="progressbar"
              aria-valuenow={adherence ?? 0} aria-valuemin={0} aria-valuemax={100}>
              <div
                className="tr-adherence-fill"
                style={{ width: `${adherence ?? 0}%` }}
              />
            </div>
          </div>
          {daysRemaining !== null && (
            <p className="tr-days-remaining">
              <Clock size={12} />
              <span>{daysRemaining} day{daysRemaining === 1 ? '' : 's'} remaining</span>
            </p>
          )}

          {t.status === 'completed' && t.endDate && (
            <p className="tr-ended-text">
              Ended {fmtDateTimestamp(t.endDate)}
            </p>
          )}

          {!readOnly && t.status !== 'completed' && (
            // Action row. stopPropagation so taps don't bubble to the card-
            // level click that opens the detail bottom sheet.
            <div className="tr-actions" onClick={e => e.stopPropagation()}>
              {t.status === 'active' && (
                <>
                  <button
                    type="button"
                    className="tr-action-btn tr-action-btn--pause"
                    onClick={() => setPauseConfirm(t)}
                  >
                    <Pause size={12} /> Pause
                  </button>
                  {(t.category === 'chronic' || t.category === 'preventive') && (
                    <button
                      type="button"
                      className="tr-action-btn tr-action-btn--end"
                      onClick={() => setEndConfirm(t)}
                    >
                      <StopCircle size={12} /> End
                    </button>
                  )}
                  {(t.category === 'acute' || t.category === 'prn') && (
                    <button
                      type="button"
                      className="tr-action-btn tr-action-btn--delete"
                      onClick={() => setDeleteConfirm(t)}
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  )}
                </>
              )}
              {t.status === 'paused' && (
                <button
                  type="button"
                  className="tr-action-btn tr-action-btn--resume"
                  onClick={() => handleResume(t)}
                  disabled={actionPending}
                >
                  <Play size={12} /> Resume
                </button>
              )}
            </div>
          )}
        </li>
      )
    }

    return (
      <div className="cb-view">
        <div className="cb-list-header">
          <h2 className="cb-page-title">{readOnly ? 'My Treatments' : 'Treatments'}</h2>
          {!readOnly && (
            <button className="cb-add-btn" onClick={startAdd}>
              <Plus size={16} />
              <span>Add treatment</span>
            </button>
          )}
        </div>

        {/* AK-138 — Post-save "Saved." flash. Mirrors the AK-132 affirmation
            styling so the visual language stays consistent. Auto-clears via
            the effect above. */}
        {editSavedMessage && (
          <p
            className="tr-confirm-message"
            role="status"
            style={{ textAlign: 'center', margin: '4px 0 8px' }}
          >
            {editSavedMessage}
          </p>
        )}

        {loadingList && (
          <div className="cb-loader"><div className="cb-spinner" role="status" aria-label="Loading" /></div>
        )}

        {!loadingList && visibleTreatments.length === 0 && (
          <div className="db-card db-empty-state">
            <div className="empty-state-icon">
              <CalendarHeart size={28} color="#5DC1C8" />
            </div>
            <p className="db-empty-text">No treatments yet</p>
            {!readOnly && (
              <p className="db-empty-sub">
                Schedule a medicine and MediCab will remind you — and your family — every day.
              </p>
            )}
          </div>
        )}

        {!loadingList && needsAttention.length > 0 && (
          <>
            <h3 className="tr-section-title tr-section-title--attention">Needs attention</h3>
            <ul className="cb-item-list">
              {needsAttention.map(({ t, blockedName }) =>
                renderTreatmentCard(t, { blockedName }))}
            </ul>
          </>
        )}

        {!loadingList && active.length > 0 && (
          <>
            {needsAttention.length > 0 && (
              <h3 className="tr-section-title">Active treatments</h3>
            )}
            <ul className="cb-item-list">
              {active.map(t => renderTreatmentCard(t, null))}
            </ul>
          </>
        )}

        {!loadingList && paused.length > 0 && (
          <>
            <h3 className="tr-section-title">Paused</h3>
            <ul className="cb-item-list tr-paused-list">
              {paused.map(t => renderTreatmentCard(t, null))}
            </ul>
          </>
        )}

        {!loadingList && past.length > 0 && (
          <>
            <button
              type="button"
              className="tr-section-toggle"
              onClick={() => setPastExpanded(x => !x)}
              aria-expanded={pastExpanded}
            >
              <span className="tr-section-title">Past treatments ({past.length})</span>
              <ChevronDown
                size={18}
                className={`tr-chev${pastExpanded ? ' tr-chev--open' : ''}`}
                aria-hidden="true"
              />
            </button>
            {pastExpanded && (
              <ul className="cb-item-list tr-past-list">
                {past.map(t => renderTreatmentCard(t, null))}
              </ul>
            )}
          </>
        )}

        {/* ── Treatment detail bottom sheet (Fix 3) ───────────────── */}
        {/* AK-138 — Suppress the detail sheet when the edit sheet is open so
            both don't stack. selectedTreatmentId stays set during edit so
            the detail sheet reappears underneath on Cancel / Save. */}
        {view !== 'edit' && (() => {
          const t = selectedTreatmentId
            ? treatments.find(x => x.tId === selectedTreatmentId)
            : null
          if (!t) return null
          const regs = regimensByTId[t.tId] ?? []
          const adherence = adherenceByTId[t.tId]
          const endDate   = endDateByTId[t.tId]
          // Earliest start across regimens.
          let earliestStart: string | null = null
          for (const r of regs) {
            if (!earliestStart || r.startDate < earliestStart) earliestStart = r.startDate
          }
          let daysRemaining: number | null = null
          if (t.category === 'acute' && endDate) {
            const today = new Date(todayISTString() + 'T00:00:00').getTime()
            const end   = new Date(endDate + 'T00:00:00').getTime()
            daysRemaining = Math.max(0, Math.ceil((end - today) / 86400000))
          }
          return (
            <div
              className="bs-overlay"
              onClick={() => setSelectedTreatmentId(null)}
              role="dialog"
              aria-modal="true"
              aria-labelledby="tr-bs-title"
            >
              <div className="bs-sheet" onClick={e => e.stopPropagation()}>
                <span className="bs-handle" aria-hidden="true" />
                <h2 id="tr-bs-title" className="bs-title">{t.name}</h2>
                <p className="bs-meta-line">
                  {t.memberName ?? 'Unknown member'}
                  {' · '}
                  <span className={`md-cat-badge md-cat-badge--${t.category}`}>
                    {CATEGORY_LABELS[t.category]}
                  </span>
                </p>

                {(earliestStart || endDate) && (
                  <ul className="bs-meta">
                    {earliestStart && (
                      <li><span className="bs-meta-label">Start</span><span>{fmtDate(earliestStart)}</span></li>
                    )}
                    {endDate && (
                      <li><span className="bs-meta-label">End</span><span>{fmtDate(endDate)}</span></li>
                    )}
                  </ul>
                )}

                <section className="bs-section">
                  <h3 className="bs-section-title">Medicines in this treatment</h3>
                  {regs.length === 0 ? (
                    <p className="bs-empty">No regimens yet</p>
                  ) : (
                    <ul className="bs-treatment-list">
                      {regs.map(r => {
                        const food = r.slots[0]?.foodTiming
                        const foodLbl = food ? FOOD_LABELS[food] : ''
                        const sched = summarize(r.scheduleType, r.scheduleDays ?? [], r.slots)
                        return (
                          <li key={r.rId} className="bs-treatment-row">
                            <span className="bs-treatment-medicine">{r.displayName}</span>
                            <span className="bs-treatment-detail">
                              {r.doseAmount} {r.doseUnit}{r.doseAmount !== 1 && r.doseUnit !== 'ml' ? 's' : ''}
                              {' · '}{sched}
                              {foodLbl && <> · {foodLbl}</>}
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  )}
                </section>

                <section className="bs-section">
                  <h3 className="bs-section-title">Adherence — last 7 days</h3>
                  <div className="tr-adherence">
                    <div className="tr-adherence-row">
                      <span className="tr-adherence-label">Adherence this week</span>
                      <span className="tr-adherence-value">
                        {adherence === null || adherence === undefined ? '—' : `${adherence}%`}
                      </span>
                    </div>
                    <div className="tr-adherence-bar" role="progressbar"
                      aria-valuenow={adherence ?? 0} aria-valuemin={0} aria-valuemax={100}>
                      <div
                        className="tr-adherence-fill"
                        style={{ width: `${adherence ?? 0}%` }}
                      />
                    </div>
                  </div>
                  {daysRemaining !== null && (
                    <p className="tr-days-remaining">
                      <Clock size={12} />
                      <span>{daysRemaining} day{daysRemaining === 1 ? '' : 's'} remaining</span>
                    </p>
                  )}
                </section>

                <div className="bs-actions">
                  {!readOnly && (
                    <button
                      type="button"
                      className="bs-btn bs-btn--secondary"
                      onClick={() => openEditSheet(t)}
                      disabled={regs.length === 0}
                    >
                      Edit
                    </button>
                  )}
                  <button
                    type="button"
                    className="bs-btn bs-btn--primary"
                    onClick={() => setSelectedTreatmentId(null)}
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          )
        })()}

        {/* AK-138 — Edit sheet. Same overlay/sheet pattern as the detail
            sheet so the visual language stays consistent; opens via the
            Edit button in the detail-sheet action row. */}
        {view === 'edit' && editingTId && (() => {
          const t = treatments.find(x => x.tId === editingTId)
          if (!t) return null
          const regs = regimensByTId[t.tId] ?? []
          const selectedReg = regs.find(r => r.rId === editRegimenId)
          const isMultiReg = regs.length > 1

          // Dirty check — Save only enables when something actually changed.
          const trimmedName = editName.trim()
          const hasChanges = editOriginal != null && (
            trimmedName !== editOriginal.name ||
            editDoseAmount !== editOriginal.doseAmount ||
            editEndDate !== editOriginal.endDate ||
            editOngoing !== editOriginal.ongoing
          )

          // Past-date informational warning. The validator allows the save;
          // the warning just nudges the admin in case they typo'd.
          const todayIST = todayISTString()
          const showPastDateWarning =
            !editOngoing
            && editEndDate !== ''
            && editEndDate < todayIST
            && t.status === 'active'

          return (
            <div
              className="bs-overlay"
              onClick={editSaving ? undefined : cancelEdit}
              role="dialog"
              aria-modal="true"
              aria-labelledby="tr-edit-title"
            >
              <div className="bs-sheet" onClick={e => e.stopPropagation()}>
                <span className="bs-handle" aria-hidden="true" />
                <h2 id="tr-edit-title" className="bs-title">Edit treatment</h2>
                <p className="bs-meta-line">
                  {t.memberName ?? 'Unknown member'}
                  {' · '}
                  <span className={`md-cat-badge md-cat-badge--${t.category}`}>
                    {CATEGORY_LABELS[t.category]}
                  </span>
                </p>

                <div className="cb-form" style={{ marginTop: 12 }}>
                  <div className="cb-field">
                    <label className="cb-label" htmlFor="tr-edit-name">Treatment name</label>
                    <input
                      id="tr-edit-name"
                      className="cb-input"
                      type="text"
                      value={editName}
                      onChange={e => setEditName(e.target.value)}
                      maxLength={80}
                    />
                  </div>

                  {isMultiReg && (
                    <div className="cb-field">
                      <label className="cb-label" htmlFor="tr-edit-regimen">Which medicine?</label>
                      <select
                        id="tr-edit-regimen"
                        className="cb-input cb-select"
                        value={editRegimenId}
                        onChange={e => switchEditRegimen(e.target.value)}
                      >
                        {regs.map(r => (
                          <option key={r.rId} value={r.rId}>{r.displayName}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {selectedReg && (
                    <>
                      <div className="cb-field">
                        <label className="cb-label" htmlFor="tr-edit-dose">
                          Dose amount ({selectedReg.doseUnit}
                          {selectedReg.doseUnit !== 'ml' && parseFloat(editDoseAmount) !== 1 ? 's' : ''})
                        </label>
                        <input
                          id="tr-edit-dose"
                          className="cb-input"
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.5"
                          value={editDoseAmount}
                          onChange={e => setEditDoseAmount(e.target.value)}
                        />
                      </div>

                      <div className="cb-field">
                        <label className="cb-label">Duration</label>
                        <label className="cb-checkbox-row" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <input
                            type="checkbox"
                            checked={editOngoing}
                            onChange={e => {
                              const next = e.target.checked
                              setEditOngoing(next)
                              if (next) setEditEndDate('')
                            }}
                          />
                          <span>Ongoing (no end date)</span>
                        </label>
                      </div>

                      {!editOngoing && (
                        <div className="cb-field">
                          <label className="cb-label" htmlFor="tr-edit-end">End date</label>
                          <input
                            id="tr-edit-end"
                            className="cb-input"
                            type="date"
                            min={selectedReg.startDate}
                            value={editEndDate}
                            onChange={e => setEditEndDate(e.target.value)}
                          />
                          {showPastDateWarning && (
                            <p
                              className="cb-hint"
                              role="status"
                              style={{ color: '#B45309', marginTop: 4 }}
                            >
                              That date has already passed — the treatment will
                              be marked completed once you save.
                            </p>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {editError && (
                    <p className="cb-form-error" role="alert">{editError}</p>
                  )}
                </div>

                <div className="bs-actions">
                  <button
                    type="button"
                    className="bs-btn bs-btn--secondary"
                    onClick={cancelEdit}
                    disabled={editSaving}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="bs-btn bs-btn--primary"
                    onClick={handleEditSave}
                    disabled={!hasChanges || editSaving}
                  >
                    {editSaving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          )
        })()}

        {/* ── Pause confirmation ───────────────────────────────────── */}
        {pauseConfirm && (
          <div
            className="tr-modal-backdrop"
            onClick={actionPending ? undefined : () => setPauseConfirm(null)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="tr-pause-modal-title"
          >
            <div className="tr-modal" onClick={e => e.stopPropagation()}>
              <h3 id="tr-pause-modal-title" className="tr-modal-title">Pause {pauseConfirm.name}?</h3>
              <p className="tr-modal-subtitle">
                No doses will be scheduled while paused.
              </p>
              <div className="tr-modal-actions">
                <button
                  type="button"
                  className="tr-modal-btn tr-modal-btn--secondary"
                  onClick={() => setPauseConfirm(null)}
                  disabled={actionPending}
                >Cancel</button>
                <button
                  type="button"
                  className="tr-modal-btn tr-modal-btn--primary"
                  onClick={() => handlePause(pauseConfirm)}
                  disabled={actionPending}
                >
                  {actionPending ? 'Pausing…' : 'Pause'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── End confirmation ─────────────────────────────────────── */}
        {endConfirm && (
          <div
            className="tr-modal-backdrop"
            onClick={actionPending ? undefined : () => setEndConfirm(null)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="tr-end-modal-title"
          >
            <div className="tr-modal" onClick={e => e.stopPropagation()}>
              <h3 id="tr-end-modal-title" className="tr-modal-title">End {endConfirm.name}?</h3>
              <p className="tr-modal-subtitle">
                Dose history will be preserved.
              </p>
              <div className="tr-modal-actions">
                <button
                  type="button"
                  className="tr-modal-btn tr-modal-btn--secondary"
                  onClick={() => setEndConfirm(null)}
                  disabled={actionPending}
                >Cancel</button>
                <button
                  type="button"
                  className="tr-modal-btn tr-modal-btn--primary"
                  onClick={() => handleEnd(endConfirm)}
                  disabled={actionPending}
                >
                  {actionPending ? 'Ending…' : 'End treatment'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Delete confirmation (type-to-confirm) ────────────────── */}
        {deleteConfirm && (() => {
          const matches = deleteConfirmText.trim() === deleteConfirm.name
          return (
            <div
              className="tr-modal-backdrop"
              onClick={actionPending ? undefined : () => {
                setDeleteConfirm(null)
                setDeleteConfirmText('')
              }}
              role="dialog"
              aria-modal="true"
              aria-labelledby="tr-delete-modal-title"
            >
              <div className="tr-modal" onClick={e => e.stopPropagation()}>
                <h3 id="tr-delete-modal-title" className="tr-modal-title">
                  Delete {deleteConfirm.name}?
                </h3>
                <p className="tr-modal-subtitle">
                  This permanently removes the treatment and all its dose
                  logs. Type the treatment name to confirm:
                </p>
                <input
                  className="cb-input"
                  type="text"
                  placeholder={deleteConfirm.name}
                  value={deleteConfirmText}
                  onChange={e => setDeleteConfirmText(e.target.value)}
                  autoFocus
                />
                <div className="tr-modal-actions">
                  <button
                    type="button"
                    className="tr-modal-btn tr-modal-btn--secondary"
                    onClick={() => {
                      setDeleteConfirm(null)
                      setDeleteConfirmText('')
                    }}
                    disabled={actionPending}
                  >Cancel</button>
                  <button
                    type="button"
                    className="tr-modal-btn tr-modal-btn--primary tr-modal-btn--danger"
                    onClick={() => handleDelete(deleteConfirm)}
                    disabled={!matches || actionPending}
                  >
                    {actionPending ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </div>
            </div>
          )
        })()}
      </div>
    )
  }

  // ── Wizard views ────────────────────────────────────────────
  return (
    <div className="cb-view">

      {/* Step header — single row with Cancel pinned to the top right.
          Progress dots moved to a dedicated row below so Cancel can claim
          the "TOP RIGHT corner" slot the spec calls for (Fix 4). */}
      <div className="tr-step-header">
        <button className="cb-back-btn" onClick={goBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <div className="tr-step-titles">
          <p className="tr-step-eyebrow">Step {stepNum} of 4</p>
          <h2 className="tr-step-title">{stepTitle}</h2>
        </div>
        <button
          type="button"
          className="tr-cancel-link"
          onClick={() => setShowCancelConfirm(true)}
        >
          Cancel
        </button>
      </div>
      <div className="tr-step-progress">
        <div className="tr-dots" aria-hidden="true">
          {[1, 2, 3, 4].map(n => (
            <span
              key={n}
              className={`tr-dot${n === stepNum ? ' tr-dot--active' : n < stepNum ? ' tr-dot--done' : ''}`}
            />
          ))}
        </div>
      </div>

      {/* Step 1 */}
      {view === 'step1' && (
        <div className="cb-form">
          <div className="cb-field">
            <label className="cb-label" htmlFor="tr-name">Treatment name</label>
            <input
              id="tr-name"
              className="cb-input"
              type="text"
              placeholder="e.g. Rajan's Diabetes Meds"
              value={formName}
              onChange={e => setFormName(e.target.value)}
              autoFocus
            />
          </div>

          <div className="cb-field">
            <span className="cb-label">For which member?</span>
            {members.length === 0 ? (
              <p className="cb-hint">No members found.</p>
            ) : (
              <div className="tr-member-list">
                {members.map(m => {
                  const active = formMemberId === m.uid
                  return (
                    <button
                      key={m.uid}
                      type="button"
                      className={`tr-member-opt${active ? ' tr-member-opt--active' : ''}`}
                      onClick={() => { setFormMemberId(m.uid); setFormMemberName(m.displayName) }}
                    >
                      <span className="tr-member-avatar" aria-hidden="true">
                        {(m.displayName ?? 'M').charAt(0).toUpperCase()}
                      </span>
                      <span className="tr-member-name">{m.displayName ?? 'Unknown Member'}</span>
                      {active && <span className="tr-member-check" aria-hidden="true">✓</span>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="cb-field">
            <span className="cb-label">Category</span>
            <div className="tr-category-grid">
              {(Object.keys(CATEGORY_LABELS) as TreatmentCategory[]).map(cat => {
                const active = formCategory === cat
                return (
                  <button
                    key={cat}
                    type="button"
                    className={`tr-category-btn${active ? ' tr-category-btn--active' : ''}`}
                    onClick={() => setFormCategory(cat)}
                  >
                    <span className="tr-category-name">{CATEGORY_LABELS[cat]}</span>
                    <span className="tr-category-sub">{CATEGORY_SUB[cat]}</span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* Step 2 */}
      {view === 'step2' && (
        <div className="cb-form">
          <div className="cb-field">
            <label className="cb-label" htmlFor="tr-medicine-search">Medicine</label>
            {(() => {
              // AK-120 — filter expired items out of the picker. YYYY-MM-DD
              // strings compare lexicographically, so a string >= comparison
              // gives the same answer as Date >= Date without allocating Dates.
              // Items with no expiryDate stay (long-shelf-life staples or
              // user-omitted dates).
              const todayIST = todayISTString()
              const availableItems = cabinetItems.filter(
                item => !item.expiryDate || item.expiryDate >= todayIST,
              )
              if (cabinetError) {
                return <p className="cb-hint cb-hint--error" role="alert">{cabinetError}</p>
              }

              // AK-133 — Mini-form takes over the picker surface while the
              // user is filling in qty / expiry / Rx for a masterDb pick.
              if (inlineAddMaster) {
                const master = inlineAddMaster
                const dosageFormResolved = dosageFormFromMaster(master)
                const unitResolved = unitFromMaster(master)
                const canSave =
                  !!cId
                  && !inlineAddLoading
                  && !!inlineAddQty
                  && !isNaN(parseInt(inlineAddQty, 10))
                  && parseInt(inlineAddQty, 10) >= 0
                  && !!inlineAddExpiry
                return (
                  <div className="cb-form" style={{ gap: 12 }}>
                    <p className="cb-hint">
                      Add <strong>{masterDisplayName(master)}</strong> to your cabinet
                    </p>
                    <div className="cb-field">
                      <span className="cb-label">Medicine</span>
                      <span
                        className="cb-input cb-input--readonly"
                        aria-label={`Medicine: ${masterDisplayName(master)}`}
                      >
                        {masterDisplayName(master)}
                      </span>
                    </div>
                    <div className="cb-field-row">
                      <div className="cb-field">
                        <span className="cb-label">Dosage form</span>
                        <span
                          className="cb-input cb-input--readonly"
                          aria-label={`Dosage form: ${DOSAGE_FORM_LABELS[dosageFormResolved]}`}
                        >
                          {DOSAGE_FORM_LABELS[dosageFormResolved]}
                        </span>
                      </div>
                      <div className="cb-field">
                        <span className="cb-label">Strength</span>
                        <span
                          className="cb-input cb-input--readonly"
                          aria-label={`Strength: ${master.strength ?? 'not specified'}`}
                        >
                          {master.strength ?? '—'}
                        </span>
                      </div>
                    </div>
                    <div className="cb-field-row">
                      <div className="cb-field">
                        <label className="cb-label" htmlFor="tr-inline-qty">Quantity</label>
                        <input
                          id="tr-inline-qty"
                          className="cb-input"
                          type="number"
                          inputMode="numeric"
                          min="0"
                          placeholder="30"
                          value={inlineAddQty}
                          onChange={e => setInlineAddQty(e.target.value)}
                          autoFocus
                        />
                      </div>
                      <div className="cb-field">
                        <span className="cb-label">Unit</span>
                        <span
                          className="cb-input cb-input--readonly"
                          aria-label={`Unit: ${unitPillLabel(unitResolved)}`}
                        >
                          {unitPillLabel(unitResolved)}
                        </span>
                      </div>
                    </div>
                    <div className="cb-field">
                      <label className="cb-label" htmlFor="tr-inline-expiry">Expiry date</label>
                      <input
                        id="tr-inline-expiry"
                        className="cb-input"
                        type="date"
                        min={todayIST}
                        value={inlineAddExpiry}
                        onChange={e => setInlineAddExpiry(e.target.value)}
                      />
                    </div>
                    <div className="cb-field">
                      <label className="cb-label" htmlFor="tr-inline-prescribed">
                        Prescription type
                      </label>
                      <select
                        id="tr-inline-prescribed"
                        className="cb-input cb-select"
                        value={inlineAddPrescribed ? 'rx' : 'otc'}
                        onChange={e => setInlineAddPrescribed(e.target.value === 'rx')}
                      >
                        <option value="otc">Over the counter (OTC)</option>
                        <option value="rx">Prescription (Rx)</option>
                      </select>
                    </div>
                    {inlineAddError && (
                      <p className="cb-form-error" role="alert">{inlineAddError}</p>
                    )}
                    <div className="cb-field-row">
                      <button
                        type="button"
                        className="cb-submit-btn"
                        onClick={handleInlineAdd}
                        disabled={!canSave}
                      >
                        {inlineAddLoading ? 'Adding…' : 'Add to cabinet'}
                      </button>
                      <button
                        type="button"
                        className="cb-cancel-btn"
                        onClick={cancelInlineAdd}
                        disabled={inlineAddLoading}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )
              }

              // A medicine is already selected — show a compact "Selected"
              // chip with a Change affordance instead of the search results,
              // so the user can confirm what they picked and back out if
              // needed without scrolling through results.
              if (formCabinetItemId) {
                const selected = cabinetItems.find(i => i.iId === formCabinetItemId)
                const name = selected
                  ? (selected.displayNameOverride ?? selected.brandName ?? selected.medicineId)
                  : formDisplayName || 'Selected medicine'
                const qtyLabel = selected
                  ? `${selected.quantityOnHand} ${selected.unit === 'ml' ? 'ml' : selected.unit + 's'}`
                  : ''
                return (
                  <>
                    <div className="cb-field-row" style={{ alignItems: 'center' }}>
                      <span
                        className="cb-input cb-input--readonly"
                        style={{ flex: 1 }}
                        aria-label={`Selected medicine: ${name}`}
                      >
                        {name}{qtyLabel ? ` (${qtyLabel})` : ''}
                      </span>
                      <button
                        type="button"
                        className="cb-link-btn"
                        onClick={() => {
                          selectCabinetItem('')
                          setMedicineSearchQuery('')
                          setMasterSearchResults([])
                        }}
                      >
                        Change
                      </button>
                    </div>
                    {inlineAddSuccess && (
                      <p className="cb-hint" role="status">{inlineAddSuccess}</p>
                    )}
                  </>
                )
              }

              const queryTrimmed = medicineSearchQuery.trim()
              const queryLower = queryTrimmed.toLowerCase()
              const cabinetMatches = queryLower
                ? availableItems.filter(item => {
                    const candidates = [
                      item.displayNameOverride,
                      item.brandName,
                      item.medicineId,
                      item.activeIngredients,
                    ].filter((v): v is string => !!v)
                    return candidates.some(s => s.toLowerCase().includes(queryLower))
                  })
                : availableItems
              const cabinetMedicineIds = new Set(
                cabinetItems.map(i => i.masterDbId ?? i.medicineId),
              )
              const masterMatches = masterSearchResults.filter(
                m => !cabinetMedicineIds.has(m.medicineId),
              )

              return (
                <>
                  <input
                    id="tr-medicine-search"
                    className="cb-input"
                    type="search"
                    placeholder={
                      cabinetItems.length === 0
                        ? 'Search for a medicine to add it to your cabinet'
                        : 'Search your cabinet or add a new medicine'
                    }
                    value={medicineSearchQuery}
                    onChange={e => setMedicineSearchQuery(e.target.value)}
                    autoComplete="off"
                  />

                  {cabinetItems.length === 0 && !queryTrimmed && (
                    <p className="cb-hint">
                      Search for a medicine to add it to your cabinet.
                    </p>
                  )}

                  {cabinetItems.length > 0 && availableItems.length === 0 && (
                    <p className="cb-hint cb-hint--error" role="alert">
                      All your medicines have expired. Search above to add a fresh batch.
                    </p>
                  )}

                  {cabinetMatches.length > 0 && (
                    <>
                      <p className="cb-label" style={{ marginTop: 8 }}>In your cabinet</p>
                      <ul className="cb-result-list" role="listbox" aria-label="Cabinet medicines">
                        {cabinetMatches.map(item => {
                          const name = item.displayNameOverride ?? item.brandName ?? item.medicineId
                          const unit = item.unit === 'ml' ? 'ml' : `${item.unit}s`
                          return (
                            <li key={item.iId}>
                              <button
                                type="button"
                                className="cb-result-btn"
                                onClick={() => selectCabinetItemFromSearch(item.iId)}
                                role="option"
                                aria-selected={false}
                              >
                                <span className="cb-result-name">{name}</span>
                                <span className="cb-result-ingredient">
                                  {item.quantityOnHand} {unit}
                                  {item.strength ? ` · ${item.strength}` : ''}
                                </span>
                              </button>
                            </li>
                          )
                        })}
                      </ul>
                    </>
                  )}

                  {queryTrimmed && masterSearchLoading && (
                    <p className="cb-hint">Searching…</p>
                  )}

                  {queryTrimmed && !masterSearchLoading && masterMatches.length > 0 && (
                    <>
                      <p className="cb-label" style={{ marginTop: 8 }}>Add to cabinet</p>
                      <ul className="cb-result-list" role="listbox" aria-label="Catalog matches">
                        {masterMatches.map(m => (
                          <li key={m.medicineId}>
                            <button
                              type="button"
                              className="cb-result-btn"
                              onClick={() => openInlineAddFor(m)}
                              role="option"
                              aria-selected={false}
                            >
                              <span className="cb-result-name">{masterDisplayName(m)}</span>
                              {(m.strength || m.activeIngredient) && (
                                <span className="cb-result-ingredient">
                                  {[m.strength, m.activeIngredient].filter(Boolean).join(' · ')}
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}

                  {queryTrimmed
                    && !masterSearchLoading
                    && cabinetMatches.length === 0
                    && masterMatches.length === 0 && (
                    <p className="cb-hint">No matches for "{queryTrimmed}".</p>
                  )}

                  {inlineAddSuccess && (
                    <p className="cb-hint" role="status">{inlineAddSuccess}</p>
                  )}
                </>
              )
            })()}
          </div>

          <div className="cb-field-row">
            <div className="cb-field">
              <label className="cb-label" htmlFor="tr-dose-amt">Dose amount</label>
              <input
                id="tr-dose-amt"
                className="cb-input"
                type="number"
                inputMode="decimal"
                min="0"
                step="0.5"
                placeholder="1"
                value={formDoseAmount}
                onChange={e => setFormDoseAmount(e.target.value)}
              />
            </div>
            <div className="cb-field">
              <span className="cb-label">Unit</span>
              {/* AK-129 — Read-only; the unit is inherited from the chosen
                  cabinet item (selectCabinetItem populates formDoseUnit) and
                  must not diverge from how the medicine is stored. */}
              <span
                className="cb-input cb-input--readonly"
                aria-label={`Dose unit: ${unitPillLabel(formDoseUnit)}`}
              >
                {unitPillLabel(formDoseUnit)}
              </span>
            </div>
          </div>

          <div className="cb-field">
            <label className="cb-label" htmlFor="tr-display-name">
              What does {formMemberName ?? 'this member'} call this medicine?
            </label>
            <input
              id="tr-display-name"
              className="cb-input"
              type="text"
              placeholder="e.g. Sugar pill"
              value={formDisplayName}
              onChange={e => setFormDisplayName(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* Step 3 */}
      {view === 'step3' && (
        <div className="cb-form">
          <div className="cb-field">
            <span className="cb-label">How often?</span>
            <div className="tr-schedule-tabs" role="tablist">
              {(Object.keys(SCHEDULE_LABELS) as ScheduleType[]).map(type => (
                <button
                  key={type}
                  type="button"
                  role="tab"
                  aria-selected={formScheduleType === type}
                  className={`tr-schedule-tab${formScheduleType === type ? ' tr-schedule-tab--active' : ''}`}
                  onClick={() => setFormScheduleType(type)}
                >
                  {SCHEDULE_LABELS[type]}
                </button>
              ))}
            </div>
          </div>

          {formScheduleType === 'specific-days' && (
            <div className="cb-field">
              <span className="cb-label">Which days?</span>
              <div className="tr-day-grid">
                {DAY_LABELS.map((label, dow) => {
                  const active = formScheduleDays.includes(dow)
                  return (
                    <button
                      key={dow}
                      type="button"
                      className={`tr-day-btn${active ? ' tr-day-btn--active' : ''}`}
                      onClick={() => toggleDay(dow)}
                      aria-pressed={active}
                      aria-label={DAY_NAMES[dow]}
                    >
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {formScheduleType === 'as-needed' && (
            <div className="cb-field">
              <label className="cb-label" htmlFor="tr-max-doses">Maximum doses per day</label>
              <input
                id="tr-max-doses"
                type="number"
                inputMode="numeric"
                min={1}
                max={10}
                className="cb-input"
                value={formMaxDosesPerDay}
                onChange={e => {
                  const n = parseInt(e.target.value, 10)
                  if (!isNaN(n)) setFormMaxDosesPerDay(Math.max(1, Math.min(10, n)))
                }}
              />
              <p className="cb-hint" style={{ marginTop: 4 }}>
                How many times can this medicine be taken in one day?
              </p>
            </div>
          )}

          {formScheduleType === 'flexible-daily' && (
            <div className="cb-field">
              <p className="cb-hint">
                A reminder will go out at 9 AM each day. Log the dose any time before
                the day ends.
              </p>
            </div>
          )}

          {formScheduleType !== 'as-needed' && formScheduleType !== 'flexible-daily' && (
            <div className="cb-field">
              <span className="cb-label">Dose times</span>
              <div className="tr-slot-list">
                {formSlots.map((slot, i) => (
                  <div key={i}>
                    <div className="tr-slot-row">
                      <input
                        type="time"
                        className="cb-input tr-slot-time"
                        value={slot.time}
                        onChange={e => setSlotTime(i, e.target.value)}
                        aria-invalid={slotErrors[i] !== undefined}
                      />
                      <select
                        className="cb-input cb-select tr-slot-food"
                        value={slot.foodTiming}
                        onChange={e => setSlotFood(i, e.target.value as FoodTiming)}
                      >
                        <option value="before">Before food</option>
                        <option value="after">After food</option>
                        <option value="with">With food</option>
                      </select>
                      {formSlots.length > 1 && (
                        <button
                          type="button"
                          className="tr-slot-remove"
                          onClick={() => removeSlot(i)}
                          aria-label="Remove time"
                        >
                          <X size={16} />
                        </button>
                      )}
                    </div>
                    {slotErrors[i] && (
                      <p
                        className="cb-hint cb-hint--error"
                        role="alert"
                        style={{ marginTop: 4 }}
                      >
                        {slotErrors[i]}
                      </p>
                    )}
                  </div>
                ))}
              </div>
              <button
                type="button"
                className="cb-link-btn"
                onClick={addSlot}
                style={{ marginTop: 8 }}
                disabled={formSlots.length >= MAX_SLOTS_PER_DAY}
                title={formSlots.length >= MAX_SLOTS_PER_DAY ? 'Maximum 4 doses per day.' : undefined}
              >
                {formSlots.length >= MAX_SLOTS_PER_DAY ? 'Maximum 4 doses per day' : '+ Add another time'}
              </button>
            </div>
          )}

          <div className="cb-field">
            <span className="cb-label">Duration</span>
            <div className="cb-toggle-row">
              <button
                type="button"
                role="switch"
                aria-checked={formOngoing}
                className={`cb-toggle${formOngoing ? ' cb-toggle--on' : ''}`}
                onClick={() => setFormOngoing(p => !p)}
              >
                <span className="cb-toggle-knob" />
              </button>
              <span className="cb-toggle-label">
                {formOngoing ? 'Ongoing (no end date)' : 'Set an end date'}
              </span>
            </div>
            {!formOngoing && (
              <input
                type="date"
                className="cb-input"
                style={{ marginTop: 10 }}
                min={formStartDate}
                value={formEndDate}
                onChange={e => setFormEndDate(e.target.value)}
              />
            )}
          </div>

          <div className="cb-field">
            <label className="cb-label" htmlFor="tr-start">Start date</label>
            <input
              id="tr-start"
              type="date"
              className="cb-input"
              value={formStartDate}
              min={stockInsufficientForRestock ? tomorrowISTString(todayISTString()) : todayISTString()}
              onChange={e => setFormStartDate(e.target.value)}
            />
            {stockInsufficientForRestock && (
              <p className="tr-stock-restock-hint" role="status">
                Not enough stock for this dose. Start date set to tomorrow to give you time to restock.
              </p>
            )}
          </div>
        </div>
      )}

      {/* Step 4 — confirm */}
      {view === 'step4' && (
        <>
          <div className="tr-confirm-card">
            <div className="tr-confirm-section">
              <p className="tr-confirm-label">Treatment</p>
              <p className="tr-confirm-value">{formName}</p>
              <p className="tr-confirm-sub">
                {CATEGORY_LABELS[formCategory]} · for {formMemberName ?? 'Unknown member'}
              </p>
            </div>
            <div className="tr-confirm-section">
              <p className="tr-confirm-label">Medicine & dose</p>
              <p className="tr-confirm-value">{formDisplayName}</p>
              <p className="tr-confirm-sub">
                {formDoseAmount} {formDoseUnit}{parseFloat(formDoseAmount) !== 1 && formDoseUnit !== 'ml' ? 's' : ''} per dose
              </p>
            </div>
            <div className="tr-confirm-section">
              <p className="tr-confirm-label">Schedule</p>
              <p className="tr-confirm-value">
                {summarize(formScheduleType, formScheduleDays, formSlots)}
              </p>
              {formScheduleType !== 'as-needed' && formSlots.length > 0 && (
                <p className="tr-confirm-sub">
                  {formSlots.map(s => `${s.time} (${FOOD_LABELS[s.foodTiming]})`).join(' · ')}
                </p>
              )}
              <p className="tr-confirm-sub">
                From {fmtDate(formStartDate)}
                {formOngoing ? ' · Ongoing' : formEndDate ? ` · until ${fmtDate(formEndDate)}` : ''}
              </p>
            </div>
          </div>

          {stepError && <p className="cb-form-error" role="alert">{stepError}</p>}

          <button
            className="cb-submit-btn"
            onClick={handleSave}
            disabled={saveLoading}
            style={{ marginTop: 8 }}
          >
            {saveLoading ? 'Saving…' : 'Start treatment'}
          </button>
        </>
      )}

      {/* Next button for steps 1-3 */}
      {view !== 'step4' && (
        <>
          {stepError && <p className="cb-form-error" role="alert">{stepError}</p>}
          <button
            className="cb-submit-btn"
            onClick={goNext}
            style={{ marginTop: 8 }}
            disabled={checkingInteraction || checkingConflict}
          >
            {checkingInteraction || checkingConflict ? 'Checking…' : 'Next'}
          </button>
        </>
      )}

      {pendingInteractionWarning && (
        <InteractionWarningModal
          warning={pendingInteractionWarning}
          onGoBack={() => setPendingInteractionWarning(null)}
          onOverride={(justification) => {
            // AK-39 sub-task 3 — Buffer the override intent; the audit row
            // is written from handleSave once the treatment doc exists.
            // Description text doubles as the audited interactionSummary.
            const w = pendingInteractionWarning
            setInteractionOverride({
              conflictingCabinetItemId: w.conflictingCabinetItemId,
              conflictingMedicineName: w.conflictingMedicineName,
              interactionSummary: w.description,
              justification,
            })
            setPendingInteractionWarning(null)
            setView('step3')
          }}
        />
      )}

      {/* AK-124 (via AK-133) — surfaces when an inline-added cabinet item
          interacts with a medicine on another household member's active
          treatment. The Remove path also clears the wizard's selection so
          the user has to pick again before advancing. */}
      {treatmentInteractionWarning && (
        <TreatmentInteractionWarningModal
          warning={treatmentInteractionWarning}
          onDismiss={() => setTreatmentInteractionWarning(null)}
          onRemove={() => {
            const { iId, cabinetId } = treatmentInteractionWarning
            setTreatmentInteractionWarning(null)
            // Clear wizard selection so the user can't proceed with a doc
            // that's about to be deleted out from under them.
            if (formCabinetItemId === iId) {
              selectCabinetItem('')
            }
            void deleteCabinetItem(hId, cabinetId, iId).catch(() => {})
          }}
        />
      )}

      {pendingConflict && (
        <TreatmentConflictModal
          conflictType={pendingConflict.type}
          existingTreatmentName={pendingConflict.existingTreatmentName}
          medicineName={pendingConflict.medicineName}
          onGoBack={() => setPendingConflict(null)}
          {...(pendingConflict.type === 'overlap'
            ? {
                onProceed: () => {
                  setConflictAcknowledged(true)
                  setAcknowledgedConflictingTreatmentId(pendingConflict.existingTreatmentId)
                  setPendingConflict(null)
                  setView('step4')
                },
              }
            : {})}
        />
      )}

      {pastDateModal && (
        <PastDateModal
          startDate={formStartDate}
          onTrackFromToday={() => {
            setFormStartDate(todayISTString())
            setWillLogPastDoses(false)
            setPastDateModal(false)
            setView('step4')
          }}
          onLogPastDoses={() => {
            setWillLogPastDoses(true)
            setPastDateModal(false)
            setView('step4')
          }}
        />
      )}

      {retroSheet && (
        <RetroLogSheet
          slots={retroSlots}
          checks={retroChecks}
          medicineName={formDisplayName}
          wasCapped={retroWasCapped}
          onToggle={toggleRetroCheck}
          onSave={handleRetroSave}
          onSkip={handleRetroSkip}
        />
      )}

      {/* Cancel-wizard confirmation modal (Fix 4) */}
      {showCancelConfirm && (
        <div
          className="tr-modal-backdrop"
          onClick={() => setShowCancelConfirm(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="tr-cancel-modal-title"
        >
          <div className="tr-modal" onClick={e => e.stopPropagation()}>
            <h3 id="tr-cancel-modal-title" className="tr-modal-title">
              Cancel adding treatment?
            </h3>
            <p className="tr-modal-subtitle">Your progress will be lost.</p>
            <div className="tr-modal-actions">
              <button
                type="button"
                className="tr-modal-btn tr-modal-btn--secondary"
                onClick={() => setShowCancelConfirm(false)}
              >
                Keep editing
              </button>
              <button
                type="button"
                className="tr-modal-btn tr-modal-btn--primary"
                onClick={discardAndExitWizard}
              >
                Yes, cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
