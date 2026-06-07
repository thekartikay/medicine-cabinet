// Reimagined · Phase 1 — Pill (generic rounded badge).
//
// A small pill-shaped label used for tags, counts and inline status. Colour
// is driven by `tone`, mapped to the Phase-1 design tokens (AK-191). Token
// references carry a literal fallback so the component still renders correctly
// before the design-system tokens are present on the same branch.
//
// Pure presentation — props in, UI out.

import type { CSSProperties, ReactNode } from 'react'
import { pillToneStyle, type PillTone } from './helpers'

export interface PillProps {
  children: ReactNode
  tone?: PillTone
  className?: string
  style?: CSSProperties
}

export function Pill({ children, tone = 'neutral', className, style }: PillProps) {
  return (
    <span
      className={['rmg-pill', className].filter(Boolean).join(' ')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 10px',
        borderRadius: 'var(--radius-pill, 9999px)',
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
        ...pillToneStyle(tone),
        ...style,
      }}
    >
      {children}
    </span>
  )
}
