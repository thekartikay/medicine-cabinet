// AK-197 — MedDetail.
//
// One medicine's detail: header (drug + strength + person + home, with a back
// arrow), a supply-status block (days remaining + state label + SupplyLine),
// today's dose status (per-slot StatusPill, pending slots get a Take button),
// and per-day consumption + total quantity on hand. Consumes useReimagined();
// no Firestore of its own.

import { useState } from 'react'
import { Header, StatusPill, SupplyLine } from '../../components/reimagined'
import { useReimagined } from '../../contexts/reimaginedContext'
import type { TrackedMedicine } from '../../lib/trackedMedicine'
import { findTrackedById } from './cabinetSummary'

// Mirrors PersonDetail's TakeButton: owns its own in-flight + error state so a
// slow/failed markDose() is visible without blocking the rest of the screen.
function TakeButton({
  slotId,
  onTake,
}: {
  slotId: string
  onTake: (slotId: string) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        setFailed(false)
        try {
          await onTake(slotId)
        } catch {
          setFailed(true)
        } finally {
          setBusy(false)
        }
      }}
      style={{
        padding: '6px 16px',
        borderRadius: 'var(--radius-pill, 9999px)',
        background: 'var(--blueberry, #106470)',
        color: '#ffffff',
        fontSize: 13,
        fontWeight: 600,
        opacity: busy ? 0.6 : 1,
      }}
    >
      {busy ? 'Taking…' : failed ? 'Retry' : 'Take'}
    </button>
  )
}

function supplyLabel(tm: TrackedMedicine): string {
  if (tm.supplyState === 'low') return 'Low stock'
  if (Number.isFinite(tm.supplyDays)) return `${tm.supplyDays} days left`
  return 'In stock'
}

export function MedDetail({ trackedId, onBack }: { trackedId: string; onBack: () => void }) {
  const { isLoading, members, trackedByPerson, markDose } = useReimagined()
  const tm = findTrackedById(trackedByPerson, trackedId)
  const member = tm ? members.find((m) => m.uid === tm.personId) : undefined
  const personName = member?.displayName ?? 'Member'

  if (isLoading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Header title="Medicine" onBack={onBack} />
        <div role="status" aria-label="Loading medicine" style={{ margin: 16, height: 160, borderRadius: 'var(--radius-card, 24px)', background: 'var(--gray-100, #F3F4F6)' }} />
      </div>
    )
  }

  if (!tm) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <Header title="Medicine" onBack={onBack} />
        <p style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted, #6B7280)' }}>
          This medicine is no longer available.
        </p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Header
        title={[tm.drug, tm.strength].filter(Boolean).join(' ')}
        subtitle={`${personName} · Home`}
        onBack={onBack}
      />

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: 16, display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Supply status */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted, #6B7280)' }}>Supply</h2>
          <SupplyLine daysLeft={tm.supplyDays} />
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: tm.supplyState === 'low' ? 'var(--danger, #E24B4A)' : 'var(--text, #374151)',
            }}
          >
            {supplyLabel(tm)}
          </span>
          <div style={{ display: 'flex', gap: 24, fontSize: 13, color: 'var(--text-muted, #6B7280)' }}>
            <span>{tm.perDay}/day</span>
            <span>{tm.quantityOnHand} on hand</span>
          </div>
        </section>

        {/* Today's doses */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <h2 style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted, #6B7280)' }}>Today</h2>
          {tm.todaySlots.length === 0 ? (
            <span style={{ fontSize: 13, color: 'var(--text-muted, #6B7280)' }}>
              As needed — no scheduled doses today
            </span>
          ) : (
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {tm.todaySlots.map((slot) => (
                <li key={slot.slotId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 14, color: 'var(--text, #374151)' }}>{slot.time}</span>
                  {slot.status === 'pending' ? (
                    <TakeButton slotId={slot.slotId} onTake={markDose} />
                  ) : (
                    <StatusPill status={slot.status} />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
