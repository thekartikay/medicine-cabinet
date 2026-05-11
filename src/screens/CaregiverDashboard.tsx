import { useEffect, useState } from 'react'
import { onAuthStateChanged, signOut, type User } from 'firebase/auth'
import { FirebaseError } from 'firebase/app'
import type { Timestamp } from 'firebase/firestore'
import { auth } from '../lib/firebase'
import { subscribeTodaySummary } from '../services/firestoreService'
import { todayISTString } from '../lib/paths'
import {
  getCaregiverSession,
  isSessionExpired,
  clearCaregiverSession,
  type CaregiverSession,
} from '../services/caregiverSession'
import type { TodaySummary, TodaySummarySlot } from '../types'

// AK-58 sub-task 3 Step 2 — read-only caregiver view.
//
// Mount sequence:
//   1. Read sessionStorage. Missing → 'no-session'. Expired → 'expired'.
//   2. Wait for onAuthStateChanged to settle. If auth.currentUser.uid !=
//      `caregiver-${grantId}`, treat as 'no-session' (e.g. tab refreshed
//      after the sessionPersistence cleared, or a stale stored session).
//   3. Subscribe to todaySummary/{today}. On permission-denied (revoked
//      grant after rules' get() check), clear session and show 'revoked'.
//
// Real-time: the subscription stays open; Cloud Function maintainTodaySummary
// rewrites the doc whenever a dose is logged, which fires our onSnapshot.

type State =
  | { kind: 'loading' }
  | { kind: 'no-session' }
  | { kind: 'expired' }
  | { kind: 'revoked' }
  | {
      kind: 'ready'
      session: CaregiverSession
      summary: TodaySummary | null
      lastUpdatedAt: Date | null
    }

function formatTime12(hhmm: string): string {
  const [hStr, m] = hhmm.split(':')
  const h = Number(hStr)
  const period = h >= 12 ? 'PM' : 'AM'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${m} ${period}`
}

function formatLoggedAt(ts: Timestamp | null): string | null {
  if (!ts) return null
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(ts.toDate())
}

function doseUnitLabel(amount: number, unit: string): string {
  if (unit === 'ml') return 'ml'
  return amount === 1 ? unit : `${unit}s`
}

function formatDate(dateISO: string): string {
  const [y, mo, d] = dateISO.split('-').map(Number)
  const date = new Date(Date.UTC(y, mo - 1, d))
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(date)
  return `Today, ${formatted}`
}

function relativeTime(d: Date): string {
  const diff = Math.floor((Date.now() - d.getTime()) / 1000)
  if (diff < 30) return 'Updated just now'
  if (diff < 60) return `Updated ${diff}s ago`
  if (diff < 3600) return `Updated ${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `Updated ${Math.floor(diff / 3600)}h ago`
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d)
  return `Updated at ${formatted}`
}

const BADGE_MAP: Record<string, { label: string; cls: string }> = {
  taken: { label: 'Taken', cls: 'cc-slot-badge--taken' },
  missed: { label: 'Missed', cls: 'cc-slot-badge--missed' },
  skipped: { label: 'Skipped', cls: 'cc-slot-badge--skipped' },
  late: { label: 'Taken late', cls: 'cc-slot-badge--late' },
  pending: { label: 'Pending', cls: 'cc-slot-badge--pending' },
}

export function CaregiverDashboard() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  // 30-second heartbeat so the "Updated X ago" label stays fresh without us
  // having to track time elsewhere.
  const [, setTick] = useState(0)

  useEffect(() => {
    const session = getCaregiverSession()
    if (!session) {
      setState({ kind: 'no-session' })
      return
    }
    if (isSessionExpired(session)) {
      clearCaregiverSession()
      void signOut(auth).catch(() => {})
      setState({ kind: 'expired' })
      return
    }

    let summaryUnsub: (() => void) | null = null

    const authUnsub = onAuthStateChanged(auth, (user: User | null) => {
      if (!user || user.uid !== `caregiver-${session.grantId}`) {
        summaryUnsub?.()
        summaryUnsub = null
        setState({ kind: 'no-session' })
        return
      }
      setState((prev) =>
        prev.kind === 'ready'
          ? prev
          : { kind: 'ready', session, summary: null, lastUpdatedAt: null },
      )
      if (summaryUnsub) return
      summaryUnsub = subscribeTodaySummary(
        session.hId,
        todayISTString(),
        (summary) => {
          setState((prev) =>
            prev.kind === 'ready'
              ? { ...prev, summary, lastUpdatedAt: new Date() }
              : prev,
          )
        },
        (err) => {
          if (err instanceof FirebaseError && err.code === 'permission-denied') {
            clearCaregiverSession()
            void signOut(auth).catch(() => {})
            setState({ kind: 'revoked' })
          }
        },
      )
    })

    const tickInterval = window.setInterval(() => setTick((t) => t + 1), 30_000)

    return () => {
      authUnsub()
      summaryUnsub?.()
      window.clearInterval(tickInterval)
    }
  }, [])

  if (state.kind === 'loading') {
    return (
      <div className="cc-root">
        <div className="cc-card">
          <div className="cc-spinner" role="status" aria-label="Loading" />
          <p className="cc-help">Loading…</p>
        </div>
      </div>
    )
  }

  if (state.kind === 'no-session') {
    return (
      <div className="cc-root">
        <div className="cc-card cc-card--error">
          <h1 className="cc-title">No caregiver session found</h1>
          <p className="cc-error-msg">
            Please open the link your family member shared with you.
          </p>
        </div>
      </div>
    )
  }

  if (state.kind === 'expired') {
    return (
      <div className="cc-root">
        <div className="cc-card cc-card--error">
          <h1 className="cc-title">Your access has expired</h1>
          <p className="cc-error-msg">
            Ask your family member to share a new link with you.
          </p>
        </div>
      </div>
    )
  }

  if (state.kind === 'revoked') {
    return (
      <div className="cc-root">
        <div className="cc-card cc-card--error">
          <h1 className="cc-title">Access revoked</h1>
          <p className="cc-error-msg">
            Your family member has revoked this link. Ask them for a new one.
          </p>
        </div>
      </div>
    )
  }

  const { session, summary, lastUpdatedAt } = state
  const member = summary?.members?.[session.visibleMemberId]
  const slots: TodaySummarySlot[] = member
    ? Object.values(member.slots).sort((a, b) =>
        a.scheduledTime.localeCompare(b.scheduledTime),
      )
    : []
  const dateStr = summary?.date ?? todayISTString()
  const memberName = member?.displayName ?? '…'

  return (
    <div className="cc-dashboard-root">
      <header className="cc-dashboard-header">
        <h1 className="cc-dashboard-member-name">{memberName}</h1>
        <span className="cc-dashboard-date">{formatDate(dateStr)}</span>
      </header>

      {slots.length === 0 ? (
        <div className="cc-empty">
          {lastUpdatedAt === null
            ? "Loading today's doses…"
            : 'No doses scheduled for today.'}
        </div>
      ) : (
        <div className="cc-slot-list">
          {slots.map((slot) => {
            const badge = BADGE_MAP[slot.status] ?? BADGE_MAP.pending
            const showLoggedTime =
              (slot.status === 'taken' ||
                slot.status === 'late' ||
                slot.status === 'skipped') &&
              slot.loggedAt !== null
            const loggedText = showLoggedTime
              ? `${slot.status === 'skipped' ? 'Skipped' : 'Taken'} at ${formatLoggedAt(slot.loggedAt)}`
              : null
            return (
              <article
                key={`${slot.regimenId}-${slot.scheduledTime}`}
                className="cc-slot-card"
              >
                <div className="cc-slot-row">
                  <span className="cc-slot-time">
                    {formatTime12(slot.scheduledTime)}
                  </span>
                  <span className={`cc-slot-badge ${badge.cls}`}>
                    {badge.label}
                  </span>
                </div>
                <p className="cc-slot-medicine">
                  {slot.medicineName} — {slot.doseAmount}{' '}
                  {doseUnitLabel(slot.doseAmount, slot.doseUnit)}
                </p>
                {loggedText && <p className="cc-slot-logged">{loggedText}</p>}
              </article>
            )
          })}
        </div>
      )}

      <div className="cc-last-updated" aria-live="polite">
        {lastUpdatedAt ? relativeTime(lastUpdatedAt) : 'Waiting for updates…'}
      </div>
    </div>
  )
}
