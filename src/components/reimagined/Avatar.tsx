// Reimagined · Phase 1 — Avatar (circular initials / image).
//
// Renders a circular avatar: an image when `src` is supplied, otherwise up to
// two initials derived from `name` on a deterministic brand-tinted background.
// Pure presentation — props in, UI out.

import type { CSSProperties } from 'react'
import { initials } from './helpers'

export interface AvatarProps {
  /** Used for initials and the image alt text. */
  name: string
  /** Optional image URL. When present, the image is rendered instead of initials. */
  src?: string
  /** Diameter in pixels. */
  size?: number
  className?: string
}

export function Avatar({ name, src, size = 40, className }: AvatarProps) {
  const base: CSSProperties = {
    width: size,
    height: size,
    borderRadius: 'var(--radius-pill, 9999px)',
    flexShrink: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  }

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        className={['rmg-avatar', className].filter(Boolean).join(' ')}
        style={{ ...base, objectFit: 'cover' }}
      />
    )
  }

  return (
    <span
      className={['rmg-avatar', className].filter(Boolean).join(' ')}
      role="img"
      aria-label={name}
      style={{
        ...base,
        background: 'var(--robin, #5DC1C8)',
        color: '#ffffff',
        fontWeight: 600,
        fontSize: Math.round(size * 0.4),
      }}
    >
      {initials(name)}
    </span>
  )
}
