// AK-196 — pure helpers for the People screens. Kept separate from the .tsx so
// the aggregation logic is unit-testable without React.

import type { TrackedMedicine } from '../../lib/trackedMedicine'
import type { HouseholdMember } from '../../types'

export interface DoseSummary {
  taken: number
  total: number
}

// Aggregate today's slots across all of a person's tracked medicines.
export function summarizeToday(tracked: TrackedMedicine[]): DoseSummary {
  let taken = 0
  let total = 0
  for (const tm of tracked) {
    for (const slot of tm.todaySlots) {
      total += 1
      if (slot.status === 'taken') taken += 1
    }
  }
  return { taken, total }
}

export function doseSummaryLabel(summary: DoseSummary): string {
  if (summary.total === 0) return 'No doses today'
  return `${summary.taken} of ${summary.total} taken`
}

// True when any of the person's medicines is low on supply.
export function hasLowStock(tracked: TrackedMedicine[]): boolean {
  return tracked.some((tm) => tm.supplyState === 'low')
}

export interface HomeGroup {
  hId: string
  members: HouseholdMember[]
}

// Group members by home, preserving first-seen order. Single-home in beta;
// structured this way so multi-home (AK-202) drops in without a rewrite.
export function groupByHome(members: HouseholdMember[]): HomeGroup[] {
  const order: string[] = []
  const byHome = new Map<string, HouseholdMember[]>()
  for (const m of members) {
    if (!byHome.has(m.hId)) {
      byHome.set(m.hId, [])
      order.push(m.hId)
    }
    byHome.get(m.hId)!.push(m)
  }
  return order.map((hId) => ({ hId, members: byHome.get(hId)! }))
}
