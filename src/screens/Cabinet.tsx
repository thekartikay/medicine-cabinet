import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, ChevronDown, Pill } from 'lucide-react'
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
} from '../services/firestoreService'
import { checkCabinetInteractions } from '../services/geminiService'
import { todayISTString } from '../lib/paths'
import type {
  CabinetItem,
  CabinetItemUnit,
  DosageForm,
  MasterMedicine,
  Regimen,
  RestockRequest,
  Treatment,
} from '../types'
import { timeAgo } from './NotificationsPanel'

type CabinetView = 'list' | 'search' | 'enrich' | 'cabinet-details'

interface Props {
  hId: string
  // When provided, the screen renders as read-only and items are filtered to
  // the medicines used in this user's treatments only.
  readOnly?: boolean
  filterByPatientUid?: string
}

const DOSAGE_FORM_LABELS: Record<DosageForm, string> = {
  tablet:    'Tablet',
  capsule:   'Capsule',
  syrup:     'Syrup',
  injection: 'Injection',
  cream:     'Cream',
  drops:     'Drops',
  spray:     'Spray',
  powder:    'Powder',
  inhaler:   'Inhaler',
  patch:     'Patch',
}

const UNIT_LABELS: Record<CabinetItemUnit, string> = {
  tablet:  'Tablets',
  capsule: 'Capsules',
  ml:      'ml',
  spray:   'Sprays',
  dose:    'Doses',
}

function itemDisplayName(item: CabinetItem): string {
  return item.displayNameOverride ?? item.brandName ?? item.medicineId
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

export function CabinetTab({ hId, readOnly = false, filterByPatientUid }: Props) {
  const [view, setView] = useState<CabinetView>('list')
  const [cId, setCId] = useState<string | null>(null)
  const [items, setItems] = useState<CabinetItem[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [listError, setListError] = useState('')
  // AK-39 — Per-card expansion state for the interaction badge. Tracks which
  // item's warning details are currently open; null when collapsed.
  const [expandedInteractionIid, setExpandedInteractionIid] = useState<string | null>(null)

  // search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<MasterMedicine[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── manual / enrichment form state ─────────────────────────────
  const [formBrand,   setFormBrand]   = useState('')
  const [formDosageForm, setFormDosageForm] = useState<DosageForm>('tablet')
  const [formStrength, setFormStrength] = useState('')
  const [formQuantity, setFormQuantity] = useState('')
  const [formUnit, setFormUnit] = useState<CabinetItemUnit>('tablet')
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
    setFormBrand('')
    setFormDosageForm('tablet')
    setFormStrength('')
    setFormQuantity('')
    setFormUnit('tablet')
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

  function openSearch() {
    setSearchQuery('')
    setSearchResults([])
    setView('search')
  }

  function startEnrich(prefillBrand = '') {
    resetForm()
    setFormBrand(prefillBrand)
    setView('enrich')
  }

  function continueToCabinet() {
    if (!formBrand.trim())    { setFormError('Brand name is required.');   return }
    if (!formStrength.trim()) { setFormError('Strength is required.');     return }
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
    try {
      const newIid = await addCabinetItem(hId, cId, {
        medicineId: formBrand.trim(),
        displayNameOverride: null,
        quantityOnHand: parseInt(formQuantity, 10),
        unit: formUnit,
        expiryDate: formExpiry || null,
        prescribed: formPrescribed,
        brandName: formBrand.trim(),
        dosageForm: formDosageForm,
        strength: formStrength.trim() || null,
        activeIngredients: formActiveIngr.trim() || null,
        marketer: formMarketer.trim() || null,
        storageInstructions: formStorage.trim() || null,
      })
      // The subscribeCabinetItems listener installed on mount will pick up the
      // new doc and re-set items state automatically — no manual refetch.
      cancelToList()

      // AK-39 — Fire-and-forget passive interaction check. Never awaited, never
      // surfaces errors to the user; informational badge only. The newItem
      // object is built locally from form data + the returned iId; only the
      // fields checkCabinetInteractions reads are needed, so a cast covers
      // the (server-stamped) timestamp fields that aren't available client-side.
      if (otherItems.length > 0) {
        const newItem = {
          iId: newIid,
          cId: cabinetIdLocal,
          hId,
          medicineId: formBrand.trim(),
          displayNameOverride: null,
          quantityOnHand: parseInt(formQuantity, 10),
          unit: formUnit,
          expiryDate: formExpiry || null,
          prescribed: formPrescribed,
          brandName: formBrand.trim(),
          dosageForm: formDosageForm,
          strength: formStrength.trim() || null,
          activeIngredients: formActiveIngr.trim() || null,
          marketer: formMarketer.trim() || null,
          storageInstructions: formStorage.trim() || null,
        } as CabinetItem
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
                  onClick={() => startEnrich(med.name)}
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
              <label className="cb-label" htmlFor="cb-form">Dosage form</label>
              <select
                id="cb-form"
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
              <label className="cb-label" htmlFor="cb-strength">Strength</label>
              <input
                id="cb-strength"
                className="cb-input"
                type="text"
                placeholder="500mg"
                value={formStrength}
                onChange={e => setFormStrength(e.target.value)}
              />
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

  // Group items by (medicineId, prescribed). Each group renders as either a
  // single card or a parent-with-batches card. Splitting on `prescribed` keeps
  // a mixed-Rx/OTC supply for the same SKU honest in the Rx/OTC sections.
  type Group = {
    key: string
    medicineId: string
    prescribed: boolean
    items: CabinetItem[]
    canonical: CabinetItem      // first item, used for shared metadata
  }
  const groupMap = new Map<string, Group>()
  for (const item of filteredItems) {
    const key = `${item.medicineId}|${item.prescribed ? 'rx' : 'otc'}`
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
            {!readOnly && (
              <button type="button" className="bs-btn bs-btn--secondary" disabled>
                Edit
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
