import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, Pill, Trash2 } from 'lucide-react'
import {
  getOrCreateDefaultCabinet,
  subscribeCabinetItems,
  addCabinetItem,
  searchMasterDb,
  loadAllActiveRegimens,
  subscribeRestockRequests,
  updateRestockRequest,
  getHouseholdMembers,
  updateCabinetItemInteractionWarning,
  updateCabinetItem,
  getActiveTreatmentsWithRegimensForMember,
  deleteCabinetItem,
  disposeCabinetItem,
  addStock,
} from '../services/firestoreService'
import { checkCabinetInteractions } from '../services/geminiService'
import { TreatmentInteractionWarningModal } from '../components/TreatmentInteractionWarningModal'
import { todayISTString } from '../lib/paths'
import type {
  CabinetItem,
  CabinetItemUnit,
  DosageForm,
  MasterMedicine,
  Regimen,
  RestockRequest,
  StrengthUnit,
  Treatment,
} from '../types'
import { STRENGTH_UNITS } from '../types'
import { timeAgo } from './NotificationsPanel'

type CabinetView = 'list' | 'search' | 'enrich' | 'cabinet-details' | 'edit'

interface Props {
  hId: string
  // When provided, the screen renders as read-only and items are filtered to
  // the medicines used in this user's treatments only.
  readOnly?: boolean
  filterByPatientUid?: string
  // AK-174 — Actor context for the new Add stock event log. Cabinet's existing
  // mutations didn't need a uid (rules enforce by claim, not by data field);
  // the stock-event row records who performed the increment, so we surface
  // the current user explicitly. Caregivers don't reach this screen
  // (isParticipant excludes them), so the role narrows to admin | member.
  currentUid: string
  currentRole: 'admin' | 'member'
}

// AK-149 — Used both for the masterStillMatches save-time check (originally
// AK-128) and for the render-time `masterLocked` derived value that gates the
// read-only pill display for dosageForm / strength / unit. Trim, lowercase,
// collapse internal whitespace so trivial casing/whitespace edits don't
// unlock the fields.
function normalizeBrand(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

// AK-149 — Mirror of unitPillLabel from Treatments.tsx (AK-129). Inlined here
// rather than exported to avoid a cross-screen import. Singular title-case;
// `ml` stays lowercase by convention; empty input falls back to em-dash so
// the read-only pill never renders as a blank box.
function unitPillLabel(unit: string): string {
  if (!unit) return '—'
  if (unit === 'ml') return 'ml'
  return unit.charAt(0).toUpperCase() + unit.slice(1)
}

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

const UNIT_LABELS: Record<CabinetItemUnit, string> = {
  tablet:      'Tablets',
  capsule:     'Capsules',
  ml:          'ml',
  spray:       'Sprays',
  dose:        'Doses',
  puff:        'Puffs',
  drop:        'Drops',
  application: 'Applications',
  patch:       'Patches',
  other:       'Other (specify)',
}

// AK-151 — Used by startEdit to decide whether the saved unit should pre-fill
// the dropdown (enum value) or the custom-unit text input (free-text saved
// when the user picked 'other' at add time).
const UNIT_ENUM_VALUES = new Set<CabinetItemUnit>(
  Object.keys(UNIT_LABELS) as CabinetItemUnit[],
)

// AK-39 / catalog-enrichment — when the user picks a dosage form, suggest a
// count unit that fits. The form-dropdown's onChange and the masterDb pre-fill
// both run this. Returns null for "no obvious match — leave current selection
// alone" (powder is the only case today).
function suggestUnitForForm(form: DosageForm): CabinetItemUnit | null {
  switch (form) {
    case 'inhaler':     return 'puff'
    case 'drops':       return 'drop'
    case 'patch':       return 'patch'
    case 'syrup':       return 'ml'
    case 'cream':
    case 'ointment':    return 'application'
    case 'injection':   return 'dose'
    case 'tablet':      return 'tablet'
    case 'capsule':     return 'capsule'
    case 'dispersible': return 'tablet'
    case 'spray':       return 'spray'
    case 'powder':      return null
  }
}

// Whitelist used to guard the masterDb-driven dosageForm pre-fill. If an
// older masterDb doc carries a value that isn't a member of DosageForm we
// skip the pre-fill rather than feeding the select a value it can't render.
const ALLOWED_DOSAGE_FORMS: DosageForm[] = [
  'tablet', 'capsule', 'syrup', 'injection', 'cream',
  'drops', 'spray', 'powder', 'inhaler', 'patch',
]

// AK-39 / catalog-enrichment — append the strength to the resolved name when
// available. Items added before masterDb was enriched (or where the user
// skipped the strength field) fall back to just the base name unchanged.
function itemDisplayName(item: CabinetItem): string {
  const base = item.displayNameOverride ?? item.brandName ?? item.medicineId
  const strength = item.strength ? ` · ${item.strength}` : ''
  return `${base}${strength}`
}

function getStatus(item: CabinetItem): 'in-stock' | 'low-stock' | 'expired' {
  const today = todayISTString()
  if (item.expiryDate && item.expiryDate < today) return 'expired'
  if (item.quantityOnHand <= 10) return 'low-stock'
  return 'in-stock'
}

function formatExpiry(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function unitLabel(item: CabinetItem): string {
  if (item.unit === 'ml') return 'ml'
  const base = item.unit
  return item.quantityOnHand === 1 ? base : `${base}s`
}

// Days until expiry (Infinity when no expiryDate). Negative means already expired.
function daysUntilExpiry(item: CabinetItem): number {
  if (!item.expiryDate) return Infinity
  const today = new Date(todayISTString() + 'T00:00:00').getTime()
  const exp   = new Date(item.expiryDate + 'T00:00:00').getTime()
  return Math.floor((exp - today) / 86400000)
}

// Sort soonest expiring first; items without an expiry sink to the bottom.
function byExpirySoonest(a: CabinetItem, b: CabinetItem): number {
  return daysUntilExpiry(a) - daysUntilExpiry(b)
}

export function CabinetTab({ hId, readOnly = false, filterByPatientUid, currentUid, currentRole }: Props) {
  const [view, setView] = useState<CabinetView>('list')
  const [cId, setCId] = useState<string | null>(null)
  const [items, setItems] = useState<CabinetItem[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [listError, setListError] = useState('')
  // AK-39 — Per-card expansion state for the interaction badge. Tracks which
  // item's warning details are currently open; null when collapsed.
  const [expandedInteractionIid, setExpandedInteractionIid] = useState<string | null>(null)
  // AK-124 — Surfaces when a newly-added cabinet item interacts with a
  // medicine on someone's active treatment. Carries the cabinet identifiers
  // alongside the warning copy so the modal's "Remove from cabinet" button
  // can reach the doc without re-deriving it from a stale ref.
  const [treatmentInteractionWarning, setTreatmentInteractionWarning] = useState<{
    description: string
    withMedicineNames: string[]
    riskLevel: 'moderate' | 'high'
    iId: string
    cabinetId: string
  } | null>(null)

  // search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<MasterMedicine[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── manual / enrichment form state ─────────────────────────────
  // AK-128 — Tracks the masterDb entry the user picked (if any) so the saved
  // medicineId can carry the catalog's stable doc ID instead of the typed
  // brand string. Cleared on resetForm; on save, only honoured when the
  // brand text still matches what the picker prefilled (otherwise the user
  // has edited toward a different medicine, so we slug instead).
  const [selectedMaster, setSelectedMaster] = useState<MasterMedicine | null>(null)
  const [formBrand,   setFormBrand]   = useState('')
  const [formDosageForm, setFormDosageForm] = useState<DosageForm>('tablet')
  // AK-39 / catalog-enrichment — strength is now (numeric value, unit suffix).
  // On save we combine them into a single string, or null if value is blank.
  const [formStrengthValue, setFormStrengthValue] = useState('')
  const [formStrengthUnit, setFormStrengthUnit] = useState<StrengthUnit>('mg')
  const [formQuantity, setFormQuantity] = useState('')
  const [formUnit, setFormUnit] = useState<CabinetItemUnit>('tablet')
  // Free-text label written into the saved CabinetItem.unit when formUnit
  // is 'other'. Spec stores the typed string verbatim in the unit field.
  const [formCustomUnit, setFormCustomUnit] = useState('')
  const [formExpiry, setFormExpiry] = useState('')
  // Optional details
  const [showOptional, setShowOptional] = useState(false)
  const [formActiveIngr, setFormActiveIngr] = useState('')
  const [formMarketer, setFormMarketer] = useState('')
  const [formStorage, setFormStorage] = useState('')
  // Cabinet details
  const [formPrescribed, setFormPrescribed] = useState(false)
  const [formLoading, setFormLoading] = useState(false)
  const [formError, setFormError] = useState('')

  // AK-149 — Render-time derived: true when the user picked from masterDb
  // AND hasn't edited the brand text away from the prefilled value. Locks
  // dosageForm/strength/unit into read-only pills; reactive — the moment
  // formBrand diverges from the master's name, this flips false and the
  // fields become editable again. Same normalize() comparison the save
  // handler uses to choose between selectedMaster.medicineId and the slug.
  const masterLocked = !!selectedMaster
    && normalizeBrand(formBrand) === normalizeBrand(selectedMaster.brandName ?? selectedMaster.name)

  // AK-151 — Edit-flow state. editingItem holds the original CabinetItem
  // so handleEditSave can diff strength/unit/dosageForm to decide whether
  // the affected-treatments warning fires. editConfirmOpen gates the
  // warning modal between "Save" tap and the actual updateCabinetItem
  // call.
  const [editingItem, setEditingItem] = useState<CabinetItem | null>(null)
  const [editConfirmOpen, setEditConfirmOpen] = useState(false)
  const [editAffectedTreatments, setEditAffectedTreatments] = useState<Treatment[]>([])

  // AK-150 — Soft-delete flow state. disposingItems is non-empty while the
  // confirmation modal is open and holds the batch(es) about to be disposed
  // (one for per-batch delete, the full group for medicine-level delete).
  // disposeAffected lists every active treatment that references any of
  // them — drives the warning copy and shows the user what will be impacted.
  const [disposingItems, setDisposingItems] = useState<CabinetItem[] | null>(null)
  const [disposeAffected, setDisposeAffected] = useState<Treatment[]>([])
  const [disposeLoading, setDisposeLoading] = useState(false)

  // AK-174 — Add stock modal. Targets one cabinet item (group.items[0] for
  // single-batch groups, the canonical batch for multi-batch). Free-text
  // form state with inline validation; a brief toast confirms success and
  // the existing subscribeCabinetItems listener picks up the new quantity.
  const [addStockTarget, setAddStockTarget] = useState<CabinetItem | null>(null)
  const [addStockQty, setAddStockQty] = useState('')
  const [addStockExpiry, setAddStockExpiry] = useState('')
  const [addStockBatch, setAddStockBatch] = useState('')
  const [addStockNotes, setAddStockNotes] = useState('')
  const [addStockLoading, setAddStockLoading] = useState(false)
  const [addStockError, setAddStockError] = useState('')
  const [addStockToast, setAddStockToast] = useState<string | null>(null)

  // ── Read-only filter set: cabinetItem ids used in this user's treatments ──
  const [allowedItemIds, setAllowedItemIds] = useState<Set<string> | null>(null)
  // ── Active treatments + regimens (used by both the readOnly filter and the
  //    "Used in treatments" list inside the detail bottom sheet, Fix 3). ────
  const [activeTreatments, setActiveTreatments] = useState<Treatment[]>([])
  const [activeRegimens, setActiveRegimens]     = useState<Regimen[]>([])
  useEffect(() => {
    let cancelled = false
    loadAllActiveRegimens(hId)
      .then(({ treatments, regimensByTreatment }) => {
        if (cancelled) return
        const flat: Regimen[] = []
        for (const t of treatments) for (const r of regimensByTreatment[t.tId] ?? []) flat.push(r)
        setActiveTreatments(treatments)
        setActiveRegimens(flat)
        if (filterByPatientUid) {
          const myTreatments = treatments.filter(t => t.memberId === filterByPatientUid)
          const set = new Set<string>()
          for (const t of myTreatments) {
            for (const r of regimensByTreatment[t.tId] ?? []) set.add(r.cabinetItemId)
          }
          setAllowedItemIds(set)
        } else {
          setAllowedItemIds(null)
        }
      })
      .catch(() => { /* leave state empty — UI just shows "not used" */ })
    return () => { cancelled = true }
  }, [hId, filterByPatientUid])

  // Selected group in the detail bottom sheet (Fix 3). null = sheet closed.
  const [selectedGroupKey, setSelectedGroupKey] = useState<string | null>(null)

  // Restock requests panel (admin only). Subscription is gated on !readOnly
  // so members never run a query that the rules wouldn't allow for them.
  const [restockRequests, setRestockRequests] = useState<RestockRequest[]>([])
  const [restockExpanded, setRestockExpanded] = useState(false)
  const [resolvingRequestId, setResolvingRequestId] = useState<string | null>(null)
  const [memberNameById, setMemberNameById] = useState<Record<string, string>>({})

  useEffect(() => {
    if (readOnly) return
    const unsub = subscribeRestockRequests(hId, setRestockRequests)
    return () => unsub()
  }, [hId, readOnly])

  useEffect(() => {
    if (readOnly) return
    getHouseholdMembers(hId)
      .then(members => {
        const map: Record<string, string> = {}
        for (const m of members) map[m.uid] = m.displayName?.trim() || 'Member'
        setMemberNameById(map)
      })
      .catch(() => { /* non-critical — falls back to generic label */ })
  }, [hId, readOnly])

  async function resolveRestock(requestId: string, status: 'fulfilled' | 'dismissed') {
    setResolvingRequestId(requestId)
    try {
      await updateRestockRequest(hId, requestId, status)
      // Subscription will drop the resolved request from the list automatically.
    } finally {
      setResolvingRequestId(null)
    }
  }

  useEffect(() => {
    let cancelled = false
    let unsubscribe: (() => void) | null = null
    async function setup() {
      setLoadingList(true)
      setListError('')
      try {
        const id = await getOrCreateDefaultCabinet(hId)
        if (cancelled) return
        setCId(id)
        // AK-39 — Real-time subscription so the passive interaction warning
        // (stamped by a background write after addCabinetItem resolves)
        // surfaces on the list without a manual refetch.
        unsubscribe = subscribeCabinetItems(
          hId,
          id,
          (data) => {
            if (cancelled) return
            setItems(data)
            setLoadingList(false)
          },
          () => {
            if (!cancelled) {
              setListError('Could not load cabinet. Check your connection.')
              setLoadingList(false)
            }
          },
        )
      } catch {
        if (!cancelled) {
          setListError('Could not load cabinet. Check your connection.')
          setLoadingList(false)
        }
      }
    }
    setup()
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [hId])

  // debounced masterDb search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!searchQuery.trim()) { setSearchResults([]); return }
    debounceRef.current = setTimeout(async () => {
      setSearchLoading(true)
      try {
        setSearchResults(await searchMasterDb(searchQuery.trim()))
      } finally {
        setSearchLoading(false)
      }
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [searchQuery])

  function resetForm() {
    setSelectedMaster(null)
    setFormBrand('')
    setFormDosageForm('tablet')
    setFormStrengthValue('')
    setFormStrengthUnit('mg')
    setFormQuantity('')
    setFormUnit('tablet')
    setFormCustomUnit('')
    setFormExpiry('')
    setShowOptional(false)
    setFormActiveIngr('')
    setFormMarketer('')
    setFormStorage('')
    setFormPrescribed(false)
    setFormError('')
  }

  function cancelToList() {
    resetForm()
    setSearchQuery('')
    setSearchResults([])
    setView('list')
  }

  // AK-151 — Pre-populate the form state from a manually-added item and
  // switch to the edit view. The edit view reuses the same form-state
  // hooks the add flow uses (formBrand, formStrengthValue, etc.), so
  // pre-filling them is enough to put the form into "editing this item"
  // mode. editingItem holds the original snapshot for the diff in
  // handleEditSave.
  function startEdit(item: CabinetItem) {
    resetForm()
    setEditingItem(item)
    setFormBrand(item.brandName ?? item.medicineId)
    if (item.strength) {
      const parsed = parseStrengthString(item.strength)
      if (parsed) {
        setFormStrengthValue(parsed.value)
        setFormStrengthUnit(parsed.unit)
      } else {
        setFormStrengthValue(item.strength)
      }
    }
    if (item.dosageForm && ALLOWED_DOSAGE_FORMS.includes(item.dosageForm as DosageForm)) {
      setFormDosageForm(item.dosageForm as DosageForm)
    }
    // The saved unit may be the literal 'other' sentinel, an enum member,
    // or a free-text custom unit (cast to CabinetItemUnit at add time).
    // Choose dropdown vs custom input based on enum membership.
    if (UNIT_ENUM_VALUES.has(item.unit)) {
      setFormUnit(item.unit)
    } else {
      setFormUnit('other')
      setFormCustomUnit(item.unit)
    }
    setFormQuantity(String(item.quantityOnHand))
    setFormExpiry(item.expiryDate ?? '')
    setFormPrescribed(item.prescribed)
    setSelectedGroupKey(null)
    setView('edit')
  }

  function cancelEdit() {
    setEditingItem(null)
    setEditConfirmOpen(false)
    setEditAffectedTreatments([])
    resetForm()
    setView('list')
  }

  // Handles "Save" tap in the edit view. Validates required fields,
  // runs the field-aware affected-treatments check, and either fires
  // the warning modal or saves directly.
  async function handleEditSave() {
    if (!editingItem || !cId) return
    if (!formBrand.trim())    { setFormError('Brand name is required.');   return }
    const qty = parseInt(formQuantity, 10)
    if (!formQuantity || isNaN(qty) || qty < 0) {
      setFormError('Enter a valid quantity.'); return
    }
    if (!formExpiry) { setFormError('Expiry date is required.'); return }
    setFormError('')

    const trimmedStrengthValue = formStrengthValue.trim()
    const newStrength = trimmedStrengthValue
      ? `${trimmedStrengthValue}${formStrengthUnit}`
      : null
    const newUnit: CabinetItemUnit =
      formUnit === 'other'
        ? ((formCustomUnit.trim() || 'other') as CabinetItemUnit)
        : formUnit

    // AK-151 — Field-aware warning: only strength/unit/dosageForm changes
    // can desync downstream Regimen/DoseLog records (those fields were
    // snapshotted from the cabinet at regimen create time). Name, expiry,
    // and quantity edits don't touch the dose record.
    const strengthChanged = newStrength !== (editingItem.strength ?? null)
    const unitChanged = newUnit !== editingItem.unit
    const dosageFormChanged = formDosageForm !== (editingItem.dosageForm ?? 'tablet')
    const desyncRisk = strengthChanged || unitChanged || dosageFormChanged

    if (desyncRisk) {
      const affected = treatmentsUsingItem(editingItem.iId)
      if (affected.length > 0) {
        setEditAffectedTreatments(affected)
        setEditConfirmOpen(true)
        return
      }
    }
    await commitEdit(newStrength, newUnit)
  }

  async function commitEdit(strength: string | null, unit: CabinetItemUnit) {
    if (!editingItem || !cId) return
    setFormLoading(true)
    try {
      await updateCabinetItem(hId, cId, editingItem.iId, {
        brandName: formBrand.trim(),
        strength,
        dosageForm: formDosageForm,
        unit,
        quantityOnHand: parseInt(formQuantity, 10),
        expiryDate: formExpiry || null,
      })
      // Subscription will pick up the change.
      cancelEdit()
    } catch {
      setFormError('Could not save changes. Please try again.')
    } finally {
      setFormLoading(false)
    }
  }

  // Triggered from the warning modal's "Continue" button.
  async function confirmEditAndSave() {
    setEditConfirmOpen(false)
    const trimmedStrengthValue = formStrengthValue.trim()
    const newStrength = trimmedStrengthValue
      ? `${trimmedStrengthValue}${formStrengthUnit}`
      : null
    const newUnit: CabinetItemUnit =
      formUnit === 'other'
        ? ((formCustomUnit.trim() || 'other') as CabinetItemUnit)
        : formUnit
    await commitEdit(newStrength, newUnit)
  }

  // AK-150 — Open the dispose confirmation modal for a single batch or for
  // every batch in a group. Collects affected active treatments (union
  // across all targeted iIds, deduped by tId) so the warning copy can
  // name them.
  function startDispose(targets: CabinetItem[]) {
    if (targets.length === 0) return
    const usedAcross = targets.flatMap(it => treatmentsUsingItem(it.iId))
    const dedup = Array.from(new Map(usedAcross.map(t => [t.tId, t])).values())
    setDisposingItems(targets)
    setDisposeAffected(dedup)
  }

  function cancelDispose() {
    setDisposingItems(null)
    setDisposeAffected([])
    setDisposeLoading(false)
  }

  async function confirmDispose() {
    if (!disposingItems || !cId) return
    setDisposeLoading(true)
    try {
      // Sequential rather than Promise.all so a failure on item N doesn't
      // leave the user wondering which of items 1..N also failed silently
      // — and the per-write payload is tiny so there's no latency win
      // from parallelizing.
      for (const it of disposingItems) {
        await disposeCabinetItem(hId, cId, it.iId)
      }
      // Subscription filter will remove the disposed items from `items`
      // on the next snapshot — the detail sheet (which is keyed off
      // selectedGroupKey looking up groupMap) will then auto-close
      // because the group it points at no longer exists.
      cancelDispose()
      setSelectedGroupKey(null)
    } catch {
      setDisposeLoading(false)
      // Leave modal open so user can retry; surfaceable error UX is
      // deferred — disposeCabinetItem failures here are rare (single
      // updateDoc with App Check) and the modal stays in a sensible
      // retry-or-cancel state.
    }
  }

  // AK-174 — Add stock handlers. openAddStock resets prior form state so a
  // re-open after a previous save doesn't surface stale values; confirmAddStock
  // delegates validation + the transaction to firestoreService.addStock.
  function openAddStock(item: CabinetItem) {
    setAddStockTarget(item)
    setAddStockQty('')
    setAddStockExpiry('')
    setAddStockBatch('')
    setAddStockNotes('')
    setAddStockError('')
  }

  function cancelAddStock() {
    setAddStockTarget(null)
    setAddStockError('')
  }

  async function confirmAddStock() {
    if (!addStockTarget || !cId) return
    const qty = parseFloat(addStockQty)
    if (isNaN(qty) || qty <= 0) {
      setAddStockError('Enter a quantity greater than zero.')
      return
    }
    setAddStockError('')
    setAddStockLoading(true)
    try {
      await addStock(hId, cId, addStockTarget.iId, {
        amount: qty,
        source: 'manual_add',
        actorUid: currentUid,
        actorRole: currentRole,
        batchNumber: addStockBatch.trim() || null,
        expiryDate: addStockExpiry || null,
        notes: addStockNotes.trim() || null,
      })
      setAddStockTarget(null)
      setAddStockToast('Stock added.')
      setTimeout(() => setAddStockToast(null), 2400)
    } catch (err) {
      setAddStockError(err instanceof Error ? err.message : 'Could not add stock. Please try again.')
    } finally {
      setAddStockLoading(false)
    }
  }

  function openSearch() {
    setSearchQuery('')
    setSearchResults([])
    setView('search')
  }

  // AK-39 / catalog-enrichment — when a masterDb entry is passed, pre-fill
  // strength / dosageForm / activeIngredients from it so the user doesn't
  // re-type what we already know. The manual-add path keeps the existing
  // behaviour (string-only call) and leaves those fields blank.
  function startEnrich(prefillBrand = '', master?: MasterMedicine) {
    resetForm()
    if (master) {
      setSelectedMaster(master)
      setFormBrand(master.brandName ?? master.name)
      if (master.strength) {
        const parsed = parseStrengthString(master.strength)
        if (parsed) {
          setFormStrengthValue(parsed.value)
          setFormStrengthUnit(parsed.unit)
        } else {
          // Unrecognized format (e.g. "500/125mg" combo) — drop into value
          // verbatim and let the user clean it up.
          setFormStrengthValue(master.strength)
        }
      }
      if (master.dosageForm && ALLOWED_DOSAGE_FORMS.includes(master.dosageForm as DosageForm)) {
        const form = master.dosageForm as DosageForm
        setFormDosageForm(form)
        const suggested = suggestUnitForForm(form)
        if (suggested) setFormUnit(suggested)
      }
      if (master.activeIngredients) setFormActiveIngr(master.activeIngredients)
    } else {
      setFormBrand(prefillBrand)
    }
    setView('enrich')
  }

  // Tries to split "500mg" → { value: "500", unit: "mg" }. Tolerates an
  // optional space between number and unit ("60000 IU"). Returns null for
  // anything outside the recognized unit set; caller falls back to dumping
  // the whole string into the value input.
  function parseStrengthString(s: string): { value: string; unit: StrengthUnit } | null {
    const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml|iu|%)$/i)
    if (!m) return null
    const value = m[1]
    const unitRaw = m[2].toLowerCase()
    const unit: StrengthUnit = unitRaw === 'iu' ? 'IU' : (unitRaw as StrengthUnit)
    return { value, unit }
  }

  function continueToCabinet() {
    if (!formBrand.trim())    { setFormError('Brand name is required.');   return }
    // AK-39 / catalog-enrichment — strength is now optional. Inhalers,
    // topicals, and some combo products legitimately have no single number.
    const qty = parseInt(formQuantity, 10)
    if (!formQuantity || isNaN(qty) || qty < 0) {
      setFormError('Enter a valid quantity.'); return
    }
    if (!formExpiry) { setFormError('Expiry date is required.'); return }
    setFormError('')
    setView('cabinet-details')
  }

  async function handleSave() {
    if (!cId) return
    setFormLoading(true)
    setFormError('')
    // Snapshot the items currently in state as the comparison set for the
    // interaction check. The subscription will fire shortly with the post-add
    // set, but we want the pre-add view here — exactly the "other items" the
    // new addition should be checked against.
    const otherItems = items
    const cabinetIdLocal = cId
    // AK-39 / catalog-enrichment — combine value + unit, and resolve the
    // 'other' sentinel to either the typed custom string or the literal
    // 'other' when the user left the input blank.
    const trimmedStrengthValue = formStrengthValue.trim()
    const strengthCombined = trimmedStrengthValue
      ? `${trimmedStrengthValue}${formStrengthUnit}`
      : null
    const resolvedUnit: CabinetItemUnit =
      formUnit === 'other'
        ? ((formCustomUnit.trim() || 'other') as CabinetItemUnit)
        : formUnit
    // AK-128 — medicineId is the grouping/identity key, not the display
    // string. Prefer the masterDb doc id when the brand input still matches
    // what the picker prefilled; otherwise slug the typed brand so casing
    // and whitespace differences don't fragment the same medicine across
    // multiple cards. brandName below keeps the human-readable label.
    const trimmedBrand = formBrand.trim()
    const resolvedMedicineId = masterLocked
      ? selectedMaster!.medicineId
      : trimmedBrand.toLowerCase().replace(/\s+/g, '-')
    try {
      const newIid = await addCabinetItem(hId, cId, {
        medicineId: resolvedMedicineId,
        displayNameOverride: null,
        quantityOnHand: parseInt(formQuantity, 10),
        unit: resolvedUnit,
        expiryDate: formExpiry || null,
        prescribed: formPrescribed,
        brandName: trimmedBrand,
        dosageForm: formDosageForm,
        strength: strengthCombined,
        activeIngredients: formActiveIngr.trim() || null,
        marketer: formMarketer.trim() || null,
        storageInstructions: formStorage.trim() || null,
        // AK-151 — Catalog reference; null when free-text typed. Drives
        // the detail-sheet Edit gate (only items with masterDbId == null
        // are user-editable).
        masterDbId: masterLocked ? selectedMaster!.medicineId : null,
      })
      // The subscribeCabinetItems listener installed on mount will pick up the
      // new doc and re-set items state automatically — no manual refetch.
      cancelToList()

      // AK-39 + AK-124 — Two independent fire-and-forget interaction checks
      // run after a successful add. newItem is built once for both calls
      // (only the fields checkCabinetInteractions reads are needed, so a
      // cast covers the server-stamped timestamp fields).
      const newItem = {
        iId: newIid,
        cId: cabinetIdLocal,
        hId,
        medicineId: resolvedMedicineId,
        displayNameOverride: null,
        quantityOnHand: parseInt(formQuantity, 10),
        unit: resolvedUnit,
        expiryDate: formExpiry || null,
        prescribed: formPrescribed,
        brandName: trimmedBrand,
        dosageForm: formDosageForm,
        strength: strengthCombined,
        activeIngredients: formActiveIngr.trim() || null,
        marketer: formMarketer.trim() || null,
        storageInstructions: formStorage.trim() || null,
        masterDbId: masterLocked ? selectedMaster!.medicineId : null,
      } as CabinetItem

      // AK-39 — Passive check against other items already in the cabinet.
      // Writes the warning back onto the new item's doc so its card shows
      // the amber "Interaction risk" badge.
      if (otherItems.length > 0) {
        checkCabinetInteractions(newItem, otherItems.map((it) => it.iId))
          .then((result) => {
            if (result?.hasInteraction) {
              return updateCabinetItemInteractionWarning(hId, cabinetIdLocal, newIid, {
                withMedicineNames: result.withMedicineNames,
                riskLevel: result.riskLevel,
                description: result.description,
              })
            }
          })
          .catch(() => {
            // Silent — passive background check, never blocks or surfaces.
          })
      }

      // AK-124 — Active-treatment check. Pulls every active regimen across
      // every household member, collects their cabinetItemIds, and runs the
      // same interaction check against that pool. A hit opens a modal
      // (more prominent than the passive badge) with an undo path. The
      // member-uid iteration source is the existing memberNameById map —
      // populated by getHouseholdMembers on Cabinet mount.
      const memberUids = Object.keys(memberNameById)
      if (memberUids.length > 0) {
        Promise.all(
          memberUids.map((uid) => getActiveTreatmentsWithRegimensForMember(hId, uid)),
        )
          .then((results) => {
            const treatmentItemIds = results
              .flat()
              .flatMap(({ regimens }) => regimens.map((r) => r.cabinetItemId))
              .filter((id) => id && id !== newIid)
            if (treatmentItemIds.length === 0) return null
            return checkCabinetInteractions(newItem, treatmentItemIds)
          })
          .then((result) => {
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
            // Silent — informational warning, never blocks the add.
          })
      }
    } catch {
      setFormError('Failed to save. Please try again.')
    } finally {
      setFormLoading(false)
    }
  }

  // ── Search view ───────────────────────────────────────────────
  if (view === 'search') {
    return (
      <div className="cb-view">
        <div className="cb-subheader">
          <button className="cb-back-btn" onClick={cancelToList} aria-label="Cancel">
            <BackIcon />
          </button>
          <h2 className="cb-page-title">Search medicine</h2>
        </div>

        <div className="cb-search-wrap">
          <SearchIcon />
          <input
            className="cb-search-input"
            type="search"
            placeholder="e.g. Paracetamol, Metformin…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            autoFocus
          />
        </div>

        {searchLoading && <p className="cb-hint">Searching…</p>}

        {!searchLoading && searchResults.length > 0 && (
          <ul className="cb-result-list" role="listbox" aria-label="Search results">
            {searchResults.map(med => (
              <li key={med.medicineId}>
                <button
                  className="cb-result-btn"
                  onClick={() => startEnrich(med.name, med)}
                  role="option"
                >
                  <span className="cb-result-name">{med.name}</span>
                  {med.activeIngredient && (
                    <span className="cb-result-ingredient">{med.activeIngredient}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}

        {!searchLoading && searchQuery.trim() && searchResults.length === 0 && (
          <div className="cb-no-results">
            <p className="cb-hint">No results for "{searchQuery}".</p>
            <button className="cb-link-btn" onClick={() => startEnrich(searchQuery.trim())}>
              Add "{searchQuery.trim()}" manually →
            </button>
          </div>
        )}

        {!searchQuery.trim() && (
          <button className="cb-link-btn cb-link-btn--loose" onClick={() => startEnrich('')}>
            Skip search — add manually
          </button>
        )}

        <button className="cb-cancel-btn" onClick={cancelToList}>Cancel</button>
      </div>
    )
  }

  // ── Enrich (medicine identity + dose form + qty/unit + expiry) ────
  if (view === 'enrich') {
    return (
      <div className="cb-view">
        <div className="cb-subheader">
          <button className="cb-back-btn" onClick={() => setView('search')} aria-label="Back">
            <BackIcon />
          </button>
          <h2 className="cb-page-title">Add medicine</h2>
        </div>

        <div className="cb-form">
          <div className="cb-field">
            <label className="cb-label" htmlFor="cb-brand">Brand name</label>
            <input
              id="cb-brand"
              className="cb-input"
              type="text"
              placeholder="e.g. Crocin 650"
              value={formBrand}
              onChange={e => setFormBrand(e.target.value)}
              autoFocus={!formBrand}
            />
          </div>

          <div className="cb-field-row">
            <div className="cb-field">
              {/* AK-149 — Locked to the masterDb pick when masterLocked is
                  true; switches back to a regular <select> the moment the
                  user edits the brand text away from the prefilled value. */}
              {masterLocked ? (
                <>
                  <span className="cb-label">Dosage form</span>
                  <span
                    className="cb-input cb-input--readonly"
                    aria-label={`Dosage form: ${DOSAGE_FORM_LABELS[formDosageForm]}`}
                  >
                    {DOSAGE_FORM_LABELS[formDosageForm]}
                  </span>
                </>
              ) : (
                <>
                  <label className="cb-label" htmlFor="cb-form">Dosage form</label>
                  <select
                    id="cb-form"
                    className="cb-input cb-select"
                    value={formDosageForm}
                    onChange={e => {
                      const newForm = e.target.value as DosageForm
                      setFormDosageForm(newForm)
                      // AK-39 / catalog-enrichment — flip the count unit to the
                      // sensible default for the new form (puff for inhaler, ml
                      // for syrup, application for cream/ointment, etc.). User
                      // can still override after.
                      const suggested = suggestUnitForForm(newForm)
                      if (suggested) setFormUnit(suggested)
                    }}
                  >
                    {(Object.keys(DOSAGE_FORM_LABELS) as DosageForm[]).map(f => (
                      <option key={f} value={f}>{DOSAGE_FORM_LABELS[f]}</option>
                    ))}
                  </select>
                </>
              )}
            </div>
            <div className="cb-field">
              {masterLocked ? (
                <>
                  <span className="cb-label">Strength</span>
                  <span
                    className="cb-input cb-input--readonly"
                    aria-label={`Strength: ${formStrengthValue ? formStrengthValue + formStrengthUnit : 'not specified'}`}
                  >
                    {formStrengthValue ? `${formStrengthValue}${formStrengthUnit}` : '—'}
                  </span>
                </>
              ) : (
                <>
                  <label className="cb-label" htmlFor="cb-strength-value">Strength</label>
                  <div className="cb-strength-row">
                    <input
                      id="cb-strength-value"
                      className="cb-input"
                      type="text"
                      inputMode="decimal"
                      placeholder="e.g. 500"
                      value={formStrengthValue}
                      onChange={e => setFormStrengthValue(e.target.value)}
                    />
                    <select
                      id="cb-strength-unit"
                      className="cb-input cb-select"
                      value={formStrengthUnit}
                      onChange={e => setFormStrengthUnit(e.target.value as StrengthUnit)}
                      aria-label="Strength unit"
                    >
                      {STRENGTH_UNITS.map(u => (
                        <option key={u} value={u}>{u}</option>
                      ))}
                    </select>
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="cb-field-row">
            <div className="cb-field">
              <label className="cb-label" htmlFor="cb-qty">Quantity</label>
              <input
                id="cb-qty"
                className="cb-input"
                type="number"
                inputMode="numeric"
                min="0"
                placeholder="30"
                value={formQuantity}
                onChange={e => setFormQuantity(e.target.value)}
              />
            </div>
            <div className="cb-field">
              {masterLocked ? (
                <>
                  <span className="cb-label">Unit type</span>
                  <span
                    className="cb-input cb-input--readonly"
                    aria-label={`Unit type: ${unitPillLabel(formUnit)}`}
                  >
                    {unitPillLabel(formUnit)}
                  </span>
                </>
              ) : (
                <>
                  <label className="cb-label" htmlFor="cb-unit">Unit type</label>
                  <select
                    id="cb-unit"
                    className="cb-input cb-select"
                    value={formUnit}
                    onChange={e => setFormUnit(e.target.value as CabinetItemUnit)}
                  >
                    {(Object.keys(UNIT_LABELS) as CabinetItemUnit[]).map(u => (
                      <option key={u} value={u}>{UNIT_LABELS[u]}</option>
                    ))}
                  </select>
                  {formUnit === 'other' && (
                    <input
                      id="cb-unit-custom"
                      className="cb-input"
                      type="text"
                      placeholder="Type a unit (e.g. vial, sachet)"
                      value={formCustomUnit}
                      onChange={e => setFormCustomUnit(e.target.value)}
                      aria-label="Custom unit"
                      style={{ marginTop: 6 }}
                    />
                  )}
                </>
              )}
            </div>
          </div>

          <div className="cb-field">
            <label className="cb-label" htmlFor="cb-expiry">Expiry date</label>
            <input
              id="cb-expiry"
              className="cb-input"
              type="date"
              value={formExpiry}
              onChange={e => setFormExpiry(e.target.value)}
            />
          </div>

          <button
            type="button"
            className="cb-link-btn"
            onClick={() => setShowOptional(o => !o)}
          >
            {showOptional ? '− Hide details' : '+ Add more details (optional)'}
          </button>

          {showOptional && (
            <>
              <div className="cb-field">
                <label className="cb-label" htmlFor="cb-active">Active ingredients</label>
                <input id="cb-active" className="cb-input" type="text"
                  placeholder="e.g. Paracetamol"
                  value={formActiveIngr}
                  onChange={e => setFormActiveIngr(e.target.value)} />
              </div>
              <div className="cb-field">
                <label className="cb-label" htmlFor="cb-marketer">Marketer / company</label>
                <input id="cb-marketer" className="cb-input" type="text"
                  placeholder="e.g. GSK"
                  value={formMarketer}
                  onChange={e => setFormMarketer(e.target.value)} />
              </div>
              <div className="cb-field">
                <label className="cb-label" htmlFor="cb-storage">Storage instructions</label>
                <input id="cb-storage" className="cb-input" type="text"
                  placeholder="e.g. Store below 30 °C"
                  value={formStorage}
                  onChange={e => setFormStorage(e.target.value)} />
              </div>
            </>
          )}

          {formError && <p className="cb-form-error" role="alert">{formError}</p>}

          <button className="cb-submit-btn" onClick={continueToCabinet}>
            Next
          </button>
          <button className="cb-cancel-btn" onClick={cancelToList}>Cancel</button>
        </div>
      </div>
    )
  }

  // ── Edit (AK-151) ─────────────────────────────────────────────────
  // Reuses the same form-state hooks as the add flow. medicineId and
  // prescribed are shown as locked pills (per spec); brand/strength/
  // dosage form/unit/quantity/expiry are editable. Save runs the
  // field-aware affected-treatments check.
  if (view === 'edit' && editingItem) {
    return (
      <div className="cb-view">
        <div className="cb-subheader">
          <button className="cb-back-btn" onClick={cancelEdit} aria-label="Back">
            <BackIcon />
          </button>
          <h2 className="cb-page-title">Edit medicine</h2>
        </div>

        <div className="cb-form">
          <div className="cb-field">
            <span className="cb-label">Medicine ID</span>
            <span
              className="cb-input cb-input--readonly"
              aria-label={`Medicine ID: ${editingItem.medicineId}`}
            >
              {editingItem.medicineId}
            </span>
          </div>

          <div className="cb-field">
            <label className="cb-label" htmlFor="cb-edit-brand">Brand name</label>
            <input
              id="cb-edit-brand"
              className="cb-input"
              type="text"
              value={formBrand}
              onChange={e => setFormBrand(e.target.value)}
            />
          </div>

          <div className="cb-field-row">
            <div className="cb-field">
              <label className="cb-label" htmlFor="cb-edit-form">Dosage form</label>
              <select
                id="cb-edit-form"
                className="cb-input cb-select"
                value={formDosageForm}
                onChange={e => setFormDosageForm(e.target.value as DosageForm)}
              >
                {(Object.keys(DOSAGE_FORM_LABELS) as DosageForm[]).map(f => (
                  <option key={f} value={f}>{DOSAGE_FORM_LABELS[f]}</option>
                ))}
              </select>
            </div>
            <div className="cb-field">
              <label className="cb-label" htmlFor="cb-edit-strength-value">Strength</label>
              <div className="cb-strength-row">
                <input
                  id="cb-edit-strength-value"
                  className="cb-input"
                  type="text"
                  inputMode="decimal"
                  placeholder="e.g. 500"
                  value={formStrengthValue}
                  onChange={e => setFormStrengthValue(e.target.value)}
                />
                <select
                  id="cb-edit-strength-unit"
                  className="cb-input cb-select"
                  value={formStrengthUnit}
                  onChange={e => setFormStrengthUnit(e.target.value as StrengthUnit)}
                  aria-label="Strength unit"
                >
                  {STRENGTH_UNITS.map(u => (
                    <option key={u} value={u}>{u}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div className="cb-field-row">
            <div className="cb-field">
              <label className="cb-label" htmlFor="cb-edit-qty">Quantity</label>
              <input
                id="cb-edit-qty"
                className="cb-input"
                type="number"
                inputMode="numeric"
                min="0"
                value={formQuantity}
                onChange={e => setFormQuantity(e.target.value)}
              />
            </div>
            <div className="cb-field">
              <label className="cb-label" htmlFor="cb-edit-unit">Unit type</label>
              <select
                id="cb-edit-unit"
                className="cb-input cb-select"
                value={formUnit}
                onChange={e => setFormUnit(e.target.value as CabinetItemUnit)}
              >
                {(Object.keys(UNIT_LABELS) as CabinetItemUnit[]).map(u => (
                  <option key={u} value={u}>{UNIT_LABELS[u]}</option>
                ))}
              </select>
              {formUnit === 'other' && (
                <input
                  id="cb-edit-unit-custom"
                  className="cb-input"
                  type="text"
                  placeholder="Type a unit (e.g. vial, sachet)"
                  value={formCustomUnit}
                  onChange={e => setFormCustomUnit(e.target.value)}
                  aria-label="Custom unit"
                  style={{ marginTop: 6 }}
                />
              )}
            </div>
          </div>

          <div className="cb-field">
            <label className="cb-label" htmlFor="cb-edit-expiry">Expiry date</label>
            <input
              id="cb-edit-expiry"
              className="cb-input"
              type="date"
              value={formExpiry}
              onChange={e => setFormExpiry(e.target.value)}
            />
          </div>

          <div className="cb-field">
            <span className="cb-label">Prescription type</span>
            <span
              className="cb-input cb-input--readonly"
              aria-label={`Prescription type: ${editingItem.prescribed ? 'Prescription (Rx)' : 'Over the counter (OTC)'}`}
            >
              {editingItem.prescribed ? 'Prescription (Rx)' : 'Over the counter (OTC)'}
            </span>
          </div>

          {formError && <p className="cb-form-error" role="alert">{formError}</p>}

          <button
            className="cb-submit-btn"
            onClick={handleEditSave}
            disabled={formLoading}
          >
            {formLoading ? 'Saving…' : 'Save changes'}
          </button>
          <button className="cb-cancel-btn" onClick={cancelEdit}>Cancel</button>
        </div>

        {/* AK-151 — Field-aware affected-treatments warning. Fires only when
            strength / unit / dosageForm changed AND active treatments
            reference this item. */}
        {editConfirmOpen && (
          <div
            className="bs-overlay"
            onClick={() => setEditConfirmOpen(false)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-confirm-title"
          >
            <div className="bs-sheet" onClick={e => e.stopPropagation()}>
              <span className="bs-handle" aria-hidden="true" />
              <h2 id="edit-confirm-title" className="bs-title">Affected treatments</h2>
              <p style={{ marginTop: 8 }}>
                {editAffectedTreatments.length === 1
                  ? `${editAffectedTreatments[0].name} uses this medicine.`
                  : `${editAffectedTreatments.length} treatments use this medicine: ${editAffectedTreatments.map(t => t.name).join(', ')}.`}
                {' '}Changing strength, unit, or dosage form may desync its dose records. Continue?
              </p>
              <div className="bs-actions" style={{ marginTop: 16 }}>
                <button
                  type="button"
                  className="bs-btn bs-btn--secondary"
                  onClick={() => setEditConfirmOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="bs-btn bs-btn--primary"
                  onClick={confirmEditAndSave}
                >
                  Continue
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  // ── Cabinet details (target cabinet + Rx toggle) ──────────────────
  if (view === 'cabinet-details') {
    return (
      <div className="cb-view">
        <div className="cb-subheader">
          <button className="cb-back-btn" onClick={() => setView('enrich')} aria-label="Back">
            <BackIcon />
          </button>
          <h2 className="cb-page-title">Cabinet details</h2>
        </div>

        <div className="cb-form">
          <div className="cb-field">
            <span className="cb-label">Target cabinet</span>
            <p className="cb-hint cb-hint--left">
              Saving to your household's main cabinet.
            </p>
          </div>

          <div className="cb-toggle-row">
            <button
              className={`cb-toggle${formPrescribed ? ' cb-toggle--on' : ''}`}
              type="button"
              role="switch"
              aria-checked={formPrescribed}
              onClick={() => setFormPrescribed(p => !p)}
            >
              <span className="cb-toggle-knob" />
            </button>
            <span className="cb-toggle-label">
              {formPrescribed ? 'Prescription (Rx)' : 'Over the counter (OTC)'}
            </span>
          </div>

          {formError && <p className="cb-form-error" role="alert">{formError}</p>}

          <button className="cb-submit-btn" onClick={handleSave} disabled={formLoading}>
            {formLoading ? 'Saving…' : 'Save to cabinet'}
          </button>
          <button className="cb-cancel-btn" onClick={cancelToList}>Cancel</button>
        </div>
      </div>
    )
  }

  // ── List view (default) ───────────────────────────────────────
  const filteredItems = allowedItemIds
    ? items.filter(i => allowedItemIds.has(i.iId))
    : items

  // Group items by (medicineId, strength, prescribed). Each group renders as
  // either a single card or a parent-with-batches card. Splitting on
  // `prescribed` keeps a mixed-Rx/OTC supply for the same SKU honest in the
  // Rx/OTC sections. AK-128 — `strength` is part of the key so that "Crocin
  // 500" and "Crocin 650" stay as separate cards even when a user typed both
  // under the same brand label; an absent strength collapses to '' so older
  // un-enriched items still group with each other.
  type Group = {
    key: string
    medicineId: string
    prescribed: boolean
    items: CabinetItem[]
    canonical: CabinetItem      // first item, used for shared metadata
  }
  const groupMap = new Map<string, Group>()
  for (const item of filteredItems) {
    const key = `${item.medicineId}|${item.strength ?? ''}|${item.prescribed ? 'rx' : 'otc'}`
    let g = groupMap.get(key)
    if (!g) {
      g = { key, medicineId: item.medicineId, prescribed: item.prescribed, items: [], canonical: item }
      groupMap.set(key, g)
    }
    g.items.push(item)
  }
  // Sort batches within each group by expiry (soonest first).
  for (const g of groupMap.values()) g.items.sort(byExpirySoonest)
  // Group-level sort: groups with the soonest-expiring batch surface first.
  const allGroups = Array.from(groupMap.values()).sort((a, b) =>
    daysUntilExpiry(a.items[0]) - daysUntilExpiry(b.items[0]),
  )
  const rxGroups  = allGroups.filter(g => g.prescribed)
  const otcGroups = allGroups.filter(g => !g.prescribed)

  // Find the active treatments using a given cabinet item iId.
  // Cheap O(N) scan — `activeRegimens` is small (dozens at most per household).
  function treatmentsUsingItem(iId: string): Treatment[] {
    const tIds = new Set<string>()
    for (const r of activeRegimens) if (r.cabinetItemId === iId) tIds.add(r.tId)
    return activeTreatments.filter(t => tIds.has(t.tId))
  }

  // ── Bottom-sheet renderer (Fix 3) ─────────────────────────────
  function renderDetailSheet() {
    const group = selectedGroupKey ? groupMap.get(selectedGroupKey) : null
    if (!group) return null
    const c = group.canonical
    const name = itemDisplayName(c)
    const totalQty = group.items.reduce((sum, it) => sum + it.quantityOnHand, 0)
    const usedIn = group.items.flatMap(it => treatmentsUsingItem(it.iId))
    // Dedupe by tId.
    const usedInDedup = Array.from(new Map(usedIn.map(t => [t.tId, t])).values())
    return (
      <div
        className="bs-overlay"
        onClick={() => setSelectedGroupKey(null)}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bs-title"
      >
        <div className="bs-sheet" onClick={e => e.stopPropagation()}>
          <span className="bs-handle" aria-hidden="true" />
          <div className="bs-title-row">
            <h2 id="bs-title" className="bs-title">{name}</h2>
            <span className={`cb-rx-badge cb-rx-badge--${group.prescribed ? 'rx' : 'otc'}`}>
              {group.prescribed ? 'Rx' : 'OTC'}
            </span>
          </div>

          {/* Medicine identity */}
          <ul className="bs-meta">
            {c.activeIngredients && (
              <li><span className="bs-meta-label">Active ingredients</span><span>{c.activeIngredients}</span></li>
            )}
            {c.strength && (
              <li><span className="bs-meta-label">Strength</span><span>{c.strength}</span></li>
            )}
            {c.dosageForm && (
              <li><span className="bs-meta-label">Dosage form</span><span>{c.dosageForm}</span></li>
            )}
            {c.marketer && (
              <li><span className="bs-meta-label">Marketer</span><span>{c.marketer}</span></li>
            )}
            {c.storageInstructions && (
              <li><span className="bs-meta-label">Storage</span><span>{c.storageInstructions}</span></li>
            )}
          </ul>

          {/* Batches */}
          {group.items.length > 1 && (
            <section className="bs-section">
              <h3 className="bs-section-title">Batches ({group.items.length}) · Total: {totalQty} {c.unit === 'ml' ? 'ml' : (totalQty === 1 ? c.unit : `${c.unit}s`)}</h3>
              <ul className="bs-batch-list">
                {group.items.map((it, idx) => {
                  const status = getStatus(it)
                  return (
                    <li key={it.iId} className="bs-batch-row">
                      <span className="bs-batch-label">Batch {idx + 1}</span>
                      <span className="bs-batch-qty">{it.quantityOnHand} {unitLabel(it)}</span>
                      <span className="bs-batch-exp">
                        {it.expiryDate ? `Exp: ${formatExpiry(it.expiryDate)}` : 'No expiry set'}
                      </span>
                      <span className={`cb-badge cb-badge--${status}`}>
                        {status === 'in-stock' ? 'In Stock'
                          : status === 'low-stock' ? 'Low Stock'
                          : 'Expired'}
                      </span>
                      {!readOnly && (
                        // AK-150 — Per-batch soft delete. stopPropagation
                        // so the tap doesn't bubble to the sheet's overlay
                        // close handler.
                        <button
                          type="button"
                          className="bs-batch-delete"
                          aria-label={`Delete batch ${idx + 1}`}
                          title={`Delete batch ${idx + 1}`}
                          onClick={(e) => { e.stopPropagation(); startDispose([it]) }}
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            </section>
          )}

          {/* Used in treatments */}
          <section className="bs-section">
            <h3 className="bs-section-title">Used in treatments</h3>
            {usedInDedup.length === 0 ? (
              <p className="bs-empty">Not used in any active treatment</p>
            ) : (
              <ul className="bs-treatment-list">
                {usedInDedup.map(t => (
                  <li key={t.tId} className="bs-treatment-row">
                    <span>{t.name}</span>
                    {t.memberName && <span className="bs-treatment-member">{t.memberName}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="bs-actions">
            {!readOnly && (() => {
              // AK-151 + AK-130 — Edit gating. Catalog (masterDb-picked) items
              // are now editable too; updateCabinetItem's field whitelist
              // (quantity / expiry / brand / strength / dosage form / unit /
              // displayNameOverride) is what bounds a safe edit. The only
              // remaining block is multi-batch groups — those must be edited as
              // individual batches from the cabinet list.
              const isSingleBatch = group.items.length === 1
              const editable = isSingleBatch
              const disabledReason = !isSingleBatch
                ? 'Edit not available for batches with multiple items. Edit individual batches from the cabinet list.'
                : undefined
              return (
                <button
                  type="button"
                  className="bs-btn bs-btn--secondary"
                  disabled={!editable}
                  title={disabledReason}
                  onClick={editable ? () => startEdit(group.items[0]) : undefined}
                >
                  Edit
                </button>
              )
            })()}
            {/* AK-174: Add stock — inventory management, separate from the refill decision.
                When Request Refill (AK-162) lands, it takes primary weight; Add stock stays secondary. */}
            {!readOnly && (
              <button
                type="button"
                className="bs-btn bs-btn--secondary"
                onClick={() => openAddStock(group.items[0])}
              >
                Add stock
              </button>
            )}
            {!readOnly && (
              // AK-150 — Medicine-level (group-level) soft delete. Disposes
              // every batch in the group. Works for both single-batch and
              // multi-batch groups; the per-batch trash icons inside the
              // batch list cover the single-batch-out-of-many case.
              <button
                type="button"
                className="bs-btn bs-btn--danger"
                onClick={() => startDispose(group.items)}
              >
                Delete medicine
              </button>
            )}
            <button
              type="button"
              className="bs-btn bs-btn--primary"
              onClick={() => setSelectedGroupKey(null)}
            >
              Close
            </button>
          </div>

          {/* AK-150 — Dispose confirmation modal. One copy serves both
              per-batch and medicine-level delete; the count of items and
              affected treatments adapts the message. */}
          {disposingItems && (
            <div
              className="bs-overlay"
              onClick={cancelDispose}
              role="dialog"
              aria-modal="true"
              aria-labelledby="dispose-confirm-title"
            >
              <div className="bs-sheet" onClick={(e) => e.stopPropagation()}>
                <span className="bs-handle" aria-hidden="true" />
                <h2 id="dispose-confirm-title" className="bs-title">
                  {disposingItems.length === 1
                    ? 'Delete this batch?'
                    : `Delete ${disposingItems.length} batches?`}
                </h2>
                <p style={{ marginTop: 8 }}>
                  {disposeAffected.length === 0
                    ? 'This batch is not used in any active treatment.'
                    : disposeAffected.length === 1
                      ? `This medicine is used in ${disposeAffected[0].name}. Deleting it won't stop the treatment but doses can no longer debit inventory. Continue?`
                      : `This medicine is used in ${disposeAffected.length} active treatments: ${disposeAffected.map(t => t.name).join(', ')}. Deleting it won't stop the treatments but doses can no longer debit inventory. Continue?`}
                </p>
                <div className="bs-actions" style={{ marginTop: 16 }}>
                  <button
                    type="button"
                    className="bs-btn bs-btn--secondary"
                    onClick={cancelDispose}
                    disabled={disposeLoading}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="bs-btn bs-btn--danger"
                    onClick={confirmDispose}
                    disabled={disposeLoading}
                  >
                    {disposeLoading ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* AK-174 — Add stock modal. Mirrors the dispose modal's bs-overlay /
              bs-sheet shape and the edit view's cb-field / cb-input form
              styling. Atomic write goes through addStock (item update + event
              row in one transaction). No source-asking copy per ticket. */}
          {addStockTarget && (() => {
            const qtyNum = parseFloat(addStockQty)
            const qtyValid = !isNaN(qtyNum) && qtyNum > 0
            return (
              <div
                className="bs-overlay"
                onClick={addStockLoading ? undefined : cancelAddStock}
                role="dialog"
                aria-modal="true"
                aria-labelledby="add-stock-title"
              >
                <div className="bs-sheet" onClick={(e) => e.stopPropagation()}>
                  <span className="bs-handle" aria-hidden="true" />
                  <h2 id="add-stock-title" className="bs-title">Add stock</h2>
                  <p className="bs-meta-line">
                    Update your cabinet count when you get medicine from anywhere.
                  </p>

                  <div className="cb-form" style={{ marginTop: 12 }}>
                    <div className="cb-field">
                      <label className="cb-label" htmlFor="as-qty">Quantity</label>
                      <input
                        id="as-qty"
                        type="number"
                        inputMode="numeric"
                        min={1}
                        step="any"
                        className="cb-input"
                        value={addStockQty}
                        onChange={(e) => setAddStockQty(e.target.value)}
                        autoFocus
                      />
                    </div>
                    <div className="cb-field">
                      <label className="cb-label" htmlFor="as-exp">Expiry date</label>
                      <input
                        id="as-exp"
                        type="date"
                        className="cb-input"
                        value={addStockExpiry}
                        onChange={(e) => setAddStockExpiry(e.target.value)}
                      />
                    </div>
                    <div className="cb-field">
                      <label className="cb-label" htmlFor="as-batch">Batch number</label>
                      <input
                        id="as-batch"
                        type="text"
                        className="cb-input"
                        value={addStockBatch}
                        onChange={(e) => setAddStockBatch(e.target.value)}
                      />
                    </div>
                    <div className="cb-field">
                      <label className="cb-label" htmlFor="as-notes">Notes</label>
                      <input
                        id="as-notes"
                        type="text"
                        maxLength={200}
                        className="cb-input"
                        value={addStockNotes}
                        onChange={(e) => setAddStockNotes(e.target.value)}
                      />
                      <p className="cb-hint" style={{ marginTop: 4 }}>
                        {addStockNotes.length} / 200
                      </p>
                    </div>
                    {addStockError && (
                      <p className="cb-form-error" role="alert">{addStockError}</p>
                    )}
                  </div>

                  <div className="bs-actions" style={{ marginTop: 16 }}>
                    <button
                      type="button"
                      className="bs-btn bs-btn--secondary"
                      onClick={cancelAddStock}
                      disabled={addStockLoading}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="bs-btn bs-btn--primary"
                      onClick={confirmAddStock}
                      disabled={!qtyValid || addStockLoading}
                    >
                      {addStockLoading ? 'Adding…' : 'Add stock'}
                    </button>
                  </div>
                </div>
              </div>
            )
          })()}

          {/* AK-174 — Success toast. Fades after 2.4s via the timer in
              confirmAddStock. Same .db-toast styling used elsewhere. */}
          {addStockToast && (
            <div className="db-toast" role="status" aria-live="polite">
              {addStockToast}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Per-group card rendering (single-batch OR parent + indented batches) ─
  function renderGroupCard(group: Group) {
    const c = group.canonical
    const name = itemDisplayName(c)
    if (group.items.length === 1) {
      const item = group.items[0]
      const status   = getStatus(item)
      const days     = daysUntilExpiry(item)
      const expClass =
        days < 0           ? 'cb-item-card--expiring-critical' :
        days <= 5          ? 'cb-item-card--expiring-critical' :
        days <= 10         ? 'cb-item-card--expiring-soon'     : ''
      const expBadge: { cls: string; label: string } | null =
        days < 0      ? { cls: 'cb-expiry-badge cb-expiry-badge--critical', label: 'Expired' } :
        days <= 5     ? { cls: 'cb-expiry-badge cb-expiry-badge--critical', label: `Expires in ${days} day${days === 1 ? '' : 's'}` } :
        days <= 10    ? { cls: 'cb-expiry-badge cb-expiry-badge--warn',     label: `Expires in ${days} days` } :
                        null
      return (
        <li
          key={group.key}
          className={`db-card cb-item-card ${expClass} cb-item-card--tappable`}
          onClick={() => setSelectedGroupKey(group.key)}
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setSelectedGroupKey(group.key) }}
        >
          <div className="cb-item-top">
            <span className="cb-item-name-wrap">
              <span className="cb-item-name">{name}</span>
              <span className={`cb-rx-badge cb-rx-badge--${group.prescribed ? 'rx' : 'otc'}`}>
                {group.prescribed ? 'Rx' : 'OTC'}
              </span>
            </span>
            <span className={`cb-badge cb-badge--${status}`}>
              {status === 'in-stock' ? 'In Stock'
                : status === 'low-stock' ? 'Low Stock'
                : 'Expired'}
            </span>
          </div>
          <div className="cb-item-bottom">
            <span className="cb-item-qty">{item.quantityOnHand} {unitLabel(item)}</span>
            {item.expiryDate && (
              <span className="cb-item-expiry">Exp: {formatExpiry(item.expiryDate)}</span>
            )}
          </div>
          {expBadge && (
            <span className={expBadge.cls} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
              {expBadge.label}
            </span>
          )}
          {item.interactionWarning && (
            <>
              <button
                type="button"
                className="cb-interaction-badge"
                onClick={(e) => {
                  e.stopPropagation()
                  setExpandedInteractionIid((prev) =>
                    prev === item.iId ? null : item.iId,
                  )
                }}
                aria-expanded={expandedInteractionIid === item.iId}
              >
                ⚠ Interaction risk
              </button>
              {expandedInteractionIid === item.iId && (
                <div
                  className="cb-interaction-expanded"
                  onClick={(e) => e.stopPropagation()}
                  role="region"
                  aria-label="Interaction details"
                >
                  <p className="cb-interaction-description">
                    {item.interactionWarning.description}
                  </p>
                  {item.interactionWarning.withMedicineNames.length > 0 && (
                    <p className="cb-interaction-with">
                      With: {item.interactionWarning.withMedicineNames.join(', ')}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </li>
      )
    }
    // Multi-batch parent + indented children
    const totalQty = group.items.reduce((sum, it) => sum + it.quantityOnHand, 0)
    const totalLabel = c.unit === 'ml' ? 'ml' : (totalQty === 1 ? c.unit : `${c.unit}s`)
    return (
      <li
        key={group.key}
        className="db-card cb-item-card cb-group-card cb-item-card--tappable"
        onClick={() => setSelectedGroupKey(group.key)}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setSelectedGroupKey(group.key) }}
      >
        <div className="cb-item-top">
          <span className="cb-item-name-wrap">
            <span className="cb-item-name">{name}</span>
            <span className={`cb-rx-badge cb-rx-badge--${group.prescribed ? 'rx' : 'otc'}`}>
              {group.prescribed ? 'Rx' : 'OTC'}
            </span>
          </span>
          <span className="cb-batch-count">{group.items.length} batches</span>
        </div>
        <p className="cb-group-total">Total: {totalQty} {totalLabel}</p>
        <ul className="cb-batch-list" onClick={e => e.stopPropagation()}>
          {group.items.map((it, idx) => {
            const status = getStatus(it)
            return (
              <li key={it.iId} className="cb-batch-mini">
                <span className="cb-batch-mini-label">Batch {idx + 1}</span>
                <span className="cb-batch-mini-qty">{it.quantityOnHand} {unitLabel(it)}</span>
                <span className="cb-batch-mini-exp">
                  {it.expiryDate ? `Exp: ${formatExpiry(it.expiryDate)}` : 'No expiry'}
                </span>
                <span className={`cb-badge cb-badge--${status} cb-batch-mini-badge`}>
                  {status === 'in-stock' ? 'In Stock'
                    : status === 'low-stock' ? 'Low Stock'
                    : 'Expired'}
                </span>
              </li>
            )
          })}
        </ul>
      </li>
    )
  }

  return (
    <div className="cb-view">
      <div className="cb-list-header">
        <h2 className="cb-page-title">{readOnly ? 'My Medicines' : 'Medicine Cabinet'}</h2>
        {!readOnly && (
          <button className="cb-add-btn" onClick={openSearch}>
            <PlusIcon />
            <span>Add medicine</span>
          </button>
        )}
      </div>

      {/* ── Restock requests (admin only; hidden when none pending) ── */}
      {!readOnly && restockRequests.length > 0 && (
        <div className="cb-restock-card">
          <button
            type="button"
            className="cb-restock-header"
            onClick={() => setRestockExpanded(x => !x)}
            aria-expanded={restockExpanded}
          >
            <span className="cb-restock-icon" aria-hidden="true">
              <AlertTriangle size={16} />
            </span>
            <span className="cb-restock-title">Restock requests</span>
            <span className="cb-restock-count">{restockRequests.length}</span>
            <ChevronDown
              size={18}
              className={`cb-restock-chev${restockExpanded ? ' cb-restock-chev--open' : ''}`}
              aria-hidden="true"
            />
          </button>
          {restockExpanded && (
            <ul className="cb-restock-list">
              {restockRequests.map(r => {
                const resolving = resolvingRequestId === r.requestId
                const requesterName = memberNameById[r.requestedBy] ?? 'A member'
                return (
                  <li key={r.requestId} className="cb-restock-item">
                    <p className="cb-restock-medicine">{r.medicineName}</p>
                    <p className="cb-restock-meta">Requested by {requesterName}</p>
                    <p className="cb-restock-meta">
                      Had {r.quantityAtRequest} remaining · {timeAgo(r.requestedAt)}
                    </p>
                    <div className="cb-restock-actions">
                      <button
                        type="button"
                        className="cb-restock-btn cb-restock-btn--fulfill"
                        onClick={() => resolveRestock(r.requestId, 'fulfilled')}
                        disabled={resolving}
                      >
                        {resolving ? 'Saving…' : 'Mark fulfilled'}
                      </button>
                      <button
                        type="button"
                        className="cb-restock-btn cb-restock-btn--dismiss"
                        onClick={() => resolveRestock(r.requestId, 'dismissed')}
                        disabled={resolving}
                      >
                        Dismiss
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {loadingList && (
        <div className="cb-loader">
          <div className="cb-spinner" role="status" aria-label="Loading" />
        </div>
      )}

      {!loadingList && listError && (
        <p className="cb-hint cb-hint--error" role="alert">{listError}</p>
      )}

      {!loadingList && !listError && allGroups.length === 0 && (
        <div className="db-card db-empty-state">
          <div className="empty-state-icon">
            <Pill size={28} color="#5DC1C8" />
          </div>
          <p className="db-empty-text">
            {readOnly ? 'No medicines linked to your treatments yet' : 'No medicines yet'}
          </p>
          {!readOnly && <p className="db-empty-sub">Tap + to add your first.</p>}
        </div>
      )}

      {!loadingList && rxGroups.length > 0 && (
        <>
          <h3 className="db-section-title">Prescription (Rx)</h3>
          <ul className="cb-item-list">{rxGroups.map(g => renderGroupCard(g))}</ul>
        </>
      )}

      {!loadingList && otcGroups.length > 0 && (
        <>
          <h3 className="db-section-title">Over the counter (OTC)</h3>
          <ul className="cb-item-list">{otcGroups.map(g => renderGroupCard(g))}</ul>
        </>
      )}

      {renderDetailSheet()}

      {treatmentInteractionWarning && (
        <TreatmentInteractionWarningModal
          warning={treatmentInteractionWarning}
          onDismiss={() => setTreatmentInteractionWarning(null)}
          onRemove={() => {
            const { iId, cabinetId } = treatmentInteractionWarning
            // Close the modal first; the delete is async and fire-and-forget
            // (the subscribeCabinetItems listener will remove the item from
            // state as soon as Firestore processes the delete). Errors are
            // swallowed — the admin can re-attempt via the cabinet card.
            setTreatmentInteractionWarning(null)
            void deleteCabinetItem(hId, cabinetId, iId).catch(() => {})
          }}
        />
      )}
    </div>
  )
}

function BackIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.8"/>
      <path d="M16.5 16.5L21 21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  )
}
