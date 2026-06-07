// Reimagined · Phase 1 — SupplyLine (supply-days indicator bar).
//
// A horizontal progress bar showing how many days of a medicine remain. The
// fill width is proportional to `daysLeft / fullDays`, and the colour escalates
// from success → warning → danger as supply runs low. Pure presentation.

import type { CSSProperties } from 'react'
import { supplyPct, supplyTone, type SupplyTone } from './helpers'

export interface SupplyLineProps {
  /** Days of supply remaining. */
  daysLeft: number
  /** Days that represent a "full" bar (100%). Default 30. */
  fullDays?: number
  /** At or below this, the bar reads as a warning. Default 7. */
  lowThreshold?: number
  /** At or below this, the bar reads as danger. Default 3. */
  criticalThreshold?: number
  className?: string
}

const TONE_COLOR: Record<SupplyTone, string> = {
  success: 'var(--success, #639922)',
  warning: 'var(--warning, #EF9F27)',
  danger: 'var(--danger, #E24B4A)',
}

export function SupplyLine({
  daysLeft,
  fullDays = 30,
  lowThreshold = 7,
  criticalThreshold = 3,
  className,
}: SupplyLineProps) {
  const pct = supplyPct(daysLeft, fullDays)
  const tone = supplyTone(daysLeft, lowThreshold, criticalThreshold)

  const track: CSSProperties = {
    width: '100%',
    height: 6,
    borderRadius: 'var(--radius-pill, 9999px)',
    background: 'var(--gray-200, #E5E7EB)',
    overflow: 'hidden',
  }

  return (
    <div
      className={['rmg-supply', `rmg-supply--${tone}`, className].filter(Boolean).join(' ')}
      role="progressbar"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${Math.max(0, daysLeft)} days of supply left`}
      style={track}
    >
      <div
        className="rmg-supply-fill"
        style={{
          width: `${pct}%`,
          height: '100%',
          background: TONE_COLOR[tone],
          borderRadius: 'inherit',
        }}
      />
    </div>
  )
}
