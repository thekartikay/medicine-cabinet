// Reimagined · Phase 1 — MedicineCard.
//
// A card summarising one medicine: leading icon/avatar, name + descriptor,
// optional dose status, and an optional supply-days bar. Composes the Phase-1
// primitives (Icon, StatusPill, SupplyLine). Pure presentation — props in,
// UI out; an optional onClick makes the whole card actionable.

import type { CSSProperties } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Icon } from './Icon'
import { StatusPill } from './StatusPill'
import { SupplyLine } from './SupplyLine'
import type { DoseStatus } from './helpers'

export interface MedicineCardProps {
  name: string
  /** e.g. "500 mg". */
  strength?: string
  /** e.g. "Tablet" / "Syrup". */
  form?: string
  /** Days of supply remaining. When provided, a SupplyLine is rendered. */
  daysLeft?: number
  /** Dose status. When provided, a StatusPill is rendered. */
  status?: DoseStatus
  /** Leading icon. Defaults handled by callers; omit for none. */
  icon?: LucideIcon
  onClick?: () => void
  className?: string
}

export function MedicineCard({
  name,
  strength,
  form,
  daysLeft,
  status,
  icon,
  onClick,
  className,
}: MedicineCardProps) {
  const descriptor = [strength, form].filter(Boolean).join(' · ')
  const interactive = typeof onClick === 'function'

  const card: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    padding: 16,
    borderRadius: 'var(--radius-card, 24px)',
    background: 'var(--surface, #ffffff)',
    boxShadow: 'var(--shadow, 0 4px 14px rgba(16,100,112,0.10))',
    border: '1px solid var(--border, #E5E7EB)',
    textAlign: 'left',
    width: '100%',
    cursor: interactive ? 'pointer' : 'default',
  }

  const inner = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {icon && (
          <span
            aria-hidden
            style={{
              width: 40,
              height: 40,
              borderRadius: 'var(--radius-pill, 9999px)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'var(--gray-100, #F3F4F6)',
              color: 'var(--blueberry, #106470)',
              flexShrink: 0,
            }}
          >
            <Icon icon={icon} size={20} />
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            className="rmg-medcard-name"
            style={{ fontWeight: 600, color: 'var(--text-h, #111827)', fontSize: 16 }}
          >
            {name}
          </div>
          {descriptor && (
            <div
              className="rmg-medcard-desc"
              style={{ color: 'var(--text-muted, #6B7280)', fontSize: 13 }}
            >
              {descriptor}
            </div>
          )}
        </div>
        {status && <StatusPill status={status} />}
      </div>
      {typeof daysLeft === 'number' && <SupplyLine daysLeft={daysLeft} />}
    </>
  )

  const cls = ['rmg-medcard', className].filter(Boolean).join(' ')

  if (interactive) {
    return (
      <button type="button" onClick={onClick} className={cls} style={card}>
        {inner}
      </button>
    )
  }
  return (
    <div className={cls} style={card}>
      {inner}
    </div>
  )
}
