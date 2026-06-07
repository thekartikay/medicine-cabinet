// Reimagined · Phase 1 — StatusPill (dose/treatment status badge).
//
// Maps a dose status to a human label + Pill tone in one place, so every
// screen renders dose state consistently. Pure presentation — props in, UI out.

import { Pill } from './Pill'
import { statusMeta, type DoseStatus } from './helpers'

export interface StatusPillProps {
  status: DoseStatus
  className?: string
}

export function StatusPill({ status, className }: StatusPillProps) {
  const { label, tone } = statusMeta(status)
  return (
    <Pill tone={tone} className={['rmg-status-pill', className].filter(Boolean).join(' ')}>
      {label}
    </Pill>
  )
}
