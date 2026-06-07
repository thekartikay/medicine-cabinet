// Reimagined · Phase 1 — Header (screen top bar).
//
// Title (and optional subtitle), an optional back button on the left, and an
// optional action slot on the right. Pure presentation — props in, UI out.

import type { ReactNode } from 'react'
import { ChevronLeft } from 'lucide-react'
import { Icon } from './Icon'

export interface HeaderProps {
  title: string
  subtitle?: string
  /** When provided, a back button is shown on the left. */
  onBack?: () => void
  /** Optional action(s) rendered on the right (e.g. an icon button). */
  right?: ReactNode
  className?: string
}

export function Header({ title, subtitle, onBack, right, className }: HeaderProps) {
  return (
    <header
      className={['rmg-header', className].filter(Boolean).join(' ')}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 16px',
        background: 'var(--surface, #ffffff)',
        borderBottom: '1px solid var(--border, #E5E7EB)',
        minHeight: 56,
      }}
    >
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="rmg-header-back"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 36,
            height: 36,
            borderRadius: 'var(--radius-pill, 9999px)',
            background: 'transparent',
            color: 'var(--text, #374151)',
            flexShrink: 0,
          }}
        >
          <Icon icon={ChevronLeft} size={22} />
        </button>
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <h1
          className="rmg-header-title"
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: 'var(--text-h, #111827)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {title}
        </h1>
        {subtitle && (
          <p
            className="rmg-header-subtitle"
            style={{ fontSize: 13, color: 'var(--text-muted, #6B7280)' }}
          >
            {subtitle}
          </p>
        )}
      </div>

      {right && <div className="rmg-header-right" style={{ flexShrink: 0 }}>{right}</div>}
    </header>
  )
}
