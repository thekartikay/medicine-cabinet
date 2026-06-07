// AK-195 — ReimaginedCtx pure helpers.
//
// The provider's React/Firestore wiring (listeners, auth) isn't unit-tested in
// the node env, but the pure data-shaping logic it relies on is: projection +
// grouping, the slotId → logDose-args index, and the restock-arg derivation.

import { describe, expect, it } from 'vitest'

import type { CabinetItem, DoseLog, DoseStatus, Regimen, Treatment } from '../../src/types'
import { buildSlotId } from '../../src/lib/paths'
import {
  buildSlotIndex,
  buildTrackedByPerson,
  itemForTreatment,
  resolveRestockArgs,
} from '../../src/contexts/reimaginedProjection'

const TODAY = '2026-06-08'

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
    slots: [{ time: '08:00', foodTiming: 'after' }],
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
  return {
    slotId: buildSlotId('t1', 'r1', 'p1', TODAY, time.replace(':', '')),
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

describe('itemForTreatment', () => {
  it('finds the item via the first regimen cabinetItemId', () => {
    expect(itemForTreatment([regimen()], [item({ iId: 'i1' })])?.iId).toBe('i1')
  })
  it('returns null with no regimens or no matching item', () => {
    expect(itemForTreatment([], [item()])).toBeNull()
    expect(itemForTreatment([regimen({ cabinetItemId: 'iX' })], [item({ iId: 'i1' })])).toBeNull()
  })
})

describe('buildTrackedByPerson', () => {
  it('projects and groups treatments by patient UID', () => {
    const treatments = [
      treatment({ tId: 't1', memberId: 'p1' }),
      treatment({ tId: 't2', memberId: 'p1', name: 'Vitamin D' }),
      treatment({ tId: 't3', memberId: 'p2', name: 'Metformin' }),
    ]
    const regimensByTreatment = {
      t1: [regimen({ tId: 't1', rId: 'r1', cabinetItemId: 'i1' })],
      t2: [regimen({ tId: 't2', rId: 'r2', cabinetItemId: 'i2', scheduleType: 'as-needed', slots: [] })],
      t3: [regimen({ tId: 't3', rId: 'r3', cabinetItemId: 'i3' })],
    }
    const logsByTreatment = { t1: [log('08:00', 'taken')], t2: [], t3: [] }
    const items = [item({ iId: 'i1' }), item({ iId: 'i2' }), item({ iId: 'i3' })]

    const byPerson = buildTrackedByPerson(treatments, regimensByTreatment, logsByTreatment, items, TODAY)

    expect(Object.keys(byPerson).sort()).toEqual(['p1', 'p2'])
    expect(byPerson.p1).toHaveLength(2)
    expect(byPerson.p2).toHaveLength(1)
    const crocin = byPerson.p1!.find((m) => m.id === 't1')!
    expect(crocin.drug).toBe('Crocin')
    expect(crocin.todayStatus).toBe('all_done')
    const prn = byPerson.p1!.find((m) => m.id === 't2')!
    expect(prn.todayStatus).toBe('no_slots')
  })

  it('handles a treatment whose regimens have not loaded yet (no slots)', () => {
    const byPerson = buildTrackedByPerson([treatment()], {}, {}, [], TODAY)
    expect(byPerson.p1).toHaveLength(1)
    expect(byPerson.p1![0]!.todayStatus).toBe('no_slots')
  })
})

describe('buildSlotIndex', () => {
  it('maps each slotId to the args logDose needs', () => {
    const treatments = [treatment({ tId: 't1', memberId: 'p1' })]
    const regimensByTreatment = {
      t1: [
        regimen({
          tId: 't1',
          rId: 'r1',
          cabinetItemId: 'i1',
          doseAmount: 2,
          doseUnit: 'tablet',
          slots: [
            { time: '08:00', foodTiming: 'after' },
            { time: '20:00', foodTiming: 'after' },
          ],
        }),
      ],
    }
    const index = buildSlotIndex(treatments, regimensByTreatment, TODAY)
    const morningId = buildSlotId('t1', 'r1', 'p1', TODAY, '0800')
    expect(index.size).toBe(2)
    expect(index.get(morningId)).toEqual({
      tId: 't1',
      rId: 'r1',
      patientId: 'p1',
      cabinetItemId: 'i1',
      scheduledDate: TODAY,
      scheduledTime: '08:00',
      doseAmount: 2,
      doseUnit: 'tablet',
    })
    expect(index.has(buildSlotId('t1', 'r1', 'p1', TODAY, '2000'))).toBe(true)
  })
})

describe('resolveRestockArgs', () => {
  it('builds args with the display-name fallback chain', () => {
    const items = [
      item({ iId: 'i1', displayNameOverride: 'Dolo 650', quantityOnHand: 5 }),
      item({ iId: 'i2', displayNameOverride: null, brandName: 'Crocin', quantityOnHand: 3 }),
      item({ iId: 'i3', displayNameOverride: null, brandName: null, medicineId: 'med-x', quantityOnHand: 1 }),
    ]
    expect(resolveRestockArgs(items, 'i1', 'u1')).toEqual({
      cabinetItemId: 'i1',
      medicineName: 'Dolo 650',
      requestedBy: 'u1',
      quantityAtRequest: 5,
    })
    expect(resolveRestockArgs(items, 'i2', 'u1')!.medicineName).toBe('Crocin')
    expect(resolveRestockArgs(items, 'i3', 'u1')!.medicineName).toBe('med-x')
  })

  it('returns null for an unknown item', () => {
    expect(resolveRestockArgs([item()], 'nope', 'u1')).toBeNull()
  })
})
