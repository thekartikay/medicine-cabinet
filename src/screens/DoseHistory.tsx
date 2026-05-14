import { useEffect, useState } from 'react'
import { ChevronLeft, Check, X, Minus, Clock, History } from 'lucide-react'
import {
  loadLogsForDateRange,
  loadAllActiveRegimens,
  getHouseholdMembers,
} from '../services/firestoreService'
import { todayISTString } from '../lib/paths'
import type { DoseLog, HouseholdMember, Regimen, Treatment } from '../types'

interface Props {
  hId: string
  onBack: () => void
  // When set, the screen renders entries for this user only (member view)
  // and the member-filter chips are hidden.
  filterUid?: string
}

type EntryStatus = 'taken' | 'late' | 'skipped' | 'missed' | 'pending'

interface DayEntry {
  key: string                  // unique row id (rId + slotTime)
  medicineName: string
  scheduledTime: string        // "HH:MM"
  status: EntryStatus
  skipReason: string | null
  patientId: string            // which member this dose belongs to
  memberName: string | null    // displayName for member-aware rendering
}

interface DayGroup {
  date: string                 // YYYY-MM-DD
  label: string                // "Today" | "Yesterday" | "30 Apr"
  entries: DayEntry[]
  takenCount: number
  totalCount: number
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function pastNDates(n: number): string[] {
  // Returns IST-anchored YYYY-MM-DD strings, today first then descending.
  const dates: string[] = []
  const today = todayISTString()
  const todayDate = new Date(today + 'T00:00:00')
  for (let i = 0; i < n; i++) {
    const d = new Date(todayDate)
    d.setDate(d.getDate() - i)
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    dates.push(`${yyyy}-${mm}-${dd}`)
  }
  return dates
}

function dateLabel(dateStr: string, todayStr: string): string {
  if (dateStr === todayStr) return 'Today'
  const today = new Date(todayStr + 'T00:00:00')
  const target = new Date(dateStr + 'T00:00:00')
  const diff = Math.round((today.getTime() - target.getTime()) / 86400000)
  if (diff === 1) return 'Yesterday'
  return target.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

function formatTimeFriendly(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number)
  const period = h >= 12 ? 'pm' : 'am'
  const h12 = h % 12 === 0 ? 12 : h % 12
  return `${h12}:${String(m).padStart(2, '0')} ${period}`
}

// True if `regimen` has a slot scheduled on `dateStr`.
function regimenAppliesOn(reg: Regimen, dateStr: string): boolean {
  if (reg.startDate > dateStr) return false
  if (reg.endDate && reg.endDate < dateStr) return false
  if (reg.scheduleType === 'as-needed') return false
  if (reg.scheduleType === 'daily') return true
  // specific-days: dow 0 = Sunday … 6 = Saturday
  const dow = new Date(dateStr + 'T00:00:00').getDay()
  return reg.scheduleDays?.includes(dow) ?? false
}

// Build the slot id the same way logDose does on write, so we can pair an
// expected slot with its log without a second Firestore read.
function buildSlotId(t: Treatment, reg: Regimen, slotTime: string, date: string): string {
  const hhmm = slotTime.replace(':', '')
  return `${reg.tId}-${reg.rId}-${t.memberId}-${date}-${hhmm}`
}

// ── Component ───────────────────────────────────────────────────────────────

export function DoseHistory({ hId, onBack, filterUid }: Props) {
  const [groups, setGroups] = useState<DayGroup[] | null>(null)
  const [error, setError] = useState('')
  const [members, setMembers] = useState<HouseholdMember[]>([])
  // Active filter chip ('all' or a member uid). Member-mode locks to filterUid.
  const [activeFilter, setActiveFilter] = useState<string>(filterUid ?? 'all')

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const today = todayISTString()
        const dates = pastNDates(7)              // [today, yesterday, …, 7 days ago]
        const oldest = dates[dates.length - 1]
        const [logs, { treatments, regimensByTreatment }, hhMembers] = await Promise.all([
          loadLogsForDateRange(hId, oldest, today),
          loadAllActiveRegimens(hId),
          // Members are only used for the filter chips when no filterUid is set.
          filterUid ? Promise.resolve([] as HouseholdMember[]) : getHouseholdMembers(hId),
        ])
        if (cancelled) return

        // Index logs by slotId for O(1) pairing with expected slots.
        const logBySlot: Record<string, DoseLog> = {}
        for (const log of logs) logBySlot[log.slotId] = log

        const next: DayGroup[] = dates.map(date => {
          const entries: DayEntry[] = []
          for (const t of treatments) {
            for (const reg of regimensByTreatment[t.tId] ?? []) {
              if (!regimenAppliesOn(reg, date)) continue
              for (const slot of reg.slots) {
                const slotId = buildSlotId(t, reg, slot.time, date)
                const log = logBySlot[slotId]
                let status: EntryStatus
                if (log) {
                  status = log.status
                } else {
                  status = date === today ? 'pending' : 'missed'
                }
                entries.push({
                  key: slotId,
                  medicineName: reg.displayName,
                  scheduledTime: slot.time,
                  status,
                  skipReason: log?.skipReason ?? null,
                  patientId: t.memberId,
                  memberName: t.memberName,
                })
              }
            }
          }
          // Earliest slot first within a day.
          entries.sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime))
          const takenCount = entries.filter(e => e.status === 'taken' || e.status === 'late').length
          return {
            date,
            label: dateLabel(date, today),
            entries,
            takenCount,
            totalCount: entries.length,
          }
        })

        setGroups(next)        // keep all 7 day buckets; we filter at render time
        setMembers(hhMembers)
      } catch {
        if (!cancelled) setError('Could not load history. Check your connection.')
      }
    }
    load()
    return () => { cancelled = true }
  }, [hId, filterUid])

  return (
    <div className="cb-view">
      <div className="cb-subheader">
        <button className="cb-back-btn" onClick={onBack} aria-label="Back to dashboard">
          <ChevronLeft size={20} />
        </button>
        <h2 className="cb-page-title">Dose History</h2>
      </div>

      {error && <p className="cb-hint cb-hint--error" role="alert">{error}</p>}

      {/* Member-filter chips: shown only when not locked to a single user. */}
      {!filterUid && members.length > 1 && (
        <div className="dh-filter-row" role="radiogroup" aria-label="Filter by member">
          <button
            type="button"
            role="radio"
            aria-checked={activeFilter === 'all'}
            className={`dh-filter-chip${activeFilter === 'all' ? ' dh-filter-chip--active' : ''}`}
            onClick={() => setActiveFilter('all')}
          >
            <span className="dh-filter-chip-avatar" aria-hidden="true">∗</span>
            <span>All members</span>
          </button>
          {members.map(m => {
            const name = m.displayName?.trim() || 'Member'
            const initial = name.charAt(0).toUpperCase()
            const active = activeFilter === m.uid
            return (
              <button
                key={m.uid}
                type="button"
                role="radio"
                aria-checked={active}
                className={`dh-filter-chip${active ? ' dh-filter-chip--active' : ''}`}
                onClick={() => setActiveFilter(m.uid)}
              >
                <span className="dh-filter-chip-avatar" aria-hidden="true">{initial}</span>
                <span>{name}</span>
              </button>
            )
          })}
        </div>
      )}

      {!groups && !error && (
        <div className="cb-loader"><div className="cb-spinner" role="status" aria-label="Loading" /></div>
      )}

      {(() => {
        if (!groups) return null

        // Apply the active filter (or the locked filterUid in member mode).
        const lockedUid = filterUid ?? (activeFilter === 'all' ? null : activeFilter)
        const visible = groups
          .map(g => ({
            ...g,
            entries: lockedUid ? g.entries.filter(e => e.patientId === lockedUid) : g.entries,
          }))
          .map(g => ({
            ...g,
            takenCount: g.entries.filter(e => e.status === 'taken' || e.status === 'late').length,
            totalCount: g.entries.length,
          }))
          .filter(g => g.entries.length > 0)

        if (visible.length === 0) {
          return (
            <div className="db-card db-empty-state">
              <div className="empty-state-icon">
                <History size={28} color="#5DC1C8" />
              </div>
              <p className="db-empty-text">No dose history yet</p>
              <p className="db-empty-sub">Logs from the last 7 days will appear here.</p>
            </div>
          )
        }

        return (
          <ul className="dh-day-list">
            {visible.map(g => (
              <li key={g.date} className="dh-day-group">
                <div className="dh-day-header">
                  <span className="dh-day-label">{g.label}</span>
                  <span className="dh-day-summary">{g.takenCount} of {g.totalCount} taken</span>
                </div>
                <ul className="dh-entry-list">
                  {g.entries.map(e => (
                    <li key={e.key} className="db-card dh-entry">
                      <div className="dh-entry-row">
                        <div className="dh-entry-info">
                          <span className="dh-entry-medicine">{e.medicineName}</span>
                          <span className="dh-entry-time">
                            {formatTimeFriendly(e.scheduledTime)}
                            {/* Show member name only when viewing all members (admin mode) */}
                            {!filterUid && activeFilter === 'all' && e.memberName && (
                              <> · <span className="dh-entry-member">{e.memberName}</span></>
                            )}
                          </span>
                        </div>
                        <span className={`tr-log-badge tr-log-badge--${e.status}`}>
                          {e.status === 'taken'   && <Check size={12} />}
                          {e.status === 'late'    && <Check size={12} />}
                          {e.status === 'skipped' && <Minus size={12} />}
                          {e.status === 'pending' && <Clock size={12} />}
                          {e.status === 'missed'  && <X     size={12} />}
                          {labelOf(e.status)}
                        </span>
                      </div>
                      {e.status === 'skipped' && e.skipReason && (
                        <p className="tr-log-reason">"{e.skipReason}"</p>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )
      })()}
    </div>
  )
}

function labelOf(s: EntryStatus): string {
  if (s === 'taken')   return 'Taken'
  if (s === 'late')    return 'Late'
  if (s === 'skipped') return 'Skipped'
  if (s === 'pending') return 'Pending'
  return 'Missed'
}
