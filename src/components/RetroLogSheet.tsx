import type { FoodTiming } from '../types'

// AK-121 — Bottom sheet that opens after the user picks "log past doses" on
// the PastDateModal and the new treatment + regimen have been saved. Lets
// the admin tick which historical doses were actually taken vs missed.
// Skipped doses get a default skipReason; the bulk write goes through
// logRetroactiveDoses → writeBatch.

export interface RetroSlot {
  slotId: string
  date: string         // YYYY-MM-DD
  displayDate: string  // human-friendly date label
  time: string         // HH:MM
  foodTiming: FoodTiming
}

interface RetroLogSheetProps {
  slots: RetroSlot[]
  checks: Record<string, boolean>
  medicineName: string
  wasCapped: boolean
  onToggle: (slotId: string) => void
  onSave: () => void
  onSkip: () => void
}

const FOOD_LABELS: Record<FoodTiming, string> = {
  before: 'Before food',
  after: 'After food',
  with: 'With food',
}

// Group flat slot array by date — preserves newest-first order from
// generatePastSlots because we walk the input array in order and only
// create a new bucket when we encounter a new date.
function groupByDate(
  slots: RetroSlot[],
): Array<{ date: string; displayDate: string; items: RetroSlot[] }> {
  const groups: Array<{ date: string; displayDate: string; items: RetroSlot[] }> = []
  for (const s of slots) {
    let current = groups[groups.length - 1]
    if (!current || current.date !== s.date) {
      current = { date: s.date, displayDate: s.displayDate, items: [] }
      groups.push(current)
    }
    current.items.push(s)
  }
  return groups
}

export function RetroLogSheet({
  slots,
  checks,
  medicineName,
  wasCapped,
  onToggle,
  onSave,
  onSkip,
}: RetroLogSheetProps) {
  const groups = groupByDate(slots)
  return (
    <div className="bs-overlay" role="dialog" aria-modal="true" aria-labelledby="retro-title">
      <div className="bs-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="bs-handle" aria-hidden="true" />
        <h3 id="retro-title" className="bs-section-title">
          Log past doses — {medicineName}
        </h3>
        {wasCapped && (
          <p className="retro-cap-note" role="status">
            Showing the 30 most recent days.
          </p>
        )}
        <div className="retro-checklist">
          {groups.map(({ date, displayDate, items }) => (
            <div key={date} className="retro-day-group">
              <h4 className="retro-day-header">{displayDate}</h4>
              {items.map((s) => {
                const checked = checks[s.slotId] ?? true
                return (
                  <label key={s.slotId} className="retro-row">
                    <input
                      type="checkbox"
                      className="retro-checkbox"
                      checked={checked}
                      onChange={() => onToggle(s.slotId)}
                    />
                    <span className="retro-row-time">{s.time}</span>
                    <span className="retro-row-food">
                      {FOOD_LABELS[s.foodTiming]}
                    </span>
                  </label>
                )
              })}
            </div>
          ))}
        </div>
        <div className="bs-actions">
          <button
            type="button"
            className="bs-btn bs-btn--secondary"
            onClick={onSkip}
          >
            Skip for now
          </button>
          <button
            type="button"
            className="bs-btn bs-btn--primary"
            onClick={onSave}
          >
            Save logs
          </button>
        </div>
      </div>
    </div>
  )
}
