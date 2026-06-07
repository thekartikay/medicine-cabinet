// AK-197 — Cabinet (the Cabinet tab default).
//
// Every tracked medicine across the household, grouped by home in collapsible
// sections (default expanded), low-supply first. Each row shows name+strength,
// the person it belongs to, a SupplyLine traffic light + days remaining, and the
// per-day consumption. Consumes useReimagined(); no Firestore of its own.

import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Icon, Pill, SupplyLine } from '../../components/reimagined'
import type { PillTone } from '../../components/reimagined'
import { useReimagined } from '../../contexts/reimaginedContext'
import type { TrackedMedicine } from '../../lib/trackedMedicine'
import { groupTrackedByHome, toggleCollapsed } from './cabinetSummary'

const SUPPLY_TONE: Record<TrackedMedicine['supplyState'], PillTone> = {
  good: 'success',
  watch: 'warning',
  low: 'danger',
}
const SUPPLY_LABEL: Record<TrackedMedicine['supplyState'], string> = {
  good: 'Good',
  watch: 'Watch',
  low: 'Low',
}

function CabinetSkeleton() {
  return (
    <div role="status" aria-label="Loading cabinet" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ height: 72, borderRadius: 'var(--radius-card, 24px)', background: 'var(--gray-100, #F3F4F6)' }} />
      ))}
    </div>
  )
}

function EmptyCabinet() {
  return (
    <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted, #6B7280)' }}>
      <p style={{ fontSize: 15 }}>Your cabinet is empty. Add a medicine to get started.</p>
    </div>
  )
}

function daysLabel(tm: TrackedMedicine): string {
  if (!Number.isFinite(tm.supplyDays)) return 'As needed'
  return `${tm.supplyDays} days left`
}

export function Cabinet({ onSelect }: { onSelect: (trackedId: string) => void }) {
  const { isLoading, members, trackedByPerson } = useReimagined()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set()) // default: all expanded

  if (isLoading) return <CabinetSkeleton />

  const groups = groupTrackedByHome(members, trackedByPerson)
  const total = groups.reduce((n, g) => n + g.entries.length, 0)
  if (total === 0) return <EmptyCabinet />

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.hId)
        return (
          <section key={group.hId} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              type="button"
              onClick={() => setCollapsed((c) => toggleCollapsed(c, group.hId))}
              aria-expanded={!isCollapsed}
              className="rmg-cabinet-home"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                background: 'transparent',
                color: 'var(--text-muted, #6B7280)',
                fontSize: 12,
                fontWeight: 700,
                letterSpacing: 0.4,
                textTransform: 'uppercase',
              }}
            >
              <Icon icon={isCollapsed ? ChevronRight : ChevronDown} size={16} />
              <span>Home</span>
              <span style={{ fontWeight: 600 }}>· {group.entries.length}</span>
            </button>

            {!isCollapsed &&
              group.entries.map((entry) => {
                const tm = entry.tracked
                return (
                  <button
                    key={tm.id}
                    type="button"
                    onClick={() => onSelect(tm.id)}
                    className="rmg-cabinet-row"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                      padding: 14,
                      borderRadius: 'var(--radius-card, 24px)',
                      background: 'var(--surface, #ffffff)',
                      border: '1px solid var(--border, #E5E7EB)',
                      boxShadow: 'var(--shadow, 0 4px 14px rgba(16,100,112,0.10))',
                      textAlign: 'left',
                      width: '100%',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
                      <span style={{ fontWeight: 600, color: 'var(--text-h, #111827)', fontSize: 16 }}>
                        {[tm.drug, tm.strength].filter(Boolean).join(' ')}
                      </span>
                      <Pill tone={SUPPLY_TONE[tm.supplyState]}>{SUPPLY_LABEL[tm.supplyState]}</Pill>
                    </div>
                    <span style={{ fontSize: 13, color: 'var(--text-muted, #6B7280)' }}>{entry.personName}</span>
                    <SupplyLine daysLeft={tm.supplyDays} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-muted, #6B7280)' }}>
                      <span>{daysLabel(tm)}</span>
                      <span>{tm.perDay}/day</span>
                    </div>
                  </button>
                )
              })}
          </section>
        )
      })}
    </div>
  )
}
