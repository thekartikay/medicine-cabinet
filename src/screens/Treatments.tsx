import { useEffect, useState } from 'react'
import {
  ChevronLeft, Plus, X, Clock, AlertTriangle,
  Pause, Play, StopCircle, Trash2, ChevronDown, CalendarHeart,
} from 'lucide-react'
import { httpsCallable } from 'firebase/functions'
import { functions } from '../lib/firebase'
import { todayISTString } from '../lib/paths'
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
} from '../services/firestoreService'
import { checkCabinetInteractions } from '../services/geminiService'
import { InteractionWarningModal } from '../components/InteractionWarningModal'
import type {
  CabinetItem,
  CabinetItemUnit,
  FoodTiming,
  HouseholdMember,
  Regimen,
  ScheduleType,
  TimeSlot,
  Treatment,
  TreatmentCategory,
  TreatmentStatus,
} from '../types'

type TxView = 'list' | 'step1' | 'step2' | 'step3' | 'step4'

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

function summarize(scheduleType: ScheduleType, days: number[], slots: TimeSlot[]): string {
  if (scheduleType === 'as-needed') return 'As needed'
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
  // AK-39 sub-task 2 — Interaction check gate at step2 → step3 transition.
  const [checkingInteraction, setCheckingInteraction] = useState(false)
  const [pendingInteractionWarning, setPendingInteractionWarning] = useState<{
    description: string
    withMedicineNames: string[]
    riskLevel: 'moderate' | 'high'
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
        const cId = await getOrCreateDefaultCabinet(hId)
        if (cancelled) return
        unsubscribe = subscribeCabinetItems(
          hId,
          cId,
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
    setFormDoseUnit('tablet')
    setFormDisplayName('')
    setFormScheduleType('daily')
    setFormScheduleDays([1, 2, 3, 4, 5])
    setFormSlots([{ time: '08:00', foodTiming: 'after' }])
    setFormStartDate(todayISTString())
    setFormEndDate('')
    setFormOngoing(true)
    setFormMaxDosesPerDay(4)
    setStockInsufficientForRestock(false)
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
      if (formScheduleType !== 'as-needed' && formSlots.length === 0)
        return 'Add at least one dose time.'
      if (!formOngoing && !formEndDate)
        return 'Set an end date or choose ongoing.'
    }
    return ''
  }

  async function goNext() {
    const err = validate(view)
    if (err) { setStepError(err); return }
    setStepError('')
    const next: Record<TxView, TxView> = {
      list: 'step1', step1: 'step2', step2: 'step3', step3: 'step4', step4: 'step4',
    }

    // AK-39 sub-task 2 — Soft interaction check at the step2 → step3 boundary
    // only. The medicine is chosen on step2; the check compares it against the
    // member's other active-treatment regimens. Any error (no other meds, no
    // interaction, Gemini failure, no cabinet match) advances normally; only a
    // positive hit opens the confirm modal and pauses the transition.
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
        const result = await checkCabinetInteractions(
          selectedItem,
          otherMedicines.map(m => m.cabinetItemId),
        )
        if (result?.hasInteraction) {
          setPendingInteractionWarning({
            description: result.description,
            withMedicineNames: result.withMedicineNames,
            riskLevel: result.riskLevel,
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
    setFormDoseUnit('tablet')
    setFormDisplayName('')
    setFormScheduleType('daily')
    setFormScheduleDays([1, 2, 3, 4, 5])
    setFormSlots([{ time: '08:00', foodTiming: 'after' }])
    setFormStartDate(todayISTString())
    setFormEndDate('')
    setFormOngoing(true)
    setFormMaxDosesPerDay(4)
    setStockInsufficientForRestock(false)
    setStepError('')
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
      await addRegimen(hId, tId, {
        cabinetItemId: formCabinetItemId,
        medicineId: formMedicineId,
        displayName: formDisplayName.trim(),
        doseAmount: parseFloat(formDoseAmount),
        doseUnit: formDoseUnit,
        scheduleType: formScheduleType,
        scheduleDays: formScheduleType === 'specific-days' ? formScheduleDays : null,
        slots: formScheduleType === 'as-needed' ? [] : formSlots,
        startDate: formStartDate,
        endDate: formOngoing ? null : (formEndDate || null),
        ongoing: formOngoing,
        // PRN-only — conditional spread so the field is omitted entirely
        // (rather than written as undefined → Firestore would reject) for
        // time-driven regimens.
        ...(formScheduleType === 'as-needed' ? { maxDosesPerDay: formMaxDosesPerDay } : {}),
      })
      setView('list')
    } catch {
      setStepError('Failed to save. Please try again.')
    } finally {
      setSaveLoading(false)
    }
  }

  // Slot helpers
  function addSlot() {
    setFormSlots(prev => [...prev, { time: '08:00', foodTiming: 'after' }])
  }
  function removeSlot(i: number) {
    setFormSlots(prev => prev.filter((_, idx) => idx !== i))
  }
  function setSlotTime(i: number, time: string) {
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

  const stepNum = view === 'step1' ? 1 : view === 'step2' ? 2 : view === 'step3' ? 3 : 4
  const stepTitle =
    view === 'step1' ? 'Treatment details' :
    view === 'step2' ? 'Medicine & dose'   :
    view === 'step3' ? 'Schedule'          :
    'Confirm treatment'

  // ── List view ───────────────────────────────────────────────
  if (view === 'list') {
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

        {loadingList && (
          <div className="cb-loader"><div className="cb-spinner" role="status" aria-label="Loading" /></div>
        )}

        {!loadingList && visibleTreatments.length === 0 && (
          <div className="db-card db-empty-state">
            <div className="empty-state-icon">
              <CalendarHeart size={28} color="#5DC1C8" />
            </div>
            <p className="db-empty-text">No treatments yet</p>
            {!readOnly && <p className="db-empty-sub">Add one to start tracking doses.</p>}
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
        {(() => {
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
                    <button type="button" className="bs-btn bs-btn--secondary" disabled>
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
                      <span className="tr-member-name">{m.displayName ?? m.uid}</span>
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
            <label className="cb-label" htmlFor="tr-medicine">Select from cabinet</label>
            {cabinetError ? (
              <p className="cb-hint cb-hint--error" role="alert">{cabinetError}</p>
            ) : cabinetItems.length === 0 ? (
              <p className="cb-hint">Your cabinet is empty. Add medicines in the Cabinet tab first.</p>
            ) : (
              <select
                id="tr-medicine"
                className="cb-input cb-select"
                value={formCabinetItemId}
                onChange={e => selectCabinetItem(e.target.value)}
              >
                <option value="">— Choose a medicine —</option>
                {cabinetItems.map(item => {
                  const name = item.displayNameOverride ?? item.medicineId
                  const unit = item.unit === 'ml' ? 'ml' : `${item.unit}s`
                  return (
                    <option key={item.iId} value={item.iId}>
                      {name} ({item.quantityOnHand} {unit})
                    </option>
                  )
                })}
              </select>
            )}
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
              <label className="cb-label" htmlFor="tr-dose-unit">Unit</label>
              <select
                id="tr-dose-unit"
                className="cb-input cb-select"
                value={formDoseUnit}
                onChange={e => setFormDoseUnit(e.target.value as CabinetItemUnit)}
              >
                <option value="tablet">Tablet</option>
                <option value="capsule">Capsule</option>
                <option value="ml">ml</option>
              </select>
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

          {formScheduleType !== 'as-needed' && (
            <div className="cb-field">
              <span className="cb-label">Dose times</span>
              <div className="tr-slot-list">
                {formSlots.map((slot, i) => (
                  <div key={i} className="tr-slot-row">
                    <input
                      type="time"
                      className="cb-input tr-slot-time"
                      value={slot.time}
                      onChange={e => setSlotTime(i, e.target.value)}
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
                ))}
              </div>
              <button type="button" className="cb-link-btn" onClick={addSlot} style={{ marginTop: 8 }}>
                + Add another time
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
            disabled={checkingInteraction}
          >
            {checkingInteraction ? 'Checking…' : 'Next'}
          </button>
        </>
      )}

      {pendingInteractionWarning && (
        <InteractionWarningModal
          warning={pendingInteractionWarning}
          onProceed={() => {
            setPendingInteractionWarning(null)
            setView('step3')
          }}
          onGoBack={() => setPendingInteractionWarning(null)}
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
