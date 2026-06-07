// AK-197 — pure helpers for the Cabinet screens. No React, no Firestore.

import type { TrackedMedicine } from '../../lib/trackedMedicine'
import type { HouseholdMember } from '../../types'

// One medicine plus the person/home context the Cabinet rows need.
export interface CabinetEntry {
  tracked: TrackedMedicine
  personName: string
  hId: string
}

export interface HomeBucket {
  hId: string
  entries: CabinetEntry[]
}

// low first, then watch, then good.
const SUPPLY_ORDER: Record<TrackedMedicine['supplyState'], number> = { low: 0, watch: 1, good: 2 }

// Flatten members × their tracked medicines into CabinetEntry rows, preserving
// member order then per-person medicine order.
export function flattenEntries(
  members: HouseholdMember[],
  trackedByPerson: Record<string, TrackedMedicine[]>,
): CabinetEntry[] {
  const entries: CabinetEntry[] = []
  for (const m of members) {
    for (const tracked of trackedByPerson[m.uid] ?? []) {
      entries.push({ tracked, personName: m.displayName ?? 'Member', hId: m.hId })
    }
  }
  return entries
}

// Stable sort by supply urgency: low → watch → good. Does not mutate input.
export function sortBySupplyState(entries: CabinetEntry[]): CabinetEntry[] {
  return [...entries].sort(
    (a, b) => SUPPLY_ORDER[a.tracked.supplyState] - SUPPLY_ORDER[b.tracked.supplyState],
  )
}

// Group entries by home (preserving first-seen home order); each home's entries
// are sorted low-supply first. Homes with no medicines do not appear.
export function groupTrackedByHome(
  members: HouseholdMember[],
  trackedByPerson: Record<string, TrackedMedicine[]>,
): HomeBucket[] {
  const order: string[] = []
  const byHome = new Map<string, CabinetEntry[]>()
  for (const entry of flattenEntries(members, trackedByPerson)) {
    if (!byHome.has(entry.hId)) {
      byHome.set(entry.hId, [])
      order.push(entry.hId)
    }
    byHome.get(entry.hId)!.push(entry)
  }
  return order.map((hId) => ({ hId, entries: sortBySupplyState(byHome.get(hId)!) }))
}

// Find a tracked medicine by its id (treatment id) across all people.
export function findTrackedById(
  trackedByPerson: Record<string, TrackedMedicine[]>,
  id: string,
): TrackedMedicine | null {
  for (const meds of Object.values(trackedByPerson)) {
    for (const m of meds) {
      if (m.id === id) return m
    }
  }
  return null
}

// Immutably toggle a home id in the collapsed-set.
export function toggleCollapsed(collapsed: ReadonlySet<string>, hId: string): Set<string> {
  const next = new Set(collapsed)
  if (next.has(hId)) next.delete(hId)
  else next.add(hId)
  return next
}
