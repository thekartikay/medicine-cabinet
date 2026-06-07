// Reimagined · Phase 1 — shared placeholder for the nav-shell tabs (AK-193).
//
// Pure presentation. Each tab currently renders one of these with its own
// icon/title/subtitle; real screens replace them in later Phase-1 tickets.

import type { LucideIcon } from 'lucide-react'
import { Icon } from '../../components/reimagined'

export interface ScreenPlaceholderProps {
  icon: LucideIcon
  title: string
  subtitle: string
}

export function ScreenPlaceholder({ icon, title, subtitle }: ScreenPlaceholderProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 12,
        padding: 24,
        height: '100%',
        textAlign: 'center',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 64,
          height: 64,
          borderRadius: 'var(--radius-pill, 9999px)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--gray-100, #F3F4F6)',
          color: 'var(--blueberry, #106470)',
        }}
      >
        <Icon icon={icon} size={28} />
      </span>
      <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-h, #111827)' }}>{title}</h2>
      <p style={{ fontSize: 14, color: 'var(--text-muted, #6B7280)', maxWidth: '24rem' }}>
        {subtitle}
      </p>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--gray-400, #9CA3AF)' }}>
        Coming soon
      </span>
    </div>
  )
}
