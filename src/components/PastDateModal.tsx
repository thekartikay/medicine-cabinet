// AK-121 — Modal shown at the step 3 → step 4 wizard boundary when the
// chosen start date is in the past (and the schedule isn't PRN). Two
// branches:
//   • "Start tracking from today" → snaps the wizard's startDate to today
//     and proceeds normally. No retro logs are written.
//   • "Log past doses" → keeps the historical startDate, advances, and
//     opens the RetroLogSheet after save so the admin can check off which
//     past doses were actually taken.

interface PastDateModalProps {
  startDate: string                  // YYYY-MM-DD
  onTrackFromToday: () => void
  onLogPastDoses: () => void
}

// Days between two YYYY-MM-DD strings, anchored at noon IST to avoid DST/
// off-by-one. Used only for the "more than 30 days" warning.
function daysBetween(earlier: string, later: string): number {
  const a = new Date(`${earlier}T12:00:00+05:30`).getTime()
  const b = new Date(`${later}T12:00:00+05:30`).getTime()
  return Math.round((b - a) / 86400000)
}

export function PastDateModal({
  startDate,
  onTrackFromToday,
  onLogPastDoses,
}: PastDateModalProps) {
  // "today" is computed at render-time, not memoized. The modal is short-
  // lived and not re-rendered across midnight boundaries.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
  const daysInPast = daysBetween(startDate, today)
  const isLargeWindow = daysInPast > 30

  return (
    <div
      className="pdm-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pdm-title"
    >
      <div className="pdm-card">
        <div className="pdm-icon-circle" aria-hidden="true">⏱</div>
        <h2 id="pdm-title" className="pdm-title">Start date is in the past</h2>
        <p className="pdm-body">
          The start date you chose is in the past. Would you like to start
          tracking from today, or log the doses you've already taken?
        </p>
        {isLargeWindow && (
          <p className="pdm-large-window" role="status">
            That's more than 30 days of past doses. Consider starting from today instead.
          </p>
        )}
        <button
          type="button"
          className="pdm-button pdm-button--primary"
          onClick={onTrackFromToday}
        >
          Start tracking from today
        </button>
        <button
          type="button"
          className="pdm-button pdm-button--secondary"
          onClick={onLogPastDoses}
        >
          I've been taking this — log past doses
        </button>
      </div>
    </div>
  )
}
