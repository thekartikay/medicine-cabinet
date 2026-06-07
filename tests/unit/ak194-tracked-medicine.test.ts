// AK-194 — TrackedMedicine projection. This is the highest-risk module (every
// Reimagined screen reads it), so the suite covers the full status/supply matrix
// and the edge cases called out in the ticket: all-taken, partial, no-slots
// (PRN), low supply, zero quantity, and expired items.
//
// `today` is injected as '2026-06-08' (a Monday, weekday 1) so weekday-dependent
// schedules are deterministic regardless of when the suite runs.

import { describe, expect, it } from 'vitest'

import type { CabinetItem, DoseLog, DoseStatus, Regimen, Treatment } from '../../src/types'
import { buildSlotId } from '../../src/lib/paths'
import { projectTrackedMedicine, type TrackedMedicineInput } from '../../src/lib/trackedMedicine'

const TODAY = '2026-06-08' // Monday (UTC weekday 1)
const MONDAY = 1
const TUESDAY = 2

// ── typed fixture factories (only fields the projection reads need be real) ──
function treatment(over: Partial<Treatment> = {}): Treatment {
  return {
    tId: 't1',
    hId: 'h1',
    name: 'Crocin',
    memberId: 'p1',
    memberName: null,
    category: 'chronic',
    status: 'active',
    scheduleSummary: '',
    ...over,
  } as Treatment
}

function regimen(over: Partial<Regimen> = {}): Regimen {
  return {
    rId: 'r1',
    tId: 't1',
    hId: 'h1',
    cabinetItemId: 'i1',
    medicineId: 'm1',
    displayName: 'Crocin 500',
    doseAmount: 1,
    doseUnit: 'tablet',
    scheduleType: 'daily',
    scheduleDays: null,
    slots: [],
    startDate: '2020-01-01',
    endDate: null,
    ongoing: true,
    ...over,
  } as Regimen
}

function item(over: Partial<CabinetItem> = {}): CabinetItem {
  return {
    iId: 'i1',
    cId: 'c1',
    hId: 'h1',
    medicineId: 'm1',
    displayNameOverride: null,
    quantityOnHand: 60,
    unit: 'tablet',
    expiryDate: null,
    prescribed: true,
    brandName: 'Crocin',
    strength: '500mg',
    ...over,
  } as CabinetItem
}

function log(time: string, status: DoseStatus, over: Partial<DoseLog> = {}): DoseLog {
  const slotId = buildSlotId('t1', 'r1', 'p1', TODAY, time.replace(':', ''))
  return {
    slotId,
    tId: 't1',
    rId: 'r1',
    hId: 'h1',
    patientId: 'p1',
    scheduledDate: TODAY,
    scheduledTime: time,
    status,
    ...over,
  } as DoseLog
}

function project(over: Partial<TrackedMedicineInput> = {}) {
  const input: TrackedMedicineInput = {
    treatment: treatment(),
    regimens: [regimen({ slots: [{ time: '08:00', foodTiming: 'after' }] })],
    item: item(),
    todayLogs: [],
    ...over,
  }
  return projectTrackedMedicine(input, TODAY)
}

const dailyTwice = () =>
  regimen({
    slots: [
      { time: '08:00', foodTiming: 'after' },
      { time: '20:00', foodTiming: 'after' },
    ],
  })

describe('todayStatus + slots', () => {
  it('all-taken → all_done, no nextTime', () => {
    const r = projectTrackedMedicine(
      {
        treatment: treatment(),
        regimens: [dailyTwice()],
        item: item(),
        todayLogs: [log('08:00', 'taken'), log('20:00', 'taken')],
      },
      TODAY,
    )
    expect(r.todayStatus).toBe('all_done')
    expect(r.todaySlots.map((s) => s.status)).toEqual(['taken', 'taken'])
    expect(r.nextTime).toBeNull()
  })

  it('partial → partial, nextTime = earliest pending', () => {
    const r = projectTrackedMedicine(
      {
        treatment: treatment(),
        regimens: [dailyTwice()],
        item: item(),
        todayLogs: [log('08:00', 'taken')],
      },
      TODAY,
    )
    expect(r.todayStatus).toBe('partial')
    expect(r.nextTime).toBe('20:00')
    expect(r.todaySlots).toEqual([
      { slotId: buildSlotId('t1', 'r1', 'p1', TODAY, '0800'), time: '08:00', status: 'taken' },
      { slotId: buildSlotId('t1', 'r1', 'p1', TODAY, '2000'), time: '20:00', status: 'pending' },
    ])
  })

  it("'late' collapses to taken", () => {
    const r = projectTrackedMedicine(
      {
        treatment: treatment(),
        regimens: [regimen({ slots: [{ time: '08:00', foodTiming: 'after' }] })],
        item: item(),
        todayLogs: [log('08:00', 'late')],
      },
      TODAY,
    )
    expect(r.todaySlots[0]!.status).toBe('taken')
    expect(r.todayStatus).toBe('all_done')
  })

  it('no logs → none, nextTime = first slot', () => {
    const r = projectTrackedMedicine(
      { treatment: treatment(), regimens: [dailyTwice()], item: item(), todayLogs: [] },
      TODAY,
    )
    expect(r.todayStatus).toBe('none')
    expect(r.nextTime).toBe('08:00')
  })

  it('missed/skipped never count as taken (safety): all-missed → none', () => {
    const r = projectTrackedMedicine(
      {
        treatment: treatment(),
        regimens: [dailyTwice()],
        item: item(),
        todayLogs: [log('08:00', 'missed'), log('20:00', 'missed')],
      },
      TODAY,
    )
    expect(r.todayStatus).toBe('none')
    expect(r.nextTime).toBeNull() // missed slots are resolved, not pending
  })

  it('taken + skipped → partial (skip is not a take)', () => {
    const r = projectTrackedMedicine(
      {
        treatment: treatment(),
        regimens: [dailyTwice()],
        item: item(),
        todayLogs: [log('08:00', 'taken'), log('20:00', 'skipped')],
      },
      TODAY,
    )
    expect(r.todayStatus).toBe('partial')
    expect(r.nextTime).toBeNull()
  })

  it('merges multiple regimens and sorts slots by time', () => {
    const r = projectTrackedMedicine(
      {
        treatment: treatment(),
        regimens: [
          regimen({ rId: 'rA', slots: [{ time: '20:00', foodTiming: 'after' }] }),
          regimen({ rId: 'rB', slots: [{ time: '08:00', foodTiming: 'after' }] }),
        ],
        item: item(),
        todayLogs: [],
      },
      TODAY,
    )
    expect(r.todaySlots.map((s) => s.time)).toEqual(['08:00', '20:00'])
    expect(r.perDay).toBe(2)
  })
})

describe('PRN / no-slots', () => {
  it('as-needed regimen → no_slots, empty slots, indeterminate (good) supply', () => {
    const r = projectTrackedMedicine(
      {
        treatment: treatment({ category: 'prn' }),
        regimens: [regimen({ scheduleType: 'as-needed', slots: [] })],
        item: item({ quantityOnHand: 30 }),
        todayLogs: [],
      },
      TODAY,
    )
    expect(r.todayStatus).toBe('no_slots')
    expect(r.todaySlots).toEqual([])
    expect(r.nextTime).toBeNull()
    expect(r.perDay).toBe(0)
    expect(r.supplyDays).toBe(Number.POSITIVE_INFINITY)
    expect(r.supplyState).toBe('good')
  })
})

describe('specific-days schedules', () => {
  it('off-day → no slots today, but supply still computed from the daily rate', () => {
    const r = projectTrackedMedicine(
      {
        treatment: treatment(),
        regimens: [
          regimen({
            scheduleType: 'specific-days',
            scheduleDays: [TUESDAY], // today is Monday
            slots: [{ time: '08:00', foodTiming: 'after' }],
          }),
        ],
        item: item({ quantityOnHand: 30 }),
        todayLogs: [],
      },
      TODAY,
    )
    expect(r.todayStatus).toBe('no_slots')
    expect(r.todaySlots).toEqual([])
    expect(r.perDay).toBe(1)
    expect(r.supplyDays).toBe(30)
    expect(r.supplyState).toBe('good')
  })

  it('on-day → slots present', () => {
    const r = projectTrackedMedicine(
      {
        treatment: treatment(),
        regimens: [
          regimen({
            scheduleType: 'specific-days',
            scheduleDays: [MONDAY],
            slots: [{ time: '08:00', foodTiming: 'after' }],
          }),
        ],
        item: item(),
        todayLogs: [],
      },
      TODAY,
    )
    expect(r.todaySlots).toHaveLength(1)
    expect(r.todayStatus).toBe('none')
  })
})

describe('supply state thresholds', () => {
  it('low: < 7 days', () => {
    expect(project({ item: item({ quantityOnHand: 5 }) }).supplyState).toBe('low')
    expect(project({ item: item({ quantityOnHand: 5 }) }).supplyDays).toBe(5)
  })

  it('watch: 7–14 days', () => {
    const r = project({ regimens: [dailyTwice()], item: item({ quantityOnHand: 20 }) })
    expect(r.supplyDays).toBe(10) // 20 / (2 doses * 1 unit)
    expect(r.supplyState).toBe('watch')
  })

  it('good: > 14 days', () => {
    const r = project({ regimens: [dailyTwice()], item: item({ quantityOnHand: 60 }) })
    expect(r.supplyDays).toBe(30)
    expect(r.supplyState).toBe('good')
  })

  it('boundary: exactly 7 = watch, exactly 14 = watch, 15 = good', () => {
    expect(project({ item: item({ quantityOnHand: 7 }) }).supplyState).toBe('watch')
    expect(project({ item: item({ quantityOnHand: 14 }) }).supplyState).toBe('watch')
    expect(project({ item: item({ quantityOnHand: 15 }) }).supplyState).toBe('good')
  })

  it('respects doseAmount > 1 in consumption', () => {
    const r = project({
      regimens: [regimen({ doseAmount: 2, slots: [{ time: '08:00', foodTiming: 'after' }] })],
      item: item({ quantityOnHand: 20 }),
    })
    expect(r.supplyDays).toBe(10) // 20 / (1 dose * 2 units)
  })
})

describe('zero / expired / missing stock', () => {
  it('zero quantity → 0 days, low', () => {
    const r = project({ item: item({ quantityOnHand: 0 }) })
    expect(r.supplyDays).toBe(0)
    expect(r.supplyState).toBe('low')
  })

  it('expired item → low even with plenty of stock', () => {
    const r = project({ item: item({ quantityOnHand: 120, expiryDate: '2026-01-01' }) })
    expect(r.supplyDays).toBe(0)
    expect(r.supplyState).toBe('low')
  })

  it('not-yet-expired item is unaffected', () => {
    const r = project({
      regimens: [dailyTwice()],
      item: item({ quantityOnHand: 60, expiryDate: '2099-01-01' }),
    })
    expect(r.supplyState).toBe('good')
  })

  it('missing cabinet item → empty strength, zero supply, name from regimen', () => {
    const r = project({ item: null })
    expect(r.strength).toBe('')
    expect(r.supplyDays).toBe(0)
    expect(r.supplyState).toBe('low')
    expect(r.drug).toBe('Crocin 500')
  })
})

describe('identity + naming fields', () => {
  it('maps id/personId and prefers the item display name', () => {
    const r = project({
      treatment: treatment({ tId: 'tX', memberId: 'pX' }),
      item: item({ displayNameOverride: 'Dolo 650', strength: '650mg' }),
    })
    expect(r.id).toBe('tX')
    expect(r.personId).toBe('pX')
    expect(r.drug).toBe('Dolo 650')
    expect(r.strength).toBe('650mg')
  })

  it('ignores logs whose slotId does not match a scheduled slot', () => {
    // A stray log (wrong time) must not mark the real slot taken.
    const r = projectTrackedMedicine(
      {
        treatment: treatment(),
        regimens: [regimen({ slots: [{ time: '08:00', foodTiming: 'after' }] })],
        item: item(),
        todayLogs: [log('09:30', 'taken')],
      },
      TODAY,
    )
    expect(r.todaySlots[0]!.status).toBe('pending')
    expect(r.todayStatus).toBe('none')
  })

  it('excludes regimens outside their start/end window', () => {
    const future = project({
      regimens: [regimen({ startDate: '2099-01-01', slots: [{ time: '08:00', foodTiming: 'after' }] })],
    })
    expect(future.todayStatus).toBe('no_slots')

    const ended = project({
      regimens: [
        regimen({ endDate: '2020-12-31', slots: [{ time: '08:00', foodTiming: 'after' }] }),
      ],
    })
    expect(ended.todayStatus).toBe('no_slots')
  })
})
