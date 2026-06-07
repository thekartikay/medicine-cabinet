// AK-194 — TrackedMedicine projection layer.
//
// Pure transform from raw Firestore docs (a Treatment + its Regimens + the
// matching CabinetItem + today's dose logs) into the TrackedMedicine view model
// the Reimagined UI renders. No Firestore calls, no I/O, no side effects: data
// in, projection out. `today` is injected (defaulting to the IST date) so the
// function is deterministic and unit-testable.
//
// This is the highest-risk module in the Reimagined stack — every screen reads
// these fields — so the slot/status/supply logic is kept explicit and the
// edge cases (PRN, off-days, zero stock, expiry) are handled deliberately.

import type { CabinetItem, DoseLog, DoseStatus, Regimen, Treatment } from '../types'
import { buildSlotId, todayISTString } from './paths'

export type SlotStatus = 'taken' | 'missed' | 'skipped' | 'pending'
export type TodayStatus = 'all_done' | 'partial' | 'none' | 'no_slots'
export type SupplyState = 'good' | 'watch' | 'low'

export interface TrackedSlot {
  slotId: string
  time: string // "08:00"
  status: SlotStatus
}

export interface TrackedMedicine {
  id: string // treatment ID
  personId: string // patient UID
  drug: string // medicine name
  strength: string // e.g. "500mg"
  perDay: number // scheduled doses per (dosing) day
  supplyDays: number // whole days of supply at the daily consumption rate
  todayStatus: TodayStatus
  todaySlots: TrackedSlot[]
  nextTime: string | null // next pending slot time today, or null
  supplyState: SupplyState // good >14d, watch 7-14d, low <7d
}

export interface TrackedMedicineInput {
  treatment: Treatment
  regimens: Regimen[]
  /** The CabinetItem backing this treatment's regimens. Null when disposed/missing. */
  item: CabinetItem | null
  /** Today's dose log docs for this treatment (matched to slots by slotId). */
  todayLogs: DoseLog[]
}

// Supply thresholds (whole days). good > 14, watch 7–14, low < 7.
const WATCH_MAX_DAYS = 14
const WATCH_MIN_DAYS = 7

// A 'late' dose was still taken — collapse it to 'taken' for the view model.
function slotStatusFromLog(status: DoseStatus): SlotStatus {
  return status === 'late' ? 'taken' : status
}

// 0 = Sun … 6 = Sat, parsed from a YYYY-MM-DD string in UTC so the weekday is
// stable regardless of the host timezone.
function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

// Does a fixed-slot regimen carry doses on the given date? (daily always;
// specific-days only on listed weekdays). PRN / flexible-daily have no fixed
// slots and return false. Also respects the regimen's start/end window.
function regimenAppliesOn(regimen: Regimen, date: string): boolean {
  if (date < regimen.startDate) return false
  if (regimen.endDate !== null && date > regimen.endDate) return false
  if (regimen.scheduleType === 'daily') return true
  if (regimen.scheduleType === 'specific-days') {
    return regimen.scheduleDays?.includes(weekdayOf(date)) ?? false
  }
  return false // 'as-needed' (PRN) and 'flexible-daily' carry no fixed slots
}

// True for regimens that have a standing per-day dose rate (used for supply).
function hasFixedSchedule(regimen: Regimen): boolean {
  return regimen.scheduleType === 'daily' || regimen.scheduleType === 'specific-days'
}

function resolveDrugName(input: TrackedMedicineInput): string {
  const { item, regimens, treatment } = input
  return (
    item?.displayNameOverride ||
    item?.brandName ||
    regimens[0]?.displayName ||
    treatment.name ||
    item?.medicineId ||
    ''
  )
}

function supplyStateFromDays(days: number): SupplyState {
  if (days < WATCH_MIN_DAYS) return 'low'
  if (days <= WATCH_MAX_DAYS) return 'watch'
  return 'good'
}

export function projectTrackedMedicine(
  input: TrackedMedicineInput,
  today: string = todayISTString(),
): TrackedMedicine {
  const { treatment, regimens, item, todayLogs } = input
  const patientId = treatment.memberId

  // Index today's logs by slotId for O(1) slot lookup.
  const logBySlot = new Map<string, DoseLog>()
  for (const log of todayLogs) logBySlot.set(log.slotId, log)

  // ── Today's scheduled slots ────────────────────────────────────────────
  const todaySlots: TrackedSlot[] = []
  for (const regimen of regimens) {
    if (!regimenAppliesOn(regimen, today)) continue
    for (const slot of regimen.slots) {
      const hhmm = slot.time.replace(':', '')
      const slotId = buildSlotId(treatment.tId, regimen.rId, patientId, today, hhmm)
      const log = logBySlot.get(slotId)
      todaySlots.push({
        slotId,
        time: slot.time,
        status: log ? slotStatusFromLog(log.status) : 'pending',
      })
    }
  }
  todaySlots.sort((a, b) => a.time.localeCompare(b.time))

  // ── todayStatus (taken-progress; missed/skipped never read as done) ─────
  // Safety choice: 'all_done' requires every slot TAKEN, so a missed or
  // deliberately-skipped dose keeps the day at 'partial'/'none' rather than
  // masquerading as complete on a caregiver's glance.
  const total = todaySlots.length
  const takenCount = todaySlots.filter((s) => s.status === 'taken').length
  let todayStatus: TodayStatus
  if (total === 0) todayStatus = 'no_slots'
  else if (takenCount === total) todayStatus = 'all_done'
  else if (takenCount === 0) todayStatus = 'none'
  else todayStatus = 'partial'

  // Earliest still-pending slot today.
  const nextTime = todaySlots.find((s) => s.status === 'pending')?.time ?? null

  // ── Supply ─────────────────────────────────────────────────────────────
  // perDay = doses on a standard dosing day (specific-days counts its dosing-day
  // total, not calendar-averaged). dailyConsumption = units burned per dosing
  // day. supplyDays = whole days of stock at that rate.
  let perDay = 0
  let dailyConsumption = 0
  for (const regimen of regimens) {
    if (!hasFixedSchedule(regimen)) continue
    const slotsPerDay = regimen.slots.length
    perDay += slotsPerDay
    dailyConsumption += regimen.doseAmount * slotsPerDay
  }

  const quantityOnHand = item?.quantityOnHand ?? 0
  const expired = item?.expiryDate != null && item.expiryDate < today

  let supplyDays: number
  let supplyState: SupplyState
  if (quantityOnHand <= 0 || expired) {
    // No usable stock — out, or expired and shouldn't be used.
    supplyDays = 0
    supplyState = 'low'
  } else if (dailyConsumption > 0) {
    supplyDays = Math.floor(quantityOnHand / dailyConsumption)
    supplyState = supplyStateFromDays(supplyDays)
  } else {
    // Stock on hand but no standing daily rate (PRN / flexible-daily): days of
    // supply is indeterminate. Treat as not-at-risk.
    supplyDays = Number.POSITIVE_INFINITY
    supplyState = 'good'
  }

  return {
    id: treatment.tId,
    personId: patientId,
    drug: resolveDrugName(input),
    strength: item?.strength ?? '',
    perDay,
    supplyDays,
    todayStatus,
    todaySlots,
    nextTime,
    supplyState,
  }
}
