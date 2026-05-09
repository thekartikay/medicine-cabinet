import { useEffect, useRef, useState } from 'react'
import { signOut } from 'firebase/auth'
import type { User } from 'firebase/auth'
import { httpsCallable } from 'firebase/functions'
import {
  Home, Pill, HeartPulse, Settings as SettingsIcon, Sparkles,
  Check, Clock, X, Minus, Bell, ChevronDown,
} from 'lucide-react'
import { auth, functions } from '../lib/firebase'
import { todayISTString } from '../lib/paths'
import {
  getDefaultCabinetItems,
  subscribeTreatments,
  loadTodaysDoses,
  loadTodaysLogs,
  loadAllActiveRegimens,
  logDose,
  adminMarkAsTaken,
  subscribeNotifications,
  subscribeTodaySummary,
  getMemberDisplayName,
} from '../services/firestoreService'
import type { TodaySummary } from '../types'
import { NotificationsPanel } from './NotificationsPanel'
import type { CabinetItem, DoseSlotDisplay, DoseStatus, FoodTiming, Notification } from '../types'
import { CabinetTab } from './Cabinet'
import { SettingsTab } from './Settings'
import { TreatmentsTab } from './Treatments'
import { DoseHistory } from './DoseHistory'
import { MemberSettings } from './MemberSettings'
import { MemberDoseCard } from './MemberDoseCard'

type Tab = 'dashboard' | 'cabinet' | 'treatments' | 'settings'

interface Props {
  user: User
  household: { hId: string; name: string }
  role: 'admin' | 'member' | 'caregiver'
  onAccountDeleted: () => void
}

type StockStatus = 'in-stock' | 'low-stock' | 'expired'

function stockStatus(item: CabinetItem): StockStatus {
  const today = todayISTString()
  if (item.expiryDate && item.expiryDate < today) return 'expired'
  if (item.quantityOnHand === 0) return 'expired'
  if (item.quantityOnHand <= 10) return 'low-stock'
  return 'in-stock'
}

const BADGE: Record<StockStatus, { label: string; cls: string }> = {
  'in-stock':  { label: 'In Stock',  cls: 'cb-badge--in-stock'  },
  'low-stock': { label: 'Low Stock', cls: 'cb-badge--low-stock' },
  'expired':   { label: 'Expired',   cls: 'cb-badge--expired'   },
}

function unitLabel(item: CabinetItem): string {
  if (item.unit === 'ml') return 'ml'
  return item.quantityOnHand === 1 ? item.unit : `${item.unit}s`
}

const FOOD_LABELS: Record<FoodTiming, string> = {
  before: 'Before food',
  after: 'After food',
  with: 'With food',
}

function doseUnitLabel(amount: number, unit: string): string {
  if (unit === 'ml') return 'ml'
  return amount === 1 ? unit : `${unit}s`
}

type LogState = {
  status: DoseStatus
  skipReason: string | null
  lateNote: string | null
  adminOverride: boolean
  createdBy: string | null
}

// ── Skip-reason validation ──────────────────────────────────
// a) trimmed length >= 25  (also covers "only whitespace")
// b) at least 60% of (trimmed) characters are letters a-z/A-Z
const SKIP_MIN_CHARS = 25
const SKIP_MIN_LETTER_PCT = 0.6
const SKIP_ERROR =
  'Please describe the reason in your own words (minimum 25 characters)'

function validateSkipReason(text: string): { valid: boolean; count: number } {
  const trimmed = text.trim()
  const letterCount = (trimmed.match(/[a-zA-Z]/g) ?? []).length
  const letterPct = trimmed.length > 0 ? letterCount / trimmed.length : 0
  return {
    valid: trimmed.length >= SKIP_MIN_CHARS && letterPct >= SKIP_MIN_LETTER_PCT,
    count: trimmed.length,
  }
}

// ── Late time picker helpers ────────────────────────────────
function nowISTHM(): { h: number; m: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date())
  return {
    h: Number(parts.find(p => p.type === 'hour')?.value ?? '0'),
    m: Number(parts.find(p => p.type === 'minute')?.value ?? '0'),
  }
}

// 30-min increments from max(now, scheduledTime), rounded up, through 23:30 IST.
// Returns [] if no slots remain today.
function generateLateOptionsForSlot(scheduledTime: string): string[] {
  const { h: nowH, m: nowM } = nowISTHM()
  const [schedH, schedM] = scheduledTime.split(':').map(Number)
  const nowMins   = nowH   * 60 + nowM
  const schedMins = schedH * 60 + schedM
  let minMins = Math.max(nowMins, schedMins)
  // Round up to next 30-minute mark
  if (minMins % 30 !== 0) minMins = Math.ceil(minMins / 30) * 30
  const maxMins = 23 * 60 + 30
  const options: string[] = []
  for (let mins = minMins; mins <= maxMins; mins += 30) {
    const h = Math.floor(mins / 60)
    const m = mins % 60
    options.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`)
  }
  return options
}

function formatTimeFriendly(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const period = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

// Current IST time as "HH:MM" — used to decide whether an unlogged dose has
// crossed its scheduled time and should display as "Missed" instead of "Pending".
function nowHHMM(): string {
  const { h, m } = nowISTHM()
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// Positive when the slot's scheduled time is in the past (mins ago); negative
// for future slots. Used both to drive the missed/pending classification and
// to gate the "Send Reminder" button (>30 min past per spec).
const MISSED_GRACE_MIN = 30
function minsSinceScheduledHHMM(slotTime: string): number {
  const [sh, sm] = slotTime.split(':').map(Number)
  const { h: nh, m: nm } = nowISTHM()
  return (nh * 60 + nm) - (sh * 60 + sm)
}

// Recover the late-time the user committed to when they tapped "Late".
// New logs store it as `skipReason: "Taking at 4:30 pm"`; old logs stored
// only `lateNote: "16:30"`. Both produce the same display.
function lateDetail(log: LogState): string {
  if (log.skipReason) {
    const m = log.skipReason.match(/^Taking at\s+(.+)$/i)
    if (m) return `Late — taken at ${m[1]}`
    return `Late — ${log.skipReason}`
  }
  if (log.lateNote) return `Late — taken at ${formatTimeFriendly(log.lateNote)}`
  return 'Late'
}

// Status-readout kinds used in Priya's read-only dashboard. Five variants
// per the design spec: pending / taken / late / missed / skipped.
type ReadoutKind = 'pending' | 'taken' | 'late' | 'missed' | 'skipped'

const READOUT_LABEL: Record<ReadoutKind, string> = {
  pending: 'Pending',
  taken:   'Taken',
  late:    'Late',
  missed:  'Missed',
  skipped: 'Skipped',
}

export function Dashboard({ user, household, role, onAccountDeleted }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard')
  // Lazy-persist tab mounting: tabs mount on first tap and stay mounted
  // (hidden via display:none when not active). Subscriptions inside tabs
  // therefore don't run until the user has actually visited that tab.
  // Initial load: only 'dashboard' is in the set, so no tab subs are alive.
  const [visitedTabs, setVisitedTabs] = useState<Set<Tab>>(new Set(['dashboard']))
  function visitTab(tab: Tab) {
    setActiveTab(tab)
    setVisitedTabs(prev => prev.has(tab) ? prev : new Set(prev).add(tab))
  }
  // Sub-view inside the dashboard tab. 'history' renders DoseHistory in place
  // of the live dashboard panels; back button restores 'home'.
  const [dashSubview, setDashSubview] = useState<'home' | 'history'>('home')
  const [showAiModal, setShowAiModal] = useState(false)
  const [stockItems, setStockItems] = useState<CabinetItem[]>([])
  const [todaysDoses, setTodaysDoses] = useState<DoseSlotDisplay[]>([])
  const [logsBySlot, setLogsBySlot] = useState<Record<string, LogState>>({})
  const [pendingSlot, setPendingSlot] = useState<string | null>(null)
  const [confirmedSlot, setConfirmedSlot] = useState<string | null>(null)
  const [skipModeFor, setSkipModeFor] = useState<string | null>(null)
  const [skipReasonText, setSkipReasonText] = useState('')
  const [lateModeFor, setLateModeFor] = useState<string | null>(null)
  const [lateOptions, setLateOptions] = useState<string[]>([])
  const [lateTimeChoice, setLateTimeChoice] = useState('')
  const [logError, setLogError] = useState('')
  // Local-only reminder state (Fix 5). Persisting to Firestore is a follow-up
  // when the actual notification dispatch is wired up; for now a tap shows a
  // toast and the button hides for that slot until the page is reloaded.
  const [remindedSlots, setRemindedSlots] = useState<Set<string>>(new Set())
  const [toastMessage, setToastMessage] = useState<string | null>(null)
  // Admin-mark-as-taken modal: which dose slot is being confirmed, plus a
  // pending flag so the Confirm/Cancel buttons disable while the transaction
  // runs.
  const [adminMarkSlot, setAdminMarkSlot] = useState<DoseSlotDisplay | null>(null)
  const [adminMarkPending, setAdminMarkPending] = useState(false)

  // Notifications panel: live-subscribed feed, plus open/close state.
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [showNotifPanel, setShowNotifPanel] = useState(false)

  // Admin display-name cache for "Updated by [name]" notes. Keyed by uid.
  // Map ref avoids re-fetching on every render; the state mirror triggers
  // re-renders when a name resolves so the JSX picks it up.
  const adminNameCache = useRef<Map<string, string | null>>(new Map())
  const [adminNameByUid, setAdminNameByUid] = useState<Record<string, string>>({})

  async function sendReminder(slot: DoseSlotDisplay) {
    // Optimistic — disable the button immediately. Roll back on failure.
    setRemindedSlots(prev => {
      const next = new Set(prev)
      next.add(slot.slotId)
      return next
    })
    try {
      const callable = httpsCallable(functions, 'sendDoseReminder')
      await callable({
        patientId: slot.patientId,
        medicineName: slot.medicineName,
        slotTime: slot.time,
        hId: household.hId,
        slotId: slot.slotId,
      })
      setToastMessage(`Reminder sent to ${slot.memberName ?? 'them'}`)
    } catch (err) {
      setRemindedSlots(prev => {
        const next = new Set(prev)
        next.delete(slot.slotId)
        return next
      })
      const code = (err as { code?: string }).code
      setToastMessage(
        code === 'functions/failed-precondition'
          ? 'Could not send — member may have notifications disabled'
          : 'Failed to send reminder',
      )
    } finally {
      setTimeout(() => setToastMessage(null), 2400)
    }
  }

  async function handleAdminMarkAsTaken(slot: DoseSlotDisplay) {
    setAdminMarkPending(true)
    setLogError('')
    const prior = logsBySlot[slot.slotId]
    // Optimistic: flip to taken+adminOverride. The cabinet item subscription
    // will surface the inventory debit on the next snapshot tick.
    setLogsBySlot(prev => ({
      ...prev,
      [slot.slotId]: {
        status: 'taken',
        skipReason: null,
        lateNote: null,
        adminOverride: true,
        createdBy: user.uid,
      },
    }))
    try {
      await adminMarkAsTaken(household.hId, {
        tId: slot.treatmentId,
        rId: slot.regimenId,
        patientId: slot.patientId,
        cabinetItemId: slot.cabinetItemId,
        scheduledDate: todayISTString(),
        scheduledTime: slot.time,
        doseAmount: slot.doseAmount,
        doseUnit: slot.doseUnit,
        adminUid: user.uid,
        medicineName: slot.medicineName,
        memberName: slot.memberName,
        adminName: user.displayName ?? null,
      })
      setAdminMarkSlot(null)
    } catch {
      setLogsBySlot(prev => {
        const next = { ...prev }
        if (prior) next[slot.slotId] = prior
        else delete next[slot.slotId]
        return next
      })
      setLogError('Could not mark as taken. Please try again.')
    } finally {
      setAdminMarkPending(false)
    }
  }

  // Member/treatment collapsibles for "Today's doses" (Fix 2). Default closed.
  const [expandedMembers, setExpandedMembers] = useState<Set<string>>(new Set())
  const [expandedTreatments, setExpandedTreatments] = useState<Set<string>>(new Set())
  function toggleMember(uid: string) {
    setExpandedMembers(prev => {
      const next = new Set(prev)
      next.has(uid) ? next.delete(uid) : next.add(uid)
      return next
    })
  }
  function toggleTreatment(tId: string) {
    setExpandedTreatments(prev => {
      const next = new Set(prev)
      next.has(tId) ? next.delete(tId) : next.add(tId)
      return next
    })
  }

  // Map cabinetItemId → list of treatment names that depend on it. Used by
  // the stock-alerts section (Fix 1) to show "Affects: …" under OOS items.
  const [affectedByItem, setAffectedByItem] = useState<Record<string, string[]>>({})
  useEffect(() => {
    let cancelled = false
    loadAllActiveRegimens(household.hId)
      .then(({ treatments, regimensByTreatment }) => {
        if (cancelled) return
        const map: Record<string, string[]> = {}
        const treatNameByTId: Record<string, string> = {}
        for (const t of treatments) treatNameByTId[t.tId] = t.name
        for (const [tId, regs] of Object.entries(regimensByTreatment)) {
          const name = treatNameByTId[tId]
          if (!name) continue
          for (const r of regs) {
            if (!map[r.cabinetItemId]) map[r.cabinetItemId] = []
            if (!map[r.cabinetItemId].includes(name)) map[r.cabinetItemId].push(name)
          }
        }
        setAffectedByItem(map)
      })
      .catch(() => { /* leave empty; UI just won't show affects line */ })
    return () => { cancelled = true }
  }, [household.hId, todaysDoses.length])

  const displayName = user.displayName ?? user.phoneNumber ?? 'there'
  const initial = displayName.charAt(0).toUpperCase()

  // Stock alerts: one-time fetch on mount instead of a live subscription. The
  // MC-020 onCabinetItemWritten trigger keeps todaySummary.stockAlerts live
  // for downstream consumers; this section just needs a session-mount snapshot.
  // Trade-off: cabinet edits made by another admin during the session won't
  // surface here until the dashboard remounts. Acceptable to drop one Listen.
  useEffect(() => {
    let cancelled = false
    getDefaultCabinetItems(household.hId)
      .then(items => { if (!cancelled) setStockItems(items) })
      .catch(() => { /* leave empty on error — empty-state UI handles it */ })
    return () => { cancelled = true }
  }, [household.hId])

  // ── Today's data: prefer the Cloud-Function-maintained todaySummary doc
  // (one read regardless of household size, MC-020). Falls back to the direct
  // treatments+logs query path when the summary doc doesn't yet exist (brand-
  // new household before the midnight cron has materialized it; the log
  // trigger will create it on the first dose write).
  const [todaySummary, setTodaySummary] = useState<TodaySummary | null>(null)
  const [summaryLoaded, setSummaryLoaded] = useState(false)

  // Single coordinated effect for today's data:
  //   1. Subscribe to todaySummary on mount.
  //   2. Wait up to 200ms for the first snapshot.
  //   3. If summary exists: use it exclusively, never start the fallback.
  //   4. If summary is null (or timeout fires first): start the fallback,
  //      keep watching todaySummary. The instant a non-null snapshot arrives,
  //      the fallback is torn down so only the single summary listener
  //      remains at steady state.
  useEffect(() => {
    let cancelled = false
    let summaryReceived = false
    let fallbackUnsub: (() => void) | null = null

    function startFallback() {
      if (fallbackUnsub || cancelled) return
      let fbCancelled = false
      const unsub = subscribeTreatments(household.hId, async () => {
        const [doses, fetchedLogs] = await Promise.all([
          loadTodaysDoses(household.hId),
          loadTodaysLogs(household.hId),
        ])
        if (fbCancelled) return
        setTodaysDoses(doses)
        setLogsBySlot(prev => {
          const next: Record<string, LogState> = { ...prev }
          for (const log of fetchedLogs) {
            next[log.slotId] = {
              status: log.status,
              skipReason: log.skipReason ?? null,
              lateNote: log.lateNote ?? null,
              adminOverride: log.adminOverride ?? false,
              createdBy: log.createdBy ?? null,
            }
          }
          return next
        })
      })
      fallbackUnsub = () => { fbCancelled = true; unsub() }
    }

    function stopFallback() {
      if (!fallbackUnsub) return
      fallbackUnsub()
      fallbackUnsub = null
    }

    function applySummary(summary: TodaySummary) {
      const doses: DoseSlotDisplay[] = []
      const logs: Record<string, LogState> = {}
      for (const [patientId, m] of Object.entries(summary.members)) {
        for (const [slotId, s] of Object.entries(m.slots)) {
          doses.push({
            treatmentId: s.treatmentId,
            treatmentName: s.treatmentName,
            memberName: m.displayName,
            medicineName: s.medicineName,
            doseAmount: s.doseAmount,
            doseUnit: s.doseUnit,
            time: s.scheduledTime,
            foodTiming: s.foodTiming,
            regimenId: s.regimenId,
            slotId,
            patientId,
            cabinetItemId: s.cabinetItemId,
          })
          if (s.status !== 'pending') {
            logs[slotId] = {
              status: s.status,
              skipReason: s.skipReason,
              lateNote: s.lateNote,
              adminOverride: s.adminOverride,
              createdBy: s.createdBy,
            }
          }
        }
      }
      doses.sort((a, b) => a.time.localeCompare(b.time))
      setTodaysDoses(doses)
      setLogsBySlot(logs)
    }

    const summaryUnsub = subscribeTodaySummary(
      household.hId,
      todayISTString(),
      summary => {
        if (cancelled) return
        summaryReceived = true
        setSummaryLoaded(true)
        setTodaySummary(summary)
        if (summary) {
          // Tear down the fallback the instant we have authoritative data.
          stopFallback()
          applySummary(summary)
        } else if (!fallbackUnsub) {
          // Doc doesn't exist yet — fall back so the UI isn't blank.
          startFallback()
        }
      },
    )

    // Watchdog: if no snapshot has arrived in 200ms, start the fallback so
    // a slow Firestore handshake doesn't leave the dashboard empty.
    const timer = setTimeout(() => {
      if (cancelled || summaryReceived) return
      startFallback()
    }, 200)

    return () => {
      cancelled = true
      clearTimeout(timer)
      summaryUnsub()
      stopFallback()
    }
  }, [household.hId])

  // Live notifications feed for the alerts panel and the header badge.
  useEffect(() => {
    const unsub = subscribeNotifications(household.hId, setNotifications)
    return () => unsub()
  }, [household.hId])

  // Lazy-resolve admin display names for any admin-overridden log we see,
  // reading from the household's members subcollection (users/{uid} read is
  // self-only, so cross-user lookups must go through members).
  useEffect(() => {
    const todoUids = new Set<string>()
    for (const log of Object.values(logsBySlot)) {
      const uid = log.createdBy
      if (log.adminOverride && uid && !adminNameCache.current.has(uid)) {
        todoUids.add(uid)
      }
    }
    for (const uid of todoUids) {
      adminNameCache.current.set(uid, null)  // mark as in-flight
      getMemberDisplayName(household.hId, uid)
        .then(name => {
          const resolved = name?.trim() || 'admin'
          adminNameCache.current.set(uid, resolved)
          setAdminNameByUid(prev => ({ ...prev, [uid]: resolved }))
        })
        .catch(() => {
          adminNameCache.current.set(uid, 'admin')
          setAdminNameByUid(prev => ({ ...prev, [uid]: 'admin' }))
        })
    }
  }, [logsBySlot, household.hId])

  function startSkipMode(slotId: string) {
    setLateModeFor(null)
    setLateTimeChoice('')
    setSkipReasonText('')
    setSkipModeFor(slotId)
    setLogError('')
  }

  function startLateMode(slot: DoseSlotDisplay) {
    setSkipModeFor(null)
    setSkipReasonText('')
    const opts = generateLateOptionsForSlot(slot.time)
    setLateOptions(opts)
    setLateTimeChoice(opts[0] ?? '')
    setLateModeFor(slot.slotId)
    setLogError('')
  }

  function cancelSkipMode() {
    setSkipModeFor(null)
    setSkipReasonText('')
  }

  function cancelLateMode() {
    setLateModeFor(null)
    setLateTimeChoice('')
  }

  // Log a dose with optimistic UI. On failure, revert and show an error.
  async function handleLogDose(
    slot: DoseSlotDisplay,
    status: DoseStatus,
    opts: { skipReason?: string | null; lateNote?: string | null } = {},
  ) {
    setLogError('')
    setPendingSlot(slot.slotId)

    const skipReason = opts.skipReason ?? null
    const lateNote   = opts.lateNote ?? null

    // Optimistic
    setLogsBySlot(prev => ({
      ...prev,
      [slot.slotId]: { status, skipReason, lateNote, adminOverride: false, createdBy: user.uid },
    }))

    try {
      await logDose(household.hId, {
        tId: slot.treatmentId,
        rId: slot.regimenId,
        patientId: slot.patientId,
        cabinetItemId: slot.cabinetItemId,
        scheduledDate: todayISTString(),
        scheduledTime: slot.time,
        doseAmount: slot.doseAmount,
        doseUnit: slot.doseUnit,
        status,
        skipReason,
        lateNote,
        createdBy: user.uid,
      })

      if (status === 'taken' || status === 'late') {
        setConfirmedSlot(slot.slotId)
        setTimeout(() => setConfirmedSlot(prev => prev === slot.slotId ? null : prev), 1600)
      }
    } catch {
      // Revert
      setLogsBySlot(prev => {
        const next = { ...prev }
        delete next[slot.slotId]
        return next
      })
      setLogError('Could not log dose. Please try again.')
    } finally {
      setPendingSlot(null)
      if (status === 'skipped') cancelSkipMode()
      if (status === 'late')    cancelLateMode()
    }
  }

  const NAV_TABS = [
    { id: 'dashboard'  as const, label: 'Home',       Icon: Home         },
    { id: 'cabinet'    as const, label: 'Cabinet',    Icon: Pill         },
    { id: 'treatments' as const, label: 'Treatments', Icon: HeartPulse   },
    { id: 'settings'   as const, label: 'Settings',   Icon: SettingsIcon },
  ]

  return (
    <div className="db-root">

      {/* ── Header ─────────────────────────────────────────────── */}
      {/* Hidden on the member's home view — MemberDoseCard renders its own
          teal greeting header that doubles as the page header (Fix 3). */}
      {!(role === 'member' && activeTab === 'dashboard' && dashSubview === 'home') && (
      <header className="db-header">
        <div className="db-header-left">
          <span className="db-household-name">{household.name}</span>
        </div>
        <div className="db-user-info">
          {(() => {
            const unread = notifications.filter(n => !n.readBy.includes(user.uid)).length
            return (
              <button
                type="button"
                className="db-bell"
                onClick={() => setShowNotifPanel(true)}
                aria-label={unread > 0 ? `${unread} unread notifications` : 'Notifications'}
              >
                <Bell size={20} />
                {unread > 0 && <span className="db-bell-count">{unread}</span>}
              </button>
            )
          })()}
          {user.photoURL ? (
            <img
              className="db-avatar"
              src={user.photoURL}
              alt={displayName}
              referrerPolicy="no-referrer"
            />
          ) : (
            <span className="db-avatar db-avatar--initial" aria-hidden="true">
              {initial}
            </span>
          )}
          <span className="db-display-name">{displayName}</span>
          <button className="db-signout-btn" onClick={() => signOut(auth)}>
            Sign out
          </button>
        </div>
      </header>
      )}

      {/* ── Scrollable body ─────────────────────────────────────── */}
      <main className={`db-body${role === 'member' && activeTab === 'dashboard' && dashSubview === 'home' ? ' db-body--member-home' : ''}`}>

        {activeTab === 'dashboard' && dashSubview === 'history' && (
          <DoseHistory
            hId={household.hId}
            onBack={() => setDashSubview('home')}
            filterUid={role === 'member' ? user.uid : undefined}
          />
        )}

        {/* Member home: their dose card replaces the admin dashboard panels. */}
        {activeTab === 'dashboard' && dashSubview === 'home' && role === 'member' && (
          <MemberDoseCard user={user} household={household} />
        )}

        {activeTab === 'dashboard' && dashSubview === 'home' && role !== 'member' && (
          <>
            <section className="db-section">
              <h2 className="db-section-title">Today's doses</h2>
              {summaryLoaded && !todaySummary && (
                <p className="db-syncing-note" role="status">Syncing today's data…</p>
              )}
              {todaysDoses.length === 0 ? (
                <div className="db-card db-empty-state">
                  <span className="db-empty-icon" aria-hidden="true">💊</span>
                  <p className="db-empty-text">No treatments set up yet</p>
                  <p className="db-empty-sub">Add a treatment to start tracking doses</p>
                </div>
              ) : (
                <>
                  {logError && <p className="cb-form-error" role="alert">{logError}</p>}
                  {(() => {
                    // Group today's doses by patient → treatment so each member
                    // gets a collapsible card with per-treatment expandables.
                    type Bucket = {
                      patientId: string
                      memberName: string | null
                      treatments: Map<string, { tId: string; treatmentName: string; doses: DoseSlotDisplay[] }>
                    }
                    const buckets = new Map<string, Bucket>()
                    for (const d of todaysDoses) {
                      let b = buckets.get(d.patientId)
                      if (!b) {
                        b = { patientId: d.patientId, memberName: d.memberName, treatments: new Map() }
                        buckets.set(d.patientId, b)
                      }
                      let tb = b.treatments.get(d.treatmentId)
                      if (!tb) {
                        tb = { tId: d.treatmentId, treatmentName: d.treatmentName, doses: [] }
                        b.treatments.set(d.treatmentId, tb)
                      }
                      tb.doses.push(d)
                    }

                    // Per-member summary counts. Skipped doses don't appear in the
                    // 3-state strip and are rendered inline within the dose row.
                    function countsFor(b: Bucket) {
                      let taken = 0, pending = 0, missed = 0
                      for (const tb of b.treatments.values()) {
                        for (const d of tb.doses) {
                          const log = logsBySlot[d.slotId]
                          if (log) {
                            if (log.status === 'taken' || log.status === 'late') taken++
                            else if (log.status === 'missed') missed++
                            continue
                          }
                          if (minsSinceScheduledHHMM(d.time) > MISSED_GRACE_MIN) missed++
                          else pending++
                        }
                      }
                      return { taken, pending, missed }
                    }

                    return (
                      <ul className="db-member-list">
                        {Array.from(buckets.values()).map(b => {
                          const { taken, pending, missed } = countsFor(b)
                          const memberOpen = expandedMembers.has(b.patientId)
                          const initial = (b.memberName ?? 'M').charAt(0).toUpperCase()
                          return (
                            <li key={b.patientId} className="db-card db-member-section">
                              <button
                                type="button"
                                className="db-member-head"
                                onClick={() => toggleMember(b.patientId)}
                                aria-expanded={memberOpen}
                              >
                                <span className="db-member-avatar" aria-hidden="true">{initial}</span>
                                <span className="db-member-name">{b.memberName ?? 'Unknown'}</span>
                                <span className="db-member-counts" aria-label={`${taken} taken, ${pending} pending, ${missed} missed`}>
                                  <span className="db-count db-count--taken">● {taken}</span>
                                  <span className="db-count db-count--pending">◐ {pending}</span>
                                  <span className="db-count db-count--missed">✗ {missed}</span>
                                </span>
                                <ChevronDown
                                  size={18}
                                  className={`db-chevron${memberOpen ? ' db-chevron--open' : ''}`}
                                />
                              </button>

                              {memberOpen && (
                                <div className="db-member-body">
                                  {Array.from(b.treatments.values()).map(tb => {
                                    const txOpen = expandedTreatments.has(tb.tId)
                                    return (
                                      <div key={tb.tId} className="db-treatment-block">
                                        <button
                                          type="button"
                                          className="db-treatment-head"
                                          onClick={() => toggleTreatment(tb.tId)}
                                          aria-expanded={txOpen}
                                        >
                                          <span className="db-treatment-name">{tb.treatmentName}</span>
                                          <ChevronDown
                                            size={16}
                                            className={`db-chevron${txOpen ? ' db-chevron--open' : ''}`}
                                          />
                                        </button>
                                        {txOpen && (
                                          <ul className="tr-dose-list db-treatment-doses">
                                            {tb.doses.map(dose => {
                                              const log              = logsBySlot[dose.slotId]
                                              const isLogged         = !!log
                                              const isPending        = pendingSlot   === dose.slotId
                                              const isConfirmed      = confirmedSlot === dose.slotId
                                              const isAdminsOwnDose  = dose.patientId === user.uid
                                              const minsPast         = minsSinceScheduledHHMM(dose.time)
                                              const beyondGrace      = minsPast > MISSED_GRACE_MIN

                                              const kind: ReadoutKind | null =
                                                isLogged ? log.status :
                                                !isAdminsOwnDose ? (beyondGrace ? 'missed' : 'pending') :
                                                null

                                              let detail: string | null = null
                                              if (isLogged) {
                                                if (log.status === 'taken')   detail = `Taken at ${formatTimeFriendly(dose.time)}`
                                                if (log.status === 'late')    detail = lateDetail(log)
                                                if (log.status === 'skipped') detail = log.skipReason ? `Skipped — ${log.skipReason}` : 'Skipped'
                                              }

                                              const showReminder =
                                                (!isLogged || log?.status === 'missed')
                                                && !isAdminsOwnDose
                                                && beyondGrace
                                              const wasReminded = remindedSlots.has(dose.slotId)

                                              return (
                                                <li
                                                  key={dose.slotId}
                                                  className={`db-card tr-dose-card${isConfirmed ? ' tr-dose-card--just-confirmed' : ''}`}
                                                >
                                                  <div className="tr-dose-row">
                                                    <span className="tr-dose-time">{dose.time}</span>
                                                    <div className="tr-dose-info">
                                                      <span className="tr-dose-medicine">{dose.medicineName}</span>
                                                      <span className="tr-dose-detail">
                                                        {dose.doseAmount} {doseUnitLabel(dose.doseAmount, dose.doseUnit)} · {FOOD_LABELS[dose.foodTiming]}
                                                      </span>
                                                    </div>
                                                    {kind && (
                                                      <span className={`tr-log-badge tr-log-badge--${kind}`}>
                                                        {kind === 'taken'   && <Check size={12} />}
                                                        {kind === 'late'    && <Check size={12} />}
                                                        {kind === 'skipped' && <Minus size={12} />}
                                                        {kind === 'pending' && <Clock size={12} />}
                                                        {kind === 'missed'  && <X     size={12} />}
                                                        {READOUT_LABEL[kind]}
                                                      </span>
                                                    )}
                                                    {role === 'admin' && kind === 'missed' && (
                                                      <button
                                                        type="button"
                                                        className="tr-action tr-action--admin-take"
                                                        onClick={() => setAdminMarkSlot(dose)}
                                                      >
                                                        Mark as taken
                                                      </button>
                                                    )}
                                                  </div>

                                                  {!isLogged && isAdminsOwnDose && (
                                                    <div className="tr-dose-controls">
                                                      <button
                                                        type="button"
                                                        className="tr-action tr-action--taken"
                                                        onClick={() => handleLogDose(dose, 'taken')}
                                                        disabled={isPending}
                                                      >
                                                        <Check size={14} /> Taken
                                                      </button>
                                                      <button
                                                        type="button"
                                                        className="tr-action tr-action--late"
                                                        onClick={() => startLateMode(dose)}
                                                        disabled={isPending}
                                                      >
                                                        <Clock size={14} /> Late
                                                      </button>
                                                      <button
                                                        type="button"
                                                        className="tr-action tr-action--skip"
                                                        onClick={() => startSkipMode(dose.slotId)}
                                                        disabled={isPending}
                                                      >
                                                        Skip
                                                      </button>
                                                    </div>
                                                  )}

                                                  {detail && (
                                                    <p className={`tr-log-reason tr-log-reason--${log!.status}`}>{detail}</p>
                                                  )}

                                                  {log?.adminOverride && (() => {
                                                    const uid = log.createdBy
                                                    const name = uid ? (adminNameByUid[uid] ?? 'admin') : 'admin'
                                                    return (
                                                      <p className="tr-admin-override-note">Updated by {name}</p>
                                                    )
                                                  })()}

                                                  {showReminder && (
                                                    <button
                                                      type="button"
                                                      className={`tr-remind-btn${wasReminded ? ' tr-remind-btn--done' : ''}`}
                                                      onClick={() => !wasReminded && sendReminder(dose)}
                                                      disabled={wasReminded}
                                                    >
                                                      {wasReminded ? (
                                                        <>
                                                          <Check size={11} />
                                                          <span>Reminded ✓</span>
                                                        </>
                                                      ) : (
                                                        <>
                                                          <Bell size={11} />
                                                          <span>Remind {dose.memberName?.split(' ')[0] ?? 'member'}</span>
                                                        </>
                                                      )}
                                                    </button>
                                                  )}
                                                </li>
                                              )
                                            })}
                                          </ul>
                                        )}
                                      </div>
                                    )
                                  })}
                                </div>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )
                  })()}
                </>
              )}

              <button
                type="button"
                className="db-history-link"
                onClick={() => setDashSubview('history')}
              >
                View history →
              </button>
            </section>

            <section className="db-section">
              <h2 className="db-section-title">Stock alerts</h2>

              {stockItems.length === 0 ? (
                <div className="db-card db-empty-state">
                  <span className="db-empty-icon" aria-hidden="true">🗄️</span>
                  <p className="db-empty-text">Your cabinet is empty</p>
                  <p className="db-empty-sub">Add medicines to track your stock</p>
                </div>
              ) : (
                <ul className="cb-item-list">
                  {/* Soonest-expiring first; items without expiry sink to the bottom. */}
                  {stockItems
                    .slice()
                    .sort((a, b) => {
                      const da = a.expiryDate ? Math.floor((new Date(a.expiryDate + 'T00:00:00').getTime() - Date.now()) / 86400000) : Infinity
                      const db = b.expiryDate ? Math.floor((new Date(b.expiryDate + 'T00:00:00').getTime() - Date.now()) / 86400000) : Infinity
                      return da - db
                    })
                    .map(item => {
                    const s = stockStatus(item)
                    const badge = BADGE[s]
                    const name = item.displayNameOverride ?? item.medicineId

                    // Days-supply estimate (existing logic).
                    const dailyDoses = todaysDoses.filter(d => d.cabinetItemId === item.iId).length
                    const daysLeft   = dailyDoses > 0
                      ? Math.floor(item.quantityOnHand / dailyDoses)
                      : null
                    const supplyClass =
                      daysLeft === null    ? null  :
                      daysLeft <= 3        ? 'cb-supply cb-supply--critical' :
                      daysLeft <= 7        ? 'cb-supply cb-supply--warn'     :
                                             'cb-supply cb-supply--ok'
                    const supplyMarker =
                      daysLeft === null ? '' :
                      daysLeft <= 3     ? ' 🔴' :
                      daysLeft <= 7     ? ' ⚠'  : ''

                    // Expiry-soon highlights: ≤5 days = critical, 6–10 = warn.
                    const daysToExp = item.expiryDate
                      ? Math.floor((new Date(item.expiryDate + 'T00:00:00').getTime() - Date.now()) / 86400000)
                      : Infinity
                    const expClass =
                      daysToExp < 0   ? 'cb-item-card--expiring-critical' :
                      daysToExp <= 5  ? 'cb-item-card--expiring-critical' :
                      daysToExp <= 10 ? 'cb-item-card--expiring-soon'     : ''
                    const expBadge: { cls: string; label: string } | null =
                      daysToExp < 0   ? { cls: 'cb-expiry-badge cb-expiry-badge--critical', label: 'Expired' } :
                      daysToExp <= 5  ? { cls: 'cb-expiry-badge cb-expiry-badge--critical', label: `Expires in ${daysToExp} day${daysToExp === 1 ? '' : 's'}` } :
                      daysToExp <= 10 ? { cls: 'cb-expiry-badge cb-expiry-badge--warn',     label: `Expires in ${daysToExp} days` } :
                                        null

                    // OOS-affected treatments line (Fix 1).
                    const isOOS = item.quantityOnHand === 0
                    const affectedNames = isOOS ? affectedByItem[item.iId] ?? [] : []

                    return (
                      <li key={item.iId} className={`db-card cb-item-card ${expClass}`}>
                        <div className="cb-item-top">
                          <span className="cb-item-name">{name}</span>
                          <span className={`cb-badge ${badge.cls}`}>{badge.label}</span>
                        </div>
                        {affectedNames.length > 0 && (
                          <p className="cb-affects-line">
                            Affects: {affectedNames.join(', ')}
                          </p>
                        )}
                        <div className="cb-item-bottom">
                          <span className="cb-item-qty">
                            {item.quantityOnHand} {unitLabel(item)}
                            {daysLeft !== null && supplyClass && (
                              <>
                                {' · '}
                                <span className={supplyClass}>
                                  ~{daysLeft} day{daysLeft === 1 ? '' : 's'} supply{supplyMarker}
                                </span>
                              </>
                            )}
                          </span>
                          {item.expiryDate && (
                            <span className="cb-item-expiry">
                              Exp: {new Date(item.expiryDate + 'T00:00:00').toLocaleDateString(
                                'en-IN', { day: 'numeric', month: 'short', year: 'numeric' }
                              )}
                            </span>
                          )}
                        </div>
                        {expBadge && (
                          <span className={expBadge.cls} style={{ alignSelf: 'flex-start', marginTop: 4 }}>
                            {expBadge.label}
                          </span>
                        )}
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          </>
        )}

        {/* Lazy-persist mounting: each tab renders only after first visit and
            stays mounted thereafter (hidden via display:none when not active).
            This prevents tab subscriptions from running on initial Dashboard
            load AND avoids re-subscribing every time the user toggles tabs. */}
        {visitedTabs.has('cabinet') && (
          <div style={{ display: activeTab === 'cabinet' ? 'contents' : 'none' }}>
            <CabinetTab
              hId={household.hId}
              readOnly={role === 'member'}
              filterByPatientUid={role === 'member' ? user.uid : undefined}
            />
          </div>
        )}
        {visitedTabs.has('treatments') && (
          <div style={{ display: activeTab === 'treatments' ? 'contents' : 'none' }}>
            <TreatmentsTab
              hId={household.hId}
              currentUid={user.uid}
              readOnly={role === 'member'}
              filterByPatientUid={role === 'member' ? user.uid : undefined}
            />
          </div>
        )}
        {visitedTabs.has('settings') && (
          <div style={{ display: activeTab === 'settings' ? 'contents' : 'none' }}>
            {role === 'member' ? (
              <MemberSettings
                currentUid={user.uid}
                currentUserName={user.displayName?.trim() || 'there'}
                onAccountDeleted={onAccountDeleted}
              />
            ) : (
              <SettingsTab
                hId={household.hId}
                householdName={household.name}
                currentUid={user.uid}
                currentUserName={user.displayName?.trim() || 'A family member'}
                isAdmin={role === 'admin'}
                onAccountDeleted={onAccountDeleted}
              />
            )}
          </div>
        )}

      </main>

      {/* ── Late modal (centered) ────────────────────────────────── */}
      {(() => {
        const slot = lateModeFor ? todaysDoses.find(d => d.slotId === lateModeFor) : null
        if (!slot) return null
        const isPending = pendingSlot === slot.slotId
        const noSlots = lateOptions.length === 0
        return (
          <div
            className="tr-modal-backdrop"
            onClick={isPending ? undefined : cancelLateMode}
            role="dialog"
            aria-modal="true"
            aria-labelledby="late-modal-title"
          >
            <div className="tr-modal" onClick={e => e.stopPropagation()}>
              <h3 id="late-modal-title" className="tr-modal-title">When will you take this?</h3>
              <p className="tr-modal-subtitle">{slot.medicineName} · scheduled {slot.time}</p>

              {noSlots ? (
                <>
                  <p className="tr-modal-empty">
                    No time slots remaining today. You can still mark this as taken now.
                  </p>
                  <div className="tr-modal-actions">
                    <button
                      type="button"
                      className="tr-modal-btn tr-modal-btn--secondary"
                      onClick={cancelLateMode}
                      disabled={isPending}
                    >Cancel</button>
                    <button
                      type="button"
                      className="tr-modal-btn tr-modal-btn--primary"
                      onClick={() => handleLogDose(slot, 'taken')}
                      disabled={isPending}
                    >
                      {isPending ? 'Saving…' : 'Mark as Taken'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="tr-time-grid" role="radiogroup" aria-label="Intended time">
                    {lateOptions.map(opt => (
                      <button
                        key={opt}
                        type="button"
                        role="radio"
                        aria-checked={lateTimeChoice === opt}
                        className={`tr-time-chip${lateTimeChoice === opt ? ' tr-time-chip--active' : ''}`}
                        onClick={() => setLateTimeChoice(opt)}
                      >
                        {formatTimeFriendly(opt)}
                      </button>
                    ))}
                  </div>
                  <div className="tr-modal-actions">
                    <button
                      type="button"
                      className="tr-modal-btn tr-modal-btn--secondary"
                      onClick={cancelLateMode}
                      disabled={isPending}
                    >Cancel</button>
                    <button
                      type="button"
                      className="tr-modal-btn tr-modal-btn--primary"
                      onClick={() => handleLogDose(slot, 'late', {
                        skipReason: `Taking at ${formatTimeFriendly(lateTimeChoice)}`,
                      })}
                      disabled={!lateTimeChoice || isPending}
                    >
                      {isPending ? 'Saving…' : 'Confirm'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )
      })()}

      {/* ── Skip modal (centered) ────────────────────────────────── */}
      {(() => {
        const slot = skipModeFor ? todaysDoses.find(d => d.slotId === skipModeFor) : null
        if (!slot) return null
        const check = validateSkipReason(skipReasonText)
        const showError = !check.valid && check.count > 0
        const isPending = pendingSlot === slot.slotId
        return (
          <div
            className="tr-modal-backdrop"
            onClick={isPending ? undefined : cancelSkipMode}
            role="dialog"
            aria-modal="true"
            aria-labelledby="skip-modal-title"
          >
            <div className="tr-modal" onClick={e => e.stopPropagation()}>
              <h3 id="skip-modal-title" className="tr-modal-title">Why are you skipping this dose?</h3>
              <p className="tr-modal-subtitle">Please describe in your own words</p>

              <textarea
                className="tr-modal-textarea"
                rows={3}
                value={skipReasonText}
                onChange={e => setSkipReasonText(e.target.value)}
                placeholder="e.g. Feeling nauseous, doctor advised to pause for today…"
                aria-invalid={showError}
                autoFocus
              />
              <div className={
                check.valid       ? 'tr-modal-counter tr-modal-counter--valid'
                : check.count > 0 ? 'tr-modal-counter tr-modal-counter--invalid'
                :                   'tr-modal-counter'
              }>
                {check.count} / {SKIP_MIN_CHARS}
              </div>
              {showError && (
                <p className="tr-modal-error" role="alert">{SKIP_ERROR}</p>
              )}

              <div className="tr-modal-actions">
                <button
                  type="button"
                  className="tr-modal-btn tr-modal-btn--secondary"
                  onClick={cancelSkipMode}
                  disabled={isPending}
                >Cancel</button>
                <button
                  type="button"
                  className="tr-modal-btn tr-modal-btn--primary"
                  onClick={() => handleLogDose(slot, 'skipped', { skipReason: skipReasonText.trim() })}
                  disabled={!check.valid || isPending}
                >
                  {isPending ? 'Skipping…' : 'Confirm Skip'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* ── Notifications panel (admin sees all household notifications) ── */}
      <NotificationsPanel
        open={showNotifPanel}
        onClose={() => setShowNotifPanel(false)}
        notifications={notifications}
        currentUid={user.uid}
        hId={household.hId}
      />

      {/* ── Admin: mark missed dose as taken (confirmation modal) ── */}
      {adminMarkSlot && (
        <div
          className="tr-modal-backdrop"
          onClick={adminMarkPending ? undefined : () => setAdminMarkSlot(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-mark-modal-title"
        >
          <div className="tr-modal" onClick={e => e.stopPropagation()}>
            <h3 id="admin-mark-modal-title" className="tr-modal-title">Mark as taken?</h3>
            <p className="tr-modal-subtitle">
              This will record that {adminMarkSlot.memberName ?? 'this member'} took
              their {adminMarkSlot.medicineName} and deduct from cabinet stock.
            </p>
            <div className="tr-modal-actions">
              <button
                type="button"
                className="tr-modal-btn tr-modal-btn--secondary"
                onClick={() => setAdminMarkSlot(null)}
                disabled={adminMarkPending}
              >Cancel</button>
              <button
                type="button"
                className="tr-modal-btn tr-modal-btn--primary"
                onClick={() => handleAdminMarkAsTaken(adminMarkSlot)}
                disabled={adminMarkPending}
              >
                {adminMarkPending ? 'Saving…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── FAB ─────────────────────────────────────────────────── */}
      {/* Members only see the FAB on the home tab; admins see it everywhere. */}
      {(role !== 'member' || activeTab === 'dashboard') && (
        <button
          className="db-fab"
          onClick={() => setShowAiModal(true)}
          aria-label="Ask your cabinet"
        >
          <Sparkles size={17} />
          <span>Ask your cabinet</span>
        </button>
      )}

      {/* ── Bottom navigation ───────────────────────────────────── */}
      <nav className="db-bottom-nav" aria-label="Main navigation">
        {NAV_TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={`db-nav-tab${activeTab === id ? ' db-nav-tab--active' : ''}`}
            onClick={() => visitTab(id)}
            aria-current={activeTab === id ? 'page' : undefined}
          >
            <Icon size={26} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      {/* ── AI modal ────────────────────────────────────────────── */}
      {showAiModal && (
        <div
          className="db-modal-overlay"
          onClick={() => setShowAiModal(false)}
          role="dialog"
          aria-modal="true"
          aria-label="AI feature coming soon"
        >
          <div className="db-modal" onClick={e => e.stopPropagation()}>
            <span className="db-modal-icon" aria-hidden="true">✨</span>
            <p className="db-modal-title">AI coming soon</p>
            <p className="db-modal-sub">
              Ask your cabinet anything about your medicines — coming in a future update.
            </p>
            <button className="db-modal-close" onClick={() => setShowAiModal(false)}>
              Got it
            </button>
          </div>
        </div>
      )}

      {/* Reminder toast (Fix 5) */}
      {toastMessage && (
        <div className="db-toast" role="status" aria-live="polite">
          {toastMessage}
        </div>
      )}

    </div>
  )
}
