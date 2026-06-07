// Reimagined · Phase 1 — Icon (lucide-react wrapper).
//
// Thin, typed wrapper around a lucide-react glyph so every screen renders
// icons the same way and accessibility is handled in one place:
//   • decorative by default (aria-hidden), so screen readers skip it;
//   • when `label` is given it becomes an img with an accessible name.
// Pure presentation — props in, SVG out. No data, no context.

import type { LucideIcon } from 'lucide-react'

export interface IconProps {
  /** A lucide-react icon component, e.g. `import { Pill } from 'lucide-react'`. */
  icon: LucideIcon
  /** Accessible label. Omit for purely decorative icons (aria-hidden). */
  label?: string
  /** Pixel size of the square glyph. */
  size?: number
  /** Stroke colour. Defaults to `currentColor` so it inherits text colour. */
  color?: string
  strokeWidth?: number
  className?: string
}

export function Icon({
  icon: Glyph,
  label,
  size = 20,
  color = 'currentColor',
  strokeWidth = 2,
  className,
}: IconProps) {
  return (
    <Glyph
      size={size}
      color={color}
      strokeWidth={strokeWidth}
      className={className}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  )
}
