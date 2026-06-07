// AK-196 — MyPeople + PersonDetail.
//
// The pure aggregation helpers are tested directly; the screens are rendered to
// static HTML with a mock ReimaginedContext value (no Firestore), which lets us
// assert the list/summary/low-stock/empty/loading states and the PersonDetail
// dose cards without a live data layer.

import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'

import { ReimaginedContext, type ReimaginedCtxValue } from '../../src/contexts/reimaginedContext'
import type { TrackedMedicine } from '../../src/lib/trackedMedicine'
import type { HouseholdMember } from '../../src/types'
import { MyPeople } from '../../src/screens/reimagined/MyPeople'
import { PersonDetail } from '../../src/screens/reimagined/PersonDetail'
import {
  doseSummaryLabel,
  groupByHome,
  hasLowStock,
  summarizeToday,
} from '../../src/screens/reimagined/peopleSummary'

function tm(over: Partial<TrackedMedicine> = {}): TrackedMedicine {
  return {
    id: 't1',
    personId: 'p1',
    drug: 'Crocin',
    strength: '500mg',
    perDay: 2,
    supplyDays: 30,
    todayStatus: 'partial',
    todaySlots: [
      { slotId: 's1', time: '08:00', status: 'taken' },
      { slotId: 's2', time: '20:00', status: 'pending' },
    ],
    nextTime: '20:00',
    supplyState: 'good',
    ...over,
  }
}

function member(over: Partial<HouseholdMember> = {}): HouseholdMember {
  return { uid: 'p1', hId: 'h1', role: 'member', displayName: 'Rajan', ...over } as HouseholdMember
}

function renderWith(ui: ReactElement, value: Partial<ReimaginedCtxValue>): string {
  const full: ReimaginedCtxValue = {
    isLoading: false,
    members: [],
    trackedByPerson: {},
    markDose: async () => {},
    addTracked: async () => 't1',
    requestRestock: async () => {},
    ...value,
  }
  return renderToStaticMarkup(<ReimaginedContext.Provider value={full}>{ui}</ReimaginedContext.Provider>)
}

describe('peopleSummary helpers', () => {
  it('summarizeToday aggregates slots across medicines', () => {
    expect(summarizeToday([tm(), tm({ id: 't2', todaySlots: [] })])).toEqual({ taken: 1, total: 2 })
    expect(summarizeToday([])).toEqual({ taken: 0, total: 0 })
  })

  it('doseSummaryLabel reads naturally', () => {
    expect(doseSummaryLabel({ taken: 3, total: 5 })).toBe('3 of 5 taken')
    expect(doseSummaryLabel({ taken: 0, total: 0 })).toBe('No doses today')
  })

  it('hasLowStock is true when any medicine is low', () => {
    expect(hasLowStock([tm(), tm({ supplyState: 'low' })])).toBe(true)
    expect(hasLowStock([tm(), tm({ supplyState: 'good' })])).toBe(false)
  })

  it('groupByHome groups by hId preserving order', () => {
    const groups = groupByHome([
      member({ uid: 'a', hId: 'h1' }),
      member({ uid: 'b', hId: 'h2' }),
      member({ uid: 'c', hId: 'h1' }),
    ])
    expect(groups.map((g) => g.hId)).toEqual(['h1', 'h2'])
    expect(groups[0]!.members.map((m) => m.uid)).toEqual(['a', 'c'])
  })
})

describe('MyPeople', () => {
  it('shows a loading skeleton while loading', () => {
    const out = renderWith(<MyPeople onSelect={() => {}} />, { isLoading: true })
    expect(out).toContain('aria-label="Loading people"')
  })

  it('shows the empty state with no members', () => {
    const out = renderWith(<MyPeople onSelect={() => {}} />, { isLoading: false, members: [] })
    expect(out).toContain('No one here yet. Add a household member to get started.')
  })

  it('renders each person with a dose summary and low-stock indicator', () => {
    const out = renderWith(<MyPeople onSelect={() => {}} />, {
      members: [member({ uid: 'p1', displayName: 'Rajan' })],
      trackedByPerson: { p1: [tm(), tm({ id: 't2', supplyState: 'low', todaySlots: [] })] },
    })
    expect(out).toContain('Rajan')
    expect(out).toContain('1 of 2 taken')
    expect(out).toContain('Low stock')
  })
})

describe('PersonDetail', () => {
  it('renders dose cards with Take for pending and StatusPill for resolved slots', () => {
    const out = renderWith(<PersonDetail personId="p1" onBack={() => {}} />, {
      members: [member({ uid: 'p1', displayName: 'Rajan' })],
      trackedByPerson: { p1: [tm()] },
    })
    expect(out).toContain('Rajan') // header name
    expect(out).toContain('Crocin') // MedicineCard
    expect(out).toContain('role="progressbar"') // SupplyLine
    expect(out).toContain('30 days left')
    expect(out).toContain('Take') // pending slot action
    expect(out).toContain('Taken') // resolved slot StatusPill
    expect(out).toContain('aria-label="Back"')
  })

  it('shows an empty message when the person has no medicines', () => {
    const out = renderWith(<PersonDetail personId="p1" onBack={() => {}} />, {
      members: [member({ uid: 'p1', displayName: 'Rajan' })],
      trackedByPerson: {},
    })
    expect(out).toContain('No medicines tracked for Rajan yet.')
  })
})
