// Reimagined · Phase 1 — pure helpers + shared types for the component library.
//
// Kept separate from the .tsx component files so each component module only
// exports components (satisfies react-refresh/only-export-components) and so the
// presentation logic stays unit-testable in isolation.

import type { CSSProperties } from 'react'

export type PillTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger'
export type DoseStatus = 'taken' | 'pending' | 'missed' | 'skipped'
export type SupplyTone = 'success' | 'warning' | 'danger'

export interface StatusMeta {
  label: string
  tone: PillTone
}

// Background/foreground per Pill tone, mapped to the Phase-1 tokens (AK-191)
// with literal fallbacks so a component renders correctly in isolation.
export function pillToneStyle(tone: PillTone): CSSProperties {
  switch (tone) {
    case 'brand':
      return { background: 'var(--robin, #5DC1C8)', color: '#ffffff' }
    case 'success':
      return { background: 'var(--success, #639922)', color: '#ffffff' }
    case 'warning':
      return { background: 'var(--warning, #EF9F27)', color: '#ffffff' }
    case 'danger':
      return { background: 'var(--danger, #E24B4A)', color: '#ffffff' }
    case 'neutral':
    default:
      return { background: 'var(--gray-100, #F3F4F6)', color: 'var(--gray-700, #374151)' }
  }
}

// Single source of truth for how a dose status reads and colours.
export function statusMeta(status: DoseStatus): StatusMeta {
  switch (status) {
    case 'taken':
      return { label: 'Taken', tone: 'success' }
    case 'missed':
      return { label: 'Missed', tone: 'danger' }
    case 'skipped':
      return { label: 'Skipped', tone: 'warning' }
    case 'pending':
    default:
      return { label: 'Pending', tone: 'neutral' }
  }
}

// First letter of the first and last whitespace-separated words, uppercased.
// Single-word names yield one initial; empty/whitespace yields ''.
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase()
  return (parts[0]!.charAt(0) + parts[parts.length - 1]!.charAt(0)).toUpperCase()
}

// Supply-bar fill percentage, clamped to [0, 100].
export function supplyPct(daysLeft: number, fullDays = 30): number {
  if (fullDays <= 0) return 0
  const pct = (daysLeft / fullDays) * 100
  return Math.max(0, Math.min(100, pct))
}

// Urgency tone from remaining days.
export function supplyTone(
  daysLeft: number,
  lowThreshold = 7,
  criticalThreshold = 3,
): SupplyTone {
  if (daysLeft <= criticalThreshold) return 'danger'
  if (daysLeft <= lowThreshold) return 'warning'
  return 'success'
}
