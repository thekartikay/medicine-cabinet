// Reimagined · Phase 1 — BottomNav (bottom tab bar).
//
// Renders a fixed-width row of tab buttons. The active tab is highlighted with
// the brand colour and marked aria-current. Pure presentation: the parent owns
// the active key and handles navigation via onNavigate.

import type { LucideIcon } from 'lucide-react'
import { Icon } from './Icon'

export interface BottomNavItem {
  key: string
  label: string
  icon: LucideIcon
}

export interface BottomNavProps {
  items: BottomNavItem[]
  activeKey: string
  onNavigate: (key: string) => void
  className?: string
}

export function BottomNav({ items, activeKey, onNavigate, className }: BottomNavProps) {
  return (
    <nav
      className={['rmg-bottomnav', className].filter(Boolean).join(' ')}
      aria-label="Primary"
      style={{
        display: 'flex',
        alignItems: 'stretch',
        background: 'var(--surface, #ffffff)',
        borderTop: '1px solid var(--border, #E5E7EB)',
      }}
    >
      {items.map((item) => {
        const active = item.key === activeKey
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onNavigate(item.key)}
            aria-current={active ? 'page' : undefined}
            className={['rmg-bottomnav-item', active ? 'rmg-bottomnav-item--active' : '']
              .filter(Boolean)
              .join(' ')}
            style={{
              flex: 1,
              display: 'inline-flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
              padding: '8px 4px',
              background: 'transparent',
              color: active ? 'var(--blueberry, #106470)' : 'var(--gray-400, #9CA3AF)',
              fontSize: 11,
              fontWeight: active ? 600 : 500,
            }}
          >
            <Icon icon={item.icon} size={22} />
            <span>{item.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
