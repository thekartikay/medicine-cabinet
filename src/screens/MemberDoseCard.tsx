import { useEffect, useMemo, useState } from 'react'
import type { User } from 'firebase/auth'
import { signOut } from 'firebase/auth'
import { useTranslation } from 'react-i18next'
import { Bell, Check, Clock, X, AlertTriangle } from 'lucide-react'
import { auth } from '../lib/firebase'
import { todayISTString } from '../lib/paths'
import {
  subscribeTreatments,
  loadTodaysDoses,
  loadTodaysLogs,
  logDose,
  loadLogsForDateRange,
  loadAllActiveRegimens,
  getDefaultCabinetItems,
  createRestockRequest,
  subscribeNotifications,
} from '../services/firestoreService'
import type {
  CabinetItem,
  DoseSlotDisplay,
  DoseStatus,
  FoodTiming,
  Notification,
  TreatmentCategory,
} from '../types'
import { DoseHistory } from './DoseHistory'
import { NotificationsPanel } from './NotificationsPanel'

interface Props {
  user: User
  household: { hId: string; name: string }
}

type LogState = {
  status: DoseStatus
  skipReason: string | null
  lateNote: string | null
}

// ── Skip-reason validation (same rules as the admin Dashboard) ────────────────
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

// ── Time helpers ──────────────────────────────────────────────────────────────
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

function nowHHMM(): string {
  const { h, m } = nowISTHM()
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

// 30-min increments from max(now, scheduledTime), rounded up, through 23:30 IST.
function generateLateOptionsForSlot(scheduledTime: string): string[] {
  const { h: nowH, m: nowM } = nowISTHM()
  const [schedH, schedM] = scheduledTime.split(':').map(Number)
  const nowMins   = nowH   * 60 + nowM
  const schedMins = schedH * 60 + schedM
  let minMins = Math.max(nowMins, schedMins)
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
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

function todayLongDate(): string {
  return new Date().toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Asia/Kolkata',
  })
}

function firstName(displayName: string | null): string {
  if (!displayName) return 'there'
  return displayName.trim().split(/\s+/)[0]
}

function timeOfDayKey(): 'morning' | 'afternoon' | 'evening' {
  const h = nowISTHM().h
  if (h < 12) return 'morning'
  if (h < 17) return 'afternoon'
  return 'evening'
}

function unitLabel(amount: number, unit: string): string {
  if (unit === 'ml') return 'ml'
  // Capitalise tablet/capsule for the dose-card subtitle ("1 Tablet · …").
  const cap = unit.charAt(0).toUpperCase() + unit.slice(1)
  return amount === 1 ? cap : `${cap}s`
}

// Inline label for the dose subtitle line. The translated strings include
// a "Take" prefix, which reads awkward when embedded after the dose amount,
// so the inline form drops the verb.
function foodInline(timing: FoodTiming): string {
  if (timing === 'before') return 'Before food'
  if (timing === 'after')  return 'After food'
  return 'With food'
}

// AK-132 — Random affirmation picked at confirm time. Kept identical to the
// Dashboard pool so the experience is consistent across the two views.
const CONFIRM_MESSAGES = ['Nice work.', 'Done.', 'Logged.'] as const
function pickConfirmMessage(): string {
  return CONFIRM_MESSAGES[Math.floor(Math.random() * CONFIRM_MESSAGES.length)]
}

export function MemberDoseCard({ user, household }: Props) {
  const { t } = useTranslation()

  // Live data
  const [todaysDoses, setTodaysDoses] = useState<DoseSlotDisplay[]>([])
  const [logsBySlot, setLogsBySlot] = useState<Record<string, LogState>>({})

  // UI state
  const [pendingSlot, setPendingSlot] = useState<string | null>(null)
  const [confirmedSlot, setConfirmedSlot] = useState<string | null>(null)
  // AK-132 — Affirmation line shown briefly under the dose card after a
  // taken/late mark. Picked once at confirm time and held stable through
  // the 1.6s window via the same setTimeout that clears confirmedSlot.
  const [confirmedMessage, setConfirmedMessage] = useState<string | null>(null)
  const [logError, setLogError] = useState('')

  // Modals
  const [skipModalSlot, setSkipModalSlot] = useState<DoseSlotDisplay | null>(null)
  const [skipReasonText, setSkipReasonText] = useState('')

  const [lateModalSlot, setLateModalSlot] = useState<DoseSlotDisplay | null>(null)
  const [lateOptions, setLateOptions] = useState<string[]>([])
  const [lateTimeChoice, setLateTimeChoice] = useState('')

  // Notifications panel state + live subscription. Member-side filtering
  // happens at render time so we can show the household-wide low_stock and
  // expiring_soon notifications alongside member-scoped missed_dose,
  // admin_override, and caregiver_reminder notifications.
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [showNotifPanel, setShowNotifPanel] = useState(false)
  useEffect(() => {
    const unsub = subscribeNotifications(household.hId, setNotifications)
    return () => unsub()
  }, [household.hId])

  const myNotifications = useMemo(() => {
    return notifications.filter(n => {
      if (
        n.type === 'missed_dose' ||
        n.type === 'admin_override' ||
        n.type === 'caregiver_reminder'
      ) {
        return n.relatedMemberId === user.uid
      }
      // low_stock, expiring_soon, restock_request — household-wide for members.
      return true
    })
  }, [notifications, user.uid])

  const myUnreadCount = useMemo(
    () => myNotifications.filter(n => !n.readBy.includes(user.uid)).length,
    [myNotifications, user.uid],
  )

  // ── Subscribe to today's doses + logs, filtered to this user ──────────────
  useEffect(() => {
    let cancelled = false
    const unsub = subscribeTreatments(household.hId, async () => {
      const [doses, logs] = await Promise.all([
        loadTodaysDoses(household.hId),
        loadTodaysLogs(household.hId),
      ])
      if (cancelled) return
      const myDoses = doses.filter(d => d.patientId === user.uid)
      setTodaysDoses(myDoses)
      setLogsBySlot(prev => {
        const next: Record<string, LogState> = { ...prev }
        for (const log of logs) {
          if (log.patientId !== user.uid) continue
          next[log.slotId] = {
            status: log.status,
            skipReason: log.skipReason ?? null,
            lateNote: log.lateNote ?? null,
          }
        }
        return next
      })
    })
    return () => { cancelled = true; unsub() }
  }, [household.hId, user.uid])

  // ── Derived: next pending dose, separately-missed dose, progress totals ──
  const { nextPending, missedToShow, allDoneForToday, loggedCount, totalDoses } = useMemo(() => {
    const nowHm = nowHHMM()
    const unlogged = todaysDoses.filter(d => !logsBySlot[d.slotId])
    const next = unlogged[0] ?? null  // already sorted ascending in loadTodaysDoses
    // A missed dose worth surfacing separately: a server-marked 'missed' log,
    // or — during the up-to-30min gap before the cron writes it — an unlogged
    // dose whose scheduled time is already past. Never the focus card itself.
    const missed = todaysDoses.find(d => {
      if (d.slotId === next?.slotId) return false
      const log = logsBySlot[d.slotId]
      if (log) return log.status === 'missed'
      return d.time < nowHm
    }) ?? null
    const hasMissed = todaysDoses.some(d => logsBySlot[d.slotId]?.status === 'missed')
    return {
      nextPending: next,
      missedToShow: missed,
      // "All done" requires every dose to have a non-missed log.
      allDoneForToday: todaysDoses.length > 0 && unlogged.length === 0 && !hasMissed,
      // Progress strip: only user-acted logs count toward "logged".
      loggedCount: todaysDoses.filter(d => {
        const log = logsBySlot[d.slotId]
        return !!log && log.status !== 'missed'
      }).length,
      totalDoses: todaysDoses.length,
    }
  }, [todaysDoses, logsBySlot])

  // First dose time today (used as proxy for "tomorrow's first dose")
  const earliestTodayTime = todaysDoses[0]?.time ?? null

  // ── Per-treatment adherence — last 7 days (Fix 5) + cabinet items (Fix 6) ─
  // Loads logs + regimens + cabinet items once on mount, then computes a card
  // per treatment the member is on. Same date-window math as Treatments.tsx
  // but scoped to this user. Cabinet items power the "My medicines" section.
  type TreatmentAdherence = {
    tId: string
    name: string
    category: TreatmentCategory
    cabinetItemIds: string[]
    taken: number
    expected: number
  }
  const [adherenceByTreatment, setAdherenceByTreatment] = useState<TreatmentAdherence[]>([])
  const [cabinetItems, setCabinetItems] = useState<CabinetItem[]>([])
  useEffect(() => {
    let cancelled = false
    async function load() {
      const today = todayISTString()
      const fromDate = (() => {
        const d = new Date(today + 'T00:00:00')
        d.setDate(d.getDate() - 6)
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      })()
      const [logs, { treatments, regimensByTreatment }, items] = await Promise.all([
        loadLogsForDateRange(household.hId, fromDate, today),
        loadAllActiveRegimens(household.hId),
        getDefaultCabinetItems(household.hId),
      ])
      if (cancelled) return

      const myTreatments = treatments.filter(t => t.memberId === user.uid)
      const next: TreatmentAdherence[] = []
      for (const t of myTreatments) {
        const regs = regimensByTreatment[t.tId] ?? []
        let expected = 0
        for (let i = 0; i < 7; i++) {
          const d = new Date(today + 'T00:00:00')
          d.setDate(d.getDate() - i)
          const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
          for (const r of regs) {
            if (r.startDate > dateStr) continue
            if (r.endDate && r.endDate < dateStr) continue
            if (r.scheduleType === 'as-needed') continue
            // AK-131 — flexible-daily contributes one expected dose per
            // applicable day (slots is always empty for this mode).
            if (r.scheduleType === 'flexible-daily') { expected += 1; continue }
            if (r.scheduleType === 'daily') { expected += r.slots.length; continue }
            if (r.scheduleDays?.includes(d.getDay())) expected += r.slots.length
          }
        }
        const taken = logs.filter(l =>
          l.tId === t.tId
          && l.patientId === user.uid
          && (l.status === 'taken' || l.status === 'late'),
        ).length
        next.push({
          tId: t.tId,
          name: t.name,
          category: t.category,
          cabinetItemIds: regs.map(r => r.cabinetItemId),
          taken,
          expected,
        })
      }
      setAdherenceByTreatment(next)
      setCabinetItems(items)
    }
    load().catch(() => { /* silent — section will be hidden if data missing */ })
    return () => { cancelled = true }
  }, [household.hId, user.uid])

  // Cabinet items used in this member's active treatments AND running low.
  const myLowStockItems = useMemo(() => {
    const usedIds = new Set<string>()
    for (const a of adherenceByTreatment) for (const id of a.cabinetItemIds) usedIds.add(id)
    return cabinetItems
      .filter(i => usedIds.has(i.iId) && i.quantityOnHand <= 10)
      .slice()
      .sort((a, b) => a.quantityOnHand - b.quantityOnHand)
  }, [cabinetItems, adherenceByTreatment])

  // Restock-request UI state. Local-only by design — refresh resets it.
  const [requestedItems, setRequestedItems] = useState<Set<string>>(new Set())
  const [restockPending, setRestockPending] = useState<string | null>(null)
  const [restockToast, setRestockToast]   = useState<string | null>(null)

  async function handleRestockRequest(item: CabinetItem) {
    setRestockPending(item.iId)
    try {
      await createRestockRequest(household.hId, {
        cabinetItemId: item.iId,
        medicineName: item.displayNameOverride ?? item.brandName ?? item.medicineId,
        requestedBy: user.uid,
        quantityAtRequest: item.quantityOnHand,
      })
      setRequestedItems(prev => {
        const next = new Set(prev); next.add(item.iId); return next
      })
      setRestockToast('Restock requested ✓')
      setTimeout(() => setRestockToast(null), 2200)
    } catch {
      setRestockToast('Could not send request. Try again.')
      setTimeout(() => setRestockToast(null), 2400)
    } finally {
      setRestockPending(null)
    }
  }

  // ── History sub-view ──────────────────────────────────────────────────────
  const [showHistory, setShowHistory] = useState(false)

  // ── Action handler (shared by all three buttons) ──────────────────────────
  async function handleLog(
    slot: DoseSlotDisplay,
    status: DoseStatus,
    opts: { skipReason?: string | null } = {},
  ) {
    setLogError('')
    setPendingSlot(slot.slotId)

    const skipReason = opts.skipReason ?? null

    setLogsBySlot(prev => ({
      ...prev,
      [slot.slotId]: { status, skipReason, lateNote: null },
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
        createdBy: user.uid,
        scheduleType: slot.scheduleType,
      })

      if (status === 'taken' || status === 'late') {
        setConfirmedSlot(slot.slotId)
        setConfirmedMessage(pickConfirmMessage())
        setTimeout(() => {
          setConfirmedSlot(prev => {
            if (prev !== slot.slotId) return prev
            setConfirmedMessage(null)
            return null
          })
        }, 1600)
      }
    } catch {
      setLogsBySlot(prev => {
        const next = { ...prev }
        delete next[slot.slotId]
        return next
      })
      setLogError('Could not log dose. Please try again.')
    } finally {
      setPendingSlot(null)
      if (status === 'skipped') closeSkipModal()
      if (status === 'late')    closeLateModal()
    }
  }

  function openSkipModal(slot: DoseSlotDisplay) {
    closeLateModal()
    setSkipReasonText('')
    setSkipModalSlot(slot)
    setLogError('')
  }

  function closeSkipModal() {
    setSkipModalSlot(null)
    setSkipReasonText('')
  }

  function openLateModal(slot: DoseSlotDisplay) {
    closeSkipModal()
    const opts = generateLateOptionsForSlot(slot.time)
    setLateOptions(opts)
    setLateTimeChoice(opts[0] ?? '')
    setLateModalSlot(slot)
    setLogError('')
  }

  function closeLateModal() {
    setLateModalSlot(null)
    setLateTimeChoice('')
  }

  // ── Render ────────────────────────────────────────────────────────────────
  const greeting = t(`greeting.${timeOfDayKey()}`)
  const name = firstName(user.displayName)

  const skipPending = pendingSlot === skipModalSlot?.slotId
  const latePending = pendingSlot === lateModalSlot?.slotId
  const skipCheck = skipModalSlot ? validateSkipReason(skipReasonText) : null

  if (showHistory) {
    return (
      <DoseHistory
        hId={household.hId}
        filterUid={user.uid}
        onBack={() => setShowHistory(false)}
      />
    )
  }

  return (
    <div className="md-root">

      {/* ── Header ───────────────────────────────────────────────
          Member view: header is permanently fixed to the viewport top
          (position: fixed via .md-header in App.css). It never scrolls
          away. The db-body--member-home container reserves 120px of
          top padding to keep the first card from hiding underneath. */}
      <header className="md-header">
        <div>
          <p className="md-eyebrow">{greeting}</p>
          <h1 className="md-name">{name}</h1>
          <p className="md-date">{todayLongDate()}</p>
        </div>
        <div className="md-header-actions">
          <button
            type="button"
            className="db-bell md-bell"
            onClick={() => setShowNotifPanel(true)}
            aria-label={myUnreadCount > 0 ? `${myUnreadCount} unread notifications` : 'Notifications'}
          >
            <Bell size={20} />
            {myUnreadCount > 0 && <span className="db-bell-count">{myUnreadCount}</span>}
          </button>
          <button className="md-signout" onClick={() => signOut(auth)}>
            Sign out
          </button>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────── */}
      <main className="md-body">

        {logError && <p className="md-error" role="alert">{logError}</p>}

        {/* Progress strip: "X of Y logged" + horizontal bar + next-dose time. */}
        {totalDoses > 0 && (
          <div className="md-progress-card">
            <div className="md-progress-row">
              <span className="md-progress-text">
                {loggedCount} of {totalDoses} logged
              </span>
              {nextPending && (
                <span className="md-progress-next">
                  {nextPending.scheduleType === 'flexible-daily'
                    ? 'Any time'
                    : formatTimeFriendly(nextPending.time)}
                </span>
              )}
            </div>
            <div
              className="md-progress-bar"
              role="progressbar"
              aria-valuenow={loggedCount}
              aria-valuemin={0}
              aria-valuemax={totalDoses}
            >
              <div
                className="md-progress-fill"
                style={{ width: `${(loggedCount / totalDoses) * 100}%` }}
              />
            </div>
          </div>
        )}

        {nextPending ? (() => {
          const isFlexible = nextPending.scheduleType === 'flexible-daily'
          return (
          <div
            className={`md-dose-card${confirmedSlot === nextPending.slotId ? ' md-dose-card--just-confirmed' : ''}`}
          >
            <div className="md-dose-time">
              <Clock size={16} />
              <span>
                {isFlexible ? 'Any time today' : formatTimeFriendly(nextPending.time)}
              </span>
            </div>
            <div className="md-medicine">{nextPending.medicineName}</div>
            <div className="md-dose-detail">
              {nextPending.doseAmount} {unitLabel(nextPending.doseAmount, nextPending.doseUnit)}
              {!isFlexible && (
                <>
                  {' · '}
                  {foodInline(nextPending.foodTiming)}
                </>
              )}
            </div>

            <div className="md-actions">
              <button
                type="button"
                className="md-btn md-btn-primary"
                onClick={() => handleLog(nextPending, 'taken')}
                disabled={pendingSlot === nextPending.slotId}
              >
                <Check size={20} />
                <span>{t('member.markAsTaken')}</span>
              </button>
              <div className="md-secondary-row">
                <button
                  type="button"
                  className="md-btn md-btn-secondary"
                  onClick={() => openSkipModal(nextPending)}
                  disabled={pendingSlot === nextPending.slotId}
                >
                  <X size={18} />
                  <span>{t('member.skip')}</span>
                </button>
                {/* AK-131 — late mode is meaningless when the slot has no
                    fixed time; hide the button for flexible-daily. */}
                {!isFlexible && (
                  <button
                    type="button"
                    className="md-btn md-btn-secondary"
                    onClick={() => openLateModal(nextPending)}
                    disabled={pendingSlot === nextPending.slotId}
                  >
                    <Clock size={18} />
                    <span>{t('member.takeLater')}</span>
                  </button>
                )}
              </div>
            </div>
          </div>
          )
        })() : allDoneForToday ? (
          <div className="md-done">
            <div className="md-done-tick" aria-hidden="true">
              <Check size={48} strokeWidth={3} />
            </div>
            <h2 className="md-done-title">{t('member.allDoneTitle')}</h2>
            <p className="md-done-body">{t('member.allDoneBody', { name })}</p>
            {earliestTodayTime && (
              <p className="md-done-next">
                {t('member.nextTomorrow', { time: formatTimeFriendly(earliestTodayTime) })}
              </p>
            )}
          </div>
        ) : totalDoses === 0 ? (
          <div className="md-done">
            <div className="md-done-body">No doses scheduled for today.</div>
          </div>
        ) : null}

        {/* AK-132 — Affirmation flash. Sits below the focus card / done panel
            so the celebration message rides whichever surface is currently
            showing. Fades with the same 1.6s timer that clears the pulse. */}
        {confirmedSlot && confirmedMessage && (
          <p className="md-confirm-message" role="status">
            {confirmedMessage}
          </p>
        )}

        {/* Persistent missed-dose card (separate from the focus card) */}
        {missedToShow && (() => {
          const isFlexible = missedToShow.scheduleType === 'flexible-daily'
          return (
            <div className="md-missed-card">
              <p className="md-missed-title">{t('member.missedTitle')}</p>
              <p className="md-missed-medicine">{missedToShow.medicineName}</p>
              <p className="md-missed-meta">
                {isFlexible ? 'Any time today' : formatTimeFriendly(missedToShow.time)}
                {' · '}{missedToShow.doseAmount}{' '}
                {unitLabel(missedToShow.doseAmount, missedToShow.doseUnit)}
              </p>
              {/* AK-131 — flex missed slots skip the late-modal (no fixed time
                  to be late from). Tap-to-take logs it as 'taken' directly. */}
              <button
                type="button"
                className="md-btn md-btn-amber"
                onClick={() =>
                  isFlexible
                    ? handleLog(missedToShow, 'taken')
                    : openLateModal(missedToShow)
                }
                disabled={pendingSlot === missedToShow.slotId}
              >
                <Clock size={18} />
                <span>{t('member.markLateTaken')}</span>
              </button>
            </div>
          )
        })()}

        {/* ── Per-treatment adherence (Fix 5) ─────────────────────── */}
        {adherenceByTreatment.length > 0 && (
          <section className="md-adherence-section">
            <h3 className="md-section-title">My adherence — last 7 days</h3>
            <ul className="md-adherence-list">
              {adherenceByTreatment.map(a => {
                const pct = a.expected > 0 ? Math.round((a.taken / a.expected) * 100) : null
                const tone =
                  pct == null   ? 'empty'   :
                  pct >= 80     ? 'good'    :
                  pct >= 50     ? 'warn'    :
                                  'critical'
                return (
                  <li key={a.tId} className="md-adherence-tile">
                    <div className="md-adherence-tile-head">
                      <span className="md-adherence-tile-name">{a.name}</span>
                      <span className={`md-cat-badge md-cat-badge--${a.category}`}>
                        {a.category.charAt(0).toUpperCase() + a.category.slice(1)}
                      </span>
                    </div>
                    {pct == null ? (
                      <p className="md-adherence-empty">No scheduled doses yet</p>
                    ) : (
                      <>
                        <p className={`md-adherence-tile-pct md-adherence-tile-pct--${tone}`}>
                          {pct}% adherence — last 7 days
                        </p>
                        <div
                          className="md-adherence-bar"
                          role="progressbar"
                          aria-valuenow={pct}
                          aria-valuemin={0}
                          aria-valuemax={100}
                        >
                          <div
                            className={`md-adherence-fill md-adherence-fill--${tone}`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <p className="md-adherence-sub">
                          {a.taken} of {a.expected} doses taken
                        </p>
                      </>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {/* ── My medicines — low-stock + restock request (Fix 6).
            Split into Rx and OTC sections to mirror the cabinet (Fix 2). ── */}
        {myLowStockItems.length > 0 && (() => {
          const rx  = myLowStockItems.filter(i => i.prescribed)
          const otc = myLowStockItems.filter(i => !i.prescribed)
          const renderItem = (item: CabinetItem) => {
            const name = item.displayNameOverride ?? item.brandName ?? item.medicineId
            const requested = requestedItems.has(item.iId)
            const pending   = restockPending === item.iId
            const unit = item.unit === 'ml' ? 'ml'
              : item.quantityOnHand === 1 ? item.unit : `${item.unit}s`
            return (
              <li key={item.iId} className="md-med-card">
                <div className="md-med-info">
                  <span className="md-med-name-row">
                    <span className="md-med-name">{name}</span>
                    <span className={`cb-rx-badge cb-rx-badge--${item.prescribed ? 'rx' : 'otc'}`}>
                      {item.prescribed ? 'Rx' : 'OTC'}
                    </span>
                  </span>
                  <span className="md-med-qty">
                    <AlertTriangle size={13} aria-hidden="true" />
                    <span>Only {item.quantityOnHand} {unit} left</span>
                  </span>
                </div>
                <button
                  type="button"
                  className={`md-restock-btn${requested ? ' md-restock-btn--done' : ''}`}
                  onClick={() => handleRestockRequest(item)}
                  disabled={requested || pending}
                >
                  {requested ? 'Restock requested ✓'
                    : pending ? 'Sending…'
                    : 'Request Restock'}
                </button>
              </li>
            )
          }
          return (
            <section className="md-meds-section">
              <h3 className="md-section-title">My medicines</h3>
              {rx.length > 0 && (
                <>
                  <h4 className="db-section-title">Prescription (Rx)</h4>
                  <ul className="md-meds-list">{rx.map(renderItem)}</ul>
                </>
              )}
              {otc.length > 0 && (
                <>
                  <h4 className="db-section-title">Over the counter (OTC)</h4>
                  <ul className="md-meds-list">{otc.map(renderItem)}</ul>
                </>
              )}
            </section>
          )
        })()}

        <button
          type="button"
          className="md-history-link"
          onClick={() => setShowHistory(true)}
        >
          View my history
        </button>
      </main>

      {restockToast && (
        <div className="db-toast" role="status" aria-live="polite">
          {restockToast}
        </div>
      )}

      {/* ── Notifications panel (member-filtered) ────────────────── */}
      <NotificationsPanel
        open={showNotifPanel}
        onClose={() => setShowNotifPanel(false)}
        notifications={myNotifications}
        currentUid={user.uid}
        hId={household.hId}
      />

      {/* ── Skip modal ─────────────────────────────────────────── */}
      {skipModalSlot && skipCheck && (
        <div
          className="tr-modal-backdrop"
          onClick={skipPending ? undefined : closeSkipModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="md-skip-modal-title"
        >
          <div className="tr-modal" onClick={e => e.stopPropagation()}>
            <h3 id="md-skip-modal-title" className="tr-modal-title">Why are you skipping this dose?</h3>
            <p className="tr-modal-subtitle">Please describe in your own words</p>
            <textarea
              className="tr-modal-textarea"
              rows={3}
              value={skipReasonText}
              onChange={e => setSkipReasonText(e.target.value)}
              placeholder="e.g. Feeling nauseous, doctor advised to pause for today…"
              aria-invalid={!skipCheck.valid && skipCheck.count > 0}
              autoFocus
            />
            <div className={
              skipCheck.valid       ? 'tr-modal-counter tr-modal-counter--valid'
              : skipCheck.count > 0 ? 'tr-modal-counter tr-modal-counter--invalid'
              :                       'tr-modal-counter'
            }>
              {skipCheck.count} / {SKIP_MIN_CHARS}
            </div>
            {!skipCheck.valid && skipCheck.count > 0 && (
              <p className="tr-modal-error" role="alert">{SKIP_ERROR}</p>
            )}
            <div className="tr-modal-actions">
              <button
                type="button"
                className="tr-modal-btn tr-modal-btn--secondary"
                onClick={closeSkipModal}
                disabled={skipPending}
              >Cancel</button>
              <button
                type="button"
                className="tr-modal-btn tr-modal-btn--primary"
                onClick={() => handleLog(skipModalSlot, 'skipped', { skipReason: skipReasonText.trim() })}
                disabled={!skipCheck.valid || skipPending}
              >
                {skipPending ? 'Skipping…' : 'Confirm Skip'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Late modal ─────────────────────────────────────────── */}
      {lateModalSlot && (
        <div
          className="tr-modal-backdrop"
          onClick={latePending ? undefined : closeLateModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="md-late-modal-title"
        >
          <div className="tr-modal" onClick={e => e.stopPropagation()}>
            <h3 id="md-late-modal-title" className="tr-modal-title">When will you take this?</h3>
            <p className="tr-modal-subtitle">{lateModalSlot.medicineName} · scheduled {formatTimeFriendly(lateModalSlot.time)}</p>
            {lateOptions.length === 0 ? (
              <>
                <p className="tr-modal-empty">
                  No time slots remaining today. You can still mark this as taken now.
                </p>
                <div className="tr-modal-actions">
                  <button
                    type="button"
                    className="tr-modal-btn tr-modal-btn--secondary"
                    onClick={closeLateModal}
                    disabled={latePending}
                  >Cancel</button>
                  <button
                    type="button"
                    className="tr-modal-btn tr-modal-btn--primary"
                    onClick={() => handleLog(lateModalSlot, 'taken')}
                    disabled={latePending}
                  >
                    {latePending ? 'Saving…' : t('member.markAsTaken')}
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
                    onClick={closeLateModal}
                    disabled={latePending}
                  >Cancel</button>
                  <button
                    type="button"
                    className="tr-modal-btn tr-modal-btn--primary"
                    onClick={() => handleLog(lateModalSlot, 'late', {
                      skipReason: `Taking at ${formatTimeFriendly(lateTimeChoice)}`,
                    })}
                    disabled={!lateTimeChoice || latePending}
                  >
                    {latePending ? 'Saving…' : 'Confirm'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

