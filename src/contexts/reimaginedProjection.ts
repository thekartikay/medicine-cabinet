// AK-195 — pure data-shaping helpers for ReimaginedCtx.
//
// Kept out of the .tsx so the context module only exports the provider + hook
// (react-refresh clean) and so the projection/grouping, slot resolution, and
// restock-arg derivation stay unit-testable without React or Firestore.

import { buildSlotId } from '../lib/paths'
import { projectTrackedMedicine, type TrackedMedicine } from '../lib/trackedMedicine'
import type {
  CabinetItem,
  DoseLog,
  Regimen,
  ScheduleType,
  TimeSlot,
  Treatment,
  TreatmentCategory,
} from '../types'

export interface AddTrackedInput {
  treatment: {
    name: string
    memberId: string
    memberName: string | null
    category: TreatmentCategory
  }
  regimen: {
    cabinetItemId: string
    medicineId: string
    displayName: string
    doseAmount: number
    doseUnit: string
    scheduleType: ScheduleType
    scheduleDays: number[] | null
    slots: TimeSlot[]
    startDate: string
    endDate: string | null
    ongoing: boolean
    maxDosesPerDay?: number
    timezone?: string
  }
}

// Everything logDose() needs for one slot, keyed by slotId. status is supplied
// by the caller of markDose.
export interface DoseArgs {
  tId: string
  rId: string
  patientId: string
  cabinetItemId: string
  scheduledDate: string
  scheduledTime: string
  doseAmount: number
  doseUnit: string
}

export interface RestockArgs {
  cabinetItemId: string
  medicineName: string
  requestedBy: string
  quantityAtRequest: number
}

// The CabinetItem a treatment's regimens point at (via the first regimen's
// cabinetItemId), or null when it isn't in the loaded item set (disposed, or in
// a non-default cabinet).
export function itemForTreatment(regimens: Regimen[], items: CabinetItem[]): CabinetItem | null {
  const cabinetItemId = regimens[0]?.cabinetItemId
  if (!cabinetItemId) return null
  return items.find((i) => i.iId === cabinetItemId) ?? null
}

// Project every treatment through trackedMedicine.ts and group by patient UID.
export function buildTrackedByPerson(
  treatments: Treatment[],
  regimensByTreatment: Record<string, Regimen[]>,
  logsByTreatment: Record<string, DoseLog[]>,
  items: CabinetItem[],
  today: string,
): Record<string, TrackedMedicine[]> {
  const byPerson: Record<string, TrackedMedicine[]> = {}
  for (const treatment of treatments) {
    const regimens = regimensByTreatment[treatment.tId] ?? []
    const todayLogs = logsByTreatment[treatment.tId] ?? []
    const item = itemForTreatment(regimens, items)
    const tracked = projectTrackedMedicine({ treatment, regimens, item, todayLogs }, today)
    ;(byPerson[tracked.personId] ??= []).push(tracked)
  }
  return byPerson
}

// Map every today-dated slot to the args logDose() needs, so markDose(slotId)
// can resolve a UI slot back to a write without re-deriving from the slotId
// string (which can contain dashes in its id segments).
export function buildSlotIndex(
  treatments: Treatment[],
  regimensByTreatment: Record<string, Regimen[]>,
  today: string,
): Map<string, DoseArgs> {
  const index = new Map<string, DoseArgs>()
  for (const treatment of treatments) {
    const regimens = regimensByTreatment[treatment.tId] ?? []
    for (const regimen of regimens) {
      for (const slot of regimen.slots) {
        const slotId = buildSlotId(
          treatment.tId,
          regimen.rId,
          treatment.memberId,
          today,
          slot.time.replace(':', ''),
        )
        index.set(slotId, {
          tId: treatment.tId,
          rId: regimen.rId,
          patientId: treatment.memberId,
          cabinetItemId: regimen.cabinetItemId,
          scheduledDate: today,
          scheduledTime: slot.time,
          doseAmount: regimen.doseAmount,
          doseUnit: regimen.doseUnit,
        })
      }
    }
  }
  return index
}

// Build the createRestockRequest args for a cabinet item, or null if unknown.
export function resolveRestockArgs(
  items: CabinetItem[],
  itemId: string,
  requestedBy: string,
): RestockArgs | null {
  const item = items.find((i) => i.iId === itemId)
  if (!item) return null
  return {
    cabinetItemId: item.iId,
    medicineName: item.displayNameOverride ?? item.brandName ?? item.medicineId,
    requestedBy,
    quantityAtRequest: item.quantityOnHand,
  }
}
