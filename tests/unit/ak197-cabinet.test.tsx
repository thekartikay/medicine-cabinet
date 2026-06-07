// @vitest-environment jsdom
//
// AK-197 — Cabinet + MedDetail. Pure helpers are tested directly; the screens
// are tested against a mock ReimaginedContext with @testing-library/react so we
// can drive real interactions (collapse toggle, tap-to-select, Take → markDose
// with busy/Retry states, back arrow). Scoped to jsdom via the docblock above;
// the rest of the suite stays in the node env.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ReimaginedContext, type ReimaginedCtxValue } from '../../src/contexts/reimaginedContext'
import type { TrackedMedicine } from '../../src/lib/trackedMedicine'
import type { HouseholdMember } from '../../src/types'
import { Cabinet } from '../../src/screens/reimagined/Cabinet'
import { MedDetail } from '../../src/screens/reimagined/MedDetail'
import {
  findTrackedById,
  groupTrackedByHome,
  sortBySupplyState,
  toggleCollapsed,
  type CabinetEntry,
} from '../../src/screens/reimagined/cabinetSummary'

afterEach(cleanup)

function tm(over: Partial<TrackedMedicine> = {}): TrackedMedicine {
  return {
    id: 't1',
    personId: 'p1',
    drug: 'Crocin',
    strength: '500mg',
    perDay: 2,
    quantityOnHand: 40,
    supplyDays: 20,
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

function entry(over: Partial<CabinetEntry> = {}): CabinetEntry {
  return { tracked: tm(), personName: 'Rajan', hId: 'h1', ...over }
}

function renderWith(ui: ReactElement, value: Partial<ReimaginedCtxValue>) {
  const full: ReimaginedCtxValue = {
    isLoading: false,
    members: [],
    trackedByPerson: {},
    markDose: async () => {},
    addTracked: async () => 't1',
    requestRestock: async () => {},
    ...value,
  }
  return render(<ReimaginedContext.Provider value={full}>{ui}</ReimaginedContext.Provider>)
}

// ── Pure helpers ─────────────────────────────────────────────────────────────
describe('cabinetSummary helpers', () => {
  it('groupTrackedByHome groups across multiple homes', () => {
    const members = [member({ uid: 'p1', hId: 'h1' }), member({ uid: 'p2', hId: 'h2' })]
    const byPerson = { p1: [tm({ id: 't1' })], p2: [tm({ id: 't2' })] }
    const groups = groupTrackedByHome(members, byPerson)
    expect(groups.map((g) => g.hId)).toEqual(['h1', 'h2'])
    expect(groups[0]!.entries[0]!.tracked.id).toBe('t1')
  })

  it('groupTrackedByHome handles a single home and empty input', () => {
    const single = groupTrackedByHome([member({ uid: 'p1', hId: 'h1' })], { p1: [tm(), tm({ id: 't2' })] })
    expect(single).toHaveLength(1)
    expect(single[0]!.entries).toHaveLength(2)
    expect(groupTrackedByHome([], {})).toEqual([])
  })

  it('sortBySupplyState orders low → watch → good', () => {
    const entries = [
      entry({ tracked: tm({ id: 'g', supplyState: 'good' }) }),
      entry({ tracked: tm({ id: 'l', supplyState: 'low' }) }),
      entry({ tracked: tm({ id: 'w', supplyState: 'watch' }) }),
    ]
    expect(sortBySupplyState(entries).map((e) => e.tracked.id)).toEqual(['l', 'w', 'g'])
  })

  it('findTrackedById hits and misses', () => {
    const byPerson = { p1: [tm({ id: 't1' }), tm({ id: 't2' })] }
    expect(findTrackedById(byPerson, 't2')?.id).toBe('t2')
    expect(findTrackedById(byPerson, 'nope')).toBeNull()
  })

  it('toggleCollapsed flips membership immutably', () => {
    const a = toggleCollapsed(new Set<string>(), 'h1')
    expect(a.has('h1')).toBe(true)
    const b = toggleCollapsed(a, 'h1')
    expect(b.has('h1')).toBe(false)
    expect(a.has('h1')).toBe(true) // original untouched
  })
})

// ── Cabinet screen ───────────────────────────────────────────────────────────
describe('Cabinet screen', () => {
  it('shows a skeleton while loading', () => {
    renderWith(<Cabinet onSelect={() => {}} />, { isLoading: true })
    expect(screen.getByLabelText('Loading cabinet')).toBeTruthy()
  })

  it('shows the empty state with no medicines', () => {
    renderWith(<Cabinet onSelect={() => {}} />, { members: [member()], trackedByPerson: {} })
    expect(screen.getByText('Your cabinet is empty. Add a medicine to get started.')).toBeTruthy()
  })

  it('renders medicines grouped under a home header, low state shown', () => {
    renderWith(<Cabinet onSelect={() => {}} />, {
      members: [member({ uid: 'p1' })],
      trackedByPerson: { p1: [tm({ supplyState: 'low' })] },
    })
    expect(screen.getByText('Home')).toBeTruthy()
    expect(screen.getByText('Crocin 500mg')).toBeTruthy()
    expect(screen.getByText('Rajan')).toBeTruthy()
    expect(screen.getByText('Low')).toBeTruthy()
  })

  it('collapse/expand toggles a home’s medicines', () => {
    renderWith(<Cabinet onSelect={() => {}} />, {
      members: [member({ uid: 'p1' })],
      trackedByPerson: { p1: [tm()] },
    })
    expect(screen.getByText('Crocin 500mg')).toBeTruthy()
    const header = screen.getByRole('button', { name: /home/i })
    fireEvent.click(header) // collapse
    expect(screen.queryByText('Crocin 500mg')).toBeNull()
    fireEvent.click(header) // expand
    expect(screen.getByText('Crocin 500mg')).toBeTruthy()
  })

  it('tapping a medicine fires onSelect with its id', () => {
    const onSelect = vi.fn()
    renderWith(<Cabinet onSelect={onSelect} />, {
      members: [member({ uid: 'p1' })],
      trackedByPerson: { p1: [tm({ id: 't1' })] },
    })
    fireEvent.click(screen.getByText('Crocin 500mg'))
    expect(onSelect).toHaveBeenCalledWith('t1')
  })
})

// ── MedDetail screen ─────────────────────────────────────────────────────────
describe('MedDetail screen', () => {
  const base = { members: [member({ uid: 'p1', displayName: 'Rajan' })], trackedByPerson: { p1: [tm({ id: 't1' })] } }

  it('renders header with drug/strength/person/home and supply/consumption', () => {
    renderWith(<MedDetail trackedId="t1" onBack={() => {}} />, base)
    expect(screen.getByText('Crocin 500mg')).toBeTruthy()
    expect(screen.getByText('Rajan · Home')).toBeTruthy()
    expect(screen.getByText('2/day')).toBeTruthy()
    expect(screen.getByText('40 on hand')).toBeTruthy()
  })

  it('renders Take for pending slots and StatusPill for resolved slots', () => {
    renderWith(<MedDetail trackedId="t1" onBack={() => {}} />, base)
    expect(screen.getByText('Take')).toBeTruthy() // pending 20:00
    expect(screen.getByText('Taken')).toBeTruthy() // resolved 08:00
  })

  it('clicking Take calls markDose with the correct slotId', async () => {
    const markDose = vi.fn().mockResolvedValue(undefined)
    renderWith(<MedDetail trackedId="t1" onBack={() => {}} />, { ...base, markDose })
    fireEvent.click(screen.getByText('Take'))
    expect(markDose).toHaveBeenCalledWith('s2')
    await screen.findByText('Take') // settle the post-await state update
  })

  it('shows busy state during the call', () => {
    const markDose = vi.fn(() => new Promise<void>(() => {})) // never resolves
    renderWith(<MedDetail trackedId="t1" onBack={() => {}} />, { ...base, markDose })
    fireEvent.click(screen.getByText('Take'))
    expect(screen.getByText('Taking…')).toBeTruthy()
    expect((screen.getByText('Taking…').closest('button') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows Retry when markDose rejects', async () => {
    const markDose = vi.fn().mockRejectedValue(new Error('nope'))
    renderWith(<MedDetail trackedId="t1" onBack={() => {}} />, { ...base, markDose })
    fireEvent.click(screen.getByText('Take'))
    expect(await screen.findByText('Retry')).toBeTruthy()
  })

  it('back arrow fires the back handler', () => {
    const onBack = vi.fn()
    renderWith(<MedDetail trackedId="t1" onBack={onBack} />, base)
    fireEvent.click(screen.getByLabelText('Back'))
    expect(onBack).toHaveBeenCalled()
  })
})
