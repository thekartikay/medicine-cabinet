import { Bell, X } from 'lucide-react'
import {
  markNotificationRead,
  markAllNotificationsRead,
} from '../services/firestoreService'
import type { Notification } from '../types'
import { todayISTString } from '../lib/paths'

interface Props {
  open: boolean
  onClose: () => void
  notifications: Notification[]   // already filtered for this view
  currentUid: string
  hId: string
}

export function timeAgo(ts: { toMillis: () => number } | null | undefined): string {
  if (!ts) return ''
  const ms = Date.now() - ts.toMillis()
  if (ms < 60_000) return 'Just now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.floor(hrs / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

// IST calendar date (YYYY-MM-DD) for grouping. Falls back to today if the
// timestamp hasn't resolved yet (rare — applies only to local-only writes
// before server commit, which we don't use for notifications).
function istDateOf(ts: { toDate: () => Date } | null): string {
  if (!ts) return todayISTString()
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(ts.toDate())
}

function groupLabel(dateStr: string, todayStr: string): string {
  if (dateStr === todayStr) return 'Today'
  const today = new Date(todayStr + 'T00:00:00')
  const target = new Date(dateStr + 'T00:00:00')
  const diff = Math.round((today.getTime() - target.getTime()) / 86400000)
  if (diff === 1) return 'Yesterday'
  return target.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

export function NotificationsPanel({ open, onClose, notifications, currentUid, hId }: Props) {
  if (!open) return null

  const today = todayISTString()
  const hasUnread = notifications.some(n => !n.readBy.includes(currentUid))

  // Group by IST date. Notifications are already sorted desc by createdAt,
  // so per-group order is preserved; group order is then date-desc.
  const groupMap = new Map<string, Notification[]>()
  for (const n of notifications) {
    const date = istDateOf(n.createdAt)
    if (!groupMap.has(date)) groupMap.set(date, [])
    groupMap.get(date)!.push(n)
  }
  const groups = Array.from(groupMap.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([date, items]) => ({ date, label: groupLabel(date, today), items }))

  return (
    <div
      className="db-notif-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="db-notif-title"
    >
      <div className="db-notif-panel" onClick={e => e.stopPropagation()}>
        <header className="db-notif-header">
          <h3 id="db-notif-title" className="db-notif-title">Notifications</h3>
          <div className="db-notif-header-actions">
            {hasUnread && (
              <button
                type="button"
                className="db-notif-mark-all"
                onClick={() => markAllNotificationsRead(hId, notifications, currentUid)}
              >
                Mark all read
              </button>
            )}
            <button
              type="button"
              className="db-notif-close"
              onClick={onClose}
              aria-label="Close notifications"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {notifications.length === 0 ? (
          <div className="db-notif-empty">
            <Bell size={28} aria-hidden="true" />
            <p>No notifications</p>
          </div>
        ) : (
          <div className="db-notif-scroll">
            {groups.map(g => (
              <section key={g.date} className="db-notif-group">
                <h4 className="db-notif-group-label">{g.label}</h4>
                <ul className="db-notif-list">
                  {g.items.map(n => {
                    const unread = !n.readBy.includes(currentUid)
                    const itemClass =
                      'db-notif-item'
                      + (unread ? ` db-notif-item--unread db-notif-item--${n.type}` : '')
                    return (
                      <li
                        key={n.notifId}
                        className={itemClass}
                        onClick={() => unread && markNotificationRead(hId, n.notifId, currentUid)}
                      >
                        <span
                          className={`db-notif-dot db-notif-dot--${unread ? n.type : 'read'}`}
                          aria-hidden="true"
                        />
                        <div className="db-notif-body">
                          <p className="db-notif-message">{n.message}</p>
                          <time className="db-notif-time">{timeAgo(n.createdAt)}</time>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
