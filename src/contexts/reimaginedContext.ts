// AK-195 — Reimagined context object + consumer hook.
//
// Split out from the provider (.tsx) so the provider module only exports a
// component (react-refresh clean) while the context value type, the Context
// instance, and the useReimagined() hook live here.

import { createContext, useContext } from 'react'
import type { TrackedMedicine } from '../lib/trackedMedicine'
import type { DoseStatus, HouseholdMember } from '../types'
import type { AddTrackedInput } from './reimaginedProjection'

export interface ReimaginedCtxValue {
  isLoading: boolean
  members: HouseholdMember[]
  /** TrackedMedicine[] keyed by patient UID (treatment.memberId). */
  trackedByPerson: Record<string, TrackedMedicine[]>
  markDose: (slotId: string, status?: DoseStatus) => Promise<void>
  addTracked: (data: AddTrackedInput) => Promise<string>
  requestRestock: (itemId: string) => Promise<void>
}

export const ReimaginedContext = createContext<ReimaginedCtxValue | null>(null)

export function useReimagined(): ReimaginedCtxValue {
  const ctx = useContext(ReimaginedContext)
  if (!ctx) throw new Error('useReimagined must be used within <ReimaginedProvider>')
  return ctx
}
